package bh.box.plugin.legado.engine;

import android.util.Base64;
import android.util.Log;

import com.google.gson.Gson;

import org.mozilla.javascript.NativeArray;
import org.mozilla.javascript.NativeObject;
import org.mozilla.javascript.Wrapper;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.SimpleTimeZone;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 书源 JS 的 java.* 全局桥对象（逐函数对齐 app/server/src/engine/java-api.js#createJavaApi
 * 挂在 java 对象上的属性全集）。Rhino 原生支持把本类实例放入 scope 后 JS 直调其公共方法
 * （NativeJavaObject 自动包装），方法名与 node 版 java 对象属性名一致。
 *
 * 与 node 版的关键差异：
 * - ajax 同步抓取：进程内 OkHttp 连接池（HttpFetcher）直抓，替代 node execFileSync 子进程 spawn；
 * - node 侧 DES-ECB 经 3DES EDE 密钥重合的兼容层不需要：JCE 原生支持单 DES；
 * - node desDecodeToString 对 OpenSSL autoPadding 结果再走 pkcs5Unpad 属双重去填充
 *   （尾数据恰似 padding 会被误剥），Java 标准 PKCS5Padding 一次去净，不复制该缺陷。
 *
 * 上下文注入合同（T4 层接口，替代 node 从全局拿 source/book/result 的方式）：
 * - 构造参数 ctx/bindings 即 JsEngine.eval 的注入 Map（同一引用共享），约定键名：
 *   source（Map 书源对象）、book（Map 书籍对象）、baseUrl（String 当前请求地址）、
 *   result（Object 当前内容）、root（Object 本次规则求值的根 repr，缺省回退 result）、
 *   key/searchKey/page/chapter/title/data 等其余 runJs 上下文名；变量池建议以
 *   ctx["vars"] 传入共享 Map 实现跨求值持久（node c.vars 语义）。
 * - {@link #setContext(Map)} 可在规则执行链中切换「当前请求视角」（对齐 node c.getApi()
 *   动态取上下文的复用语义）。
 */
public class JsExtensions {

    private static final String TAG = "legado-engine";

    /** 对齐任务约定：java.log 输出独立 tag（区别于引擎告警的 legado-engine） */
    private static final String LOG_TAG_JS = "LegadoJs";

    /** 对齐 java-api.js#parseSourceHeaders 的缺省 UA */
    private static final String DEFAULT_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

    /** 对齐 parseSourceHeaders 的 UA 宽松提取：/["']?UA["']?\s*[:=]\s*["']([^"']+)["']/ */
    private static final Pattern UA_IN_HEADER =
            Pattern.compile("['\"]?UA['\"]?\\s*[:=]\\s*['\"]([^'\"]+)['\"]");

    /** 对齐 legado AppPattern.titleNumPattern：(第)(.+?)(章) 首个匹配 */
    private static final Pattern TITLE_NUM = Pattern.compile("第(.+?)章");

    private static final Gson GSON = new Gson();

    /**
     * 执行上下文 bindings（与调用方共享同一 Map，即 JsEngine.eval 的注入作用域）：
     * source/book/baseUrl/result/root/key/page 等上下文名 + 变量池展平值。
     */
    private Map<String, Object> bindings;

    /** 变量池（node c.vars）：java.put/get 的存储；T4 经 ctx["vars"] 传共享 Map 实现跨求值持久 */
    private Map<String, Object> vars;

    /** 无上下文构造（baseUrl/source 等为空，仅适合纯工具型求值） */
    public JsExtensions() {
        reset(null);
    }

    /**
     * 常规构造：ctx 即 JsEngine.eval 的 bindings（同引用共享），键名约定见类注释；
     * 构造时自动把自身注入 ctx["java"]，使 {{java.xxx}} 模板/JS 内可递归求值。
     */
    public JsExtensions(Map<String, Object> ctx) {
        reset(ctx);
    }

    /** 切换执行上下文（规则执行链中复用本实例时对齐 node c.getApi() 的动态视角切换） */
    public void setContext(Map<String, Object> ctx) {
        reset(ctx);
    }

    private void reset(Map<String, Object> ctx) {
        this.bindings = ctx != null ? ctx : new LinkedHashMap<String, Object>();
        this.bindings.put("java", this);
        Object v = this.bindings.get("vars");
        @SuppressWarnings("unchecked")
        Map<String, Object> vm = v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<String, Object>();
        this.vars = vm;
    }

    // ==================== 网络请求 ====================

    /**
     * 对齐 legado JsExtensionsCommon#ajax：入参为 List 时取首元素为地址；URL 规则的 ",{...}"
     * options 尾巴承担 method/charset/headers/body/retry 全集；失败返回异常堆栈字符串
     * （对齐 legado getOrElse { it.stackTraceStr }，原 node 行为: 返回 ''）。
     */
    public String ajax(Object url) {
        Object u = unwrap(url);
        if (u instanceof List) {
            List<?> l = (List<?>) u;
            u = l.isEmpty() ? null : l.get(0);
        }
        String rendered = TemplateRenderer.render(String.valueOf(u), bindings);
        try {
            // URL 尾部 ,{...} options（JS 源拼的 headers/method/body）需拆出合并——如七猫
            // `java.ajax(url+','+java.get("headers"))` 的 App 签名头全在 options 里
            UrlRule.Parsed p = UrlRule.parseUrlRule(rendered);
            Map<String, String> merged = new LinkedHashMap<>(defaultHeaders());
            if (p.options.headers != null) merged.putAll(p.options.headers);
            String method = p.options.method != null ? p.options.method : "GET";
            // POST 走 legado configureRequest 同款三分支（form 编码/CT 补全），与 fetchText 一致
            String postBody = "POST".equals(method)
                    ? UrlRule.applyPostBody("POST", p.options.body != null ? p.options.body : "", merged, p.options.charset)
                    : null;
            // legado encodeUrlParams isQuery=true：GET query 按 charset 编码（gbk 搜索关键字）
            String finalUrl = "POST".equals(method) ? p.url : UrlRule.encodeUrlQuery(p.url, p.options.charset);
            // 对齐 legado getOkHttpStrResponse：newCallStrResponse(option?.retry ?: 0)，失败重试
            HttpFetcher.HttpResult r = fetchWithRetry(finalUrl, method, merged, postBody,
                    p.options.charset, retryOf(p.options.retry));
            return r.body;
        } catch (Exception e) {
            Log.w(TAG, "java.ajax failed [" + truncate(rendered, 80) + "]: " + e.getMessage());
            // 对齐 legado JsExtensionsCommon#ajax：失败返回 stackTraceStr 而非空串（原 node 行为: 返回 ''）
            return Log.getStackTraceString(e);
        }
    }

    /**
     * 对齐 java-api.js#post：同步 POST，返回 StrResponse 形态（body()/header()/code()，
     * toString 为 body——legado StrResponse 本质是 String，拼接/match 自动拆箱）。
     */
    public StrResponse post(Object url) {
        return post(url, null, null);
    }

    public StrResponse post(Object url, Object body) {
        return post(url, body, null);
    }

    public StrResponse post(Object url, Object body, Object headers) {
        return syncFetch(TemplateRenderer.render(String.valueOf(url), bindings), "POST",
                body == null ? "" : String.valueOf(body), headersOf(headers));
    }

    /**
     * 对齐 java-api.js#ajaxAll：批量抓取 → StrResponse 列表（legado Array&lt;StrResponse&gt;：
     * body()/code()/header()/url()；参数摊平一层，对齐 urls.flat()）。单项失败返回空载体不炸穿。
     */
    public List<StrResponse> ajaxAll(Object... urls) {
        List<Object> flat = new ArrayList<>();
        for (Object a : urls) {
            Object v = a instanceof Wrapper ? ((Wrapper) a).unwrap() : a;
            if (v instanceof NativeArray) {
                NativeArray na = (NativeArray) v;
                int len = (int) na.getLength();
                for (int i = 0; i < len; i++) flat.add(na.get(i, na));
            } else if (v instanceof Object[]) {
                flat.addAll(Arrays.asList((Object[]) v));
            } else if (v instanceof List) {
                flat.addAll((List<?>) v);
            } else {
                flat.add(v);
            }
        }
        List<StrResponse> out = new ArrayList<>(flat.size());
        for (Object u : flat) {
            String rendered = TemplateRenderer.render(String.valueOf(u), bindings);
            try {
                UrlRule.Parsed p = UrlRule.parseUrlRule(rendered);
                out.add(syncFetch(p.url, p.options.method != null ? p.options.method : "GET",
                        p.options.body != null ? p.options.body : "", p.options.headers,
                        retryOf(p.options.retry)));
            } catch (Exception e) {
                Log.w(TAG, "java.ajaxAll failed [" + truncate(rendered, 80) + "]: " + e.getMessage());
                out.add(StrResponse.empty(rendered));
            }
        }
        return out;
    }

    /** 对齐 java-api.js#connect：同 ajax，返回 { body } 形态（legado connect 语义简化） */
    public ConnectResult connect(Object url) {
        return connect(url, null);
    }

    /**
     * 对齐 legado JsExtensionsCommon#connect(urlStr, header)：header 为 JSON 对象或 JSON 字符串，
     * 解析为请求头与书源头合并（原 node 行为: connect 仅单参 { body } 形态，无自定义头重载）。
     */
    public ConnectResult connect(Object url, Object header) {
        String rendered = TemplateRenderer.render(String.valueOf(unwrap(url)), bindings);
        try {
            UrlRule.Parsed p = UrlRule.parseUrlRule(rendered);
            Map<String, String> merged = new LinkedHashMap<>(defaultHeaders());
            if (p.options.headers != null) merged.putAll(p.options.headers);
            merged.putAll(headerMapOf(header));
            String method = p.options.method != null ? p.options.method : "GET";
            String postBody = "POST".equals(method)
                    ? UrlRule.applyPostBody("POST", p.options.body != null ? p.options.body : "", merged, p.options.charset)
                    : null;
            String finalUrl = "POST".equals(method) ? p.url : UrlRule.encodeUrlQuery(p.url, p.options.charset);
            HttpFetcher.HttpResult r = fetchWithRetry(finalUrl, method, merged, postBody,
                    p.options.charset, retryOf(p.options.retry));
            return new ConnectResult(r.body, r.finalUrl);
        } catch (Exception e) {
            // 对齐 legado connect 失败路径：StrResponse(url, it.stackTraceStr) 的 body 为堆栈字符串
            Log.w(TAG, "java.connect failed [" + truncate(rendered, 80) + "]: " + e.getMessage());
            return new ConnectResult(Log.getStackTraceString(e), null);
        }
    }

    /**
     * 对齐 legado JsExtensionsCommon#head(urlStr, headers)：同步 HEAD（不发送 body，
     * 返回 StrResponse 面）。有意偏差：legado 用 Jsoup followRedirects(false) 拦截重定向，
     * 本实现跟随重定向（HttpFetcher 统一策略），取跳转地址用 url()。
     */
    public StrResponse head(Object url, Object headers) {
        String rendered = TemplateRenderer.render(String.valueOf(unwrap(url)), bindings);
        return syncFetch(rendered, "HEAD", "", headersOf(headers));
    }

    /**
     * 对齐 legado JsExtensionsCommon#strResponse(url, body)：构造响应对象（登录检查 JS
     * 替换本次响应用的工厂）（原 node 行为: 无此方法）。
     */
    public StrResponse strResponse(Object url, Object body) {
        return new StrResponse(body == null ? "" : String.valueOf(body), 200,
                new LinkedHashMap<String, String>(), null, String.valueOf(url));
    }

    /** 对齐 legado JsExtensionsCommon#strResponse(url) 单参重载（body 为 null） */
    public StrResponse strResponse(Object url) {
        return strResponse(url, null);
    }

    /**
     * 同步抓取 → StrResponse（node syncFetch：code()/body()/header()/url() 共用载体）。
     * node GET 空 body 经 fetch 脚本 falsy 归 undefined → 不发送；POST 空 body Java 侧发空体
     * （Content-Length: 0，与 node 无 body 的服务器侧差异可忽略）。GET 非空 body okhttp 拒绝
     * （对齐 node undici GET body 抛错 → 空载体）。
     */
    private StrResponse syncFetch(String url, String method, String body, Map<String, String> headers) {
        return syncFetch(url, method, body, headers, 0);
    }

    private StrResponse syncFetch(String url, String method, String body, Map<String, String> headers, int retry) {
        String m = method == null || method.trim().isEmpty() ? "GET" : method.trim().toUpperCase(Locale.ROOT);
        try {
            Map<String, String> merged = new LinkedHashMap<>(defaultHeaders());
            if (headers != null) merged.putAll(headers);
            String b = body == null ? "" : body;
            if (("GET".equals(m) || "HEAD".equals(m)) && b.isEmpty()) b = null;
            HttpFetcher.HttpResult r = fetchWithRetry(url, m, merged, b, null, retry);
            return new StrResponse(r.body, r.code, r.headers, r.finalUrl, url);
        } catch (Exception e) {
            Log.w(TAG, "java." + m.toLowerCase(Locale.ROOT) + " failed [" + truncate(url, 80) + "]: " + e.getMessage());
            return StrResponse.empty(url);
        }
    }

    /**
     * 对齐 legado newCallStrResponse(option?.retry ?: 0) 的重试语义：网络失败（握手/IO/非 2xx 空体）
     * 时整体重试至多 retry 次；retry<=0 即单次。
     */
    private static HttpFetcher.HttpResult fetchWithRetry(String url, String method, Map<String, String> headers,
                                                         String body, String charset, int retry) {
        Exception last = null;
        for (int attempt = 0; attempt <= Math.max(0, retry); attempt++) {
            try {
                return HttpFetcher.fetch(url, method, headers, body, charset);
            } catch (Exception e) {
                last = e;
            }
        }
        throw last instanceof RuntimeException ? (RuntimeException) last : new RuntimeException(last);
    }

    /** legado UrlOption.retry（Int?）等价：null/负值归 0 */
    private static int retryOf(Double retry) {
        return retry == null || retry < 0 ? 0 : (int) Math.floor(retry);
    }

    /** Rhino 包装对象解包（NativeJavaObject/Wrapper → 底层值） */
    private static Object unwrap(Object v) {
        if (v instanceof Wrapper) return ((Wrapper) v).unwrap();
        return v;
    }

    /**
     * 对齐 legado JsExtensionsCommon#connect(urlStr, header) 的 header 入参：JSON 字符串经
     * GSON 解析为 Map，Map（JS 对象字面量）直接收；其余返回空 Map。
     */
    private static Map<String, String> headerMapOf(Object header) {
        Object h = unwrap(header);
        if (h instanceof Map) return headersOfStatic(h);
        if (h instanceof String) {
            try {
                Object m = GSON.fromJson((String) h, Map.class);
                if (m instanceof Map) return headersOfStatic(m);
            } catch (Exception ignored) {
            }
        }
        return new LinkedHashMap<String, String>();
    }

    /** JS 对象/Map → 请求头 Map（值字符串化，键空跳过） */
    private static Map<String, String> headersOfStatic(Object def) {
        LinkedHashMap<String, String> out = new LinkedHashMap<>();
        Object h = unwrap(def);
        if (h instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) h).entrySet()) {
                if (e.getKey() != null && e.getValue() != null) {
                    out.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
                }
            }
        }
        return out;
    }

    /** legado Connection.Response 面：code()/body()/header()/url()；toString → body（String 载体语义） */
    public static final class StrResponse {
        private final String bodyStr;
        private final int codeV;
        private final Map<String, String> headersMap;
        private final String finalUrl;
        private final String requestUrl;

        StrResponse(String body, int code, Map<String, String> headers, String finalUrl, String requestUrl) {
            this.bodyStr = body;
            this.codeV = code;
            this.headersMap = headers;
            this.finalUrl = finalUrl;
            this.requestUrl = requestUrl;
        }

        static StrResponse empty(String url) {
            return new StrResponse("", 0, new LinkedHashMap<String, String>(), url, url);
        }

        public int code() {
            return codeV;
        }

        public String body() {
            return bodyStr;
        }

        public Map<String, String> headers() {
            return headersMap;
        }

        public String url() {
            return finalUrl != null ? finalUrl : requestUrl;
        }

        public String header(String name) {
            String k = String.valueOf(name).toLowerCase(Locale.ROOT);
            String v = headersMap.get(k);
            if (v != null && !v.isEmpty()) return v;
            // 302 跟随后 location 头消失（Node/okhttp redirect:follow），社区源高频
            // `java.get(url).header('location')` 取跳转地址 → 以最终 URL 兜底
            if ("location".equals(k) && finalUrl != null && !finalUrl.isEmpty() && !finalUrl.equals(requestUrl)) {
                return finalUrl;
            }
            return "";
        }

        @Override
        public String toString() {
            return bodyStr;
        }
    }

    /**
     * connect 返回体：JS 侧 java.connect(url).body（公开字段，Rhino 属性访问直读）。
     * raw()/request() 链对齐 legado StrResponse.okhttp 面——社区源（如趣书网）用
     * java.connect(so).raw().request().url() 取重定向后最终地址；T4 不保留 okhttp
     * Response 句柄，链上直接返回自持 finalUrl。
     */
    public static final class ConnectResult {
        public final String body;
        private final String finalUrl;

        ConnectResult(String body, String finalUrl) {
            this.body = body;
            this.finalUrl = finalUrl;
        }

        public ConnectResult raw() {
            return this;
        }

        public ConnectResult request() {
            return this;
        }

        public String url() {
            return finalUrl != null ? finalUrl : "";
        }
    }

    // ==================== 规则执行（legado AnalyzeRule.getString：JS 内对当前内容执行规则） ====================

    /**
     * 对齐 java-api.js#getString：默认对根内容（本次规则求值的 root，缺省回退 result）求值，
     * 而非当前 result——社区源高频 java.getString('$.data.xxx') 从整页 JSON 取字段。
     * 委托 RuleAnalyzer.evalRule（analyzeStr 语义：失败降级空串）。
     */
    public String getString(Object ruleStr) {
        return getString(ruleStr, null);
    }

    public String getString(Object ruleStr, Object mContent) {
        String rule = ruleStr == null ? "" : String.valueOf(ruleStr);
        Object out = RuleAnalyzer.evalRule(rule, ruleBase(mContent), bindings);
        return out == null ? "" : String.valueOf(out);
    }

    /**
     * 对齐 java-api.js#getStringList：@ 切段（前段依次选元素、末段取值）等方言细节保留，
     * 分发委托 RuleAnalyzer.evalRule/evalRuleList。
     */
    public List<String> getStringList(Object ruleStr) {
        return getStringList(ruleStr, null);
    }

    public List<String> getStringList(Object ruleStr, Object mContent) {
        String rule = ruleStr == null ? "" : String.valueOf(ruleStr);
        Object base = ruleBase(mContent);
        List<String> out = new ArrayList<>();
        // legado AnalyzeByXPath.getStringList：xpath 方言整条求值（属性节点取 value、元素取
        // textContent），不走 JSoup 方言的 @ 切段——误拆 '/a/@href' 会留下孤立 '/' 报 XPath 错
        if (rule.regionMatches(true, 0, "@xpath:", 0, 7) || rule.startsWith("/")) {
            Object r = RuleAnalyzer.evalRule(rule, base, bindings);
            String joined = r == null ? "" : String.valueOf(r);
            for (String s : joined.split("\n", -1)) {
                if (!s.isEmpty()) out.add(s);
            }
            return out;
        }
        // legado AnalyzeByJSoup.getStringList → getResultList：按 @ 切段，前段依次选元素、
        // 末段 getResultLast 取值（如 nextTocUrl 'id.next@href' 得 ['/toc/2']）
        boolean isJs = rule.regionMatches(true, 0, "@js:", 0, 4) || rule.startsWith("<js>");
        int at = isJs ? -1 : rule.lastIndexOf('@');
        if (at > 0) {
            List<?> els = asList(RuleAnalyzer.evalRuleList(rule.substring(0, at), base, bindings));
            String tail = rule.substring(at + 1);
            for (Object el : els) {
                Object v = RuleAnalyzer.evalRule(tail, el, bindings);
                out.add(v == null ? "" : String.valueOf(v));
            }
            return out;
        }
        // 无取值尾巴：列表元素转字符串（text 优先、raw 兜底，repr 形态兼容）
        List<?> raw = asList(RuleAnalyzer.evalRuleList(rule, base, bindings));
        for (Object el : raw) {
            out.add(reprToString(el));
        }
        return out;
    }

    /**
     * 对齐 java-api.js#getElements：对当前内容执行规则取元素列表。node 版逐项包 elementProxy
     * （text/attr 可链）；Java 侧元素方法面由 RuleAnalyzer 的 repr 形态承担，此处原样返回列表。
     */
    public List<?> getElements(Object ruleStr) {
        return getElements(ruleStr, null);
    }

    public List<?> getElements(Object ruleStr, Object mContent) {
        String rule = ruleStr == null ? "" : String.valueOf(ruleStr);
        return asList(RuleAnalyzer.evalRuleList(rule, ruleBase(mContent), bindings));
    }

    /** getString 系共用的内容基：mContent 优先，其次 root（本次求值根），再回退 result（URL 构建等无 root 场景） */
    private Object ruleBase(Object mContent) {
        if (mContent != null) return mContent;
        Object root = bindings.get("root");
        if (root != null) return root;
        Object result = bindings.get("result");
        return result != null ? result : "";
    }

    private static List<?> asList(Object r) {
        if (r instanceof List) return (List<?>) r;
        if (r instanceof Object[]) return Arrays.asList((Object[]) r);
        if (r == null) return new ArrayList<>(0);
        return Arrays.asList(r);
    }

    /** repr → 字符串：{kind:'text',text} 取 text；有 raw 取 raw；其余 String 化 */
    private static String reprToString(Object repr) {
        if (repr == null) return "";
        if (repr instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) repr;
            if ("text".equals(m.get("kind")) && m.get("text") != null) return String.valueOf(m.get("text"));
            if (m.get("raw") != null) return String.valueOf(m.get("raw"));
            return "";
        }
        return String.valueOf(repr);
    }

    // ==================== 变量池 ====================

    /**
     * 对齐 java-api.js#put（legado AnalyzeUrlCore.put: String）：put 返回 value——社区源依赖
     * 返回值拼 URL options 尾巴（如七猫 `"," + java.put("headers", JSON...)`）。同时写穿
     * bindings，保证 {{var}} 模板经 TemplateRenderer 查表可见。
     */
    public Object put(String key, Object value) {
        String k = String.valueOf(key);
        // 对齐 legado AnalyzeRuleCore#put：bookName/title 特殊键提示易被覆盖
        if ("bookName".equals(k) || "title".equals(k)) {
            Log.w(TAG, "≡变量 " + k + " 在特定情况下会被覆盖，建议使用其他键名");
        }
        vars.put(k, value);
        bindings.put(k, value);
        return value;
    }

    /**
     * 对齐 java-api.js#get：变量池 get；URL + headers 对象时走 legado JsExtensions.get
     * （同步 HTTP GET → StrResponse）。
     */
    public Object get(String keyOrUrl) {
        return get(keyOrUrl, "");
    }

    public Object get(String keyOrUrl, Object def) {
        if (keyOrUrl != null && keyOrUrl.contains("://") && isHeadersArg(def)) {
            return syncFetch(TemplateRenderer.render(keyOrUrl, bindings), "GET", "", headersOf(def));
        }
        String k = String.valueOf(keyOrUrl);
        // 对齐 legado AnalyzeRuleCore#get 特殊键：bookName → 书名、title → 章节标题，
        // 均不落变量池（原 node 行为: get 为纯变量池含 def 兜底）
        if ("bookName".equals(k)) {
            Object b = bindings.get("book");
            if (b instanceof Map) {
                Object n = ((Map<?, ?>) b).get("name");
                return n != null ? String.valueOf(n) : "";
            }
            return "";
        }
        if ("title".equals(k)) {
            Object t = bindings.get("title");
            return t != null ? t : "";
        }
        return vars.containsKey(k) ? vars.get(k) : def;
    }

    /** node typeof def === 'object' 等价：null / Map（Rhino 对象字面量 NativeObject 实现 Map，同被覆盖）均作请求头形态 */
    private static boolean isHeadersArg(Object def) {
        return def == null || def instanceof Map;
    }

    /** JS 对象/Map → 请求头 Map（值字符串化，键空跳过） */
    private static Map<String, String> headersOf(Object def) {
        LinkedHashMap<String, String> out = new LinkedHashMap<>();
        Object h = def instanceof Wrapper ? ((Wrapper) def).unwrap() : def;
        if (h instanceof NativeObject) {
            // NativeObject 实现 Map（对齐 JsEngine.expand 的 entrySet 遍历），特判以绕开 get(int/Object, Scriptable) 重载歧义
            Map<?, ?> no = (Map<?, ?>) h;
            for (Map.Entry<?, ?> e : no.entrySet()) {
                if (e.getKey() != null && e.getValue() != null) {
                    out.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
                }
            }
        } else if (h instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) h).entrySet()) {
                if (e.getKey() != null && e.getValue() != null) {
                    out.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
                }
            }
        }
        return out;
    }

    // ==================== 上下文 ====================

    /** 对齐 java-api.js#baseUrl：当前请求 baseUrl，回退书源地址 */
    public String baseUrl() {
        Object b = bindings.get("baseUrl");
        if (b != null && !String.valueOf(b).isEmpty()) return String.valueOf(b);
        Object sv = bindings.get("source") instanceof Map
                ? ((Map<?, ?>) bindings.get("source")).get("bookSourceUrl") : null;
        return sv == null ? "" : String.valueOf(sv);
    }

    /** 对齐 java-api.js#setContent：正文暂存（node 存 vars['__content_'+key]） */
    public void setContent(Object v, Object key) {
        vars.put("__content_" + (key == null ? "" : String.valueOf(key)), v);
    }

    public Object getContent(Object key) {
        String k = "__content_" + (key == null ? "" : String.valueOf(key));
        return vars.containsKey(k) ? vars.get(k) : null;
    }

    /** legado 元素对象无对应实现，返回原始内容（node c.result ?? null） */
    public Object getElement() {
        return bindings.get("result");
    }

    /**
     * 对齐 legado AnalyzeRule.getElement(ruleStr)：对当前整页内容（ctx.root repr）执行规则，
     * 取列表首个条目（元素 repr → JS 载体：json→NativeObject / html→Element / 其余文本）。
     * 得间等源 JS 内 java.getElement("$.newestChapter") 后直接 .name/.url 属性访问依赖此桥。
     */
    public Object getElement(String ruleStr) {
        Object root = bindings.get("root");
        Object content = root != null ? root : bindings.get("result");
        List<Object> out = RuleAnalyzer.evalRuleList(String.valueOf(ruleStr), content, bindings);
        if (out.isEmpty()) return null;
        Object el = out.get(0);
        return el instanceof RuleAnalyzer.Repr ? RuleAnalyzer.elementProxy((RuleAnalyzer.Repr) el) : el;
    }

    /**
     * 对齐 java-api.js#getSource：返回 bindings 里的 source（Map 形态书源）。node 版为 source
     * 对象增强（getKey/tag/name 等属性面）；Java Map 形态下 JS 侧经 source.get("xxx") 取值，
     * 属性形态访问由 T4 注入的包装决定。
     */
    public Object getSource() {
        Object s = bindings.get("source");
        return s != null ? s : new LinkedHashMap<String, Object>();
    }

    public Object getBook() {
        Object b = bindings.get("book");
        return b != null ? b : new LinkedHashMap<String, Object>();
    }

    /**
     * JS cookie 桥（对齐 legado CookieStore 面）：JS 侧 cookie.getCookie/setCookie/removeCookie，
     * 既有 ctx cookie 值经 backing Map 透传；T4 okhttp 会话内无持久 cookie 域管理，
     * set/get 走内存 Map（书源自 set 自 get 同一 url 的延时/清洗场景可用）。
     * removeCookie 对齐 legado void 签名（undefined → 模板输出空串——社区源
     * {{cookie.removeCookie(source.getKey())}}/path 写法靠空输出拼 URL 前缀，不可返回 boolean）。
     */
    public static class CookieBridge {
        private final Map<String, Object> backing;

        public CookieBridge(Map<String, Object> backing) {
            this.backing = backing != null ? backing : new LinkedHashMap<String, Object>();
        }

        public Object get(String key) {
            return backing.get(key);
        }

        public String getCookie(String url) {
            Object v = backing.get(url);
            return v != null ? String.valueOf(v) : "";
        }

        public void removeCookie(String url) {
            backing.remove(url);
        }

        public void setCookie(String url, String cookie) {
            backing.put(String.valueOf(url), String.valueOf(cookie));
        }

        public Object put(String key, Object value) {
            backing.put(String.valueOf(key), value);
            return null;
        }
    }

    /**
     * JS cache 桥（对齐 legado CacheManager 内存面）：进程级内存缓存，得间等源用
     * cache.getFromMemory/putMemory/deleteMemory 跨请求暂存章节游标。
     */
    public static class CacheBridge {
        private static final Map<String, Object> MEM = new ConcurrentHashMap<>();
        private static final int MAX_MEM = 500;

        public Object getFromMemory(String key) {
            return key == null ? null : MEM.get(key);
        }

        public void putMemory(String key, Object value) {
            if (key == null) return;
            if (MEM.size() >= MAX_MEM && !MEM.containsKey(key)) {
                MEM.remove(MEM.keySet().iterator().next());
            }
            MEM.put(key, value);
        }

        public void deleteMemory(String key) {
            if (key != null) MEM.remove(key);
        }

        public Object get(String key) {
            return getFromMemory(key);
        }

        public void put(String key, Object value) {
            putMemory(key, value);
        }

        public void put(String key, Object value, long timeout) {
            putMemory(key, value);
        }
    }

    // ==================== 编码/格式化 ====================

    /**
     * 对齐 java-api.js#encodeURI（legado JsExtensions.encodeURI）：全字符百分号编码
     * （unreserved 保留，空格 → +），enc 支持指定字符集；字符集不可用时回退
     * encodeURIComponent（UTF-8）。
     */
    public String encodeURI(Object str) {
        return encodeURI(str, null);
    }

    public String encodeURI(Object str, Object enc) {
        String s = str == null ? "" : String.valueOf(str);
        String cs = (enc == null || String.valueOf(enc).isEmpty()) ? "utf-8" : String.valueOf(enc).toLowerCase(Locale.ROOT);
        try {
            return UrlRule.formEncode(s, cs);
        } catch (Exception e) {
            return encodeURIComponent(s);
        }
    }

    public String urlEncode(Object str) {
        return encodeURI(str);
    }

    public String urlEncode(Object str, Object enc) {
        return encodeURI(str, enc);
    }

    public String urlDecode(Object str) {
        return utf8Decode(str);
    }

    /** 对齐 java-api.js#utf8Decode：UTF-8 百分号解码（decodeURIComponent 语义，'+' 保留） */
    public String utf8Decode(Object str) {
        if (str == null) return "";
        String s = String.valueOf(str);
        if (s.isEmpty()) return "";
        try {
            return decodePercent(s);
        } catch (Exception e) {
            return s;
        }
    }

    /**
     * 对齐 legado JsExtensionsCommon#timeFormatUTC / JsExtensionsPlatform#formatTimeUtc：
     * SimpleDateFormat(format) 全 pattern 支持 + SimpleTimeZone(sh, "UTC")——sh 直接作为相对
     * GMT 的毫秒偏移（原 node 行为: sh 当小时数累加偏移 + 手写 yyyy-MM-dd 等少数 token 替换）。
     * format 非法时异常上抛（对齐 legado actual 无 catch）。
     */
    public String timeFormatUTC(Object ms, String fmt) {
        return timeFormatUTC(ms, fmt, null);
    }

    public String timeFormatUTC(Object ms, String fmt, Object sh) {
        SimpleDateFormat sdf = new SimpleDateFormat(fmt == null || fmt.isEmpty() ? "yyyy-MM-dd HH:mm:ss" : fmt);
        sdf.setTimeZone(new SimpleTimeZone((int) numOf(sh), "UTC"));
        return sdf.format(new Date(timeMillisOf(ms)));
    }

    /** 对齐 legado JsExtensionsCommon#timeFormat：AppConst.dateFormat（yyyy/MM/dd HH:mm）本地时区（原 node 行为: 缺省 yyyy-MM-dd HH:mm:ss） */
    public String timeFormat(Object ms) {
        return new SimpleDateFormat("yyyy/MM/dd HH:mm").format(new Date(timeMillisOf(ms)));
    }

    /** 双参为插件超集（legado timeFormat 仅单参）；fmt 走 SimpleDateFormat 全 pattern（原 node 行为: 手写 token 替换） */
    public String timeFormat(Object ms, String fmt) {
        return new SimpleDateFormat(fmt == null || fmt.isEmpty() ? "yyyy/MM/dd HH:mm" : fmt)
                .format(new Date(timeMillisOf(ms)));
    }

    /** node `ms ? Number(ms) : Date.now()`（0/空/非法归当前时间） */
    private static long timeMillisOf(Object ms) {
        double n = numOf(ms);
        return n == 0 ? System.currentTimeMillis() : (long) n;
    }

    private static double numOf(Object v) {
        if (v instanceof Number) return ((Number) v).doubleValue();
        if (v instanceof String) {
            try {
                return Double.parseDouble(((String) v).trim());
            } catch (Exception e) {
                return 0;
            }
        }
        return 0;
    }

    // ==================== 工具 ====================

    /**
     * 对齐 java-api.js#log（legado JsExtensionsCommon.log）：打印后返回 msg——社区源依赖
     * java.log(x) 的返回值作为 JS 规则结果出口（如八叉书库 ruleContent 的 java.log(content)）。
     */
    public Object log(Object... args) {
        StringBuilder tagMsg = new StringBuilder("[java.log]");
        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < args.length; i++) {
            String s = String.valueOf(args[i]);
            tagMsg.append(' ').append(s);
            if (i > 0) joined.append(' ');
            joined.append(s);
        }
        Log.d(LOG_TAG_JS, tagMsg.toString());
        return args.length == 1 ? args[0] : joined.toString();
    }

    /** 空实现：需要 WebView 的能力在本插件不可用（对齐 node 空实现面） */
    public void toast() {
    }

    public void toast(Object msg) {
    }

    public void longToast() {
    }

    public void longToast(Object msg) {
    }

    /** 繁转简（legado JsExtensions 同名 API；单字映射表见 Trans） */
    public String t2s(String text) {
        return Trans.t2s(text);
    }

    /** 简转繁（legado JsExtensions 同名 API） */
    public String s2t(String text) {
        return Trans.s2t(text);
    }

    public String startBrowser() {
        return "";
    }

    public String startBrowser(Object url) {
        return "";
    }

    public BrowserResult startBrowserAwait() {
        return new BrowserResult();
    }

    public BrowserResult startBrowserAwait(Object url, Object options) {
        return new BrowserResult();
    }

    /** JS 侧 java.startBrowserAwait(url, opt).html / .url（公开字段，Rhino 属性访问直读） */
    public static final class BrowserResult {
        public String html = "";
        public String url = "";
    }

    /** 对齐 legado JsExtensionsCommon#hexDecodeToByteArray：hex → 字节数组（非法/奇长/空返回 null）（原 node 行为: 仅有 hexDecodeToString） */
    public static byte[] hexDecodeToByteArray(Object hex) {
        String s = hex == null ? "" : String.valueOf(hex).trim();
        if (s.isEmpty() || s.length() % 2 != 0 || !s.matches("[0-9a-fA-F]+")) return null;
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) ((Character.digit(s.charAt(i * 2), 16) << 4) | Character.digit(s.charAt(i * 2 + 1), 16));
        }
        return out;
    }

    /** 对齐 java-api.js#hexDecodeToString：hex → utf-8 字符串（非法/奇长/空返回 null） */
    public String hexDecodeToString(Object hex) {
        String s = hex == null ? "" : String.valueOf(hex).trim();
        if (s.isEmpty() || s.length() % 2 != 0 || !s.matches("[0-9a-fA-F]+")) return null;
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) ((Character.digit(s.charAt(i * 2), 16) << 4) | Character.digit(s.charAt(i * 2 + 1), 16));
        }
        return new String(out, StandardCharsets.UTF_8);
    }

    /** 对齐 java-api.js#hexEncodeToString：utf-8 字符串 → 小写 hex */
    public String hexEncodeToString(Object utf8) {
        return hexLower(String.valueOf(utf8 == null ? "" : utf8).getBytes(StandardCharsets.UTF_8));
    }

    // ==================== 散列/对称加密（上游 legado JsExtensions 常用面） ====================

    /** 对齐 java-api.js#HMacHex(data, algorithm, key)：散列消息鉴别码 → 小写 hex（algorithm 如 HmacMD5/HmacSHA256） */
    public String HMacHex(Object data, Object algorithm, Object key) {
        return hmac(data, algorithm, key, false);
    }

    /** 对齐 java-api.js#HMacBase64：HMAC → base64（带 padding，对齐 node digest('base64')） */
    public String HMacBase64(Object data, Object algorithm, Object key) {
        return hmac(data, algorithm, key, true);
    }

    private String hmac(Object data, Object algorithm, Object key, boolean base64) {
        // node: algorithm.toLowerCase().replace(/^hmac-?/,'')；再吞内部 '-'（如 sha-256 → SHA256）
        String alg = String.valueOf(algorithm == null ? "" : algorithm).toLowerCase(Locale.ROOT)
                .replaceFirst("^hmac-?", "").replace("-", "").toUpperCase(Locale.ROOT);
        try {
            Mac mac = Mac.getInstance("Hmac" + alg);
            mac.init(new SecretKeySpec(String.valueOf(key == null ? "" : key).getBytes(StandardCharsets.UTF_8), "Hmac" + alg));
            byte[] d = mac.doFinal(String.valueOf(data == null ? "" : data).getBytes(StandardCharsets.UTF_8));
            return base64 ? Base64.encodeToString(d, Base64.NO_WRAP) : hexLower(d);
        } catch (Exception e) {
            // node createHmac 未知算法直接抛，此处同样上抛为 JS 可见错误
            throw new RuntimeException("hmac failed: " + e.getMessage(), e);
        }
    }

    /**
     * 对齐 legado JsExtensionsCommon#createSymmetricCrypto(transformation, key[, iv])：
     * JS 侧 java.createSymmetricCrypto(t, key, iv).decrypt(data) / .decryptStr(data) /
     * .encrypt(data) / .encryptBase64(data) / .encryptHex(data)。transformation 直传
     * Cipher.getInstance（PKCS7Padding → PKCS5Padding 归一，对齐 legado SymmetricCryptoAndroid
     * 的 normalizePkcs7Padding——块密码下两者字节级等价）；key/iv 长度不做补零截断，由 JCE 校验
     * （对齐 legado SecretKeySpec 原样构造）；key 为 null 时使用随机密钥（原 node 行为: 无此方法，
     * 仅 des 系/aes 系一次性 API）。
     */
    public SymmetricCrypto createSymmetricCrypto(Object transformation, Object key) {
        return createSymmetricCrypto(transformation, key, null);
    }

    public SymmetricCrypto createSymmetricCrypto(Object transformation, Object key, Object iv) {
        String tt = String.valueOf(transformation == null ? "" : transformation);
        if (tt.contains("PKCS7Padding")) {
            tt = tt.replaceAll("(?i)PKCS7Padding", "PKCS5Padding");
        }
        byte[] keyBuf;
        if (key == null || String.valueOf(key).isEmpty()) {
            // 对齐 legado: key 为 null 时使用随机密钥（AES-128）
            byte[] rnd = new byte[16];
            new java.security.SecureRandom().nextBytes(rnd);
            keyBuf = rnd;
        } else if (key instanceof byte[]) {
            keyBuf = (byte[]) key;
        } else {
            keyBuf = String.valueOf(key).getBytes(StandardCharsets.UTF_8);
        }
        byte[] ivBuf = null;
        if (iv instanceof byte[]) {
            ivBuf = (byte[]) iv;
        } else if (iv != null && !String.valueOf(iv).isEmpty()) {
            ivBuf = String.valueOf(iv).getBytes(StandardCharsets.UTF_8);
        }
        return new SymmetricCrypto(tt, keyBuf, ivBuf);
    }

    /**
     * 对齐 legado SymmetricCrypto（hutool SymmetricCrypto JS 面）：构造时初始化 Cipher
     * （ECB 免 IV；其余模式有 IV 用之，无 IV 交由 JCE 自动生成——对齐 hutool 单 key 构造行为）。
     * 书源 JS 同步调用，Cipher 非线程安全但实例由 JS 独占。
     */
    public static final class SymmetricCrypto {
        private final Cipher cipher;

        private SymmetricCrypto(String transformation, byte[] key, byte[] iv) {
            try {
                String algo = transformation.contains("/") ? transformation.substring(0, transformation.indexOf('/')) : transformation;
                this.cipher = Cipher.getInstance(transformation);
                SecretKeySpec ks = new SecretKeySpec(key, algo);
                if (iv != null) {
                    cipher.init(Cipher.ENCRYPT_MODE, ks, new IvParameterSpec(iv));
                } else {
                    cipher.init(Cipher.ENCRYPT_MODE, ks);
                }
            } catch (Exception e) {
                throw new RuntimeException("createSymmetricCrypto failed: " + e.getMessage(), e);
            }
        }

        /** 加密 → 密文字节（对齐 hutool encrypt） */
        public byte[] encrypt(Object data) {
            try {
                return cipher.doFinal(toBytes(data));
            } catch (Exception e) {
                throw new RuntimeException("encrypt failed: " + e.getMessage(), e);
            }
        }

        /** 加密 → 小写 hex（对齐 hutool encryptHex） */
        public String encryptHex(Object data) {
            return hexLower(encrypt(data));
        }

        /** 加密 → 标准 base64（对齐 hutool encryptBase64 → EncoderUtils.base64Encode NO_WRAP） */
        public String encryptBase64(Object data) {
            return Base64.encodeToString(encrypt(data), Base64.NO_WRAP);
        }

        /** 解密 → 明文字节；String 入参 hex 优先（对齐 legado decrypt(String) 的 isHex 分支），否则宽松 base64 */
        public byte[] decrypt(Object data) {
            byte[] src;
            if (data instanceof byte[]) {
                src = (byte[]) data;
            } else {
                String s = String.valueOf(data == null ? "" : data);
                src = s.matches("(?i)^[0-9a-fA-F]+$") && !s.isEmpty()
                        ? hexDecodeToByteArray(s)
                        : base64DecodeBytes(s);
            }
            try {
                return cipher.doFinal(src);
            } catch (Exception e) {
                throw new RuntimeException("decrypt failed: " + e.getMessage(), e);
            }
        }

        /** 解密 → utf-8 字符串（对齐 hutool decryptStr） */
        public String decryptStr(Object data) {
            return new String(decrypt(data), StandardCharsets.UTF_8);
        }

        private static byte[] toBytes(Object data) {
            if (data instanceof byte[]) return (byte[]) data;
            return String.valueOf(data == null ? "" : data).getBytes(StandardCharsets.UTF_8);
        }
    }

    /** 对齐 legado JsExtensionsCommon#digestHex：消息摘要 → 小写 hex，algorithm 直传 MessageDigest（如 MD5/SHA-256）（原 node 行为: 无此方法） */
    public String digestHex(Object data, Object algorithm) {
        try {
            return hexLower(MessageDigest.getInstance(String.valueOf(algorithm)).digest(
                    String.valueOf(data == null ? "" : data).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException("digestHex failed: " + e.getMessage(), e);
        }
    }

    /** 对齐 legado JsExtensionsCommon#digestBase64Str：消息摘要 → 标准 base64（原 node 行为: 无此方法） */
    public String digestBase64Str(Object data, Object algorithm) {
        try {
            return Base64.encodeToString(
                    MessageDigest.getInstance(String.valueOf(algorithm)).digest(
                            String.valueOf(data == null ? "" : data).getBytes(StandardCharsets.UTF_8)),
                    Base64.NO_WRAP);
        } catch (Exception e) {
            throw new RuntimeException("digestBase64Str failed: " + e.getMessage(), e);
        }
    }

    /** 对齐 java-api.js#randomUUID */
    public String randomUUID() {
        return UUID.randomUUID().toString();
    }

    /**
     * 对齐 java-api.js#desEncodeToBase64String(data, key, transformation, iv)：
     * transformation 形如 "AES/CBC/PKCS5Padding"、"DES/ECB/PKCS5Padding"；AES/DES/DESede
     * （对齐 bridgeCipherName：非 DES 系一律按 AES 处理）；DES 密钥定长 8 字节（短补零、长截断，
     * Java DESKeySpec 取前 8 字节语义）；失败抛出（对齐 node 无 catch 上抛）。
     */
    public String desEncodeToBase64String(Object data, Object key) {
        return desEncodeToBase64String(data, key, null, null);
    }

    public String desEncodeToBase64String(Object data, Object key, Object transformation) {
        return desEncodeToBase64String(data, key, transformation, null);
    }

    public String desEncodeToBase64String(Object data, Object key, Object transformation, Object iv) {
        try {
            byte[] keyBuf = String.valueOf(key == null ? "" : key).getBytes(StandardCharsets.UTF_8);
            byte[] src = String.valueOf(data == null ? "" : data).getBytes(StandardCharsets.UTF_8);
            String tt = String.valueOf(transformation == null ? "" : transformation).toUpperCase(Locale.ROOT);
            String mode = tt.contains("GCM") ? "GCM" : tt.contains("CBC") ? "CBC"
                    : tt.contains("CFB") ? "CFB" : tt.contains("OFB") ? "OFB" : "ECB";
            boolean isGcm = "GCM".equals(mode);
            // 对齐 bridgeCipherName：DESEDE/TRIPLEDES → 3DES，DES → 单 DES，其余（含 RC4）一律 AES
            String algo = tt.contains("DESEDE") || tt.contains("TRIPLEDES") ? "DESede" : tt.contains("DES") ? "DES" : "AES";
            byte[] keyN = normalizeKey(algo, keyBuf);
            byte[] ivBuf = (iv == null || String.valueOf(iv).isEmpty()) ? null : String.valueOf(iv).getBytes(StandardCharsets.UTF_8);
            // PKCS5Padding 恒定（bridgeCipherName 不看 padding 段，NoPadding 输入同样按默认填充）
            Cipher c = Cipher.getInstance(isGcm ? "AES/GCM/NoPadding" : algo + "/" + mode + "/PKCS5Padding");
            SecretKeySpec ks = new SecretKeySpec(keyN, algo);
            if (isGcm) {
                if (ivBuf == null) throw new RuntimeException("GCM requires iv");
                c.init(Cipher.ENCRYPT_MODE, ks, new GCMParameterSpec(128, ivBuf));
            } else if ("ECB".equals(mode)) {
                c.init(Cipher.ENCRYPT_MODE, ks);
            } else {
                if (ivBuf == null) throw new RuntimeException("Missing IV for " + mode);
                c.init(Cipher.ENCRYPT_MODE, ks, new IvParameterSpec(ivBuf));
            }
            return Base64.encodeToString(c.doFinal(src), Base64.NO_WRAP);
        } catch (Exception e) {
            throw new RuntimeException("desEncodeToBase64String failed: " + e.getMessage(), e);
        }
    }

    /** 对齐 java-api.js#desDecodeToString：base64 密文解密 → utf-8 字符串（失败抛出，对齐 node 无 catch） */
    public String desDecodeToString(Object data, Object key) {
        return desDecodeToString(data, key, null, null);
    }

    public String desDecodeToString(Object data, Object key, Object transformation) {
        return desDecodeToString(data, key, transformation, null);
    }

    public String desDecodeToString(Object data, Object key, Object transformation, Object iv) {
        try {
            byte[] keyBuf = String.valueOf(key == null ? "" : key).getBytes(StandardCharsets.UTF_8);
            byte[] src = base64DecodeBytes(String.valueOf(data == null ? "" : data));
            String tt = String.valueOf(transformation == null ? "" : transformation).toUpperCase(Locale.ROOT);
            String mode = tt.contains("GCM") ? "GCM" : tt.contains("CBC") ? "CBC"
                    : tt.contains("CFB") ? "CFB" : tt.contains("OFB") ? "OFB" : "ECB";
            boolean isGcm = "GCM".equals(mode);
            String algo = tt.contains("DESEDE") || tt.contains("TRIPLEDES") ? "DESede" : tt.contains("DES") ? "DES" : "AES";
            byte[] keyN = normalizeKey(algo, keyBuf);
            byte[] ivBuf = (iv == null || String.valueOf(iv).isEmpty()) ? null : String.valueOf(iv).getBytes(StandardCharsets.UTF_8);
            Cipher d = Cipher.getInstance(isGcm ? "AES/GCM/NoPadding" : algo + "/" + mode + "/PKCS5Padding");
            SecretKeySpec ks = new SecretKeySpec(keyN, algo);
            if (isGcm) {
                // node 此路径未拆 auth tag，final() 必抛；JCE 同样抛（AEADBadTag），行为等价
                if (ivBuf == null) throw new RuntimeException("GCM requires iv");
                d.init(Cipher.DECRYPT_MODE, ks, new GCMParameterSpec(128, ivBuf));
            } else if ("ECB".equals(mode)) {
                d.init(Cipher.DECRYPT_MODE, ks);
            } else {
                if (ivBuf == null) throw new RuntimeException("Missing IV for " + mode);
                d.init(Cipher.DECRYPT_MODE, ks, new IvParameterSpec(ivBuf));
            }
            return new String(d.doFinal(src), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new RuntimeException("desDecodeToString failed: " + e.getMessage(), e);
        }
    }

    /** node normDesKey 等价：DES 定长 8 字节（短补零、长截断）；DESede 24；AES 按原始字节长（JCE 自动定 128/192/256） */
    private static byte[] normalizeKey(String algo, byte[] keyBuf) {
        int len = "DES".equals(algo) ? 8 : "DESede".equals(algo) ? 24 : keyBuf.length;
        return len == keyBuf.length ? keyBuf : Arrays.copyOf(keyBuf, len);
    }

    // ==================== base64 / md5（无参形态取当前 result，对齐 node str === undefined 分支） ====================

    public String base64() {
        return base64((Object) null);
    }

    /** 对齐 java-api.js#base64：无参=当前 result 编码；传参=编码入参（标准字母表带 padding） */
    public String base64(Object str) {
        String v = str == null ? resultOrEmpty() : String.valueOf(str);
        return Base64.encodeToString(v.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    public String base64Encode() {
        return base64((Object) null);
    }

    public String base64Encode(Object str) {
        return base64(str);
    }

    /**
     * 对齐 legado EncoderUtils#base64Encode(str, flags)：flags 位 1 NO_PADDING / 2 NO_WRAP /
     * 4 CRLF / 8 URL_SAFE（与 android.util.Base64 常量同值——URL_SAFE 切字母表、NO_PADDING 去尾
     * '='、缺 NO_WRAP 时每 76 字符断行且行尾追加分隔符）（原 node 行为: 无 flags 重载，恒标准字母表）。
     */
    public String base64Encode(Object str, int flags) {
        String v = str == null ? resultOrEmpty() : String.valueOf(str);
        byte[] b = v.getBytes(StandardCharsets.UTF_8);
        if (b.length == 0) return "";
        return Base64.encodeToString(b, flags);
    }

    public String base64Decode() {
        return base64Decode((Object) null);
    }

    /** 对齐 java-api.js#base64Decode：node Buffer 宽松语义（容忍 url-safe 变体与非法字符） */
    public String base64Decode(Object str) {
        String v = str == null ? resultOrEmpty() : String.valueOf(str);
        return new String(base64DecodeBytes(v), StandardCharsets.UTF_8);
    }

    /**
     * 对齐 legado EncoderUtils#base64Decode(str, flags)：URL_SAFE 位切字母表，字母表外字符剔除
     * （含换行），缺失 padding 自动补齐（原 node 行为: 无 flags 重载，恒 Buffer 宽松解码）。
     */
    public String base64Decode(Object str, int flags) {
        String v = str == null ? resultOrEmpty() : String.valueOf(str);
        return new String(base64DecodeToByteArray(v, flags), StandardCharsets.UTF_8);
    }

    /** 对齐 legado JsExtensionsCommon#base64DecodeToByteArray(str)：空白输入返回 null（原 node 行为: 无此方法） */
    public byte[] base64DecodeToByteArray(Object str) {
        if (str == null || String.valueOf(str).trim().isEmpty()) return null;
        return base64DecodeToByteArray(str, 0);
    }

    /** 对齐 legado EncoderUtils#base64DecodeToByteArray(str, flags)：flags 同 base64Encode（原 node 行为: 无此方法） */
    public byte[] base64DecodeToByteArray(Object str, int flags) {
        if (str == null || String.valueOf(str).trim().isEmpty()) return null;
        boolean urlSafe = (flags & 8) != 0;
        String s = String.valueOf(str);
        StringBuilder clean = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '=') {
                clean.append(c);
            } else if (urlSafe ? (c == '-' || c == '_') : (c == '+' || c == '/')) {
                clean.append(c);
            }
        }
        int pad = (4 - clean.length() % 4) % 4;
        for (int i = 0; i < pad; i++) clean.append('=');
        return Base64.decode(clean.toString(), (urlSafe ? Base64.URL_SAFE : 0) | Base64.NO_WRAP);
    }

    /** 无参=当前 result（node str === undefined 分支，插件超集保留） */
    public String md5Encode() {
        return md5Encode(resultOrEmpty());
    }

    /** 对齐 legado JsExtensionsCommon#md5Encode（MD5Utils.md5Encode：null → ""；MD5 小写 hex） */
    public String md5Encode(Object str) {
        String v = str == null ? "" : String.valueOf(str);
        try {
            return hexLower(MessageDigest.getInstance("MD5").digest(v.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException("md5 failed: " + e.getMessage(), e);
        }
    }

    /** 对齐 legado MD5Utils#md5Encode16：md5(str).substring(8, 24)；长度不足时返回空串（原 node 行为: 无兜底） */
    public String md5Encode16(Object str) {
        String md5 = md5Encode(str);
        return md5.length() >= 24 ? md5.substring(8, 24) : "";
    }

    /** node Buffer.from(s,'base64') 宽松等价：url-safe 归一 + 非法字符剔除 + 无 padding 容忍 */
    private static byte[] base64DecodeBytes(String s) {
        StringBuilder clean = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '-') clean.append('+');
            else if (c == '_') clean.append('/');
            else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '+' || c == '/' || c == '=') {
                clean.append(c);
            }
        }
        return Base64.decode(clean.toString(), Base64.NO_WRAP);
    }

    private String resultOrEmpty() {
        Object r = bindings.get("result");
        return r == null ? "" : String.valueOf(r);
    }

    // ==================== 加解密（crypto：AES/DES/RC4 常用组合） ====================

    public String aesBase64DecodeToString(Object cipher, Object password) {
        return cryptoDecrypt(cipher, password, null, null, true, false);
    }

    public String aesBase64DecodeToString(Object cipher, Object password, Object transformation) {
        return cryptoDecrypt(cipher, password, transformation, null, true, false);
    }

    /** 对齐 java-api.js#aesBase64DecodeToString(cipher, password, transformation, iv) */
    public String aesBase64DecodeToString(Object cipher, Object password, Object transformation, Object iv) {
        return cryptoDecrypt(cipher, password, transformation, iv, true, false);
    }

    public String aesBase64Decode(Object cipher, Object password) {
        return cryptoDecrypt(cipher, password, null, null, true, true);
    }

    public String aesBase64Decode(Object cipher, Object password, Object transformation) {
        return cryptoDecrypt(cipher, password, transformation, null, true, true);
    }

    public String aesBase64Decode(Object cipher, Object password, Object transformation, Object iv) {
        return cryptoDecrypt(cipher, password, transformation, iv, true, true);
    }

    public String aesDecodeToString(Object cipher, Object password) {
        return cryptoDecrypt(cipher, password, null, null, false, false);
    }

    public String aesDecodeToString(Object cipher, Object password, Object transformation) {
        return cryptoDecrypt(cipher, password, transformation, null, false, false);
    }

    public String aesDecodeToString(Object cipher, Object password, Object transformation, Object iv) {
        return cryptoDecrypt(cipher, password, transformation, iv, false, false);
    }

    public String desBase64DecodeToString(Object cipher, Object password) {
        return cryptoDecrypt(cipher, password, null, null, true, false);
    }

    public String desBase64DecodeToString(Object cipher, Object password, Object transformation) {
        return cryptoDecrypt(cipher, password, transformation, null, true, false);
    }

    public String desBase64DecodeToString(Object cipher, Object password, Object transformation, Object iv) {
        return cryptoDecrypt(cipher, password, transformation, iv, true, false);
    }

    /**
     * 对齐 java-api.js#cryptoDecrypt（4 参缺省 transformation="AES/CBC/PKCS5Padding"）：
     * transformation 形如 "AES/CBC/PKCS5Padding"、"DES/ECB/PKCS5Padding"、"RC4"；
     * base64Input: 密文是否 base64 编码；rawOutput: 输出是否保留二进制 latin1。
     * 密钥长度（Java SecretKeySpec 常规用法）：DES 8 / DESede·TRIPLEDES 24 / 其余 16（短补零长截断）；
     * IV 截断到分组块长；GCM 密文格式 = 密文 + 16 字节认证标签。失败告警后返回 ''（对齐 node catch）。
     */
    private String cryptoDecrypt(Object cipherText, Object password, Object transformation, Object iv,
                                 boolean base64Input, boolean rawOutput) {
        try {
            byte[] data = base64Input
                    ? base64DecodeBytes(String.valueOf(cipherText == null ? "" : cipherText))
                    : String.valueOf(cipherText == null ? "" : cipherText).getBytes(StandardCharsets.ISO_8859_1);
            // 对齐 node 侧 'PADPING' → 'PADDING' 手误修正
            String t = String.valueOf(transformation == null ? "" : transformation)
                    .toUpperCase(Locale.ROOT).replace("PADPING", "PADDING");
            if (t.startsWith("RC4")) {
                byte[] out = rc4Crypt(String.valueOf(password == null ? "" : password).getBytes(StandardCharsets.UTF_8), data);
                return new String(out, rawOutput ? StandardCharsets.ISO_8859_1 : StandardCharsets.UTF_8);
            }
            String[] parts = t.split("/");
            String algoRaw = parts.length > 0 ? parts[0] : "";
            String mode = parts.length > 1 ? parts[1] : "CBC";
            String padding = parts.length > 2 ? parts[2] : "PKCS5";
            boolean isGcm = t.contains("GCM");
            boolean tripleDes = "DESEDE".equals(algoRaw) || "TRIPLEDES".equals(algoRaw);
            boolean isDes = "DES".equals(algoRaw);
            int keyLen = isDes ? 8 : tripleDes ? 24 : 16;
            int blockLen = isDes || tripleDes ? 8 : 16;
            byte[] key = String.valueOf(password == null ? "" : password).getBytes(StandardCharsets.UTF_8);
            if (key.length != keyLen) key = Arrays.copyOf(key, keyLen);
            boolean noPad = "NOPADDING".equalsIgnoreCase(padding);
            byte[] ivBuf = (iv == null || String.valueOf(iv).isEmpty()) ? null : String.valueOf(iv).getBytes(StandardCharsets.UTF_8);
            if (ivBuf != null && ivBuf.length > blockLen) ivBuf = Arrays.copyOf(ivBuf, blockLen);
            if (isGcm) {
                if (ivBuf == null) throw new RuntimeException("GCM requires iv");
                // Java Cipher GCM 密文格式 = 密文 + 认证标签（16 字节），解密前拆出
                byte[] tag = data.length > 16 ? Arrays.copyOfRange(data, data.length - 16, data.length) : new byte[0];
                byte[] ct = data.length > 16 ? Arrays.copyOfRange(data, 0, data.length - 16) : new byte[0];
                Cipher d = Cipher.getInstance("AES/GCM/NoPadding");
                d.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, tag));
                byte[] out = d.doFinal(ct);
                return new String(out, rawOutput ? StandardCharsets.ISO_8859_1 : StandardCharsets.UTF_8);
            }
            Cipher d = Cipher.getInstance(algoRaw + "/" + mode + "/" + (noPad ? "NoPadding" : "PKCS5Padding"));
            SecretKeySpec ks = new SecretKeySpec(key, algoRaw);
            if ("ECB".equalsIgnoreCase(mode)) {
                d.init(Cipher.DECRYPT_MODE, ks);
            } else {
                // node createDecipheriv 对非 ECB 缺 IV 抛错 → catch 返回 ''，此处抛出同走 catch
                if (ivBuf == null) throw new RuntimeException("Missing IV for " + mode);
                d.init(Cipher.DECRYPT_MODE, ks, new IvParameterSpec(ivBuf));
            }
            byte[] out = d.doFinal(data);
            return new String(out, rawOutput ? StandardCharsets.ISO_8859_1 : StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "cryptoDecrypt failed (" + transformation + "): " + e.getMessage());
            return "";
        }
    }

    /** 对齐 java-api.js#rc4Crypt（KSA+PRGA） */
    private static byte[] rc4Crypt(byte[] key, byte[] data) {
        int[] s = new int[256];
        for (int i = 0; i < 256; i++) s[i] = i;
        int j = 0;
        for (int i = 0; i < 256; i++) {
            j = (j + s[i] + (key[i % key.length] & 0xff)) & 0xff;
            int tmp = s[i];
            s[i] = s[j];
            s[j] = tmp;
        }
        byte[] out = new byte[data.length];
        int a = 0;
        j = 0;
        for (int k = 0; k < data.length; k++) {
            a = (a + 1) & 0xff;
            j = (j + s[a]) & 0xff;
            int tmp = s[a];
            s[a] = s[j];
            s[j] = tmp;
            out[k] = (byte) (data[k] ^ s[(s[a] + s[j]) & 0xff]);
        }
        return out;
    }

    // ==================== 章节名中文数字（legado toNumChapter） ====================

    /** 对齐 java-api.js#toNumChapter：章节名「第X章」中文数字转阿拉伯数字（第一百二十三章 → 第123章；无匹配返回原文） */
    public Object toNumChapter(Object s) {
        if (s == null) return null;
        Matcher m = TITLE_NUM.matcher(String.valueOf(s));
        if (!m.find()) return s;
        return "第" + _stringToInt(m.group(1)) + "章";
    }

    /** 对齐 java-api.js#_stringToInt（legado StringUtils.stringToInt）：整串整数解析优先，失败走中文数字 */
    public int _stringToInt(Object str) {
        if (str == null) return -1;
        // fullToHalf：全角转半角
        String s0 = String.valueOf(str);
        StringBuilder sb = new StringBuilder(s0.length());
        for (int i = 0; i < s0.length(); ) {
            int code = s0.codePointAt(i);
            if (code == 12288) sb.append(' ');
            else if (code >= 65281 && code <= 65374) sb.appendCodePoint(code - 65248);
            else sb.appendCodePoint(code);
            i += Character.charCount(code);
        }
        String s = sb.toString().replaceAll("\\s+", "");
        if (s.matches("-?\\d+")) {
            try {
                return Integer.parseInt(s);
            } catch (NumberFormatException e) {
                return -1; // 超出 int（node 返回超宽浮点，无实际书源场景）
            }
        }
        return chineseNumToInt(s);
    }

    /**
     * 对齐 java-api.js#chineseNumToInt（legado StringUtils.chineseNumToInt）：中文数字转整数
     * （权值分段法；「一零二五」位值形式；含〇零一二两三四五六七八九十百千万亿与壹贰叁肆伍陆柒捌玖拾佰仟
     * 大写；无匹配字符返回 -1）。
     */
    private static int chineseNumToInt(String chNum) {
        char[] cn = chNum.toCharArray();
        // 「一零二五」位值形式（legado：长度>1 且每位均为零到九字符）
        boolean positional = cn.length > 1;
        for (char ch : cn) {
            Integer v = CHN_NUM.get(ch);
            if (v == null || v > 9) {
                positional = false;
                break;
            }
        }
        if (positional) {
            StringBuilder digits = new StringBuilder(cn.length);
            for (char ch : cn) digits.append(CHN_NUM.get(ch));
            return Integer.parseInt(digits.toString());
        }
        try {
            int result = 0;
            int tmp = 0;
            int billion = 0;
            for (int i = 0; i < cn.length; i++) {
                Integer num = CHN_NUM.get(cn[i]);
                if (num == null) return -1; // legado ChnMap[cn[i]]!! NPE → runCatching getOrDefault(-1)
                int tmpNum = num;
                if (tmpNum == 100000000) {
                    result += tmp;
                    result *= tmpNum;
                    billion = billion * 100000000 + result;
                    result = 0;
                    tmp = 0;
                } else if (tmpNum == 10000) {
                    result += tmp;
                    result *= tmpNum;
                    tmp = 0;
                } else if (tmpNum >= 10) {
                    if (tmp == 0) tmp = 1;
                    result += tmpNum * tmp;
                    tmp = 0;
                } else {
                    // 「一千二」省略位形式：末位数字 × 前一权值 / 10
                    Integer prev = i >= 1 ? CHN_NUM.get(cn[i - 1]) : null;
                    tmp = (i >= 2 && i == cn.length - 1 && prev != null && prev > 10)
                            ? (int) (tmpNum * prev / 10.0)
                            : tmp * 10 + tmpNum;
                }
            }
            return result + tmp + billion;
        } catch (Exception e) {
            return -1;
        }
    }

    private static final Map<Character, Integer> CHN_NUM = new HashMap<>();

    static {
        putChn('零', 0);
        putChn('〇', 0);
        putChn('一', 1);
        putChn('壹', 1);
        putChn('二', 2);
        putChn('两', 2);
        putChn('贰', 2);
        putChn('三', 3);
        putChn('叁', 3);
        putChn('四', 4);
        putChn('肆', 4);
        putChn('五', 5);
        putChn('伍', 5);
        putChn('六', 6);
        putChn('陆', 6);
        putChn('七', 7);
        putChn('柒', 7);
        putChn('八', 8);
        putChn('捌', 8);
        putChn('九', 9);
        putChn('玖', 9);
        putChn('十', 10);
        putChn('拾', 10);
        putChn('百', 100);
        putChn('佰', 100);
        putChn('千', 1000);
        putChn('仟', 1000);
        putChn('万', 10000);
        putChn('亿', 100000000);
    }

    private static void putChn(char c, int v) {
        CHN_NUM.put(c, v);
    }

    // ==================== 书源 header 解析（java.ajax 默认请求头来源） ====================

    /**
     * 对齐 java-api.js#parseSourceHeaders（BaseSource.getHeaderMap）：解析书源 header 字段 →
     * 请求头。@js:/&lt;js&gt; 前缀先求值（baseUrl 绑书源地址，如 `{"Referer":baseUrl}`），产物再解析；
     * 纯文本容忍单引号宽松 JSON（JS 求值兜底）；无 UA 补默认。header 缺省返回空 Map（node if (!raw)
     * 早退——不补默认 UA，对齐）。
     *
     * @param source 书源对象（Map 形态，读 header/bookSourceUrl/jsLib 字段）
     * @param ctx    求值上下文（可空；为空时以书源地址构造最小上下文）
     */
    public static Map<String, String> parseSourceHeaders(Object source, Map<String, Object> ctx) {
        LinkedHashMap<String, String> headers = new LinkedHashMap<>();
        if (!(source instanceof Map)) return headers;
        Object raw = ((Map<?, ?>) source).get("header");
        if (raw == null || String.valueOf(raw).isEmpty()) return headers;
        String text = String.valueOf(raw).trim();
        try {
            Object obj = null;
            if (text.regionMatches(true, 0, "@js:", 0, 4) || text.startsWith("<js>")) {
                String code = text.regionMatches(true, 0, "@js:", 0, 4)
                        ? text.substring(4)
                        : text.substring(4, text.lastIndexOf('<'));
                Map<String, Object> jctx = ctx != null ? ctx : new LinkedHashMap<String, Object>();
                if (!(jctx.get("source") instanceof Map)) jctx.put("source", source);
                if (jctx.get("java") == null) jctx.put("java", new JsExtensions(jctx));
                // node runJs 语义：source.jsLib 前置为共享全局作用域
                StringBuilder js = new StringBuilder();
                Object lib = ((Map<?, ?>) source).get("jsLib");
                if (lib != null && !String.valueOf(lib).trim().isEmpty()) js.append(lib).append("\n;\n");
                js.append(code);
                Map<String, Object> b = new LinkedHashMap<>(jctx);
                b.put("result", text);
                Object r = JsEngine.eval(js.toString(), b);
                obj = r instanceof Map ? r : GSON.fromJson(String.valueOf(r), Map.class);
            } else {
                try {
                    obj = GSON.fromJson(text, Map.class);
                } catch (Exception ignored) {
                    // 宽松 JS 对象字面量（单引号/无引号键）→ JS 求值兜底（node vm 1s 超时，失败走 UA 提取）
                    Object v = JsEngine.eval("(" + text + ")", null);
                    if (v instanceof Map) obj = v;
                }
            }
            if (obj instanceof Map) {
                // 空值头跳过：legado 原样发送空值 header，node undici 校验直接炸（如 "Keep-Alive":""）
                for (Map.Entry<?, ?> e : ((Map<?, ?>) obj).entrySet()) {
                    if (e.getValue() != null && !String.valueOf(e.getValue()).isEmpty()) {
                        headers.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
                    }
                }
            }
        } catch (Exception e) {
            Matcher m = UA_IN_HEADER.matcher(text);
            if (m.find()) headers.put("User-Agent", m.group(1));
        }
        if (!headers.containsKey("User-Agent")) {
            headers.put("User-Agent", DEFAULT_UA);
        }
        return headers;
    }

    // ==================== 内部辅助 ====================

    /** ajax/post/ajaxAll 合并请求头的来源：书源 header 字段解析（node defaultHeaders） */
    private Map<String, String> defaultHeaders() {
        return parseSourceHeaders(bindings.get("source"), bindings);
    }

    private static String hexLower(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** decodeURIComponent 等价：%XX 按字节收集、其余字符按 UTF-8 编码收集；畸形序列抛错（调用方回退原文） */
    private static String decodePercent(String s) {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); ) {
            char c = s.charAt(i);
            if (c == '%') {
                if (i + 2 >= s.length()) throw new IllegalArgumentException("URI malformed");
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) throw new IllegalArgumentException("URI malformed");
                buf.write((hi << 4) | lo);
                i += 3;
            } else {
                int cp = s.codePointAt(i);
                for (byte b : new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8)) buf.write(b);
                i += Character.charCount(cp);
            }
        }
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }

    /** encodeURIComponent 等价：unreserved A-Za-z0-9-_.!~*'() 保留，其余 UTF-8 百分号编码（大写） */
    private static String encodeURIComponent(String s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            if (cp < 128 && isUriUnreserved(cp)) {
                out.append((char) cp);
            } else {
                for (byte b : new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8)) {
                    out.append('%').append(String.format("%02X", b));
                }
            }
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    private static boolean isUriUnreserved(int cp) {
        return (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9')
                || cp == '-' || cp == '_' || cp == '.' || cp == '!' || cp == '~'
                || cp == '*' || cp == '\'' || cp == '(' || cp == ')';
    }

    private static String truncate(String s, int len) {
        if (s == null) return "";
        return s.length() > len ? s.substring(0, len) : s;
    }
}
