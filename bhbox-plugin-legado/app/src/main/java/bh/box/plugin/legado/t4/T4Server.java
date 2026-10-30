package bh.box.plugin.legado.t4;

import android.util.Log;

import bh.box.plugin.legado.LegadoPlugin;

import com.github.catvod.utils.Plugin;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.net.URLDecoder;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import fi.iki.elonen.NanoHTTPD;

/**
 * legado-server 传输层（对齐 app/server/src/index.js：node:http 裸写单进程单用途 →
 * NanoHTTPD 进程内实现），承载 T4 五动作与书源状态。
 *
 * 端点（逐一对齐 index.js#createServer handler）：
 *   GET  /            移动端状态页（订阅复制、状态概况、重载、源列表搜索；宿主插件页「打开网页」入口）
 *   GET  /check       探活（宿主看护探测用）
 *   GET  /config      订阅 JSON：每个启用书源一个 type=4 站点（api 按请求 Host 动态构造）
 *   GET  /status      书源加载概况（JSON；参数有外部修改时自动重载，打开 web 即最新）
 *   POST /reload      重新拉取书源（本地文件重读 + 网络下载）
 *   GET  /params      插件参数原始值（remoteUrls 多行值，宿主 bean，非内存合并值）
 *   POST /params      保存插件参数（宿主持久化 + 内存热更）并重载书源
 *   GET  /api/&lt;md5&gt;   T4 五动作（home/list/detail/search/play）
 *
 * 启动模型对齐 node「先监听后加载源」：绑定端口即视为服务就绪（宿主探活不依赖源数据），
 * 源数据请求经 awaitSources 等待加载完成（上限 25s，宿主 okhttp 默认 30s 超时内）。
 *
 * 与 node 版差异：node 版为独立子进程（LegadoServerManager 管理生命周期 + 看护自愈），
 * Java 版为进程内 NanoHTTPD（随宿主进程存活，无子进程被杀场景，看护自愈不再需要）；
 * uncaughtException/unhandledRejection 守护由 serve 的 try-catch + 引擎层隔离等价承担。
 */
public final class T4Server extends NanoHTTPD {

    private static final String TAG = "legado-t4";

    private static final Gson GSON = new Gson();

    /** 端口段 9930-9939（避开宿主 9978、drpyS 9940+、cat 9970+、php 9980+） */
    private static final int PORT_MIN = 9930;
    private static final int PORT_MAX = 9939;

    /** 进程内单实例（对齐 node 单进程） */
    private static volatile T4Server instance;

    /** 最近一次 start 的参数（对齐 node LEGADO_PARAMS 环境变量）；POST /params 保存后热更新替换 */
    private volatile SourceManager.Params params;

    /** 全局书源状态：启动时加载一次，POST /reload 刷新（对齐 index.js state） */
    private volatile SourceManager.LoadResult state = new SourceManager.LoadResult();
    private volatile String loadedAt = null;
    private final AtomicBoolean loading = new AtomicBoolean(false);

    private T4Server(int port, SourceManager.Params params) {
        super(port);
        this.params = params;
    }

    /**
     * 启动服务：端口 9930-9939 try-start 探测（被占则递增），绑定成功即返回
     * （源数据后台加载）。阻塞毫秒级，可在任意线程调用；重复调用幂等。
     *
     * @param paramsJson 书源参数 JSON（remoteUrls 多行值，对齐 node LEGADO_PARAMS）
     * @return 是否成功监听
     */
    public static synchronized boolean start(String paramsJson) {
        T4Server cur = instance;
        if (cur != null && cur.wasStarted()) return true;
        shutdown();
        SourceManager.Params params = SourceManager.parseParams(paramsJson);
        for (int port = PORT_MIN; port <= PORT_MAX; port++) {
            try {
                T4Server s = new T4Server(port, params);
                s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true);
                instance = s;
                Log.i(TAG, "listening on 0.0.0.0:" + port);
                // 先监听后加载源：listening 即就绪，源数据请求经 awaitSources 等待
                s.loadAllAsync();
                return true;
            } catch (IOException e) {
                Log.i(TAG, "端口 " + port + " 不可用，尝试下一个");
            }
        }
        Log.e(TAG, "启动失败，无可用端口（9930-9939）");
        return false;
    }

    /** 停止服务（对齐 node 版 stop：杀进程 → 此处关 socket。命名避开 NanoHTTPD#stop 实例方法） */
    public static synchronized void shutdown() {
        T4Server cur = instance;
        instance = null;
        if (cur != null) {
            try {
                cur.superStop();
            } catch (Exception e) {
                Log.w(TAG, "stop failed: " + e.getMessage());
            }
        }
    }

    public static boolean isRunning() {
        T4Server cur = instance;
        return cur != null && cur.wasStarted();
    }

    public static int getPort() {
        T4Server cur = instance;
        return cur != null && cur.wasStarted() ? cur.getListeningPort() : 0;
    }

    // ============ 书源加载（对齐 index.js#loadAll / awaitSources） ============

    private void loadAllAsync() {
        new Thread(this::loadAll, "legado-load-sources").start();
    }

    /** 对齐 index.js#loadAll */
    private void loadAll() {
        loading.set(true);
        try {
            state = SourceManager.loadSources(params);
            loadedAt = nowIso();
            Log.i(TAG, "sources loaded: " + state.list.size() + " usable"
                    + ", errors=" + state.errors.size()
                    + ", skipped=" + state.skipped.size()
                    + ", incompatible=" + state.incompatible.size());
        } finally {
            loading.set(false);
        }
    }

    /**
     * 源数据端点等待当前加载完成：冷启动先监听后加载源，宿主（缓存配置）的请求
     * 到达时挂住至源就绪再处理，而非返回空数据。上限 25s（宿主 okhttp 默认 30s 超时内）。
     */
    private void awaitSources() {
        long deadline = System.currentTimeMillis() + 25_000;
        while (loading.get() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    // ============ 请求分发（对齐 index.js#createServer handler） ============

    @Override
    public Response serve(IHTTPSession session) {
        Method method = session.getMethod();
        String uri = session.getUri();
        // api 地址按请求 Host 动态构造：端口漂移随宿主刷新订阅自愈；局域网设备亦可直接订阅
        String host = session.getHeaders().get("host");
        if (host == null || host.isEmpty()) host = "127.0.0.1:" + getListeningPort();
        try {
            if (method == Method.GET && "/check".equals(uri)) {
                return json(Response.Status.OK, kv("run", true, "sources", state.list.size()));
            }
            if (method == Method.GET && "/config".equals(uri)) {
                awaitSources();
                return json(Response.Status.OK,
                        kv("sites", SourceManager.buildSites(state.list, host)));
            }
            if (method == Method.GET && "/status".equals(uri)) {
                // 打开 web 自动跟进最新参数（TV 端表单等外部修改），无需手动重载
                if (LegadoPlugin.syncIfChanged()) reloadWithParams();
                LinkedHashMap<String, Object> out = new LinkedHashMap<>();
                out.put("running", true);
                out.put("loading", loading.get());
                out.put("loadedAt", loadedAt);
                out.put("usable", state.list.size());
                out.put("report", state.reportMap());
                List<Object> sources = new java.util.ArrayList<>(state.list.size());
                for (Map<String, Object> s : state.list) {
                    LinkedHashMap<String, Object> item = new LinkedHashMap<>();
                    String name = SourceManager.strOrEmpty(SourceManager.mapGet(s, "bookSourceName"));
                    item.put("name", name.isEmpty()
                            ? SourceManager.strOrEmpty(SourceManager.mapGet(s, "bookSourceUrl")) : name);
                    item.put("url", SourceManager.mapGet(s, "bookSourceUrl"));
                    item.put("group", SourceManager.strOrEmpty(SourceManager.mapGet(s, "bookSourceGroup")));
                    sources.add(item);
                }
                out.put("sources", sources);
                return json(Response.Status.OK, out);
            }
            if (method == Method.POST && "/reload".equals(uri)) {
                T4Actions.clearCaches();
                loadAll();
                LinkedHashMap<String, Object> out = new LinkedHashMap<>();
                out.put("ok", true);
                out.put("usable", state.list.size());
                out.put("report", state.reportMap());
                return json(Response.Status.OK, out);
            }
            if (method == Method.GET && "/params".equals(uri)) {
                return handleGetParams();
            }
            if (method == Method.POST && "/params".equals(uri)) {
                return handlePostParams(session);
            }
            if (method == Method.GET && uri.startsWith("/api/")) {
                awaitSources();
                return handleApi(uri.substring("/api/".length()), queryParams(session));
            }
            if (method == Method.GET && ("/".equals(uri) || "/index.html".equals(uri))) {
                return html(statusPage());
            }
            return json(Response.Status.NOT_FOUND, kv("error", "not found"));
        } catch (Exception e) {
            Log.e(TAG, "request failed: " + method + " " + uri + ": " + e.getMessage());
            return json(Response.Status.INTERNAL_ERROR, kv("error", String.valueOf(e.getMessage())));
        }
    }

    /** 对齐 index.js#handleApi：hash → 书源，五动作分发（home/list/detail/search/play） */
    private Response handleApi(String hash, Map<String, String> query) {
        for (Map<String, Object> src : state.list) {
            String url = SourceManager.strOrEmpty(SourceManager.mapGet(src, "bookSourceUrl")).trim();
            if (SourceManager.md5(url).equals(hash)) {
                return json(Response.Status.OK, T4Actions.dispatchT4(src, query));
            }
        }
        return json(Response.Status.NOT_FOUND, kv("error", "source not found: " + hash));
    }

    // ============ 插件参数（网页配置；原始值存宿主 bean，经 LegadoPlugin 读写） ============

    /** GET /params：宿主 bean 的参数原始值（remoteUrls 多行值），供状态页回显 */
    private Response handleGetParams() {
        return json(Response.Status.OK, kv(
                "remoteUrls", SourceManager.strOrEmpty(LegadoPlugin.getParamRaw("remoteUrls"))));
    }

    /**
     * POST /params：body 为 UTF-8 JSON {remoteUrls}（原始值，多行文本，每行 http(s)://
     * 订阅地址或 file:// 本地书源文件）的 Base64 编码——绕开 NanoHTTPD 对非 form body
     * 的单字节解码（中文路径会乱码）。保存经 SDK 交宿主统一持久化，随后清缓存、按最新
     * 参数重建内存 params 并重载书源——保存即生效，无需重启插件。
     */
    private Response handlePostParams(IHTTPSession session) throws IOException, ResponseException {
        Map<String, String> files = new LinkedHashMap<>();
        session.parseBody(files);
        String raw = files.get("postData");
        if (raw == null || raw.trim().isEmpty())
            return json(Response.Status.BAD_REQUEST, kv("error", "empty body"));
        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(raw.trim(), android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return json(Response.Status.BAD_REQUEST, kv("error", "invalid base64 body"));
        }
        JsonObject in = GSON.fromJson(new String(bytes, java.nio.charset.StandardCharsets.UTF_8), JsonObject.class);
        if (in == null) return json(Response.Status.BAD_REQUEST, kv("error", "empty body"));
        String remoteUrls = in.has("remoteUrls") && !in.get("remoteUrls").isJsonNull()
                ? in.get("remoteUrls").getAsString() : null;
        if (remoteUrls == null)
            return json(Response.Status.BAD_REQUEST, kv("error", "missing remoteUrls"));
        try {
            LegadoPlugin.saveParams(remoteUrls);
        } catch (Throwable t) {
            Log.e(TAG, "save params failed: " + t);
            return json(Response.Status.INTERNAL_ERROR, kv("error", "save failed: " + t));
        }
        reloadWithParams();
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("usable", state.list.size());
        out.put("report", state.reportMap());
        return json(Response.Status.OK, out);
    }

    /** 保存参数后热更新：对齐 /reload 语义清缓存，用宿主 bean 最新参数重建内存 params 并重载 */
    private void reloadWithParams() {
        T4Actions.clearCaches();
        params = SourceManager.parseParams(LegadoPlugin.buildParamsJson());
        loadAll();
    }

    // ============ 状态页（移动端 Web 风格；页面本体为独立 assets/index.html，随 APK 打包） ============

    /**
     * 状态页：HTML/CSS/JS 全在 assets/index.html（前端 fetch /status 拉数据、订阅地址取
     * location.origin），服务端零注入——host 参数不再需要（/config 仍按请求 Host 构造）。
     */
    private String statusPage() {
        String page = Plugin.readPluginAssetString(LegadoPlugin.ID, "index.html");
        return page != null ? page
                : "<!doctype html><meta charset=\"utf-8\"><p>index.html 资源缺失（打包异常）</p>";
    }

    // ============ HTTP 辅助 ============

    /** query 参数解析（node url.searchParams 等价：urlencoded 语义，'+' 解空格，同名取首个） */
    private static Map<String, String> queryParams(IHTTPSession session) {
        LinkedHashMap<String, String> out = new LinkedHashMap<>();
        String q = session.getQueryParameterString();
        if (q == null || q.isEmpty()) return out;
        for (String pair : q.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = eq < 0 ? pair : pair.substring(0, eq);
            String v = eq < 0 ? "" : pair.substring(eq + 1);
            try {
                String key = URLDecoder.decode(k, "UTF-8");
                if (!out.containsKey(key)) {
                    out.put(key, URLDecoder.decode(v, "UTF-8"));
                }
            } catch (Exception ignore) {
                // 畸形 % 序列：保留原值
                if (!out.containsKey(k)) out.put(k, v);
            }
        }
        return out;
    }

    private static Response json(Response.Status status, Object obj) {
        return newFixedLengthResponse(status, "application/json; charset=utf-8", GSON.toJson(obj));
    }

    private static Response html(String body) {
        return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", body);
    }

    /** 单键值对便捷构造（LinkedHashMap 保序） */
    private static LinkedHashMap<String, Object> kv(Object... pairs) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) m.put(String.valueOf(pairs[i]), pairs[i + 1]);
        return m;
    }

    /** ISO8601 时间戳（node new Date().toISOString() 等价，UTC） */
    private static String nowIso() {
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(new Date());
    }

    /** 实例停止（NanoHTTPD#stop 为实例方法，静态 shutdown 经此调用） */
    private void superStop() {
        super.stop();
    }
}
