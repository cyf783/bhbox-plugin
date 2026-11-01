package bh.box.plugin.legado.engine;

import android.util.Log;

import java.util.Map;
import java.util.regex.Pattern;

/**
 * {{}} 模板渲染（对齐 app/server/src/engine/template.js#render / matchDoubleBrace / evalExpr，
 * URL 与规则通用）。{{expr}} 内为 JS 表达式：bindings 注入变量（node 的 vars 变量池与
 * key/result 等上下文名由调用方合并注入）+ java.* 调用 + $.path（JSON 上下文）。
 */
public final class TemplateRenderer {

    private static final String TAG = "legado-engine";

    /** 对齐 template.js#evalExpr 纯变量名判定 /^[A-Za-z_$][\w$]*$/ */
    private static final Pattern IDENT = Pattern.compile("[A-Za-z_$][\\w$]*");

    private TemplateRenderer() {}

    /**
     * 对齐 template.js#render：渲染模板字符串中的 {{expr}}。
     * 空值处理：求值结果 null → ''；单段求值失败该段置空、整条规则继续
     * （legado makeUpRule 语义，避免原样保留 {{...}} 被下游当 URL 反复抓取刷屏）。
     *
     * @param tpl      模板串（null 或不含 {{ 原样返回，null → ''）
     * @param bindings 求值上下文（透传 JsEngine.eval 注入作用域）
     * @return 渲染结果
     */
    public static String render(String tpl, Map<String, Object> bindings) {
        if (tpl == null || tpl.isEmpty() || !tpl.contains("{{")) return tpl == null ? "" : tpl;
        // source/book 桥兜底：bindings.source 为裸 Map 时（调用方未经 RuleAnalyzer/
        // T4Actions.ensureBridges），包桥注入——模板段 JS 对 source.getVariable() 等方法面
        // 的调用才能命中（对齐阅读 AnalyzeRule bindings 注入 BookSource 实例语义）
        if (bindings != null && !(bindings.get("source") instanceof SourceBridge)) {
            Object raw = bindings.get("source");
            if (raw instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> rawMap = (Map<String, Object>) raw;
                Object existing = rawMap.get("__bridge__");
                if (existing instanceof SourceBridge) {
                    bindings.put("source", existing);
                } else {
                    Object sk = rawMap.get("bookSourceUrl");
                    SourceBridge sb = new SourceBridge(
                            sk != null ? String.valueOf(sk).trim() : "", rawMap);
                    rawMap.put("__bridge__", sb);
                    bindings.put("source", sb);
                }
            }
        }
        if (bindings != null && !(bindings.get("book") instanceof BookBridge)) {
            Object raw = bindings.get("book");
            if (raw instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> rawMap = (Map<String, Object>) raw;
                Object existing = rawMap.get("__bridge__");
                if (existing instanceof BookBridge) {
                    bindings.put("book", existing);
                } else {
                    BookBridge bb = new BookBridge(rawMap);
                    rawMap.put("__bridge__", bb);
                    bindings.put("book", bb);
                }
            }
        }
        // 对齐 render 主循环：indexOf 找 {{，matchDoubleBrace 引号感知找配对 }}
        StringBuilder out = new StringBuilder(tpl.length());
        int i = 0;
        while (i < tpl.length()) {
            int open = tpl.indexOf("{{", i);
            if (open < 0) {
                out.append(tpl, i, tpl.length());
                break;
            }
            out.append(tpl, i, open);
            int close = matchDoubleBrace(tpl, open + 2);
            if (close < 0) {
                out.append(tpl, open, tpl.length());
                break;
            }
            String expr = tpl.substring(open + 2, close).trim();
            try {
                Object v = evalExpr(expr, bindings);
                // 空值处理：null → ''（node: v == null ? '' : String(v)）
                out.append(v == null ? "" : String.valueOf(v));
            } catch (Exception e) {
                Log.w(TAG, "template render failed: " + expr + ": " + e.getMessage());
                // 单段求值失败该段置空（node catch 分支 out += ''）
            }
            i = close + 2;
        }
        return out.toString();
    }

    /**
     * 对齐 template.js#matchDoubleBrace：从 start 找配对 }}（引号内字符与 { 深度不参与；
     * \ 转义感知——JSON.stringify 产物 {{java.get(\"id\")}} 中 quote 态外的 \ 必须跳过，
     * 否则引号状态错乱导致找不到配对 }}，模板段整体原样保留）。
     */
    private static int matchDoubleBrace(String tpl, int start) {
        int depth = 0;
        char quote = 0;
        for (int i = start; i < tpl.length() - 1; i++) {
            char c = tpl.charAt(i);
            if (quote != 0) {
                if (c == '\\') { i++; continue; }
                if (c == quote) quote = 0;
                continue;
            }
            if (c == '\\') { i++; continue; }
            if (c == '\'' || c == '"' || c == '`') { quote = c; continue; }
            if (c == '{') { depth++; continue; }
            if (c == '}') {
                if (depth > 0) { depth--; continue; }
                if (tpl.charAt(i + 1) == '}') return i;
            }
        }
        return -1;
    }

    /**
     * 对齐 template.js#evalExpr：求值单个 {{}} 表达式。
     * $. / $[ 开头为 JSONPath 子规则（不进 JS 沙箱，走 JsonPathRule）；@ 与 / 开头为
     * 规则语法（CSS/XPath），需 analyzer 的 evalRule 上下文——本批次未移植，段置空
     * （同 node「无 evalRule 上下文时同样段置空」）；纯变量名查 bindings（node 的
     * page ?? 1 / sourceKey / title 等逐名缺省语义对齐保留），其余走 JsEngine.eval。
     */
    public static Object evalExpr(String expr, Map<String, Object> bindings) {
        // JSON.stringify 产物残留：{{java.get(\"id\")}} 引号转义还原为 "（阅友等加密源常态）
        if (expr.contains("\\\"")) expr = expr.replace("\\\"", "\"");
        // $. / $[ 开头：作为 JSONPath 子规则对当前内容求值（legado AnalyzeByJSonPath 语义）
        if (expr.startsWith("$.") || expr.startsWith("$[")) {
            Object data = bindings != null ? bindings.get("data") : null;
            if (data == null) {
                // JSON 上下文缺失时对 result 文本（当前内容）做严格 JSON.parse 尝试，
                // 解析失败按无匹配返回空（JsonPathRule#normalize 同语义）
                Object resultObj = bindings != null ? bindings.get("result") : null;
                if (resultObj instanceof String) {
                    String t = ((String) resultObj).trim();
                    if (t.startsWith("{") || t.startsWith("[")) data = t;
                }
            }
            if (data != null) return KotlinBridge.jsonLookup(data, expr);
            return null; // 无 JSON 上下文 → 段置空
        }
        // @（CSS/JSON 规则）与 /（XPath）开头：不进 JS 沙箱，本批次无 evalRule 上下文 → 段置空
        if (expr.startsWith("@") || expr.startsWith("/")) return null;
        // a.b.c 纯属性链：bindings 根为 Map 时逐级取值（{{book.kind}}/{{source.bookSourceUrl}}——
        // JS 沙箱对 Java Map 注入的属性点访问不通，legado book 实例属性语义对齐）；含方法调用
        // 括号或下标的仍走 JS 沙箱
        if (!expr.contains("(") && !expr.contains("[") && expr.indexOf('.') > 0) {
            Object cur = bindings;
            for (String part : expr.split("\\.")) {
                cur = cur instanceof Map ? ((Map<?, ?>) cur).get(part) : null;
                if (cur == null) break;
            }
            if (cur != null) return cur;
        }
        if (IDENT.matcher(expr).matches()) {
            // 对齐 node：page/searchPage → ctx.page ?? 1
            if ("page".equals(expr) || "searchPage".equals(expr)) {
                Object p = bindings != null ? bindings.get("page") : null;
                return p != null ? p : 1;
            }
            if (bindings != null) {
                // node 的 vars 变量池与 key/searchKey/result/src 等上下文名由调用方合并注入，统一查表
                Object v = bindings.get(expr);
                if (v != null) return v;
                // node: sourceKey → source.bookSourceUrl ?? ''
                if ("sourceKey".equals(expr)) {
                    Object sk = mapGet(bindings.get("source"), "bookSourceUrl");
                    return sk != null ? sk : "";
                }
                // node: title → ctx.title ?? (chapter?.title ?? '')
                if ("title".equals(expr)) {
                    Object t = bindings.get("title");
                    if (t != null) return t;
                    Object ct = mapGet(bindings.get("chapter"), "title");
                    return ct != null ? ct : "";
                }
                // node: expr in ctx.source → source[expr]
                Object sv = mapGet(bindings.get("source"), expr);
                if (sv != null) return sv;
            }
            // 未命中 → JS 沙箱（jsLib 名字命中；真未定义名抛 ReferenceError，由 render 捕获置空）
            return JsEngine.eval(prependJsLib(expr, bindings), withJavaBridge(bindings));
        }
        return JsEngine.eval(prependJsLib(expr, bindings), withJavaBridge(bindings));
    }

    /** bindings 无 java 桥时注入（长佩 searchUrl 的 {{java.put("key",key);key}} 依赖——
     *  URL 构建段的模板表达式不在 buildJsBindings/buildRenderBindings 链上） */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> withJavaBridge(Map<String, Object> bindings) {
        if (bindings != null && !(bindings.get("java") instanceof JsExtensions)) {
            bindings.put("java", new JsExtensions(bindings));
        }
        return bindings;
    }

    /**
     * jsLib 前置（对齐 template.js#runJs 的 jsLib 共享作用域语义）：书源 jsLib 定义的共享函数
     * （GetUL/Sort_/Ajax 等）在 {{}} 模板表达式内直接裸调——阅读 App 中 jsLib 先于模板求值
     * 常驻执行（SharedJsScope topScope），此处以源码前置等价（表达式每次重执行函数定义，
     * 幂等无害；loginUrl 顶部变量初始化自带 try/catch 可重复执行）。
     */
    private static String prependJsLib(String expr, Map<String, Object> bindings) {
        if (bindings == null) return expr;
        // source 可能是 SourceBridge（render 入口桥兜底后）或裸 Map——两态都取 jsLib
        Object srcObj = bindings.get("source");
        Object lib = null;
        if (srcObj instanceof SourceBridge) {
            lib = ((SourceBridge) srcObj).getProperty("jsLib");
        } else if (srcObj instanceof Map) {
            lib = ((Map<?, ?>) srcObj).get("jsLib");
        }
        if (lib instanceof String && !((String) lib).trim().isEmpty()) {
            String s = (String) lib;
            if (expr.contains(s)) return expr; // 表达式本身已含 jsLib（防重复拼接）
            return s + "\n;\n" + expr;
        }
        return expr;
    }

    /** source/chapter 等 node 上下文对象以 Map 形态注入 bindings：安全取属性 */
    private static Object mapGet(Object obj, String key) {
        if (!(obj instanceof Map)) return null;
        return ((Map<?, ?>) obj).get(key);
    }
}
