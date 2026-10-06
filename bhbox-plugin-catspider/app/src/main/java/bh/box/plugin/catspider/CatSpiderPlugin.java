package bh.box.plugin.catspider;

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
import com.google.gson.JsonObject;

import java.io.File;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * CatSpider 插件入口类（CatVodOpen nodejs 源支持）。
 *
 * 与 PhpSpiderPlugin 架构一致：
 * - 管理 Spider 实例缓存（按站点 key 去重）
 * - 委托 NodeServerManager 管理 node 服务（cat-server.js）生命周期
 * - Spider 实例通过 T4 HTTP 协议调用对应 nodejs 源
 *
 * 与 PHP 的差异：源文件（.js）需要被 server 动态加载，
 * 新增/更新的源文件要求重启 node 进程。
 */
public class CatSpiderPlugin implements ISpiderPlugin {

    private static final String ID = "bh.box.plugin.catspider";

    public static File sourceCache = Path.cacheFile("cat");

    /** 已创建的 Spider 实例缓存，key=站点 key */
    private final ConcurrentHashMap<String, Spider> spiders = new ConcurrentHashMap<>();
    /** 最近一次使用的站点 key（用于 proxyInvoke 定位） */
    private String recent;
    /** node 服务管理器 */
    private NodeServerManager serverManager;
    /** server 当前已加载的源文件名集合（并发安全：宿主多线程并发调 getSpider） */
    private final Set<String> loadedFiles = Collections.newSetFromMap(new ConcurrentHashMap<>());

    @Override
    public void init() {
        this.serverManager = new NodeServerManager();
    }

    @Override
    public void install() {
        // 安装/更新插件时一次性部署源目录基础设施（ESM package.json + 预置依赖 node_modules）
        deployModulePackageJson(sourceCache);
        deployNodeModules(sourceCache, true);
    }

    @Override
    public void uninstall() {}

    @Override
    public Spider getSpider(String key, String api, String ext) {
        try {
            recent = key;

            // 缓存：相同 key 不重复创建；server 意外退出时在此自愈（重启 + 刷新 baseUrl）
            if (spiders.containsKey(key)) {
                Spider cached = spiders.get(key);
                if (cached instanceof NodeSpider && (!serverManager.isRunning() || !serverAlive())) {
                    LOG.i("CatSpider", "server 未运行，重启自愈");
                    startServer();
                    ((NodeSpider) cached).setBaseUrl(serverManager.getBaseUrl());
                }
                return cached;
            }

            // 先解析/下载源文件（此时不依赖 server）
            NodeSpider spider = new NodeSpider(this, null, api);
            spider.init(Init.context(), ext);
            if (spider.getSourceFile() == null || TextUtils.isEmpty(spider.getRouteName())) {
                LOG.e("CatSpider", "源文件解析失败: " + api);
                return new SpiderNull();
            }

            // 再启动/同步 server（新源文件需要重启加载）
            syncServer(spider.getSourceFile(), spider.isNewFile());

            spider.setBaseUrl(serverManager.getBaseUrl());
            spider.siteKey = key;
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
        LOG.i("CatSpider", "server 未响应，重启自愈");
        startServer();
        return serverManager.isRunning() ? serverManager.getBaseUrl() : null;
    }

    /** 保证 server 运行且已加载指定源文件：优先热加载（不重启、端口稳定），失败回退重启 */
    private void syncServer(File sourceFile, boolean isNewFile) {
        if (!serverManager.isRunning()) {
            startServer();
            return;
        }
        if (isNewFile || !loadedFiles.contains(sourceFile.getName())) {
            LOG.i("CatSpider", "热加载源文件: " + sourceFile.getName());
            if (hotLoad(sourceFile.getName())) {
                loadedFiles.add(sourceFile.getName());
                return;
            }
            LOG.e("CatSpider", "热加载失败，回退重启 server");
            startServer();
            return;
        }
        // 文件已在已加载集合：仍需探测 server 真实存活（node 进程可能被系统杀死而内存标志未更新，
        // 否则新 Spider 会带着死 server 的 baseUrl 被缓存，导致该站点本次访问全部空返回）
        if (!serverAlive()) {
            LOG.i("CatSpider", "server 探测失败，重启自愈");
            startServer();
        }
    }

    /** 调用 server 的 /load 接口热加载单个源文件（bust 穿透 import 缓存） */
    private boolean hotLoad(String fileName) {
        try {
            JsonObject body = new JsonObject();
            body.addProperty("file", fileName);
            body.addProperty("bust", true);
            Request request = new Request.Builder()
                    .url(serverManager.getBaseUrl() + "/load")
                    .header("Connection", "close")
                    .post(RequestBody.create(body.toString(), MediaType.parse("application/json; charset=utf-8")))
                    .build();
            try (Response response = OkHttp.client().newCall(request).execute()) {
                String text = response.body() != null ? response.body().string() : "";
                return response.isSuccessful() && text.contains("\"ok\":true");
            }
        } catch (Exception e) {
            return false;
        }
    }

    private void startServer() {
        synchronized (this) {
            serverManager.stop();

            File nodeBinary = resolveBinary();
            if (nodeBinary == null) return;
            File assetsDir = new File(Path.getSystemPluginPath() + "/" + ID + "/assets");
            File serverJs = new File(assetsDir, "cat-server.cjs");

            File sourcesDir = sourceCache;
            sourcesDir.mkdirs();
            // 幂等兜底：数据清除后插件重载不走 install()，此处自愈
            deployModulePackageJson(sourcesDir);
            deployNodeModules(sourcesDir, false);

            serverManager.start(nodeBinary, serverJs, sourcesDir);

            loadedFiles.clear();
            String[] files = sourcesDir.list((dir, name) -> name.endsWith(".js"));
            if (files != null) loadedFiles.addAll(Arrays.asList(files));
        }
    }

    /** 从自身 plugin.json 的 depends 声明定位运行时插件提供的 node 可执行文件 */
    private File resolveBinary() {
        ApkPluginBean self = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<String> depends = self == null ? null : self.getDepends();
        if (depends == null || depends.isEmpty()) {
            LOG.e("CatSpider", "plugin.json 未声明 depends，无法定位 node 二进制");
            return null;
        }
        IRuntimePlugin runtime = Plugin.getRuntimePluginById(depends.get(0));
        File bin = new File(runtime.getExecutable());
        // init 并行加载的极端时序兜底：依赖插件可能仍在解压 assets，等待落盘（最多 5s）
        long deadline = System.currentTimeMillis() + 5_000;
        while (!bin.exists() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(200); } catch (InterruptedException e) { break; }
        }
        if (!bin.exists()) LOG.e("CatSpider", "运行时插件未安装或缺少 node，请先安装: " + depends);
        return bin.exists() ? bin : null;
    }

    /** 源目录需按 ESM 解析 .js，部署 {"type":"module"} 的 package.json（覆盖写，防外部拷入的 package.json 破坏 ESM 解析） */
    private void deployModulePackageJson(File sourcesDir) {
        File pkg = new File(sourcesDir, "package.json");
        try {
            Io.write(pkg, "{\"type\":\"module\"}");
        } catch (Exception e) {
            LOG.e("CatSpider", "部署 package.json 失败");
        }
    }

    /**
     * 释放 assets/npm/ 预置依赖到源目录 node_modules/。
     * assets/npm 为「每包 3 文件」的精简结构（build-deps.mjs 产物）：
     * <pkg>.cjs（全量 bundle）+ <pkg>.mjs（ESM wrapper）+ <pkg>.json（package.json），
     * 落地文件数 15（原完整 node_modules 为 2367 文件，释放极慢）。
     */
    private void deployNodeModules(File sourcesDir, boolean force) {
        File from = new File(Path.getSystemPluginPath() + "/" + ID + "/assets", "npm");
        File to = new File(sourcesDir, "node_modules");
        String[] pkgs = from.list((dir, name) -> name.endsWith(".json"));
        if (pkgs == null || pkgs.length == 0) return;
        try {
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
        } catch (Exception e) {
            LOG.e("CatSpider", "释放预置依赖失败");
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
        loadedFiles.clear();
        if (serverManager != null) {
            serverManager.stop();
        }
        // 只清理下载的源文件，保留安装时部署的 package.json/node_modules 基础设施
        String[] files = sourceCache.list((dir, name) -> name.endsWith(".js"));
        if (files != null) {
            for (String name : files) Io.delete(new File(sourceCache, name));
        }
    }
}
