package bh.box.plugin.phpspider;

import android.content.Context;
import android.text.TextUtils;

import com.github.catvod.crawler.Spider;
import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.Json;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Util;
import com.google.gson.JsonObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * PHP Spider 桥接类 —— T3 → T4 协议转换。
 *
 * 每个 .php 脚本对应一个 PhpSpider 实例。
 * Spider 接口的每个方法通过 HTTP 请求转发给 PHP 内置 Web Server，
 * 使用 T4 标准采集站协议参数，现有 PHP 脚本无需修改。
 */
public class PhpSpider extends Spider {

    private final Context context;
    private final String baseUrl;
    private final String api;
    private final String scriptName;
    private String localScriptPath;
    private String extend;

    /** homeContent 缓存的 list JSON，供 homeVideoContent 使用 */
    private String cachedHomeList;

    public PhpSpider(Context context, String baseUrl, String api) {
        this.context = context;
        this.baseUrl = baseUrl;
        this.api = api;
        this.scriptName = extractScriptName(api);
    }

    @Override
    public void init(Context context) {
        init(context, null);
    }

    @Override
    public void init(Context context, String extend) {
        this.extend = extend;
        downloadScript();
    }

    // ==================== Spider 接口方法（T3 → T4 转换） ====================

    @Override
    public String homeContent(boolean filter) {
        String url = buildUrl("filter=" + filter);
        String response = httpGet(url);
        if (TextUtils.isEmpty(response)) return "{}";

        try {
            JsonObject obj = Json.parse(response).getAsJsonObject();

            if (obj.has("list")) {
                cachedHomeList = obj.get("list").toString();
            }

            JsonObject result = new JsonObject();
            if (obj.has("class")) result.add("class", obj.get("class"));
            if (obj.has("filters")) result.add("filters", obj.get("filters"));
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

        String url = buildUrl("");
        String response = httpGet(url);
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
        StringBuilder params = new StringBuilder();
        params.append("ac=detail");
        params.append("&t=").append(enc(tid));
        params.append("&pg=").append(enc(pg));
        if (extend != null && !extend.isEmpty()) {
            params.append("&ext=").append(enc(Util.base64(Json.toJson(extend))));
        } else if (!TextUtils.isEmpty(this.extend)) {
            params.append("&ext=").append(enc(Util.base64(this.extend)));
        }
        return httpGet(buildUrl(params.toString()));
    }

    @Override
    public String detailContent(List<String> ids) {
        String idsStr = TextUtils.join(",", ids);
        return httpGet(buildUrl("ac=detail&ids=" + enc(idsStr)));
    }

    @Override
    public String searchContent(String key, boolean quick) {
        return httpGet(buildUrl("wd=" + enc(key)));
    }

    @Override
    public String searchContent(String key, boolean quick, String pg) {
        return httpGet(buildUrl("wd=" + enc(key) + "&pg=" + enc(pg)));
    }

    @Override
    public String searchContentPage(String key, boolean quick, String pg) {
        return httpGet(buildUrl("wd=" + enc(key) + "&pg=" + enc(pg)));
    }

    @Override
    public String playerContent(String flag, String id, List<String> vipFlags) {
        return httpGet(buildUrl("ac=play&play=" + enc(id) + "&flag=" + enc(flag)));
    }

    @Override
    public String liveContent(String url) {
        return httpGet(buildUrl("ac=play&play=" + enc(url)));
    }

    @Override
    public Object[] proxyLocal(Map<String, String> params) {
        try {
            String url = baseUrl + "/" + localScriptPath + "?ac=proxy";
            if (!TextUtils.isEmpty(extend)) {
                url += "&ext=" + enc(Util.base64(extend));
            }

            String json = Json.toJson(params);
            RequestBody body = RequestBody.create(
                    json, MediaType.parse("application/json; charset=utf-8"));
            Request request = new Request.Builder().url(url).post(body).build();

            try (Response response = OkHttp.client().newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) return null;
                String result = response.body().string();
                if (TextUtils.isEmpty(result)) return null;

                JsonObject obj = Json.parse(result).getAsJsonObject();

                Object[] ret = new Object[4];
                ret[0] = obj.has("code") ? obj.get("code").getAsInt() : 200;
                ret[1] = obj.has("mime") ? obj.get("mime").getAsString() : "application/octet-stream";

                boolean isBase64 = obj.has("base64") && obj.get("base64").getAsInt() == 1;
                String bodyStr = obj.has("body") ? obj.get("body").getAsString() : "";
                if (isBase64 && bodyStr.contains("base64,")) {
                    bodyStr = bodyStr.split("base64,")[1];
                }
                ret[2] = new ByteArrayInputStream(
                        isBase64 ? Util.decode(bodyStr) : bodyStr.getBytes("UTF-8"));

                if (obj.has("headers") && !obj.get("headers").isJsonNull()) {
                    ret[3] = Json.toMap(obj.getAsJsonObject("headers"));
                }

                return ret;
            }
        } catch (Exception e) {
            LOG.e("PHP", "proxyLocal 失败");
            return null;
        }
    }

    @Override
    public boolean manualVideoCheck() {
        return false;
    }

    @Override
    public boolean isVideoFormat(String url) {
        return false;
    }

    @Override
    public String action(String action) {
        return httpGet(buildUrl("ac=action&action=" + enc(action)));
    }

    @Override
    public String action(String action, String value) {
        return httpGet(buildUrl("ac=action&action=" + enc(action) + "&value=" + enc(value)));
    }

    @Override
    public void destroy() {
    }

    // ==================== 脚本下载 ====================

    private void downloadScript() {
        if (TextUtils.isEmpty(api)) return;

        File cacheDir = Path.php();

        File localFile = new File(cacheDir, scriptName);
        this.localScriptPath = scriptName;

        if (localFile.exists()) return;

        try {
            String url = api;
            if (url.startsWith("clan://")) {
                url = Util.clanToAddress(url);
            }

            if (url.startsWith("http")) {
                try (Response response = OkHttp.newCall(url).execute()) {
                    if (response.isSuccessful() && response.body() != null) {
                        Io.write(localFile, response.body().string());
                    }
                }
            } else if (url.startsWith("file://")) {
                File srcFile = new File(url.replace("file://", ""));
                if (srcFile.exists()) {
                    Io.copy(srcFile, localFile);
                }
            } else if (url.startsWith("php_")) {
                String name = url.substring(4) + ".php";
                File local = new File(cacheDir, name);
                if (local.exists()) {
                    this.localScriptPath = name;
                } else {
                    this.localScriptPath = null;
                    LOG.e("PHP", "本地脚本不存在: " + name);
                }
            }
        } catch (Exception e) {
            LOG.e("PHP", "下载脚本失败: " + api);
        }
    }

    // ==================== HTTP 通信 ====================

    private String buildUrl(String params) {
        StringBuilder url = new StringBuilder(baseUrl);
        url.append("/").append(localScriptPath);
        if (!TextUtils.isEmpty(params)) {
            url.append("?").append(params);
        } else {
            url.append("?");
        }
        if (!TextUtils.isEmpty(extend)) {
            url.append("&ext=").append(enc(Util.base64(extend)));
        }
        return url.toString();
    }

    private String httpGet(String url) {
        if (localScriptPath == null) return "";
        try {
            try (Response response = OkHttp.newCall(url).execute()) {
                if (response.isSuccessful() && response.body() != null) {
                    return response.body().string();
                }
            }
        } catch (Exception e) {
            LOG.e("PHP", "HTTP 请求失败: " + url);
        }
        return "";
    }

    // ==================== 工具方法 ====================

    private String extractScriptName(String api) {
        if (TextUtils.isEmpty(api)) return "index.php";
        if (api.startsWith("php_")) {
            return api.substring(4) + ".php";
        }
        String name = api.substring(api.lastIndexOf('/') + 1);
        int queryIdx = name.indexOf('?');
        if (queryIdx > 0) name = name.substring(0, queryIdx);
        return TextUtils.isEmpty(name) || !name.endsWith(".php") ? "index.php" : name;
    }

    private String enc(String value) {
        try {
            return URLEncoder.encode(value != null ? value : "", "UTF-8");
        } catch (Exception e) {
            return value != null ? value : "";
        }
    }
}
