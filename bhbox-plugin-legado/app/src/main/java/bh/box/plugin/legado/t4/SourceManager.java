package bh.box.plugin.legado.t4;

import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import bh.box.plugin.legado.engine.HttpFetcher;

/**
 * 书源加载/合并/去重/兼容性标记（阅读APP 3.0 书源格式）——逐函数对齐 app/server/src/sources.js。
 *
 * 输入经 start 参数注入（原 node 版为环境变量 LEGADO_PARAMS，Java 版直接传参）：
 *   { "remoteUrls": "http://a/1.json\nhttp://b/2.json", "localFile": "/path/shuyuan.txt" }
 * 加载顺序：本地文件 → 网络 URL 依次；同一 bookSourceUrl 首见胜出（本地优先，后到者不覆盖）。
 * 收录过滤：enabled !== false；音频源（bookSourceType 1）play 返回直链由宿主播放器播放；
 *          规则含 startBrowserAwait 等强 WebView 特征标记不兼容（不入订阅，/status 报告原因）。
 *
 * 对象形态：书源以 Map&lt;String,Object&gt; 承载（Gson LinkedTreeMap，键序保留，与 node
 * 普通对象一致），规则引擎各入口均按 Map 键值访问。
 */
public final class SourceManager {

    private static final String TAG = "legado-t4";

    private static final Gson GSON = new Gson();

    /** 强 WebView 交互特征：书源规则依赖内置浏览器（验证码/登录），无 WebView 环境不可用 */
    private static final String[] INCOMPATIBLE_MARKERS = {"startBrowserAwait", "startBrowser"};

    /** 规则/URL 字段（兼容性扫描范围，排除 comment 等说明文本） */
    private static final String[] RULE_KEYS = {
            "searchUrl", "exploreUrl", "loginUrl", "jsLib",
            "ruleSearch", "ruleExplore", "ruleBookInfo", "ruleToc", "ruleContent",
    };

    private SourceManager() {}

    /** 对齐 sources.js#md5：小写 hex */
    public static String md5(String s) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("MD5")
                    .digest(String.valueOf(s).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    /** 对齐 sources.js#siteKeyOf */
    public static String siteKeyOf(Map<String, Object> src) {
        return "legado_" + md5(strOrEmpty(mapGet(src, "bookSourceUrl")).trim());
    }

    /** start 参数（对齐 parseParams 产物 { remoteUrls: [], localFile: '' }） */
    public static final class Params {
        public final List<String> remoteUrls = new ArrayList<>();
        public String localFile = "";
    }

    /** 对齐 sources.js#parseParams：解析参数 JSON 字符串 → Params */
    public static Params parseParams(String raw) {
        Params p = new Params();
        Map<?, ?> obj = null;
        try {
            if (raw != null && !raw.trim().isEmpty()) {
                JsonElement el = JsonParser.parseString(raw);
                if (el.isJsonObject()) obj = GSON.fromJson(el, Map.class);
            }
        } catch (Exception ignore) {
            // node: JSON.parse 失败归 {}，继续空参数
        }
        if (obj == null) return p;
        String urls = strOrEmpty(obj.get("remoteUrls"));
        for (String s : urls.split("\n", -1)) {
            String t = s.trim();
            if (HTTP_URL.matcher(t).find()) p.remoteUrls.add(t);
        }
        p.localFile = strOrEmpty(obj.get("localFile")).trim();
        return p;
    }

    /** 对齐 /^https?:\/\//i */
    private static final Pattern HTTP_URL = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

    /**
     * 对齐 sources.js#toLocalPath：file:// URI（宿主文件选择器产物）转绝对路径，
     * 中文等非 ASCII 由 URI 自动解码；已是绝对路径原样返回。
     */
    public static String toLocalPath(String v) {
        String s = v == null ? "" : v.trim();
        if (!s.toLowerCase(Locale.ROOT).startsWith("file://")) return s;
        try {
            return new File(new URI(s)).getAbsolutePath();
        } catch (Exception e) {
            // 畸形 URI 兜底粗剥 file:// 前缀（node 同）
            return s.replaceFirst("(?i)^file://", "");
        }
    }

    /**
     * 对齐 sources.js#parseBookSources：解析一段书源 JSON 文本（数组 / 单对象）→ 数组；
     * 解析失败抛错（调用方记入 report.errors）。支持部分订阅包装 {data:[...]} 形态。
     */
    public static List<Map<String, Object>> parseBookSources(String text) throws Exception {
        JsonElement el = JsonParser.parseString(text);
        List<Map<String, Object>> out = new ArrayList<>();
        if (el.isJsonArray()) {
            for (JsonElement item : el.getAsJsonArray()) {
                if (item != null && item.isJsonObject()) {
                    out.add((Map<String, Object>) GSON.fromJson(item, Map.class));
                }
            }
            return out;
        }
        if (el.isJsonObject()) {
            Map<?, ?> data = GSON.fromJson(el, Map.class);
            Object inner = data.get("data");
            if (inner instanceof List) {
                for (Object item : (List<?>) inner) {
                    if (item instanceof Map) out.add((Map<String, Object>) item);
                }
                return out;
            }
            out.add((Map<String, Object>) data);
            return out;
        }
        throw new Exception("书源 JSON 需为数组或单对象");
    }

    /** 对齐 sources.js#isIncompatible：规则字段是否依赖 WebView，返回命中的 marker（无则 null） */
    public static String isIncompatible(Map<String, Object> src) {
        for (String key : RULE_KEYS) {
            Object v = src.get(key);
            if (v == null) continue;
            String text = (v instanceof String) ? (String) v : GSON.toJson(v);
            for (String marker : INCOMPATIBLE_MARKERS) {
                if (text.contains(marker)) return marker;
            }
        }
        return null;
    }

    /** 对齐 sources.js#loadSources 的返回形态：list 为已排序可用书源，report 为各环节概况 */
    public static final class LoadResult {
        public final List<Map<String, Object>> list = new ArrayList<>();
        public final List<Map<String, Object>> loaded = new ArrayList<>();
        public final List<Map<String, Object>> errors = new ArrayList<>();
        public final List<Map<String, Object>> skipped = new ArrayList<>();
        public final List<Map<String, Object>> incompatible = new ArrayList<>();

        /** report 对象（/status 与 /reload 响应体用，键序对齐 node） */
        public Map<String, Object> reportMap() {
            LinkedHashMap<String, Object> r = new LinkedHashMap<>();
            r.put("loaded", loaded);
            r.put("errors", errors);
            r.put("skipped", skipped);
            r.put("incompatible", incompatible);
            return r;
        }
    }

    /** 单条概况记录（{ from, count, fresh } / { from, error } / { name, reason }） */
    private static Map<String, Object> rec(Object... kv) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
        return m;
    }

    /**
     * 对齐 sources.js#loadSources：按参数加载全部书源（同步实现——node 版 async 下载，
     * Java 侧线程内顺序下载，任一失败不影响其余；下载超时 30s 为 HttpFetcher 缺省，
     * node 为 15s，仅影响坏源加载速度不影响语义）。
     */
    public static LoadResult loadSources(Params params) {
        // bookSourceUrl → source（首见胜出）
        LinkedHashMap<String, Map<String, Object>> merged = new LinkedHashMap<>();
        LoadResult report = new LoadResult();

        // mergeText(text, from)：解析合并，后到者不覆盖（本地优先于网络，先载者优先于后载）
        // node 以闭包实现，此处拉直为本地读取 + URL 循环两段共用逻辑
        if (params.localFile != null && !params.localFile.isEmpty()) {
            String path = toLocalPath(params.localFile);
            try {
                String text = readTextFile(path);
                mergeText(text, "local:" + path, merged, report);
            } catch (Exception e) {
                report.errors.add(rec("from", "local:" + path, "error", e.getMessage()));
            }
        }
        for (String url : params.remoteUrls) {
            try {
                HttpFetcher.HttpResult r = HttpFetcher.fetch(url, "GET", null, null, null);
                if (r.code < 200 || r.code >= 300) throw new Exception("HTTP " + r.code);
                mergeText(r.body, url, merged, report);
            } catch (Exception e) {
                report.errors.add(rec("from", url, "error", e.getMessage()));
            }
        }

        // 过滤 + 排序（customOrder 升序，缺省 0）
        for (Map<String, Object> src : merged.values()) {
            String name = strOrEmpty(mapGet(src, "bookSourceName"));
            if (name.isEmpty()) name = strOrEmpty(mapGet(src, "bookSourceUrl"));
            if (Boolean.FALSE.equals(src.get("enabled"))) {
                report.skipped.add(rec("name", name, "reason", "未启用"));
                continue;
            }
            String marker = isIncompatible(src);
            if (marker != null) {
                report.incompatible.add(rec("name", name, "reason", "依赖WebView:" + marker));
                continue;
            }
            report.list.add(src);
        }
        report.list.sort(new Comparator<Map<String, Object>>() {
            @Override
            public int compare(Map<String, Object> a, Map<String, Object> b) {
                return Double.compare(customOrder(a), customOrder(b));
            }
        });
        return report;
    }

    private static double customOrder(Map<String, Object> src) {
        Object v = src.get("customOrder");
        return v instanceof Number ? ((Number) v).doubleValue() : 0d;
    }

    /** 本地书源文本读取（node readFileSync(path,'utf-8) 等价） */
    private static String readTextFile(String path) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(path), StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = br.read(buf)) > 0) sb.append(buf, 0, n);
        }
        return sb.toString();
    }

    /** 对齐 loadSources 内 mergeText：解析一段文本并入 merged（首见胜出），概况写入 report */
    @SuppressWarnings("unchecked")
    private static void mergeText(String text, String from,
                                  LinkedHashMap<String, Map<String, Object>> merged,
                                  LoadResult report) {
        try {
            List<Map<String, Object>> arr = parseBookSources(text);
            int fresh = 0;
            for (Map<String, Object> src : arr) {
                String key = strOrEmpty(src.get("bookSourceUrl")).trim();
                if (key.isEmpty()) continue;
                if (merged.containsKey(key)) continue;
                merged.put(key, src);
                fresh++;
            }
            report.loaded.add(rec("from", from, "count", arr.size(), "fresh", fresh));
        } catch (Exception e) {
            report.errors.add(rec("from", from, "error", e.getMessage()));
        }
    }

    /**
     * 对齐 sources.js#buildSites：书源列表 → T4 站点数组（/config 用）。
     * api 按请求 Host 动态构造：端口漂移随宿主刷新订阅自愈；局域网设备亦可直接订阅。
     */
    public static List<Map<String, Object>> buildSites(List<Map<String, Object>> sources, String host) {
        List<Map<String, Object>> out = new ArrayList<>(sources.size());
        for (Map<String, Object> src : sources) {
            String url = strOrEmpty(mapGet(src, "bookSourceUrl")).trim();
            String hash = md5(url);
            LinkedHashMap<String, Object> site = new LinkedHashMap<>();
            site.put("key", "legado_" + hash);
            String name = strOrEmpty(mapGet(src, "bookSourceName"));
            site.put("name", withGroups(name.isEmpty() ? url : name, strOrEmpty(mapGet(src, "bookSourceGroup"))));
            site.put("type", 4);
            site.put("api", "http://" + host + "/api/" + hash);
            site.put("searchable", mapGet(src, "searchUrl") != null ? 1 : 0);
            site.put("quickSearch", 1);
            site.put("filterable", 0);
            out.add(site);
        }
        return out;
    }

    /** 站点名后缀分组标记：多分组各包一个 []（"A,B" → "[A][B]"），空分组跳过。 */
    private static String withGroups(String name, String group) {
        if (group.isEmpty()) return name;
        StringBuilder sb = new StringBuilder(name);
        for (String g : group.split("[,，\\n]")) {
            g = g.trim();
            if (!g.isEmpty()) sb.append('[').append(g).append(']');
        }
        return sb.toString();
    }

    static Object mapGet(Object obj, String key) {
        if (!(obj instanceof Map)) return null;
        return ((Map<?, ?>) obj).get(key);
    }

    static String strOrEmpty(Object v) {
        return v == null ? "" : String.valueOf(v);
    }
}
