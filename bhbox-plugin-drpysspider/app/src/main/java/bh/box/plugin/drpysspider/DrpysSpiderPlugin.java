package bh.box.plugin.drpysspider;

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
 * drpyS Spider 插件入口（lang='ds' 中文规则源支持）。
 *
 * 架构与 CatSpiderPlugin 一致，差异：
 * - drpyS 引擎按文件内容 hash 缓存源模块，源文件新增/覆盖后下次请求自动生效，
 *   不需要 /load 热加载接口，也不需要为新源重启 node 进程；
 * - 源文件经 vm.runInContext 以文本执行（非 ESM import），源目录无需 {"type":"module"}。
 */
public class DrpysSpiderPlugin implements ISpiderPlugin {

    private static final String ID = "bh.box.plugin.drpysspider";

    public static File sourceCache = Path.cacheFile("ds");

    /** 已创建的 Spider 实例缓存，key=站点 key */
    private final ConcurrentHashMap<String, Spider> spiders = new ConcurrentHashMap<>();
    /** node 服务管理器 */
    private DsServerManager serverManager;

    @Override
    public void init() {
        this.serverManager = new DsServerManager();
    }

    @Override
    public void install() {
        // 安装/更新插件时一次性部署预置依赖 node_modules
        deployNodeModules(sourceCache, true);
    }

    @Override
    public void uninstall() {}

    @Override
    public Spider getSpider(String key, String api, String ext) {
        try {
            // 缓存：相同 key 不重复创建；server 意外退出时在此自愈（重启 + 刷新 baseUrl）
            if (spiders.containsKey(key)) {
                Spider cached = spiders.get(key);
                if (cached instanceof DsSpider && (!serverManager.isRunning() || !serverAlive())) {
                    LOG.i("DsSpider", "server 未运行，重启自愈");
                    startServer();
                    ((DsSpider) cached).setBaseUrl(serverManager.getBaseUrl());
                }
                return cached;
            }

            // 先解析/下载源文件（此时不依赖 server）
            DsSpider spider = new DsSpider(this, null, api);
            spider.init(Init.context(), ext);
            if (spider.getSourceFile() == null || TextUtils.isEmpty(spider.getRouteName())) {
                LOG.e("DsSpider", "源文件解析失败: " + api);
                return new SpiderNull();
            }

            // 再启动 server（源文件按请求实时读取，无需为新源重启）
            if (!serverManager.isRunning() || !serverAlive()) startServer();

            spider.setBaseUrl(serverManager.getBaseUrl());
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

    /** 确认 server 存活（必要时重启自愈），返回可用 baseUrl；server 不可用返回 null */
    String ensureAlive() {
        if (serverManager.isRunning() && serverAlive()) return serverManager.getBaseUrl();
        LOG.i("DsSpider", "server 未响应，重启自愈");
        startServer();
        return serverManager.isRunning() ? serverManager.getBaseUrl() : null;
    }

    private void startServer() {
        synchronized (this) {
            serverManager.stop();

            File nodeBinary = resolveBinary();
            if (nodeBinary == null) return;
            File assetsDir = new File(Path.getSystemPluginPath() + "/" + ID + "/assets");
            File serverJs = new File(assetsDir, "ds-server.cjs");

            File sourcesDir = sourceCache;
            sourcesDir.mkdirs();
            // 幂等兜底：数据清除后插件重载不走 install()，此处自愈
            deployNodeModules(sourcesDir, false);

            serverManager.start(nodeBinary, serverJs, sourcesDir);
        }
    }

    /** 从自身 plugin.json 的 depends 声明定位运行时插件提供的 node 可执行文件 */
    private File resolveBinary() {
        ApkPluginBean self = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<String> depends = self == null ? null : self.getDepends();
        if (depends == null || depends.isEmpty()) {
            LOG.e("DsSpider", "plugin.json 未声明 depends，无法定位 node 二进制");
            return null;
        }
        IRuntimePlugin runtime = Plugin.getRuntimePluginById(depends.get(0));
        File bin = new File(runtime.getExecutable());
        // init 并行加载的极端时序兜底：依赖插件可能仍在解压 assets，等待落盘（最多 5s）
        long deadline = System.currentTimeMillis() + 5_000;
        while (!bin.exists() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(200); } catch (InterruptedException e) { break; }
        }
        if (!bin.exists()) LOG.e("DsSpider", "运行时插件未安装或缺少 node，请先安装: " + depends);
        return bin.exists() ? bin : null;
    }

    /**
     * 释放 assets/npm/ 预置依赖到源目录 node_modules/。
     * assets/npm 为「每包 3 文件」的精简结构（build-deps.mjs 产物）：
     * <pkg>.cjs（全量 bundle）+ <pkg>.mjs（ESM wrapper）+ <pkg>.json（package.json），
     * 部署时落地为 node_modules/&lt;pkg&gt;/ 三文件（json 改名 package.json）。
     * noop.js 为引擎 moduleLoader 的裸包 require 解析锚点。
     */
    private void deployNodeModules(File sourcesDir, boolean force) {
        File from = new File(Path.getSystemPluginPath() + "/" + ID + "/assets", "npm");
        File to = new File(sourcesDir, "node_modules");
        String[] pkgs = from.list((dir, name) -> name.endsWith(".json"));
        try {
            if (pkgs != null && pkgs.length > 0) {
                for (String json : pkgs) {
                    String pkg = json.substring(0, json.length() - ".json".length());
                    File dir = new File(to, pkg);
                    // 非强制时幂等：已释放过该包则跳过（install 时 force=true 保证插件更新后依赖同步刷新）
                    if (!force && new File(dir, "package.json").exists()) continue;
                    if (!dir.exists()) dir.mkdirs();
                    Io.write(new File(dir, "package.json"), Io.read(new File(from, json)));
                    Io.copy(new File(from, pkg + ".cjs"), new File(dir, pkg + ".cjs"));
                    Io.copy(new File(from, pkg + ".mjs"), new File(dir, pkg + ".mjs"));
                }
            }
            // 解析锚点（createRequire 锚定文件，存在与否均可解析，落盘仅为完备）
            File noop = new File(to, "noop.js");
            if (force || !noop.exists()) Io.write(noop, "");
        } catch (Exception e) {
            LOG.e("DsSpider", "释放预置依赖失败");
        }
    }

    @Override
    public Object[] proxyInvoke(java.util.Map<String, String> params) {
        // 播放代理由源返回的 127.0.0.1 绝对地址直连 node 端口，无需宿主转发
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
        // 只清理源缓存（<md5> 隔离目录 + 引擎运行时数据），保留安装时部署的 node_modules 基础设施
        String[] children = sourceCache.list();
        if (children != null) {
            for (String name : children) {
                if (name.equals("node_modules")) continue;
                Io.delete(new File(sourceCache, name));
            }
        }
    }
}
