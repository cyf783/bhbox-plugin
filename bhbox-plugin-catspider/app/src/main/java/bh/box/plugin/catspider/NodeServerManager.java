package bh.box.plugin.catspider;

import android.text.TextUtils;

import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Shell;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Node.js 服务进程管理器（承载 cat-server.js，动态加载各源 fastify 子路由）。
 *
 * 端口自动探测：从 9970 起递增（与宿主内嵌 Server 9978、PHP 9980-9999 错开），
 * 端口通过 PORT 环境变量传给 node；stdout 出现 "listening" 视为就绪。
 */
public class NodeServerManager {

    private Process nodeProcess;
    private String baseUrl;
    private int usedPort;
    /** start 时传入的 node 可执行文件（stop 时按该路径 kill 进程） */
    private File nodeBinary;

    private final AtomicBoolean starting = new AtomicBoolean(false);
    private final AtomicBoolean serverUp = new AtomicBoolean(false);

    private static final int DEFAULT_PORT = 9970;
    private static final int MAX_PORT = 9999;

    private static final String[] READY_KEYWORDS = {
            "listening", "ready", "started", "server is running"
    };

    public NodeServerManager() {
    }

    /**
     * 启动 node 服务。
     *
     * @param nodeBinary node 可执行文件（插件 assets 解压目录）
     * @param serverJs   cat-server.js 入口（插件 assets 解压目录）
     * @param sourcesDir 源文件目录
     */
    public void start(File nodeBinary, File serverJs, File sourcesDir) {
        if (serverUp.get()) return;
        if (!starting.compareAndSet(false, true)) return;

        try {
            this.nodeBinary = nodeBinary;
            nodeBinary.setExecutable(true);

            int port = DEFAULT_PORT;
            do {
                if (!isPortAvailable(port)) {
                    port++;
                    continue;
                }

                LOG.i("CatSpider", "尝试启动 Node Server 于端口 " + port);

                List<String> cmd = Arrays.asList(
                        "nohup",
                        nodeBinary.getAbsolutePath(),
                        serverJs.getAbsolutePath(),
                        sourcesDir.getAbsolutePath()
                );

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.directory(sourcesDir);
                pb.redirectErrorStream(true);
                pb.environment().put("PORT", String.valueOf(port));
                pb.environment().put("TMPDIR", System.getProperty("java.io.tmpdir"));

                nodeProcess = pb.start();

                new Thread(() -> {
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(nodeProcess.getInputStream()))) {
                        String line;
                        while ((line = br.readLine()) != null) {
                            LOG.i("CatSpider", line);
                            if (!serverUp.get() && isReadySignal(line)) {
                                LOG.i("CatSpider", "检测到就绪信号: " + line);
                                serverUp.set(true);
                            }
                        }
                    } catch (IOException ignored) {
                    }
                }).start();

                // 等待就绪（node 启动含 ESM 加载，放宽到 10 秒）
                long deadline = System.currentTimeMillis() + 10_000;
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
                            LOG.i("CatSpider", "进程存活但未检测到就绪信号，标记为启动成功");
                            serverUp.set(true);
                        }
                        break;
                    }
                }

                LOG.i("CatSpider", "端口 " + port + " 启动失败，尝试下一个端口");
                nodeProcess = null;
                port++;

            } while (port < MAX_PORT);

            usedPort = port;
            baseUrl = "http://127.0.0.1:" + port;
            starting.set(false);

            if (serverUp.get()) {
                LOG.i("CatSpider", "Node Server 启动成功 (" + baseUrl + ")");
            } else {
                LOG.e("CatSpider", "Node Server 启动失败，无可用端口");
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
    public void stop() {
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
}
