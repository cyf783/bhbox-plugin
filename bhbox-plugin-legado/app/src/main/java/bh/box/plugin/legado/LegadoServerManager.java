package bh.box.plugin.legado;

import android.text.TextUtils;

import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Shell;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Node.js 服务进程管理器（承载 legado-server.cjs，书源转 T4 服务）。
 *
 * 与 CatSpiderPlugin.NodeServerManager 同构，差异仅两点：
 * - 端口段 9930-9939（避开宿主 9978、drpyS 9940+、cat 9970+、php 9980+）
 * - 书源配置经 LEGADO_PARAMS 环境变量注入（JSON：remoteUrls/localFile）
 *
 * 端口自动探测：被占则递增；端口经 PORT 环境变量传给 node；
 * stdout 出现 "listening" 视为就绪；进程存活但未收到信号也降级标记成功。
 * 启动后由看护线程每 60s 探活（进程存活 + /check 可达），失败自动重启自愈。
 */
public class LegadoServerManager {

    private Process nodeProcess;
    private String baseUrl;
    private int usedPort;
    /** start 时传入的 node 可执行文件（stop 时按该路径 kill 进程） */
    private File nodeBinary;
    /** 最近一次 start 的参数（看护线程自愈重启用） */
    private String lastServerJs;
    private String lastParams;

    private final AtomicBoolean starting = new AtomicBoolean(false);
    private final AtomicBoolean serverUp = new AtomicBoolean(false);
    /** 看护线程是否已启动（仅启动一次） */
    private boolean watchdogStarted = false;

    private static final int DEFAULT_PORT = 9930;
    private static final int MAX_PORT = 9939;

    private static final String[] READY_KEYWORDS = {
            "listening", "ready", "started", "server is running"
    };

    public LegadoServerManager() {
    }

    /** 同步标记启动中：宿主在 start() 返回后立即轮询 isStarting()，置位不能晚于 start() 返回（消除后台线程竞态窗口） */
    public void markStarting() {
        if (!serverUp.get()) starting.set(true);
    }

    /** 撤销 markStarting（node 不可用等同步失败路径），让宿主轮询快速失败而非等满超时 */
    public void cancelStart() {
        if (!serverUp.get()) starting.set(false);
    }

    /**
     * 启动 node 服务（阻塞直至就绪或超时，调用方自行放后台线程）。
     * starting 已由 markStarting() 同步置位；本方法 synchronized 串行化，防并发重入。
     *
     * @param nodeBinary node 可执行文件（运行时插件 assets 解压目录）
     * @param serverJs   legado-server.cjs 入口（本插件 assets 解压目录）
     * @param legadoParams 书源参数 JSON（remoteUrls/localFile），经 LEGADO_PARAMS 环境变量注入
     */
    public synchronized void start(File nodeBinary, File serverJs, String legadoParams) {
        if (serverUp.get()) return;
        starting.set(true); // markStarting 已同步置位（宿主轮询语义）；此处兜底 watchdog 自愈路径

        try {
            this.nodeBinary = nodeBinary;
            this.lastServerJs = serverJs.getAbsolutePath();
            this.lastParams = legadoParams;
            nodeBinary.setExecutable(true);

            int port = DEFAULT_PORT;
            do {
                if (!isPortAvailable(port)) {
                    port++;
                    continue;
                }

                LOG.i("Legado", "尝试启动 Node Server 于端口 " + port);

                // --max-old-space-size=128：无堆顶时大目录页解析把 RSS 推到 460MB+，
                // 后台孤儿进程被 Android LMK 按内存阈值杀掉（表现为「访问几次后 T4 重启」）。
                // 128MB 堆顶下实测米读 5 本千章详情全部正常且 RSS 稳定 ~175MB
                List<String> cmd = Arrays.asList(
                        "nohup",
                        nodeBinary.getAbsolutePath(),
                        "--max-old-space-size=128",
                        serverJs.getAbsolutePath()
                );

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.directory(serverJs.getParentFile());
                pb.redirectErrorStream(true);
                pb.environment().put("PORT", String.valueOf(port));
                pb.environment().put("LEGADO_PARAMS", legadoParams == null ? "{}" : legadoParams);
                pb.environment().put("TMPDIR", System.getProperty("java.io.tmpdir"));

                nodeProcess = pb.start();

                final int probePort = port;
                new Thread(() -> {
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(nodeProcess.getInputStream()))) {
                        String line;
                        while ((line = br.readLine()) != null) {
                            LOG.i("Legado", line);
                            if (!serverUp.get() && isReadySignal(line)) {
                                LOG.i("Legado", "检测到就绪信号: " + line);
                                serverUp.set(true);
                            }
                        }
                    } catch (IOException ignored) {
                    }
                }).start();

                // 等待就绪（node 启动 + 书源首次加载，放宽到 15 秒）
                long deadline = System.currentTimeMillis() + 15_000;
                while (!serverUp.get() && System.currentTimeMillis() < deadline) {
                    try { TimeUnit.MILLISECONDS.sleep(300); } catch (InterruptedException ignored) {}
                }

                if (serverUp.get()) break;

                if (isProcessAlive()) {
                    long extendDeadline = System.currentTimeMillis() + 10_000;
                    while (!serverUp.get() && System.currentTimeMillis() < extendDeadline) {
                        try { TimeUnit.MILLISECONDS.sleep(500); } catch (InterruptedException ignored) {}
                    }
                    if (serverUp.get() || isProcessAlive()) {
                        if (!serverUp.get()) {
                            LOG.i("Legado", "进程存活但未检测到就绪信号，标记为启动成功");
                            serverUp.set(true);
                        }
                        break;
                    }
                }

                LOG.i("Legado", "端口 " + port + " 启动失败，尝试下一个端口");
                nodeProcess = null;
                port++;

            } while (port < MAX_PORT);

            usedPort = port;
            baseUrl = "http://127.0.0.1:" + port;
            starting.set(false);

            if (serverUp.get()) {
                LOG.i("Legado", "Node Server 启动成功 (" + baseUrl + ")");
                ensureWatchdog();
            } else {
                LOG.e("Legado", "Node Server 启动失败，无可用端口");
            }
        } catch (Exception e) {
            e.printStackTrace();
            starting.set(false);
        }
    }

    private boolean isPortAvailable(int port) {
        try (ServerSocket ss = new ServerSocket(port)) {
            ss.setReuseAddress(true);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** 停止 node 服务 */
    public synchronized void stop() {
        serverUp.set(false);
        starting.set(false);
        if (nodeProcess != null) {
            nodeProcess.destroy();
            nodeProcess = null;
            if (nodeBinary != null) {
                Shell.exec("killall -9 " + nodeBinary.getAbsolutePath());
            }
        }
    }

    public boolean isRunning() {
        return serverUp.get();
    }

    public boolean isStarting() {
        return starting.get();
    }

    public int getPort() {
        return usedPort;
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    private boolean isReadySignal(String line) {
        if (TextUtils.isEmpty(line)) return false;
        String lower = line.toLowerCase();
        for (String keyword : READY_KEYWORDS) {
            if (lower.contains(keyword)) return true;
        }
        return false;
    }

    private boolean isProcessAlive() {
        if (nodeProcess == null) return false;
        try {
            nodeProcess.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
    }

    /** 确保看护线程在跑（仅启动一次，serverUp=false 时空转） */
    private void ensureWatchdog() {
        if (watchdogStarted) return;
        synchronized (this) {
            if (watchdogStarted) return;
            watchdogStarted = true;
        }
        Thread t = new Thread(() -> {
            while (true) {
                try { TimeUnit.SECONDS.sleep(60); } catch (InterruptedException e) { return; }
                if (!serverUp.get() || starting.get()) continue;
                // node 进程可能被系统杀死而标志未更新：进程死亡或 /check 不可达均视为掉线，重启自愈
                if (!isProcessAlive() || !checkAlive()) {
                    LOG.i("Legado", "探活失败，重启自愈");
                    stop();
                    start(new File(nodeBinary.getAbsolutePath()), new File(lastServerJs), lastParams);
                }
            }
        }, "legado-watchdog");
        t.setDaemon(true);
        t.start();
    }

    /** GET /check 探活（node 进程假死场景，进程存活但服务不响应） */
    private boolean checkAlive() {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + "/check").openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            conn.setRequestProperty("Connection", "close");
            int code = conn.getResponseCode();
            conn.disconnect();
            return code >= 200 && code < 300;
        } catch (Exception e) {
            return false;
        }
    }
}
