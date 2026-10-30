package bh.box.plugin.legado.engine;

import android.util.Log;

import com.google.gson.Gson;

import java.nio.charset.Charset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * URL 规则解析与请求编码辅助（对齐 app/server/src/engine/urlrule.js 全量 +
 * http.js 中被 java-api.js#ajax 引用的 formEncode/formEncodeParams/applyPostBody/encodeUrlQuery 子集）。
 * 供 JsExtensions（java.ajax/post/ajaxAll）与 T4 服务层（bh.box.plugin.legado.t4）共用，
 * 故声明为 public。
 *
 * node 版差异说明：
 * - parseOptions 的宽松 JS 对象字面量求值（vm.runInNewContext 2s 超时）以 JsEngine.eval 等价实现
 *   （Rhino 解释模式无求值超时，对象字面量无死循环风险）；
 * - iconv 编码以 String.getBytes(Charset) 等价，hex 大写、空格转 + 等细节逐一对齐。
 */
public final class UrlRule {

    private static final String TAG = "legado-engine";

    private static final Gson GSON = new Gson();

    /** 对齐 urlrule.js#findOptionsStart：/\s*,\s*(?=\{)/ */
    private static final Pattern OPTIONS_START = Pattern.compile("\\s*,\\s*(?=\\{)");

    /** 对齐 http.js#encodeUrlQuery 的 /^utf-?8$/i 判定 */
    private static final Pattern UTF8_NAME = Pattern.compile("utf-?8", Pattern.CASE_INSENSITIVE);

    private UrlRule() {}

    /** 解析结果：url 与 options 尾巴（字段语义见 Options 注释） */
    public static final class Parsed {
        /** options 尾巴之前的地址段（trim 后） */
        public final String url;
        /** options 尾巴解析产物（无尾巴/解析失败为全空 Options） */
        public final Options options;

        Parsed(String url, Options options) {
            this.url = url;
            this.options = options;
        }
    }

    /** options 尾巴字段（对齐 urlrule.js#parseOptions 返回面） */
    public static final class Options {
        /** 大写方法名；解析成功恒有值（缺省 GET），无尾巴/解析失败为 null */
        public String method;
        /** 请求体（Map/List 形态已序列化为 JSON 文本，对齐 legado postJson）；无则 null */
        public String body;
        /** 请求头（值转字符串；空值头保留，对齐 normalizeHeaders v != null 语义）；无则 null */
        public Map<String, String> headers;
        /** 响应解码/查询串编码字符集；无则 null */
        public String charset;
        public boolean webView;
        /** legado UrlOption.js：解析完 url 参数后执行的 JS（结果赋值给 url，由调用方决定是否执行） */
        public String js;
        public String type;
        public Double retry;
    }

    /**
     * 对齐 urlrule.js#parseUrlRule：解析完整 URL 规则 → { url, options }
     * （url 中的 {{}} 模板由调用方先行渲染）。
     */
    public static Parsed parseUrlRule(String rule) {
        String r = rule == null ? "" : rule;
        Matcher m = OPTIONS_START.matcher(r);
        if (m.find()) {
            int start = m.start();
            int end = matchBrace(r, start);
            if (end >= 0) {
                return new Parsed(r.substring(0, start).trim(), parseOptions(r.substring(start + 1, end + 1)));
            }
        }
        return new Parsed(r.trim(), new Options());
    }

    /** 对齐 urlrule.js#splitUrlRule + matchBrace：从 ',' 后的 '{' 起配对扫描（忽略引号内内容） */
    private static int matchBrace(String s, int open) {
        int depth = 0;
        char quote = 0;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (quote != 0) {
                if (c == '\\') i++;
                else if (c == quote) quote = 0;
                continue;
            }
            if (c == '\'' || c == '"') {
                quote = c;
                continue;
            }
            if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    /** 对齐 urlrule.js#parseOptions：options 文本（宽松 JS 对象字面量）→ 规范化 Options；解析失败返回空 Options */
    private static Options parseOptions(String text) {
        if (text == null || text.trim().isEmpty()) return new Options();
        try {
            // node: vm.runInNewContext('(' + text + ')')——括号包成表达式求值；
            // JsEngine.expand 将 NativeObject 展开为 LinkedHashMap
            Object v = JsEngine.eval("(" + text + ")", null);
            if (!(v instanceof Map)) return new Options();
            Map<?, ?> obj = (Map<?, ?>) v;
            Options o = new Options();
            Object m = obj.get("method");
            o.method = truthy(m) ? String.valueOf(m).toUpperCase(Locale.ROOT) : "GET";
            // body 为对象/数组时序列化为 JSON 文本（legado postJson：Map/List body → JSON 请求体），
            // 否则 String() 会得到 "[object Object]" 垃圾请求体
            Object bodyV = obj.get("body");
            if (bodyV != null) {
                o.body = (bodyV instanceof Map || bodyV instanceof List) ? GSON.toJson(bodyV) : String.valueOf(bodyV);
            }
            o.headers = normalizeHeaders(obj.get("headers"));
            Object cs = obj.get("charset");
            if (truthy(cs)) o.charset = String.valueOf(cs);
            o.webView = truthy(obj.get("useWebView")) || truthy(obj.get("webView"));
            Object js = obj.get("js");
            if (truthy(js)) o.js = String.valueOf(js);
            Object type = obj.get("type");
            if (truthy(type)) o.type = String.valueOf(type);
            Object retry = obj.get("retry");
            if (retry instanceof Number) o.retry = ((Number) retry).doubleValue();
            return o;
        } catch (Exception e) {
            Log.w(TAG, "options parse failed: " + e.getMessage());
            return new Options();
        }
    }

    /** node truthy 语义（"" / 0 / false / null 为假，"0" 为真） */
    private static boolean truthy(Object v) {
        if (v == null) return false;
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof Number) return ((Number) v).doubleValue() != 0;
        if (v instanceof String) return !((String) v).isEmpty();
        return true;
    }

    /** 对齐 urlrule.js#normalizeHeaders：非对象 → null；值非 null 即收（空串保留） */
    private static Map<String, String> normalizeHeaders(Object h) {
        if (!(h instanceof Map)) return null;
        LinkedHashMap<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : ((Map<?, ?>) h).entrySet()) {
            if (e.getValue() != null) out.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
        }
        return out;
    }

    /**
     * 对齐 http.js#formEncode：application/x-www-form-urlencoded 按 charset 编码——
     * 白名单 [A-Za-z0-9*.\-_] 保留，空格 → +，其余字符 → charset 字节 → %XX（大写）。
     * charset 不可用/未知时抛异常，由调用方兜底（对齐 node iconv 抛错路径）。
     */
    public static String formEncode(String s, String charset) {
        Charset cs = charsetOf(charset);
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            if (cp < 128 && isFormSafe(cp)) {
                out.append((char) cp);
            } else if (cp == ' ') {
                out.append('+');
            } else {
                for (byte b : new String(Character.toChars(cp)).getBytes(cs)) {
                    out.append('%').append(String.format("%02X", b));
                }
            }
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    /**
     * 对齐 http.js#formEncodeParams：POST 表单体分段编码（legado encodeUrlParams isQuery=false）——
     * 去尾 &，按 & 拆段、首 '=' 拆 key/value 分别编码；无 charset 时已编码段原样保留（checkEncoded），
     * charset="escape" 走 UTF-8 百分号编码近似。
     */
    public static String formEncodeParams(String str, String charset) {
        String cs = charset != null && !"escape".equals(charset) ? charset : "utf-8";
        boolean checkEncoded = charset == null || charset.isEmpty();
        String s = str.endsWith("&") ? str.substring(0, str.length() - 1) : str;
        String[] segs = s.split("&", -1);
        int start = 0;
        while (start < segs.length && segs[start].isEmpty()) start++;
        StringBuilder out = new StringBuilder(s.length());
        for (int i = start; i < segs.length; i++) {
            if (i > start) out.append('&');
            String seg = segs[i];
            int eq = seg.indexOf('=');
            if (eq < 0) {
                out.append(encParam(seg, cs, checkEncoded));
            } else {
                out.append(encParam(seg.substring(0, eq), cs, checkEncoded))
                        .append('=')
                        .append(encParam(seg.substring(eq + 1), cs, checkEncoded));
            }
        }
        return out.toString();
    }

    private static String encParam(String v, String cs, boolean checkEncoded) {
        return checkEncoded && encodedForm(v) ? v : formEncode(v, cs);
    }

    /** 对齐 http.js#encodedForm：白名单 0-9a-zA-Z*-._，合法 %XX（两位 hex）跳过，其余视为未编码 */
    private static boolean encodedForm(String str) {
        for (int i = 0; i < str.length(); i++) {
            char c = str.charAt(i);
            if (c < 256 && isFormSafe(c)) continue;
            if (c == '%' && i + 2 < str.length() && isHex(str.charAt(i + 1)) && isHex(str.charAt(i + 2))) {
                i += 2;
                continue;
            }
            return false;
        }
        return true;
    }

    /**
     * 对齐 http.js#applyPostBody：legado AnalyzeUrlCore POST 三分支（原地补 headers）——
     * body 为空 → 空体 + 表单 CT；body 非 JSON/XML 且无 Content-Type → 分段 URL 编码 + 表单 CT；
     * body 为 JSON/XML 或显式 Content-Type → 原样发送（无 CT 时补 JSON CT）。
     * 非 POST 返回 null（对齐 node applyPostBody 返回 undefined）。
     */
    public static String applyPostBody(String method, String raw, Map<String, String> headers, String charset) {
        if (!"POST".equals(method)) return null;
        String ctKey = null;
        for (String k : headers.keySet()) {
            if (k != null && "content-type".equals(k.toLowerCase(Locale.ROOT))) {
                ctKey = k;
                break;
            }
        }
        String r = raw == null ? "" : raw;
        if (r.isEmpty()) {
            if (ctKey == null) headers.put("Content-Type", "application/x-www-form-urlencoded");
            return "";
        }
        if (ctKey == null && !isJsonLike(r) && !isXmlLike(r)) {
            headers.put("Content-Type", "application/x-www-form-urlencoded");
            return formEncodeParams(r, charset);
        }
        if (ctKey == null) headers.put("Content-Type", "application/json; charset=UTF-8");
        return r;
    }

    /** 对齐 http.js#isJsonLike：body 首尾包络判定（legado StringExtensions.isJson） */
    private static boolean isJsonLike(String s) {
        String t = s.trim();
        return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
    }

    /** 对齐 http.js#isXmlLike（legado StringExtensions.isXml） */
    private static boolean isXmlLike(String s) {
        String t = s.trim();
        return t.startsWith("<") && t.endsWith(">");
    }

    /**
     * 对齐 http.js#encodeUrlQuery：GET query 段按 charset 编码（legado encodeUrlParams isQuery=true）——
     * 整体已编码原样，否则非安全字符（非 ASCII / JS \s / " <>{}|\^`）按 charset 百分号编码，
     * & = / 等结构符保留；utf-8 缺省时 fetch 原生 UTF-8 编码等价，仅在 gbk 等显式 charset 时介入。
     */
    public static String encodeUrlQuery(String url, String charset) {
        if (charset == null || UTF8_NAME.matcher(charset).matches()) return url;
        int pos = url.indexOf('?');
        if (pos < 0) return url;
        String q = url.substring(pos + 1);
        boolean alreadyEncoded = true;
        for (int i = 0; i < q.length(); i++) {
            char c = q.charAt(i);
            if (c == '%' && i + 2 < q.length() && isHex(q.charAt(i + 1)) && isHex(q.charAt(i + 2))) {
                i += 2;
                continue;
            }
            if (isQuerySafe(c)) continue;
            alreadyEncoded = false;
            break;
        }
        if (alreadyEncoded) return url;
        Charset cs = charsetOf(charset);
        StringBuilder out = new StringBuilder(url.length());
        out.append(url, 0, pos + 1);
        for (int i = 0; i < q.length(); ) {
            int cp = q.codePointAt(i);
            // node 替换集 [\u0080-\uffff\s"<>{}|\\^`]；增补平面字符 node 版按 UTF-16 码元错编，
            // 此处按 Unicode 码点整字编码（BMP 字符结果一致）
            if (cp >= 0x80 || isJsSpace((char) cp) || "\"<>{}|\\^`".indexOf((char) cp) >= 0) {
                for (byte b : new String(Character.toChars(cp)).getBytes(cs)) {
                    out.append('%').append(String.format("%02X", b));
                }
            } else {
                out.appendCodePoint(cp);
            }
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    /** 对齐 http.js#encodeUrlQuery 已编码白名单：[A-Za-z0-9*\-._!$&'()+,;=@:\/?~#[\]]（全 ASCII） */
    private static boolean isQuerySafe(char c) {
        return c < 256 && (isFormSafe(c) || "!$&'()+,;=@:/?~#[]".indexOf(c) >= 0);
    }

    /** formEncode/encodedForm 共用白名单 [A-Za-z0-9*.\-_] */
    private static boolean isFormSafe(int cp) {
        return (cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9')
                || cp == '*' || cp == '.' || cp == '-' || cp == '_';
    }

    private static boolean isHex(char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }

    /** JS 正则 \s 等价字符集（含 \u00a0 等非换行空白） */
    private static boolean isJsSpace(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\u000B' || c == '\f' || c == '\r'
                || c == 0x00A0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A)
                || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
    }

    private static Charset charsetOf(String name) {
        return Charset.forName((name == null ? "utf-8" : name).toLowerCase(Locale.ROOT));
    }
}
