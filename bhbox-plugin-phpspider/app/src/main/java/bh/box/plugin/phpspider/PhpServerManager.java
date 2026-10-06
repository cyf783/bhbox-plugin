package bh.box.plugin.phpspider;

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
 * PHP 内置 Web Server 进程管理器。
 *
 * 端口自动探测：从 9980 起递增，直到找到可用端口（参考 ServerManager）。
 * PHP 内置服务器绑定端口失败时进程会立即退出，通过进程存活检测判断绑定是否成功。
 */
public class PhpServerManager {

    private Process phpProcess;
    private String baseUrl;
    private int usedPort;
    /** start 时传入的 php 可执行文件（stop 时按该路径 kill 进程） */
    private File phpBinary;

    private final AtomicBoolean starting = new AtomicBoolean(false);
    private final AtomicBoolean serverUp = new AtomicBoolean(false);

    private static final int DEFAULT_PORT = 9980;
    private static final int MAX_PORT = 9999;

    private static final String[] READY_KEYWORDS = {
            "listening", "started", "development server", "server started",
            "server is running"
    };

    public PhpServerManager() {
    }

    /**
     * 启动 PHP 内置 Web Server，自动探测可用端口。
     *
     * 逻辑与 ServerManager.startHttpServer() 一致：
     * 1. 先通过 ServerSocket 探测本地可用端口
     * 2. 启动 PHP 进程绑定该端口
     * 3. 如果进程立即退出（端口冲突等），递增端口重试
     */
    public void start(File phpBinary, File docRoot) {
        if (serverUp.get()) return;
        if (!starting.compareAndSet(false, true)) return;

        try {
            this.phpBinary = phpBinary;
            phpBinary.setExecutable(true);

            int port = DEFAULT_PORT;
            do {
                // 先探测端口是否可绑定
                if (!isPortAvailable(port)) {
                    port++;
                    continue;
                }

                LOG.i("PHP", "尝试启动 PHP Server 于端口 " + port);

                List<String> cmd = Arrays.asList(
                        "nohup",
                        phpBinary.getAbsolutePath(),
                        "-d", "opcache.enable=0",
                        "-S", "127.0.0.1:" + port,
                        "-t", docRoot.getAbsolutePath()
                );

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.directory(docRoot);
                pb.redirectErrorStream(true);
                pb.environment().put("TMPDIR", System.getProperty("java.io.tmpdir"));

                phpProcess = pb.start();

                // 监听 stdout
                new Thread(() -> {
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(phpProcess.getInputStream()))) {
                        String line;
                        while ((line = br.readLine()) != null) {
                            LOG.i("PHP", line);
                            if (!serverUp.get() && isReadySignal(line)) {
                                LOG.i("PHP", "检测到就绪信号: " + line);
                                serverUp.set(true);
                            }
                        }
                    } catch (IOException ignored) {
                    } finally {
                        if (!serverUp.get()) {
                            serverUp.set(false);
                        }
                    }
                }).start();

                // 等待就绪（3 秒超时，端口冲突时进程会立即退出）
                long deadline = System.currentTimeMillis() + 3_000;
                while (!serverUp.get() && System.currentTimeMillis() < deadline) {
                    try { TimeUnit.MILLISECONDS.sleep(300); } catch (InterruptedException ignored) {}
                }

                // 检查结果
                if (serverUp.get()) {
                    break;
                }

                if (isProcessAlive()) {
                    // 进程存活但未检测到就绪信号，等待更长时间
                    long extendDeadline = System.currentTimeMillis() + 12_000;
                    while (!serverUp.get() && System.currentTimeMillis() < extendDeadline) {
                        try { TimeUnit.MILLISECONDS.sleep(500); } catch (InterruptedException ignored) {}
                    }
                    if (serverUp.get() || isProcessAlive()) {
                        if (!serverUp.get()) {
                            LOG.i("PHP", "进程存活但未检测到就绪信号，标记为启动成功");
                            serverUp.set(true);
                        }
                        break;
                    }
                }

                // 进程已退出，可能是端口冲突，递增端口重试
                LOG.i("PHP", "端口 " + port + " 启动失败，尝试下一个端口");
                phpProcess = null;
                port++;

            } while (port < MAX_PORT);

            usedPort = port;
            baseUrl = "http://127.0.0.1:" + port;
            starting.set(false);

            if (serverUp.get()) {
                LOG.i("PHP", "PHP Server 启动成功 (" + baseUrl + ")");
            } else {
                LOG.e("PHP", "PHP Server 启动失败，无可用端口");
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

    /** 停止 PHP 服务器 */
    public void stop() {
        serverUp.set(false);
        starting.set(false);
        if (phpProcess != null) {
            phpProcess.destroy();
            phpProcess = null;
            if (phpBinary != null) {
                Shell.exec("killall -9 " + phpBinary.getAbsolutePath());
            }
        }
    }

    public boolean isRunning() {
        return serverUp.get();
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public int getPort() {
        return usedPort;
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
        if (phpProcess == null) return false;
        try {
            phpProcess.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
    }
}
