package bh.box.plugin.goproxy;

import android.text.TextUtils;

import com.github.catvod.plugin.IServicePlugin;
import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Plugin;
import com.github.catvod.utils.Shell;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * GoProxyPlugin
 */
public class GoProxyPlugin implements IServicePlugin {
    private String ID = "bh.box.plugin.goproxy";
    private Process process;

    @Override
    public void init() {}

    @Override
    public void install() {}

    @Override
    public void uninstall() {}

    /** 服务启动中标志 */
    private final AtomicBoolean starting = new AtomicBoolean(false);
    /** 服务已启动标志 */
    private final AtomicBoolean serverUp = new AtomicBoolean(false);

    private String GO_PROXY = "go_proxy_video";

    private ApkParam params;

    private void loadApkParams() {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        if(bean != null && bean.getParams() != null && bean.getParams().size() > 0){
            params = bean.getParams().get(0);
        }
    }

    @Override
    public void start() {
        loadApkParams();
        if(serverUp.get() || starting.get()){
            LOG.i("GoProxy", "GO代理 启动成功");
            return;
        }
        LOG.i("GoProxy","GO代理 正在启动...");
        starting.set(true);
        new Thread(() -> {
            File file = new File(Path.getSystemPluginPath()+"/"+ID+"/assets", GO_PROXY);
            Shell.exec("killall -9 " + GO_PROXY);
            try {
                file.setExecutable(true);
                List<String> cmd = new ArrayList<>(Arrays.asList(
                        "nohup",
                        file.getAbsolutePath()
                ));

                if(params != null && params.getValue() != null){
                    // 添加参数
                    parseParams(cmd, params.getValue());
                }

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.redirectErrorStream(true);
                process = pb.start();

                // 日志输出
                new Thread(() -> {
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(process.getInputStream()))) {
                        String line;
                        while ((line = br.readLine()) != null) {
                            LOG.i("GoProxy", line);
                        }
                    } catch (IOException ignored) {}
                }).start();
                serverUp.set(true);
                starting.set(false);
                LOG.i("GoProxy", "GO代理 启动成功");
            } catch (Exception e) {
                serverUp.set(false);
                starting.set(false);
                LOG.i("GoProxy", "GO代理 启动失败");
            }
        }).start();
    }

    @Override
    public void stop() {
        new Thread(() -> {
            LOG.i("GoProxy", "GO代理 正在停止...");
            serverUp.set(false);
            Shell.exec("killall -9 " + GO_PROXY);
            LOG.i("GoProxy", "GO代理 已停止");
        }).start();
    }

    @Override
    public boolean isRunning() {
        return serverUp.get();
    }

    @Override
    public boolean isStarting() {
        return starting.get();
    }

    @Override
    public int getPort() {
        return 0;
    }


    public static void parseParams(List<String> cmd, String paramsStr) {
        if (!TextUtils.isEmpty(paramsStr)) {
            String[] params = parseCommandLine(paramsStr);
            for (String param : params) {
                if (!TextUtils.isEmpty(param)) {
                    cmd.add(param);
                }
            }
        }
    }

    private static String[] parseCommandLine(String cmdLine) {
        List<String> tokens = new ArrayList<>();
        boolean inQuotes = false;
        StringBuilder current = new StringBuilder();

        for (char c : cmdLine.toCharArray()) {
            if (c == '\"' || c == '\'') {
                inQuotes = !inQuotes;
            } else if (c == ' ' && !inQuotes) {
                if (current.length() > 0) {
                    tokens.add(current.toString());
                    current = new StringBuilder();
                }
            } else {
                current.append(c);
            }
        }

        if (current.length() > 0) {
            tokens.add(current.toString());
        }

        return tokens.toArray(new String[0]);
    }
}
