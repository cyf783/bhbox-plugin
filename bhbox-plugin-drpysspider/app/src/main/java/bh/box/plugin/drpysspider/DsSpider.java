package bh.box.plugin.drpysspider;

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
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * drpyS 桥接类 —— T3 Spider → ds-server HTTP 转换。
 *
 * 每个 drpyS 源（var rule = {...} 中文规则）对应一个 DsSpider 实例。
 * Spider 接口的每个方法 POST JSON 到本机 node 服务（/ds/&lt;md5&gt;/&lt;method&gt;），
 * 响应 JSON 直接透传给宿主（play 返回的 [flag,url] 数组与 lrc/pic 宿主原生支持，零适配）。
 */
public class DsSpider extends Spider {

    /**
     * 相对路径依赖扫描：匹配 import '...' / import('...') / from '...' / require('...') 中
     * ./ ../ 开头的引用；负向后行排除 Buffer.from、Array.from 等成员调用。
     */
    private static final Pattern RELATIVE_DEP = Pattern.compile(
            "(?<![.\\w])(?:import|from|require)\\s*(?:\\(\\s*)?['\"](\\.{1,2}/[^'\"\\n]+)['\"]");

    private final String api;
    /** 所属插件（用于传输失败时自愈 server） */
    private final DrpysSpiderPlugin plugin;
    /** 本机 node 服务地址（server 启动后由插件注入） */
    private String baseUrl;

    /** 源路由名（= 源目录名 = md5(源身份)，与 server 端路径推导一致） */
    private String routeName;
    /** 本地源文件 */
    private File sourceFile;
    /** 本源独占的隔离目录（ds/<md5(源身份)>/），主文件与相对依赖均落于此 */
    private File sourceDir;
    /** 站点级 ext（随每次请求作为 body.ext 传递，引擎注入为规则全局 EXT） */
    private String extend;
    /** homeContent 缓存的 list JSON，供 homeVideoContent 使用 */
    private String cachedHomeList;

    public DsSpider(DrpysSpiderPlugin plugin, String baseUrl, String api) {
        this.plugin = plugin;
        this.baseUrl = baseUrl;
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

    // ==================== 源文件解析与下载 ====================

    /**
     * 源文件按「源身份」隔离缓存：身份 = http/clan 源的完整 URL（clan 已转地址）或 file:// 的绝对路径，
     * 再叠加站点 ext。模板/配置类源（同一 js 通过不同 ext 配置出多个站源）ext 不同必须落为不同目录/路由，
     * 否则后加载站点的 ext 覆盖先加载的，站源间串读配置。
     * 每源独占目录 ds/&lt;md5(身份)&gt;/，主文件固定 &lt;md5&gt;.js（server 端按路由定位），
     * 相对依赖落同目录下原相对路径。
     */
    private void resolveSourceFile() {
        routeName = null;
        sourceFile = null;
        sourceDir = null;
        if (TextUtils.isEmpty(api)) return;

        String identity;
        File localSrc = null;
        if (api.startsWith("file://")) {
            localSrc = new File(api.replace("file://", ""));
            if (!localSrc.exists()) {
                LOG.e("DsSpider", "file:// 源不存在: " + api);
                return;
            }
            identity = localSrc.getAbsolutePath();
        } else if (api.startsWith("http") || api.startsWith("clan://")) {
            identity = api.startsWith("clan://") ? Util.clanToAddress(api) : api;
        } else {
            LOG.e("DsSpider", "不支持的 api 形式: " + api);
            return;
        }

        // 源身份叠加站点 ext：ext 不同 → 目录/路由均不同，隔离路由级 ext 状态
        String sourceIdentity = TextUtils.isEmpty(extend) ? identity : identity + "\n" + extend;
        String hash = Util.md5(sourceIdentity);
        sourceDir = new File(DrpysSpiderPlugin.sourceCache, hash);
        sourceDir.mkdirs();
        sourceFile = new File(sourceDir, hash + ".js");

        if (!sourceFile.exists()) {
            try {
                if (localSrc != null) {
                    Io.copy(localSrc, sourceFile);
                    fetchRelativeDeps(Io.read(sourceFile), null, localSrc.getParentFile());
                } else {
                    try (Response response = OkHttp.newCall(identity).execute()) {
                        if (response.isSuccessful() && response.body() != null) {
                            String code = response.body().string();
                            Io.write(sourceFile, code);
                            fetchRelativeDeps(code, identity, null);
                        } else {
                            LOG.e("DsSpider", "下载源失败 HTTP " + response.code() + ": " + identity);
                            sourceFile = null;
                            sourceDir = null;
                            return;
                        }
                    }
                }
            } catch (Exception e) {
                LOG.e("DsSpider", "获取源失败: " + api);
                sourceFile = null;
                sourceDir = null;
                return;
            }
        }

        routeName = hash;
    }

    // ==================== 相对路径依赖拉取 ====================

    /**
     * 递归拉取源文件的相对路径依赖（支持多层）：扫描主文件及每个依赖中的 import/from/require
     * 相对引用，http 源按主文件 URL 逐层下载，file:// 源按原目录逐层拷贝，
     * 统一落盘到源目录的相同相对路径下（含子目录）。
     * 仅在主文件新落盘时调用，依赖随主文件整体刷新，天然幂等；单个依赖失败只记日志不中断。
     */
    private void fetchRelativeDeps(String code, String httpUrl, File localDir) {
        try {
            Deque<String> queue = new ArrayDeque<>();
            Set<String> seen = new HashSet<>();
            scanDeps("", code, queue, seen);
            // seen 防环已保证终止，上限 100 仅防御病态源码
            for (int guard = 0; !queue.isEmpty() && guard < 100; guard++) {
                String rel = queue.poll();
                String body;
                if (httpUrl != null) {
                    body = downloadDep(depUrl(httpUrl, rel));
                    if (body == null) continue;
                    writeDep(rel, body);
                } else {
                    File src = new File(localDir, rel);
                    if (!src.isFile()) {
                        LOG.e("DsSpider", "依赖不存在: " + rel);
                        continue;
                    }
                    writeDep(rel, null);
                    Io.copy(src, new File(sourceDir, rel));
                    body = Io.read(src);
                }
                scanDeps(rel, body, queue, seen);
            }
        } catch (Throwable e) {
            LOG.e("DsSpider", "依赖拉取失败: " + api);
        }
    }

    /** 落盘依赖到本源隔离目录的相对路径（body 为 null 时仅建目录，供后续 Io.copy；Io.write 不建父目录） */
    private void writeDep(String rel, String body) {
        File target = new File(sourceDir, rel);
        File parent = target.getParentFile();
        if (parent != null) parent.mkdirs();
        if (body != null) Io.write(target, body);
    }

    /** 扫描 code 中的相对导入，归一化为相对源目录根的路径后入队（relFile 为当前文件相对根路径） */
    private void scanDeps(String relFile, String code, Deque<String> queue, Set<String> seen) {
        String dir = relFile.contains("/") ? relFile.substring(0, relFile.lastIndexOf('/') + 1) : "";
        Matcher m = RELATIVE_DEP.matcher(code);
        while (m.find()) {
            String target = normalizeRel(dir, m.group(1));
            if (target == null || target.isEmpty()) {
                LOG.e("DsSpider", "依赖路径越界，忽略: " + m.group(1) + " (in " + relFile + ")");
            } else if (seen.add(target)) {
                queue.add(target);
            }
        }
    }

    /** spec 相对 dir 归一化为 '/' 分隔的相对路径；.. 越出源目录根（逃逸）返回 null */
    private String normalizeRel(String dir, String spec) {
        Deque<String> stack = new ArrayDeque<>();
        for (String seg : (dir + spec).split("/+")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) {
                if (stack.isEmpty()) return null;
                stack.pollLast();
            } else {
                stack.addLast(seg);
            }
        }
        // String.join 为 API 26+，Android 6（API 23）无此方法
        return TextUtils.join("/", stack);
    }

    /** 主文件 URL 同目录拼接依赖相对路径（剥离 query 防止拼出非法 URL） */
    private String depUrl(String mainUrl, String rel) {
        String base = mainUrl;
        int q = base.indexOf('?');
        if (q >= 0) base = base.substring(0, q);
        return base.substring(0, base.lastIndexOf('/') + 1) + rel;
    }

    private String downloadDep(String url) {
        try (Response response = OkHttp.newCall(url).execute()) {
            if (response.isSuccessful() && response.body() != null) return response.body().string();
            LOG.e("DsSpider", "下载依赖失败 HTTP " + response.code() + ": " + url);
        } catch (Exception e) {
            LOG.e("DsSpider", "下载依赖失败: " + url);
        }
        return null;
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
        if (vipFlags != null && !vipFlags.isEmpty()) {
            com.google.gson.JsonArray flags = new com.google.gson.JsonArray();
            for (String f : vipFlags) flags.add(f);
            body.add("flags", flags);
        }
        addSiteExt(body);
        // 引擎返回 {parse, url:[flag,playUrl], header, lrc, pic/cover...}，宿主 PlayContent 原生支持，原样透传
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

    /** 播放代理由源返回的 127.0.0.1 绝对地址直连，无需宿主转发 */
    @Override
    public Object[] proxyLocal(java.util.Map<String, String> params) {
        return null;
    }

    @Override
    public void destroy() {
    }

    // ==================== HTTP 通信 ====================

    /** ext 为源站点配置串（通常是 JSON），引擎侧 env.ext 原样注入规则全局 EXT */
    private void addSiteExt(JsonObject body) {
        if (!TextUtils.isEmpty(extend)) body.addProperty("ext", extend);
    }

    private String httpPost(String action, String jsonBody) {
        if (TextUtils.isEmpty(routeName)) return "";
        String response = doPost(action, jsonBody);
        if (TextUtils.isEmpty(response) && plugin != null) {
            // 传输失败（node 进程被系统杀死、长请求中途连接断开等瞬态故障）：
            // 探测/自愈 server 后重试一次（home/category/detail/search 均为只读操作，可安全重试）
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
            String url = baseUrl + "/ds/" + URLEncoder.encode(routeName, "UTF-8") + "/" + action;
            RequestBody requestBody = RequestBody.create(
                    jsonBody, MediaType.parse("application/json; charset=utf-8"));
            // Connection: close 禁用连接复用：node 端 keepAliveTimeout 短于 OkHttp 连接池保留时长，
            // 长闲置后复用池中已被 server 关闭的死连接会导致 POST 偶发空返回
            Request request = new Request.Builder().url(url)
                    .header("Connection", "close")
                    .post(requestBody).build();

            try (Response response = OkHttp.client().newCall(request).execute()) {
                if (response.body() == null) return "";
                // 源在业务失败时返回 500 + {error:...}，body 一并透传给宿主展示
                return response.body().string();
            }
        } catch (Exception e) {
            LOG.e("DsSpider", "HTTP 请求失败: " + action);
        }
        return "";
    }
}
