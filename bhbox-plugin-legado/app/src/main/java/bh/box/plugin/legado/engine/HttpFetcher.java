package bh.box.plugin.legado.engine;

import android.util.Log;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.ConnectionPool;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import okio.BufferedSink;

/**
 * HTTP 抓取封装（对齐 app/server/src/engine/http.js 的基础抓取层）。
 *
 * node 版 fetchText 的 URL 规则解析（options 尾巴 / option.js / GET query 编码 / POST 表单
 * 三分支）属 urlrule.js 与调用层职责，由后续批次移植；本类只承担
 * "最终 URL + method + headers + body + 响应 charset" 的原始同步抓取。
 * HttpServer 线程直接调用，不做异步。
 *
 * 默认行为对齐（http.js#fetchText）：
 * - timeout 30000（node AbortController 缺省）→ callTimeout 覆盖整次调用
 * - redirect: 'follow' → okhttp 默认跟随重定向，finalUrl 为重定向链终点
 * - NODE_TLS_REJECT_UNAUTHORIZED='0'（legado SSLHelper.unsafeTrustManager）→ 信任所有证书
 * - node fetch 无 cookie 管理 → okhttp 默认无 CookieJar，不加
 * - body 为字符串时 node fetch 恒按 utf-8 发送 → writeUtf8
 * - 非握手异常：网络失败抛 RuntimeException（对齐 node fetch 抛 TypeError 传播）；
 *   非 2xx 且响应体为空抛 RuntimeException（对齐 "HTTP xxx for url"）
 */
public final class HttpFetcher {

    private static final String TAG = "legado-engine";

    /** node fetchText 默认 timeout 30000（AbortController 缺省） */
    private static final long TIMEOUT_MS = 30000L;

    /** 对齐 http.js#charsetFromHeader：/charset=([\w-]+)/i */
    private static final Pattern CHARSET_IN_HEADER = Pattern.compile("charset=([\\w-]+)", Pattern.CASE_INSENSITIVE);

    /** 进程级单例（含连接池），全引擎共用 */
    private static volatile OkHttpClient client;

    private HttpFetcher() {}

    private static OkHttpClient client() {
        OkHttpClient c = client;
        if (c == null) {
            synchronized (HttpFetcher.class) {
                if (client == null) client = buildClient();
                c = client;
            }
        }
        return c;
    }

    /** 单例 client：连接池 + 信任所有证书（对齐 http.js 头部 NODE_TLS_REJECT_UNAUTHORIZED='0'） */
    private static OkHttpClient buildClient() {
        OkHttpClient.Builder b = new OkHttpClient.Builder()
                .callTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .connectTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .writeTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .connectionPool(new ConnectionPool(5, 5, TimeUnit.MINUTES))
                // 对齐 node fetch redirect: 'follow'
                .followRedirects(true)
                .followSslRedirects(true);
        try {
            final X509TrustManager tm = new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            };
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, new TrustManager[]{tm}, new SecureRandom());
            b.sslSocketFactory(sc.getSocketFactory(), tm);
            b.hostnameVerifier((hostname, session) -> true);
        } catch (Exception e) {
            // 信任所有初始化失败时退回系统默认校验（仅告警，不让引擎不可用）
            Log.w(TAG, "trust-all ssl init failed: " + e);
        }
        return b.build();
    }

    /**
     * 同步抓取（HttpServer 线程直接调用）。
     *
     * @param url     最终请求地址（规则解析/模板渲染由上层完成）
     * @param method  GET/POST/...，空缺省 GET（对齐 node method 缺省）
     * @param headers 请求头（可空；node 侧 options.headers 与 opts.headers 合并后传入）
     * @param body    请求体（可空；非空时按 utf-8 字符串发送，对齐 node fetch 字符串 body 语义）
     * @param charset 响应解码字符集（可空；空则按响应头 Content-Type 的 charset，再退 utf-8，
     *                对齐 http.js#fetchText 的三级回退）
     * @return HttpResult（含重定向后 finalUrl）
     * @throws RuntimeException 网络失败，或 非 2xx 且响应体为空（对齐 http.js#fetchText）
     */
    public static HttpResult fetch(String url, String method, Map<String, String> headers, String body, String charset) {
        String m = (method == null || method.trim().isEmpty()) ? "GET" : method.trim().toUpperCase(Locale.ROOT);
        Request.Builder rb = new Request.Builder().url(url);
        if (headers != null) {
            for (Map.Entry<String, String> e : headers.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                // okhttp 头名大小写不敏感覆盖，与 node Headers 合并语义一致
                rb.header(e.getKey(), e.getValue());
            }
        }
        if (body != null) {
            // node fetch 的字符串 body 恒按 utf-8 编码（表单/gbk 场景由上层先 formEncode 成 ASCII）
            rb.method(m, new RequestBody() {
                @Override
                public MediaType contentType() {
                    return null;
                }

                @Override
                public void writeTo(BufferedSink sink) throws IOException {
                    sink.writeUtf8(body);
                }
            });
        } else {
            rb.method(m, null);
        }

        try (Response r = client().newCall(rb.build()).execute()) {
            byte[] raw = r.body() != null ? r.body().bytes() : new byte[0];
            int code = r.code();
            // 对齐 http.js#fetchText：!res.ok 且响应体为空 → 抛 "HTTP xxx for url"（url 截 100 字符）
            if ((code < 200 || code >= 300) && raw.length == 0) {
                throw new RuntimeException("HTTP " + code + " for " + truncate(url, 100));
            }
            Map<String, String> hs = new LinkedHashMap<>();
            for (String name : r.headers().names()) {
                List<String> vals = r.headers().values(name);
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < vals.size(); i++) {
                    if (i > 0) sb.append(", ");
                    sb.append(vals.get(i));
                }
                // 键小写对齐 node Headers；同名多值逗号拼接对齐 Headers.get
                hs.put(name.toLowerCase(Locale.ROOT), sb.toString());
            }
            String cs = (charset != null && !charset.isEmpty()) ? charset : charsetFromHeader(r.header("Content-Type"));
            return new HttpResult(decodeBuffer(raw, cs), r.request().url().toString(), hs, code, raw);
        } catch (IOException e) {
            throw new RuntimeException("fetch failed: " + truncate(url, 100) + ": " + e.getMessage(), e);
        }
    }

    /** 对齐 http.js#charsetFromHeader：Content-Type 头提取 charset，无则 null */
    private static String charsetFromHeader(String contentType) {
        if (contentType == null || contentType.isEmpty()) return null;
        Matcher m = CHARSET_IN_HEADER.matcher(contentType);
        return m.find() ? m.group(1) : null;
    }

    /** 对齐 http.js#decodeBuffer：按字符集解码，未知/失败回退 utf-8 */
    private static String decodeBuffer(byte[] buf, String charset) {
        if (charset != null && !charset.isEmpty()) {
            try {
                return stripBom(new String(buf, Charset.forName(charset.toLowerCase(Locale.ROOT))));
            } catch (Exception e) {
                Log.w(TAG, "charset " + charset + " unsupported, fallback utf-8");
            }
        }
        return stripBom(new String(buf, StandardCharsets.UTF_8));
    }

    /** node TextDecoder 缺省 ignoreBOM=false：解码结果剥掉开头 BOM 字符 */
    private static String stripBom(String s) {
        return (!s.isEmpty() && s.charAt(0) == '\uFEFF') ? s.substring(1) : s;
    }

    private static String truncate(String s, int len) {
        if (s == null) return "";
        return s.length() > len ? s.substring(0, len) : s;
    }

    /** 抓取结果（字段语义见各注释） */
    public static final class HttpResult {
        /** 按 charset 解码后的响应文本 */
        public final String body;
        /** 重定向后的最终地址（对齐 node res.url） */
        public final String finalUrl;
        /** 响应头（键小写；同名多值 ", " 拼接，对齐 node Headers.get） */
        public final Map<String, String> headers;
        /** HTTP 状态码 */
        public final int code;
        /** 原始响应字节（解码前） */
        public final byte[] rawBytes;

        public HttpResult(String body, String finalUrl, Map<String, String> headers, int code, byte[] rawBytes) {
            this.body = body;
            this.finalUrl = finalUrl;
            this.headers = headers;
            this.code = code;
            this.rawBytes = rawBytes;
        }
    }
}
