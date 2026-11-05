package bh.box.plugin.lxmusic;

import android.content.Context;
import android.text.TextUtils;

import com.github.catvod.crawler.Spider;
import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.Json;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Util;
import com.google.gson.JsonObject;

import java.io.File;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.List;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 洛雪音源桥接类 —— T3 Spider → lx-server HTTP 转换。
 *
 * 引擎/脚本侧的 JSON 解析复用 catvod 的 Json 工具（与宿主一致）。
 */
public class LxSpider extends Spider {

    private final String api;
    /** 所属插件（用于传输失败时自愈 server） */
    private final LxMusicPlugin plugin;
    /** 本机 node 服务地址（server 启动后由插件注入） */
    private String baseUrl;

    /** 源路由名（= md5(源身份)，与 server 端路径推导一致） */
    private String routeName;
    /** 本地源脚本文件 */
    private File sourceFile;
    /** 站点级 ext（随每次请求作为 body.ext 传递） */
    private String extend;
    /** homeContent 缓存的 list JSON，供 homeVideoContent 使用 */
    private String cachedHomeList;

    public LxSpider(LxMusicPlugin plugin, String api) {
        this.plugin = plugin;
        this.api = api;
    }

    @Override
    public void init(Context context) {
        init(context, null);
    }

    @Override
    public void init(Context context, String extend) {
        this.extend = extend;
        resolveSourceFile();
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getRouteName() {
        return routeName;
    }

    public File getSourceFile() {
        return sourceFile;
    }

    // ==================== 源脚本解析与下载 ====================

    /**
     * lx 脚本按「源身份」隔离缓存：身份 = http/clan 源的完整 URL（clan 已转地址）或 file:// 的绝对路径，
     * 再叠加站点 ext。lx 脚本以单文件为主，直接落为 sourcesDir/&lt;md5&gt;.js（node 端按 route 定位并按 mtime 热加载）。
     */
    private void resolveSourceFile() {
        routeName = null;
        sourceFile = null;
        if (TextUtils.isEmpty(api)) return;

        String identity;
        File localSrc = null;
        if (api.startsWith("file://")) {
            localSrc = new File(api.replace("file://", ""));
            if (!localSrc.exists()) {
                LOG.e("LxMusic", "file:// 源不存在: " + api);
                return;
            }
            identity = localSrc.getAbsolutePath();
        } else if (api.startsWith("http") || api.startsWith("clan://")) {
            identity = api.startsWith("clan://") ? Util.clanToAddress(api) : api;
        } else {
            LOG.e("LxMusic", "不支持的 api 形式: " + api);
            return;
        }

        // 源身份叠加站点 ext：ext 不同 → 路由不同，隔离路由级 ext 状态
        String sourceIdentity = TextUtils.isEmpty(extend) ? identity : identity + "\n" + extend;
        String hash = Util.md5(sourceIdentity);
        sourceFile = new File(LxMusicPlugin.sourceCache, hash + ".js");

        if (!sourceFile.exists()) {
            try {
                if (localSrc != null) {
                    Io.copy(localSrc, sourceFile);
                } else {
                    try (Response response = OkHttp.newCall(identity).execute()) {
                        if (response.isSuccessful() && response.body() != null) {
                            Io.write(sourceFile, response.body().string());
                        } else {
                            LOG.e("LxMusic", "下载源失败 HTTP " + response.code() + ": " + identity);
                            sourceFile = null;
                            return;
                        }
                    }
                }
            } catch (Exception e) {
                LOG.e("LxMusic", "获取源失败: " + api);
                sourceFile = null;
                return;
            }
        }

        routeName = hash;
    }

    // ==================== Spider 接口方法（T3 → HTTP 转换） ====================

    @Override
    public String homeContent(boolean filter) {
        JsonObject body = new JsonObject();
        body.addProperty("filter", filter);
        addSiteExt(body);
        String response = httpPost("home", body.toString());
        if (TextUtils.isEmpty(response)) return "{}";

        try {
            JsonObject obj = Json.parse(response).getAsJsonObject();
            if (obj.has("list")) cachedHomeList = obj.get("list").toString();

            JsonObject result = new JsonObject();
            if (obj.has("class")) result.add("class", obj.get("class"));
            if (obj.has("filters")) result.add("filters", obj.get("filters"));
            // 宿主 AbsJson.toAbsXml 直接遍历 list，键缺失会 NPE；首页推荐位为空也必须给空数组
            result.add("list", obj.has("list") ? obj.get("list") : new com.google.gson.JsonArray());
            return result.toString();
        } catch (Exception e) {
            return response;
        }
    }

    @Override
    public String homeVideoContent() {
        if (cachedHomeList != null) {
            return "{\"list\":" + cachedHomeList + "}";
        }

        JsonObject body = new JsonObject();
        addSiteExt(body);
        String response = httpPost("home", body.toString());
        if (TextUtils.isEmpty(response)) return "{}";

        try {
            JsonObject obj = Json.parse(response).getAsJsonObject();
            if (obj.has("list")) {
                return "{\"list\":" + obj.get("list") + "}";
            }
        } catch (Exception ignored) {
        }
        return "{}";
    }

    @Override
    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) {
        JsonObject body = new JsonObject();
        body.addProperty("id", tid);
        try {
            body.addProperty("page", Integer.parseInt(pg));
        } catch (Exception e) {
            body.addProperty("page", 1);
        }
        if (extend != null && !extend.isEmpty()) {
            body.add("extend", Json.parse(Json.toJson(extend)).getAsJsonObject());
        }
        addSiteExt(body);
        return httpPost("category", body.toString());
    }

    @Override
    public String detailContent(List<String> ids) {
        JsonObject body = new JsonObject();
        body.addProperty("id", ids != null && !ids.isEmpty() ? ids.get(0) : "");
        addSiteExt(body);
        return httpPost("detail", body.toString());
    }

    @Override
    public String searchContent(String key, boolean quick) {
        return search(key, "1");
    }

    @Override
    public String searchContent(String key, boolean quick, String pg) {
        return search(key, pg);
    }

    @Override
    public String searchContentPage(String key, boolean quick, String pg) {
        return search(key, pg);
    }

    private String search(String key, String pg) {
        JsonObject body = new JsonObject();
        body.addProperty("wd", key);
        try {
            body.addProperty("page", Integer.parseInt(pg));
        } catch (Exception e) {
            body.addProperty("page", 1);
        }
        addSiteExt(body);
        return httpPost("search", body.toString());
    }

    @Override
    public String playerContent(String flag, String id, List<String> vipFlags) {
        JsonObject body = new JsonObject();
        body.addProperty("id", id);
        if (!TextUtils.isEmpty(flag)) body.addProperty("flag", flag);
        addSiteExt(body);
        // 缓存目录可能被系统/宿主清理：播放依赖源脚本，缺失时自愈重下（resolveSourceFile 内部幂等）
        if (sourceFile == null || !sourceFile.exists()) {
            LOG.i("LxMusic", "源脚本缺失，重新获取: " + api);
            resolveSourceFile();
        }
        // 引擎返回 {parse, url:[flag,playUrl], header, lrc, pic, isMusic...}，宿主 PlayContent 原生支持，原样透传
        return httpPost("play", body.toString());
    }

    @Override
    public boolean manualVideoCheck() {
        return false;
    }

    @Override
    public boolean isVideoFormat(String url) {
        return false;
    }

    /** 直链为外部绝对地址，无需宿主转发 */
    @Override
    public Object[] proxyLocal(java.util.Map<String, String> params) {
        return null;
    }

    @Override
    public void destroy() {
    }

    // ==================== HTTP 通信 ====================

    /** ext 为源站点配置串，随每次请求透传给 node 侧 */
    private void addSiteExt(JsonObject body) {
        if (!TextUtils.isEmpty(extend)) body.addProperty("ext", extend);
    }

    private String httpPost(String action, String jsonBody) {
        if (TextUtils.isEmpty(routeName)) return "";
        String response = doPost(action, jsonBody);
        if (TextUtils.isEmpty(response) && plugin != null) {
            // 传输失败（node 进程被系统杀死、长请求中途连接断开等瞬态故障）：
            // 探测/自愈 server 后重试一次（五动作均为只读操作，可安全重试）
            String base = plugin.ensureAlive();
            if (!TextUtils.isEmpty(base)) {
                baseUrl = base;
                response = doPost(action, jsonBody);
            }
        }
        return response;
    }

    private String doPost(String action, String jsonBody) {
        try {
            String url = baseUrl + "/lx/" + URLEncoder.encode(routeName, "UTF-8") + "/" + action;
            RequestBody requestBody = RequestBody.create(
                    jsonBody, MediaType.parse("application/json; charset=utf-8"));
            // Connection: close 禁用连接复用：node 端 keepAliveTimeout 短于 OkHttp 连接池保留时长，
            // 长闲置后复用池中已被 server 关闭的死连接会导致 POST 偶发空返回
            Request request = new Request.Builder().url(url)
                    .header("Connection", "close")
                    .post(requestBody).build();

            try (Response response = OkHttp.client().newCall(request).execute()) {
                if (response.body() == null) return "";
                // 动作失败时返回 500 + {error:...}，body 一并透传给宿主展示
                return response.body().string();
            }
        } catch (Exception e) {
            LOG.e("LxMusic", "HTTP 请求失败: " + action);
        }
        return "";
    }
}
