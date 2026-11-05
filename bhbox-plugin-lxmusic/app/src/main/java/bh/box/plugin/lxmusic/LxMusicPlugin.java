package bh.box.plugin.lxmusic;

import android.text.TextUtils;

import com.github.catvod.Init;
import com.github.catvod.crawler.Spider;
import com.github.catvod.crawler.SpiderNull;
import com.github.catvod.net.OkHttp;
import com.github.catvod.plugin.IRuntimePlugin;
import com.github.catvod.plugin.ISpiderPlugin;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Plugin;

import java.io.File;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

import okhttp3.Request;
import okhttp3.Response;

/**
 * 洛雪音源插件入口（lx 自定义源脚本 → T3 音乐源）。
 *
 * 架构与 DrpysSpiderPlugin 一致，差异：
 * - lx 脚本零 npm 依赖（lx shim 全部映射 Node 内置模块），无需 node_modules 部署；
 * - 脚本文件落盘为 sourceCache/&lt;md5&gt;.js，node 端按 mtime 热加载，脚本更新无需重启进程；
 * - 站点 api 即 lx 脚本地址（http(s)/clan/file://），一个脚本一个站点。
 */
public class LxMusicPlugin implements ISpiderPlugin {

    private static final String ID = "bh.box.plugin.lxmusic";

    public static File sourceCache = Path.cacheFile("lx");

    /** 已创建的 Spider 实例缓存，key=站点 key */
    private final ConcurrentHashMap<String, Spider> spiders = new ConcurrentHashMap<>();
    /** node 服务管理器 */
    private LxServerManager serverManager;

    @Override
    public void init() {
        this.serverManager = new LxServerManager();
    }

    @Override
    public void install() {
        // lx 脚本零预置依赖，无需部署
    }

    @Override
    public void uninstall() {}

    @Override
    public Spider getSpider(String key, String api, String ext) {
        try {
            // 缓存：相同 key 不重复创建；server 意外退出时经 ensureAlive 自愈（持锁重启 + 刷新 baseUrl）
            if (spiders.containsKey(key)) {
                LxSpider cached = (LxSpider) spiders.get(key);
                if (cached != null && (!serverManager.isRunning() || !serverAlive())) {
                    LOG.i("LxMusic", "server 未运行，重启自愈");
                    String base = ensureAlive();
                    if (!TextUtils.isEmpty(base)) cached.setBaseUrl(base);
                }
                return cached;
            }

            // 先解析/下载源脚本（此时不依赖 server）
            LxSpider spider = new LxSpider(this, api);
            spider.init(Init.context(), ext);
            if (spider.getSourceFile() == null || TextUtils.isEmpty(spider.getRouteName())) {
                LOG.e("LxMusic", "源脚本解析失败: " + api);
                return new SpiderNull();
            }

            // 再启动 server（脚本按请求实时读取，无需为新源重启）；ensureAlive 持锁，防并发首建互相杀
            String base = ensureAlive();
            if (TextUtils.isEmpty(base)) {
                LOG.e("LxMusic", "server 启动失败");
                return new SpiderNull();
            }

            spider.setBaseUrl(base);
            spiders.put(key, spider);
            return spider;
        } catch (Throwable e) {
            e.printStackTrace();
            return new SpiderNull();
        }
    }

    /** 探测 server 是否真实存活（node 进程可能被系统杀死而内存标志未更新；短超时防 hung 住拖慢切换） */
    private boolean serverAlive() {
        try {
            Request request = new Request.Builder().url(serverManager.getBaseUrl() + "/check")
                    .header("Connection", "close").get().build();
            try (Response response = OkHttp.client(3000).newCall(request).execute()) {
                return response.isSuccessful();
            }
        } catch (Exception e) {
            return false;
        }
    }

    /** 确认 server 存活（必要时重启自愈），返回可用 baseUrl。判断+重启整体持锁：防多站点并发失败时连环 stop/start 互相杀 */
    synchronized String ensureAlive() {
        if (serverManager.isRunning() && serverAlive()) return serverManager.getBaseUrl();
        LOG.i("LxMusic", "server 未响应，重启自愈");
        startServer();
        return serverManager.isRunning() ? serverManager.getBaseUrl() : null;
    }

    private void startServer() {
        synchronized (this) {
            serverManager.stop();

            File nodeBinary = resolveBinary();
            if (nodeBinary == null) return;
            File assetsDir = new File(Path.getSystemPluginPath() + "/" + ID + "/assets");
            File serverJs = new File(assetsDir, "lx-server.cjs");

            File sourcesDir = sourceCache;
            sourcesDir.mkdirs();

            serverManager.start(nodeBinary, serverJs, sourcesDir);
        }
    }

    /** 从自身 plugin.json 的 depends 声明定位运行时插件提供的 node 可执行文件 */
    private File resolveBinary() {
        ApkPluginBean self = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<String> depends = self == null ? null : self.getDepends();
        if (depends == null || depends.isEmpty()) {
            LOG.e("LxMusic", "plugin.json 未声明 depends，无法定位 node 二进制");
            return null;
        }
        IRuntimePlugin runtime = Plugin.getRuntimePluginById(depends.get(0));
        File bin = new File(runtime.getExecutable());
        // init 并行加载的极端时序兜底：依赖插件可能仍在解压 assets，等待落盘（最多 5s）
        long deadline = System.currentTimeMillis() + 5_000;
        while (!bin.exists() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(200); } catch (InterruptedException e) { break; }
        }
        if (!bin.exists()) LOG.e("LxMusic", "运行时插件未安装或缺少 node，请先安装: " + depends);
        return bin.exists() ? bin : null;
    }

    @Override
    public Object[] proxyInvoke(java.util.Map<String, String> params) {
        // 直链为外部绝对地址，无需宿主转发
        return null;
    }

    @Override
    public void clear() {
        for (Spider spider : spiders.values()) {
            try { spider.destroy(); } catch (Exception ignored) {}
        }
        spiders.clear();
        if (serverManager != null) {
            serverManager.stop();
        }
        Io.delete(sourceCache);
    }
}
