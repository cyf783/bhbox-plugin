package bh.box.plugin.legado.engine;

import android.util.Log;

import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 书源 Cookie 罐（对齐 legado CookieManager / CookieStore 的简化实现）。
 *
 * <p>启用条件：书源 {@code enabledCookieJar == true}。调用方在请求头里打内部标记
 * {@code CookieJar: 1}，由 {@link HttpFetcher} 消费并剥除（不发往站点），对齐 legado
 * HttpHelper 拦截器的 cookieJarHeader 方案。这样 {@code java.ajax/java.post/java.connect}
 * 等所有经 JsExtensions 发出的请求都能自动带上罐内 cookie，OM_pass 过盾种下的
 * cookie 才能对后续搜索请求生效。
 *
 * <p>归并键取 Set-Cookie 的 {@code Domain} 属性（去掉前导点），无该属性时取请求
 * host；请求时收集 host 及其父域命中的全部 cookie。故 {@code Domain=.omofuns.com}
 * 的盾 cookie 对同域子域同样生效。
 *
 * <p>相对 legado 的简化：不按 path/secure 过滤、不逐条记录过期时间（仅处理
 * Max-Age&lt;=0 与已过期的 Expires 删除语义）；整桶持久化到 catvod Cache 而非 DB，
 * 会话级盾 cookie 也跨重启保留（legado 只落盘 persistent，重启需重新过盾）。
 */
public final class CookieJar {

    private static final String TAG = "legado-engine";
    private static final String CACHE_PREFIX = "legado_cookiejar|";

    /** domain（小写，无前导点） → (name → value) */
    private static final Map<String, Map<String, String>> JAR =
            new LinkedHashMap<String, Map<String, String>>();

    /** Set-Cookie 的 Expires 常见日期格式（RFC 1123 / RFC 1036 / asctime 变体） */
    private static final String[] EXPIRES_PATTERNS = {
            "EEE, dd MMM yyyy HH:mm:ss zzz",
            "EEE, dd-MMM-yy HH:mm:ss zzz",
            "EEE MMM dd HH:mm:ss yyyy"
    };

    private CookieJar() {}

    /**
     * 组装请求 Cookie 头：域罐内 cookie 在前，显式 Cookie 头在后（同名覆盖，对齐
     * legado mergeCookies 的"options 临时 cookie 优先"）。两者皆空返回空串。
     */
    public static String header(String url, String existing) {
        String host = hostOf(url);
        if (host.isEmpty()) return existing == null ? "" : existing;
        Map<String, String> merged = new LinkedHashMap<>();
        synchronized (JAR) {
            for (String d : domainsFor(host)) {
                Map<String, String> bucket = bucket(d);
                if (bucket != null) merged.putAll(bucket);
            }
        }
        if (existing != null && !existing.trim().isEmpty()) {
            for (String part : existing.split(";")) {
                int eq = part.indexOf('=');
                if (eq <= 0) continue;
                merged.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
            }
        }
        if (merged.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : merged.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    /**
     * 保存响应 Set-Cookie（支持 Max-Age&lt;=0 / 过期 Expires / 空值的删除语义），
     * 并按域落盘到 Cache。{@code setCookieValues} 为该响应的全部 Set-Cookie 头值。
     */
    public static void save(String url, List<String> setCookieValues) {
        String host = hostOf(url);
        if (host.isEmpty() || setCookieValues == null || setCookieValues.isEmpty()) return;
        for (String sc : setCookieValues) {
            if (sc == null || sc.isEmpty()) continue;
            String[] parts = sc.split(";");
            String first = parts[0].trim();
            int eq = first.indexOf('=');
            if (eq <= 0) continue;
            String name = first.substring(0, eq).trim();
            if (name.startsWith("$")) continue; // RFC 6265 属性前缀，不是 cookie
            String value = first.substring(eq + 1).trim();
            String domain = host;
            boolean remove = value.isEmpty();
            for (int i = 1; i < parts.length; i++) {
                String attr = parts[i].trim();
                int e2 = attr.indexOf('=');
                String an = (e2 >= 0 ? attr.substring(0, e2) : attr).trim().toLowerCase(Locale.ROOT);
                String av = e2 >= 0 ? attr.substring(e2 + 1).trim() : "";
                if ("domain".equals(an) && !av.isEmpty()) {
                    domain = (av.startsWith(".") ? av.substring(1) : av).toLowerCase(Locale.ROOT);
                } else if ("max-age".equals(an)) {
                    try {
                        if (Long.parseLong(av) <= 0) remove = true;
                    } catch (NumberFormatException ignored) {
                    }
                } else if ("expires".equals(an) && isExpired(av)) {
                    remove = true;
                }
            }
            synchronized (JAR) {
                Map<String, String> bucket = bucket(domain);
                if (bucket == null) {
                    bucket = new LinkedHashMap<String, String>();
                    JAR.put(domain, bucket);
                }
                if (remove) bucket.remove(name);
                else bucket.put(name, value);
                persist(domain, bucket);
            }
        }
    }

    /** 调试快照：当前内存罐内容（domain → cookie 串），真机 logcat 验证链路用 */
    public static String debugDump() {
        synchronized (JAR) {
            if (JAR.isEmpty()) return "(empty)";
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, Map<String, String>> e : JAR.entrySet()) {
                if (sb.length() > 0) sb.append(" | ");
                sb.append(e.getKey()).append(':').append(e.getValue());
            }
            return sb.toString();
        }
    }

    // ==================== 内部 ====================

    private static boolean isExpired(String v) {
        if (v == null || v.isEmpty()) return false;
        for (String p : EXPIRES_PATTERNS) {
            try {
                Date d = new SimpleDateFormat(p, Locale.US).parse(v);
                if (d != null) return d.before(new Date());
            } catch (Exception ignored) {
            }
        }
        return false;
    }

    private static String hostOf(String url) {
        try {
            String h = new URL(url).getHost();
            return h == null ? "" : h.toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return "";
        }
    }

    /** host 及其父域（至少保留两级标签），如 www.omofuns.com → [www.omofuns.com, omofuns.com] */
    private static List<String> domainsFor(String host) {
        List<String> out = new ArrayList<>();
        String h = host;
        while (h != null && !h.isEmpty()) {
            out.add(h);
            int i = h.indexOf('.');
            if (i < 0) break;
            String parent = h.substring(i + 1);
            // 至少两级标签才算可归并的域，避免把顶级域 "com" 当 cookie 域造成跨站污染
            if (parent.indexOf('.') < 0) break;
            h = parent;
        }
        return out;
    }

    /** 取域桶，未在内存时从 Cache 恢复（跨重启） */
    private static Map<String, String> bucket(String domain) {
        Map<String, String> b = JAR.get(domain);
        if (b != null) return b;
        String saved = cacheLoad(domain);
        if (saved == null || saved.isEmpty()) return null;
        b = new LinkedHashMap<>();
        for (String part : saved.split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            b.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
        }
        if (b.isEmpty()) return null;
        JAR.put(domain, b);
        return b;
    }

    private static void persist(String domain, Map<String, String> bucket) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : bucket.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        try {
            com.github.catvod.utils.Cache.put(CACHE_PREFIX + domain, sb.toString());
        } catch (Throwable t) {
            Log.w(TAG, "cookie jar persist failed: " + t.getMessage());
        }
    }

    private static String cacheLoad(String domain) {
        try {
            return com.github.catvod.utils.Cache.getString(CACHE_PREFIX + domain, null);
        } catch (Throwable t) {
            return null;
        }
    }
}
