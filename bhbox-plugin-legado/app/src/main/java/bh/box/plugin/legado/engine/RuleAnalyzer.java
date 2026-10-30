package bh.box.plugin.legado.engine;

import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import io.legado.app.model.analyzeRule.AnalyzeByJSonPath;
import io.legado.app.model.analyzeRule.AnalyzeByJSoup;
import io.legado.app.model.analyzeRule.AnalyzeByRegex;
import io.legado.app.model.analyzeRule.AnalyzeByXPath;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Element;
import org.mozilla.javascript.Context;
import org.mozilla.javascript.NativeArray;
import org.mozilla.javascript.NativeObject;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;
import org.mozilla.javascript.Undefined;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * 规则执行总入口（对齐 app/server/src/engine/analyzer.js，逐函数移植）：
 * 方言分发（@CSS/@XPath/@Json/Default）+ ## 正则净化 + || && %% 组合 + {{}} 模板 +
 * <js>/@js: 混排 + AllInOne 正则（: 开头）+ @get/@put 变量池。
 *
 * 内容表示对齐 node repr：{@link Repr}（html: jsoup Element 根；json: Gson JsonElement；
 * xml: org.w3c.dom 节点；text: 文本；正则 list 条目另带捕获组 groups）。
 *
 * ctx 约定（对齐 node ctx 对象；node 没有的按最小 Map 设计，注释标注）：
 * - "vars"：Map&lt;String,Object&gt; 变量池（@get/@put/java.put/get 共用；node ctx.vars，
 *   缺失时 @put 处自动建池写入同一 ctx）
 * - "source"/"book"：Map 书源/书本对象（jsLib、bookSourceUrl 等键值访问）
 * - "result"：当前内容文本（URL 构建与 JS 沙箱 src 绑定基准）
 * - "baseUrl"/"page"/"key"/"chapter"/"title"/"cookie"/"cache"：请求上下文名（node 同名透传）
 * - "java"：宿主 java.* 桥对象（本批次未注入，JS 侧调用报错由分段置空兜底，后续批次接线）
 * - "root"：runJsRule 执行时写回 ctx（本次求值的根 Repr；对齐 node ctx.root 注入，
 *   供 java.getString 默认对整页内容求值）
 */
public final class RuleAnalyzer {

    private static final String TAG = "legado-engine";

    /** JSON 序列化（disableHtmlEscaping 对齐 node JSON.stringify 不转义 HTML 字符） */
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    static {
        // 必须先于本类任何 Context.enter() 触发 JsEngine 静态初始化：
        // JsEngine 的 ContextFactory.initGlobal 只允许在首个 context 创建前完成，
        // 顺序颠倒会令 initGlobal 抛 "Cannot initialize global factory twice"
        try {
            Class.forName("bh.box.plugin.legado.engine.JsEngine");
        } catch (Throwable ignore) {
            // 同包类缺失属编译期错误，忽略仅防御反射受限环境
        }
    }

    private RuleAnalyzer() {}

    // ============ 公共入口 ============

    /**
     * 字段规则求值（对齐 analyzer.js#analyzeStr：返回字符串；单字段失败降级为空不炸穿调用方）。
     *
     * @param rule    规则串（支持 || && %% / ## / {{}} / &lt;js&gt;/@js: / @css:@json:@xpath: / :正则 / @get@put）
     * @param content 内容（String 原始文本 / {@link Repr} / jsoup Element / w3c Node / Map·List JSON）
     * @param ctx     执行上下文（见类注释约定；null 自动建空 Map）
     */
    public static String evalRule(String rule, Object content, Map<String, Object> ctx) {
        return evalRule(rule, content, ctx, false);
    }

    /**
     * 对齐 analyzeStr(content, rule, ctx, isUrl=true)：Default 方言取收集列表第一项
     * （bookUrl/tocUrl 等单值 URL 字段专用，其余方言不受影响）。
     */
    public static String evalRule(String rule, Object content, Map<String, Object> ctx, boolean isUrl) {
        if (rule == null) return "";
        Map<String, Object> c = ctx != null ? ctx : new LinkedHashMap<String, Object>();
        Repr repr = toRepr(content);
        // 对齐 legado AnalyzeRule#this.content：{{@rule}}/{{$.x}} 等内嵌子规则对整页内容求值
        c.put("root", repr);
        try {
            Object out = dispatch(repr, String.valueOf(rule).trim(), c, false, isUrl);
            if (out == null) return "";
            // node：对象值 → JSON 字符串（legado elementToString 语义），其余 String(out)
            String s = stringifyOut(out);
            String str = unescapeHtml(s);
            if (isUrl) {
                // 对齐 legado AnalyzeRule#getString（isUrl=true）：含 "::" 原样返回、空结果取
                // baseUrl、data URL 直通、其余相对地址对 baseUrl 绝对化
                // （原 node 行为: 求值结果原样返回，不做 URL 处理）
                if (str.contains("::")) return str;
                Object b = c.get("baseUrl");
                String base = b != null ? String.valueOf(b) : "";
                if (str.trim().isEmpty()) return base;
                if (str.startsWith("data:")) return str;
                return toAbsoluteUrl(base, str);
            }
            return str;
        } catch (Exception e) {
            Log.w(TAG, "evalRule failed [" + truncate(rule, 60) + "]: " + e.getMessage(), e);
            return "";
        }
    }

    /**
     * 列表规则求值（对齐 analyzer.js#analyzeList：返回条目数组）。
     * 条目为 {@link Repr}（元素/JSON/文本统一包装，正则条目带 groups）；Kotlin 方言引擎
     * （AnalyzeByJSoup/AnalyzeByXPath/AnalyzeByRegex）返回的 ksoup 元素/捕获组条目由
     * wrapItem 统一重建为 Java 侧 repr（html → jsoup Element、json → Gson 树）。
     * 空规则 → 单元素列表（整文档自身，对齐 node return [content]）。
     */
    public static List<Object> evalRuleList(String rule, Object content, Map<String, Object> ctx) {
        Map<String, Object> c = ctx != null ? ctx : new LinkedHashMap<String, Object>();
        if (rule == null || rule.trim().isEmpty()) {
            List<Object> single = new ArrayList<>(1);
            single.add(content);
            return single;
        }
        Repr repr = toRepr(content);
        // 对齐 legado AnalyzeRule#this.content：{{@rule}}/{{$.x}} 等内嵌子规则对整页内容求值
        c.put("root", repr);
        try {
            Object out = dispatch(repr, rule.trim(), c, true, false);
            // node：out truthy 才包单元素（'' → 空列表）
            List<?> arr = out instanceof List ? (List<?>) out
                    : (out != null && !"".equals(out) ? Collections.singletonList(out) : new ArrayList<Object>(0));
            List<Object> res = new ArrayList<>(arr.size());
            for (Object el : arr) {
                // node：带 groups 的正则条目已是 repr 透传，其余 wrapItem 包装
                res.add(wrapItem(el, repr));
            }
            return res;
        } catch (Exception e) {
            Log.w(TAG, "evalRuleList failed [" + truncate(rule, 60) + "]: " + e.getMessage());
            return new ArrayList<>();
        }
    }

    /** @put/java.put 变量池写入（node：ctx.vars Map；无池自动建——存哪对齐 node，池随 ctx 传递） */
    public static void putVar(Map<String, Object> ctx, String key, Object value) {
        Map<String, Object> vars = varsOf(ctx, true);
        if (vars != null) vars.put(String.valueOf(key), value);
    }

    /** @get/java.get 变量池读取；缺失返回 null（node：缺失置空，由调用方决定缺省串） */
    public static Object getVar(Map<String, Object> ctx, String key) {
        Map<String, Object> vars = varsOf(ctx, false);
        return vars == null ? null : vars.get(String.valueOf(key));
    }

    /** 对齐 analyzer.js#makeContent：原始文本 → 内容 repr（嗅探 json/html/text；forceKind 强制方言） */
    public static Repr makeContent(Object raw) {
        return makeContent(raw, null);
    }

    public static Repr makeContent(Object raw, String forceKind) {
        String text = raw == null ? "" : String.valueOf(raw);
        Repr c = new Repr();
        if ("html".equals(forceKind)) {
            c.kind = "html";
            c.root = Jsoup.parse(text);
            c.raw = text;
            return c;
        }
        if ("json".equals(forceKind)) {
            JsonElement el = tryParseJson(text);
            if (el != null) {
                c.kind = "json";
                c.data = el;
                c.raw = text;
                return c;
            }
            // 解析失败落回嗅探（node catch 注释）
        }
        String t = text.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
            JsonElement el = tryParseJson(text);
            if (el != null) {
                c.kind = "json";
                c.data = el;
                c.raw = text;
                return c;
            }
        }
        if (HTML_SNIFF.matcher(t).find()) {
            c.kind = "html";
            c.root = Jsoup.parse(text);
            c.raw = text;
            return c;
        }
        c.kind = "text";
        c.text = text;
        c.raw = text;
        return c;
    }

    /** 对齐 analyzer.js#elementRepr：元素 → repr（java.getElements 等外部消费用） */
    public static Repr elementRepr(Object el) {
        return wrapItem(el, null);
    }

    /** 对齐 analyzer.js#unescapeHtml：HTML 实体解码（结果含 & 时由 evalRule 调用） */
    public static String unescapeHtml(String s) {
        if (s == null || !s.contains("&")) return s;
        Matcher m = HTML_ENT.matcher(s);
        if (!m.find()) return s;
        StringBuffer sb = new StringBuffer(s.length());
        do {
            String body = m.group(1);
            String rep = m.group();
            if (!body.isEmpty() && body.charAt(0) == '#') {
                try {
                    int code = (body.length() > 1 && (body.charAt(1) == 'x' || body.charAt(1) == 'X'))
                            ? Integer.parseInt(body.substring(2), 16)
                            : Integer.parseInt(body.substring(1), 10);
                    // node：Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : 原文
                    if (code > 0 && Character.isValidCodePoint(code)) rep = new String(Character.toChars(code));
                } catch (Exception ignore) {
                    // parseInt 失败（JS NaN）→ 保留原文
                }
            } else {
                String named = NAMED_ENT.get(body.toLowerCase(Locale.ROOT));
                if (named != null) rep = named;
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
        } while (m.find());
        m.appendTail(sb);
        return sb.toString();
    }

    /** 对齐 analyzer.js#reprToString：repr → 可读文本（regex/模板/JS result 绑定基准） */
    public static String reprToString(Repr content) {
        return getResult(content);
    }

    /** 对齐 analyzer.js#elementProxy：repr → JS result 绑定载体（html: Element / json: NativeObject / 其余文本） */
    public static Object elementProxy(Repr content) {
        return makeElementResult(content);
    }

    // ============ 总分发（对齐 analyzer.js#dispatch） ============

    /** JS 混排判定：对齐 /&lt;js&gt;[\w\W]*?&lt;\/js&gt;|@js:/i */
    private static final Pattern JS_RULE = Pattern.compile("<js>[\\w\\W]*?</js>|@js:", Pattern.CASE_INSENSITIVE);

    /** URL 常量直通：对齐 /^[a-z]+:\/\//i */
    private static final Pattern URL_CONST = Pattern.compile("^[a-z]+://", Pattern.CASE_INSENSITIVE);

    /** HTML 嗅探：对齐 makeContent 的 /<[a-z!][\s\S]*>/i */
    private static final Pattern HTML_SNIFF = Pattern.compile("<[a-z!][\\s\\S]*>", Pattern.CASE_INSENSITIVE);

    /** HTML 实体：对齐 unescapeHtml 的 /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g */
    private static final Pattern HTML_ENT = Pattern.compile("&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);");

    /** 命名实体表：对齐 unescapeHtml 内 named 常量（amp/lt/gt/quot/apos/nbsp） */
    private static final Map<String, String> NAMED_ENT = new LinkedHashMap<>();

    static {
        NAMED_ENT.put("amp", "&");
        NAMED_ENT.put("lt", "<");
        NAMED_ENT.put("gt", ">");
        NAMED_ENT.put("quot", "\"");
        NAMED_ENT.put("apos", "'");
        NAMED_ENT.put("nbsp", " ");
    }

    private static Object dispatch(Repr content, String rule, Map<String, Object> ctx, boolean list, boolean isUrl) {
        // 1) JS 混排（<js> 段或 @js: 前缀，legado JS_PATTERN 分段语义）
        if (JS_RULE.matcher(rule).find()) {
            return runJsRule(content, rule, ctx, list, isUrl);
        }
        // 2) ## 正则净化拆分（后半段为 match/replace）
        Replace split = splitReplace(rule);
        String body = split.body;
        // AllInOne 正则（: 开头）：仅列表模式判 Regex（legado splitSourceRule allInOne=true，
        // getString 路径 allInOne=false 不判——单值 :xxx 落 Default 方言）；&& 链式拆分在
        // AnalyzeByRegex 内部（前条 findAll 匹配拼接为下条输入），不是组合符
        if (body.startsWith(":") && list) {
            return finalize(regexAllInOne(getRaw(content), body.substring(1)), split.replaces, list, ctx);
        }
        // 3) 单条规则 → 方言执行。|| && %% 顶层组合不再由 Java 层拆分：legado AnalyzeRule
        // 无顶层组合步骤，组合由各方言引擎内部分别处理（splitRule），@css:a||b 两段同语境
        // ——Java 层拆分会令第二段判型错乱
        //  空规则段（legado isNotBlank || replaceRegex.isEmpty()：规则为空但有 ## 时跳过求值，
        //  结果保留内容本体——元素 repr 经 stringify 取 outerHtml 供 ## 正则匹配）
        Object r = (!body.isEmpty() || split.replaces.isEmpty())
                ? dispatchSingle(content, body, ctx, list, isUrl)
                : content;
        return finalize(r, split.replaces, list, ctx);
    }

    // ============ 单条规则方言分发（对齐 analyzer.js#dispatchSingle） ============

    /** $N 组引用：对齐 /\$\d{1,2}/ */
    private static final Pattern DOLLAR_N = Pattern.compile("\\$(\\d{1,2})");

    /** @get:{key}：对齐 /@get:\{([^{}]*)\}/g */
    private static final Pattern GET_VAR = Pattern.compile("@get:\\{([^{}]*)\\}");

    private static Object dispatchSingle(Repr content, String rule, Map<String, Object> ctx,
                                         boolean list, boolean isUrl) {
        if (rule == null || rule.isEmpty()) return list ? new ArrayList<Object>() : "";
        // legado SourceRule 前缀判定顺序：@@ → Default（去前缀）并锁定方言，
        // 后续不再做 @CSS:/@Json:/@XPath:/$./$[ 前缀判型（原 node 行为: 剥离后继续按前缀判型）
        boolean forcedDefault = false;
        if (rule.startsWith("@@")) {
            rule = rule.substring(2);
            forcedDefault = true;
        }
        // $N 组引用：内容为正则 AllInOne 条目（携带捕获组，组 0 = 整个匹配）→ 组值/字面量拼接
        if (content.groups != null && DOLLAR_N.matcher(rule).find()) {
            Matcher mm = DOLLAR_N.matcher(rule);
            StringBuffer sb = new StringBuffer();
            while (mm.find()) {
                Integer idx = tryParseInt(mm.group(1));
                String v = (idx != null && idx >= 0 && idx < content.groups.size())
                        ? content.groups.get(idx) : null;
                mm.appendReplacement(sb, Matcher.quoteReplacement(v == null ? "" : v));
            }
            mm.appendTail(sb);
            return sb.toString();
        }
        // @put 尾缀（AnalyzeRule put 变量）：rule@put:{key:subrule}——子规则求值写入变量池后剥离尾缀
        // 对齐 legado AnalyzeRule#splitPutRule：剥离规则中所有 @put:{...}（原 node 行为: 仅首个）
        int putIdx;
        while ((putIdx = rule.indexOf("@put:{")) >= 0) {
            int open = putIdx + 5;
            int close = matchBrace(rule, open);
            if (close <= 0) break;
            String inner = rule.substring(open + 1, close);
            int sep = inner.indexOf(':');
            String key = sep > 0 ? inner.substring(0, sep).trim() : "";
            if (!key.isEmpty()) {
                Object sub = dispatch(content, inner.substring(sep + 1).trim(), ctx, false, false);
                Map<String, Object> vars = varsOf(ctx, true);
                if (vars != null) vars.put(key, jsValueToString(sub));
            }
            rule = rule.substring(0, putIdx) + rule.substring(close + 1);
        }
        // @get:{key} 变量引用：替换为变量池值（缺失置空）
        if (rule.contains("@get:{")) {
            rule = replaceGetVars(rule, ctx);
        }
        // URL 常量规则原样返回（legado analyzeUrl 分流）；含 {{}} 或 {$. 内嵌模板的不直通
        if (URL_CONST.matcher(rule).find() && !rule.contains("{{") && !rule.contains("{$.")) {
            return rule;
        }
        // 模板（含 {{）优先——legado SourceRule init：evalPattern 命中且（首个 {{}} 位于段首或
        // 其前缀无 ##）时翻转为 Regex 模式，makeUpRule 后直接返回组合串、不再方言解析，
        // 故 {{}} 优先于 @CSS:/@Json:/@XPath: 前缀判型（原 node 行为: @css: 等前缀先于 {{}}）；
        // {{@rule}}/{{$.x}} 内嵌子规则对整页内容求值——legado makeUpRule isRule 分支
        // getString(ruleParam) 以 this.content（setContent 整页内容）为内容
        // （原 node 行为: 对当前段 content 求值）
        if (rule.contains("{{")) {
            Repr rootRepr = ctx.get("root") instanceof Repr ? (Repr) ctx.get("root") : content;
            Map<String, Object> extras = new LinkedHashMap<>();
            extras.put("result", getResult(content));
            if ("json".equals(rootRepr.kind)) extras.put("data", rootRepr.data);
            Map<String, Object> bindings = buildRenderBindings(ctx, extras);
            return renderWithRule(rule, bindings, rootRepr, ctx);
        }
        // @CSS:（JSON/text 内容时转 HTML 选择，结果同样为空，且不抛异常）
        if (!forcedDefault && rule.length() >= 5 && rule.substring(0, 5).equalsIgnoreCase("@css:")) {
            if (!"html".equals(content.kind)) {
                String raw = "text".equals(content.kind) ? content.text
                        : (content.raw != null ? content.raw : getResult(content));
                content.kind = "html";
                content.root = Jsoup.parse(String.valueOf(raw));
            }
            ensureHtmlRoot(content);
            String cssRule = rule.substring(5);
            return jsoupEval(content, cssRule, list, isUrl);
        }
        // @JSON / $. / $[ / JSON 内容裸键（legado：isJSON || $. || $[ → Json；前缀忽略大小写）
        boolean jsonRule = !forcedDefault && ((rule.length() >= 6 && rule.substring(0, 6).equalsIgnoreCase("@json:"))
                || rule.startsWith("$.") || rule.startsWith("$[")
                || ("json".equals(content.kind) && !rule.startsWith(":")
                        && (!rule.contains("@") || rule.contains("{$."))));
        if (jsonRule) {
            Object data;
            if ("json".equals(content.kind)) {
                data = content.data;
            } else {
                data = tryParseJson(content.raw != null ? content.raw : content.text);
            }
            if (data != null) {
                return jsonEval(content, data, rule, list);
            }
            return list ? new ArrayList<Object>() : "";
        }
        // @XPath / //（legado：任何 / 开头均为 XPath；前缀忽略大小写；@@ 锁定 Default 后不再判型）
        // legado Mode.XPath：AnalyzeByXPath 自带 td/tr 补包与 xmlParser 判定，直接喂原始文本
        if (!forcedDefault && (rule.length() >= 7 && rule.substring(0, 7).equalsIgnoreCase("@xpath:")
                || rule.startsWith("/"))) {
            AnalyzeByXPath abx = new AnalyzeByXPath(getRaw(content));
            if (list) {
                List<?> nodes = abx.getElements(rule);
                return new ArrayList<Object>(nodes != null ? nodes : new ArrayList<Object>(0));
            }
            String s = abx.getString(rule);
            return s != null ? s : "";
        }
        // 纯正则（: 开头）单值：legado getString 路径不判 Regex（splitSourceRule allInOne=false）
        // → 落 Default 方言（列表模式的 Regex 早退见 dispatch）
        // 默认链（legado Mode.Default：isUrl=true 走 getString0 只取收集列表第一项）。
        // 对齐 legado AnalyzeRule#getString：非 JSON 字符串内容同样进 AnalyzeByJSoup
        // （Ksoup.parse 后走 jsoup 规则链），legado 无"text 当正则"兜底——纯文本内容
        // 的正则提取应使用 : 前缀 AllInOne 规则（原 node 行为: text 内容将规则当正则用）
        if ("text".equals(content.kind)) {
            content.kind = "html";
            content.root = Jsoup.parse(content.text != null ? content.text : "");
        } else if ("xml".equals(content.kind) && content.w3cNode != null) {
            // 对齐 legado AnalyzeByJSoup#parse：w3c Node → toString 后按 HTML 解析
            content.kind = "html";
            content.root = Jsoup.parse(xmlToString(content.w3cNode));
        }
        if ("html".equals(content.kind)) {
            return jsoupEval(content, rule, list, isUrl);
        }
        if ("json".equals(content.kind)) {
            return jsonEval(content, content.data, rule, list);
        }
        // 兜底：xml 但 w3cNode 缺失等无根内容 → 取原文按正则提取
        return regexExtract(getRaw(content), rule, list);
    }

    // ============ Kotlin 方言引擎调用（对齐 legado AnalyzeRuleCore#getAnalyzeByXxx 复用语义） ============

    /**
     * AnalyzeByJSoup 求值：org.jsoup Element → toString（outerHtml）→ Ksoup.parse，
     * Kotlin 引擎内自动转换；引擎实例按 content 缓存（legado getAnalyzeByJSoup 同款）。
     */
    private static Object jsoupEval(Repr content, String rule, boolean list, boolean isUrl) {
        ensureHtmlRoot(content);
        Object cached = content.engineJsoup;
        AnalyzeByJSoup abj;
        if (cached instanceof AnalyzeByJSoup) {
            abj = (AnalyzeByJSoup) cached;
        } else {
            abj = new AnalyzeByJSoup(content.root);
            content.engineJsoup = abj;
        }
        if (list) {
            List<?> els = abj.getElements(rule);
            return new ArrayList<Object>(els != null ? els : new ArrayList<Object>(0));
        }
        String s = isUrl ? abj.getString0(rule) : abj.getString(rule);
        return s != null ? s : "";
    }

    /** AnalyzeByJSonPath 求值：gson 数据树（JsonElement/Map/List/String 均可）→ kotlinx JsonElement */
    private static Object jsonEval(Repr content, Object data, String rule, boolean list) {
        Object cached = content.engineJson;
        AnalyzeByJSonPath abp;
        if (cached instanceof AnalyzeByJSonPath) {
            abp = (AnalyzeByJSonPath) cached;
        } else {
            abp = new AnalyzeByJSonPath(data);
            content.engineJson = abp;
        }
        if (list) return new ArrayList<Object>(abp.getList(rule));
        String s = abp.getString(rule);
        return s != null ? s : "";
    }

    /**
     * AllInOne 正则（legado AnalyzeByRegex#getElements，仅列表模式）：
     * && 盲拆链式——非末条规则 findAll 匹配文本拼接为下一条输入；末条每个匹配产出携带
     * 捕获组的 repr 条目（组 0 = 整个匹配，供字段规则 $N 引用）。
     */
    private static Object regexAllInOne(String text, String pattern) {
        List<String> regs = new ArrayList<>();
        for (String s : String.valueOf(pattern).split("&&", -1)) {
            String t = s.trim();
            if (!t.isEmpty()) regs.add(t);
        }
        if (regs.isEmpty()) return new ArrayList<Object>();
        List<List<String>> rows = AnalyzeByRegex.INSTANCE.getElements(text, regs.toArray(new String[0]), 0);
        List<Object> out = new ArrayList<>(rows.size());
        for (List<String> groups : rows) {
            Repr item = new Repr();
            item.kind = "text";
            item.text = groups.isEmpty() ? "" : groups.get(0);
            item.raw = item.text;
            item.groups = new ArrayList<>(groups);
            out.add(item);
        }
        return out;
    }

    // ============ JS 混排（对齐 analyzer.js#runJsRule / splitSourceRuleJs） ============

    /** legado JS_PATTERN 分段正则：&lt;js&gt;...&lt;/js&gt;（懒）| @js:...（贪婪到尾） */
    private static final Pattern JS_SEG = Pattern.compile("<js>([\\w\\W]*?)</js>|@js:([\\w\\W]*)",
            Pattern.CASE_INSENSITIVE);

    /**
     * JS 混排规则：legado splitSourceRule 分段语义——JS 段 evalJS(result=前段输出)；
     * 普通段以上段输出为新内容做方言解析（result 链式传递）。
     */
    private static Object runJsRule(Repr content, String rule, Map<String, Object> ctx,
                                    boolean list, boolean isUrl) {
        List<Seg> segs = splitSourceRuleJs(rule);
        // 首段 result 绑定（对齐 node analyzer.js#makeElementResult）：
        // - json 内容 → 绑对象树（JsEngine toJsValue 转 NativeObject）——JSON.stringify(result)
        //   产出单层 JSON（潇社 music lastChapter put('json',JSON.stringify(result)) 依赖；
        //   绑 raw 字符串会双重编码，get 回来退化为字符串字面量，makeContent 嗅探落 text）；
        //   String(result) 协议由 toJsValue 挂的 toString 兜底（产出 JSON 文本，
        //   喜马拉雅 nextTocUrl JSON.parse(String(result)) 依赖）
        // - html/text → 绑字符串（result.match/replace/split 社区源主流用法；
        //   八叉书库 ruleContent result.match 炸 Element 事件）
        Object result = jsResultOf(content);
        Repr cur = content; // 普通段执行上下文：首段 = 原始 repr，JS 段后重建
        Object lastOut = null; // 末段原始输出（list 模式保留数组形态）
        for (Seg seg : segs) {
            if (seg.js) {
                // legado JS 段同样支持 ## 尾巴（makeUpRule 拆分后应用于 JS 结果）
                Replace split = splitReplace(seg.code);
                String body = split.body;
                // 对齐 legado AnalyzeRule#makeUpRule：@get:{} 为独立规则参数，JS 段代码体内
                // 同样在执行前替换为变量池值（原 node 行为: 仅 {{}} 模板渲染，@get 字面量进 JS）
                if (body.contains("@get:")) body = replaceGetVars(body, ctx);
                // 社区源在 JS 段内嵌 {{$.field}}——超集支持：先渲染模板再执行，
                // JSON 条目上下文可取 $.field（HTML 内容 $. 求值为空）
                String pre = body;
                if (body.contains("{{") && body.contains("}}")) {
                    Map<String, Object> extras = new LinkedHashMap<>();
                    extras.put("result", jsValueToString(result));
                    if ("json".equals(content.kind)) extras.put("data", content.data);
                    pre = TemplateRenderer.render(body, buildRenderBindings(ctx, extras));
                }
                // 对齐 legado AnalyzeRule#makeUpRule：## 尾巴内的 {{}}/@get 与代码体同批求值
                // （result=段输入，先于 JS 执行）；原 node 行为: JS 执行后才以输出为 result 求值
                preEvalReplaces(split.replaces, jsValueToString(result), ctx);
                Map<String, Object> bindings = buildJsBindings(ctx, result, content);
                Object out = JsEngine.eval(prependJsLib(pre, ctx), bindings);
                lastOut = out;
                if (split.replaces.isEmpty()) {
                    // 对齐 legado AnalyzeRule#getString：JS 输出无 ## 时原样链式传递，
                    // list 模式保留数组形态作下一段 result 绑定
                    // （原 node 行为: 恒字符串化后再传段）
                    cur = makeContent(jsValueToString(out));
                    result = list ? out : jsValueToString(out);
                } else {
                    String text = applyReplaces(jsValueToString(out), split.replaces, ctx);
                    cur = makeContent(text);
                    result = text;
                }
            } else {
                lastOut = dispatch(cur, seg.code, ctx, list, isUrl);
                // 对齐 legado AnalyzeRule#getString：list 模式方言输出（元素列表）原样作为
                // 下一段 JS 的 result 绑定，保留数组形态（原 node 行为: 先拼接为换行字符串）
                result = list && lastOut instanceof List ? lastOut : jsValueToString(lastOut);
                cur = makeContent(jsValueToString(lastOut));
            }
        }
        if (!list) return result;
        // list 模式：末段数组形态优先（元素列表），否则字符串按行拆
        if (lastOut instanceof List) return lastOut;
        // 对齐 legado getElements：JS 段返回 JS 数组时保留条目形态（原 node 行为: 字符串化后按行拆）
        List<Object> fromJs = scriptableToList(lastOut);
        if (fromJs != null) return fromJs;
        List<Object> parsed = tryJsonArray(String.valueOf(result));
        return parsed != null ? parsed : arrayOrSplit(result);
    }

    /** Rhino NativeArray → java List（list 模式 JS 段数组输出保留条目形态；非数组返回 null） */
    private static List<Object> scriptableToList(Object v) {
        if (!(v instanceof NativeArray)) return null;
        NativeArray arr = (NativeArray) v;
        int len = (int) arr.getLength();
        List<Object> out = new ArrayList<>(len);
        for (int i = 0; i < len; i++) out.add(arr.get(i, arr));
        return out;
    }

    /** 对齐 template.js#runJs 的 jsLib 共享作用域：源 jsLib 前置拼接（等价 vm 共享全局） */
    private static String prependJsLib(String code, Map<String, Object> ctx) {
        Object lib = mapGet(ctx.get("source"), "jsLib");
        if (lib instanceof String && !((String) lib).trim().isEmpty()) {
            return lib + "\n;\n" + code;
        }
        return code;
    }

    /** 对齐 analyzer.js#splitSourceRuleJs：JS_PATTERN 分段 */
    private static List<Seg> splitSourceRuleJs(String rule) {
        List<Seg> segs = new ArrayList<>();
        Matcher m = JS_SEG.matcher(rule);
        int last = 0;
        while (m.find()) {
            if (m.start() > last) {
                String t = rule.substring(last, m.start()).trim();
                if (!t.isEmpty()) segs.add(new Seg(false, t));
            }
            segs.add(new Seg(true, m.group(2) != null ? m.group(2)
                    : (m.group(1) != null ? m.group(1) : "")));
            last = m.end();
            if (m.group(2) != null) break; // @js: 贪婪，到尾
        }
        if (last < rule.length()) {
            String t = rule.substring(last).trim();
            if (!t.isEmpty()) segs.add(new Seg(false, t));
        }
        return segs;
    }

    /**
     * JS result 绑定载体（对齐 analyzer.js#makeElementResult）：
     * json → 数据对象（Rhino NativeObject 树，toString → JSON 文本，对齐 node data.toString 补丁：
     * 潇社 JSON.stringify(result) / 喜马拉雅 JSON.parse(String(result)) 依赖）；
     * html → jsoup Element（LiveConnect 方法面，String() → outerHtml；node 的 String 载体
     * 字符串协议 match/replace 为 LiveConnect 环境的已知偏差，留待 java 桥批次处理）；
     * 其余 → 可读文本。
     */
    private static Object makeElementResult(Repr content) {
        if ("json".equals(content.kind)) return jsonNativeBinding(content.data);
        if (!"html".equals(content.kind) || content.root == null) return getRaw(content);
        return content.root;
    }

    /** json 数据 → NativeObject/NativeArray 树（须在 Rhino Context 内构建；toString 借隐藏属性回 JSON 文本） */
    private static Object jsonNativeBinding(JsonElement data) {
        if (data == null || data.isJsonNull()) return "";
        if (data.isJsonPrimitive()) return primitiveToJava(data.getAsJsonPrimitive());
        Context cx = Context.enter();
        try {
            cx.setLanguageVersion(Context.VERSION_ES6);
            Scriptable scope = cx.initStandardObjects();
            Object tree = jsonToJs(cx, scope, data);
            String jsonText = GSON.toJson(data);
            if (tree instanceof NativeObject) {
                NativeObject no = (NativeObject) tree;
                Object fn = cx.evaluateString(scope, "(function(){return this.__json__})",
                        "legado-json-tostring", 1, null);
                no.put("toString", no, fn);
                // 隐藏属性不参与 JSON.stringify 枚举（DONTENUM）
                ScriptableObject.defineProperty(no, "__json__", jsonText,
                        ScriptableObject.READONLY | ScriptableObject.PERMANENT | ScriptableObject.DONTENUM);
            }
            return tree;
        } finally {
            Context.exit();
        }
    }

    /** JsonElement → JS 值树（对象 → NativeObject、数组 → NativeArray、标量 → Java 原生类型） */
    private static Object jsonToJs(Context cx, Scriptable scope, JsonElement el) {
        if (el == null || el.isJsonNull()) return Undefined.instance;
        if (el.isJsonPrimitive()) return primitiveToJava(el.getAsJsonPrimitive());
        if (el.isJsonArray()) {
            JsonArray arr = el.getAsJsonArray();
            Object[] items = new Object[arr.size()];
            for (int i = 0; i < arr.size(); i++) items[i] = jsonToJs(cx, scope, arr.get(i));
            return new NativeArray(items);
        }
        NativeObject no = (NativeObject) cx.newObject(scope);
        for (Map.Entry<String, JsonElement> e : el.getAsJsonObject().entrySet()) {
            no.put(e.getKey(), no, jsonToJs(cx, scope, e.getValue()));
        }
        return no;
    }

    private static Object primitiveToJava(JsonPrimitive p) {
        if (p.isBoolean()) return Boolean.valueOf(p.getAsBoolean());
        if (p.isNumber()) return p.getAsNumber();
        return p.getAsString();
    }

    // ============ ## 正则净化（对齐 analyzer.js#splitReplace / finalize / applyReplaces） ============

    /**
     * ## 拆分：[rule, match, replace, first?]（legado：第 4 段存在 → 只取首个匹配替换；规则段 trim）。
     * 首个 ## 需顶层平衡感知（{{}}/引号/[]() 内不拆）；净化段内 ## 按朴素拆（同 legado）。
     */
    private static Replace splitReplace(String rule) {
        Replace r = new Replace();
        int idx = topIndexOf(rule, "##");
        if (idx < 0) {
            r.body = rule;
            return r;
        }
        // 对齐 legado AnalyzeRule#makeUpRule（rule.split("##")）：Kotlin 默认 split 去除尾部
        // 空段，"规则##匹配##" 结尾不算 replaceFirst 标志（原 node 行为: JS split('##') 保留
        // 尾部空串，此处此前用 -1 limit 同病）
        String[] rest = rule.substring(idx + 2).split("##");
        r.body = rule.substring(0, idx).trim();
        Spec s = new Spec();
        s.match = rest[0] == null ? "" : rest[0];
        s.replace = rest.length > 1 ? rest[1] : "";
        s.first = rest.length > 2;
        r.replaces.add(s);
        return r;
    }

    /** ## 正则净化应用 */
    private static Object finalize(Object result, List<Spec> replaces, boolean list, Map<String, Object> ctx) {
        if (replaces.isEmpty()) return result;
        if (list) {
            List<?> arr = result instanceof List ? (List<?>) result : Collections.singletonList(result);
            List<Object> out = new ArrayList<>(arr.size());
            for (Object v : arr) out.add(applyReplaces(stringify(v), replaces, ctx));
            return out;
        }
        return applyReplaces(stringify(result), replaces, ctx);
    }

    /**
     * ## 段内 {{}}/@get:{} 预求值（legado makeUpRule：evalPattern 覆盖整条规则含 ## 后段，
     * {{}} 以当前内容为 result 求值后替换，再做 ## 拆分）。
     */
    private static String evalRuleSegment(String seg, String s, Map<String, Object> ctx) {
        String out = seg;
        if (out.contains("@get:")) {
            out = replaceGetVars(out, ctx);
        }
        if (out.contains("{{") && out.contains("}}")) {
            try {
                Map<String, Object> extras = new LinkedHashMap<>();
                extras.put("result", s);
                out = TemplateRenderer.render(out, buildRenderBindings(ctx, extras));
            } catch (Exception ignore) {
                // 求值失败保留原文（node catch 注释）
            }
        }
        return out;
    }

    /** JS 段 ## 尾巴预求值（对齐 legado AnalyzeRule#makeUpRule：## 段 {{}}/@get 与代码体
     *  同批以段输入为 result 求值，先于 JS 执行） */
    private static void preEvalReplaces(List<Spec> replaces, String inputText, Map<String, Object> ctx) {
        for (Spec r : replaces) {
            r.match = evalRuleSegment(r.match, inputText, ctx);
            r.replace = evalRuleSegment(r.replace, inputText, ctx);
            r.preEval = true;
        }
    }

    /**
     * ## 正则净化应用（first=true：仅取首个匹配文本做替换，无匹配为空——legado replaceFirst 语义）。
     * 替换串 $N 引用捕获组；Java replaceAll 对 $/\ 的转义语义与 JS 替换串（\ 为字面量）对齐处理。
     */
    private static String applyReplaces(String s, List<Spec> replaces, Map<String, Object> ctx) {
        String out = s;
        for (Spec r : replaces) {
            try {
                String match = r.preEval ? r.match : evalRuleSegment(r.match, s, ctx);
                String replace = r.preEval ? r.replace : evalRuleSegment(r.replace, s, ctx);
                if (r.first) {
                    Matcher m = Pattern.compile(match).matcher(out);
                    if (m.find()) {
                        out = replaceDollarRefs(replace, m);
                    } else {
                        out = "";
                    }
                } else {
                    out = Pattern.compile(match).matcher(out).replaceAll(escapeJsReplacement(replace));
                }
            } catch (PatternSyntaxException e) {
                // 对齐 legado AnalyzeRule#replaceRegex：模式串无法编译 → replaceFirst 直接取
                // 替换串，否则整串字面量替换（原 node 行为: 一律按 split/join 字面量替换）
                out = r.first ? (r.replace == null ? "" : r.replace)
                        : out.replace(r.match, r.replace == null ? "" : r.replace);
            } catch (Exception e) {
                // 正则非法 → 字面量全量替换（node: out.split(r.match).join(r.replace)）
                out = out.replace(r.match, r.replace == null ? "" : r.replace);
            }
        }
        return out;
    }

    /** first 模式替换串 $N → 捕获组值（缺失置空；对齐 node replace.replace(/\$(\d{1,2})/g, ...)） */
    private static String replaceDollarRefs(String replace, Matcher m) {
        Matcher dm = DOLLAR_N.matcher(replace);
        StringBuffer sb = new StringBuffer();
        while (dm.find()) {
            Integer idx = tryParseInt(dm.group(1));
            String v = "";
            if (idx != null && idx >= 0 && idx <= m.groupCount()) {
                String g = m.group(idx);
                v = g == null ? "" : g;
            }
            dm.appendReplacement(sb, Matcher.quoteReplacement(v));
        }
        dm.appendTail(sb);
        return sb.toString();
    }

    /** JS 替换串语义 → Java replaceAll：\ 与 $ 均转义（JS 替换串反斜杠为字面量，$N 为组引用） */
    private static String escapeJsReplacement(String replace) {
        if (replace == null) return "";
        return replace.replace("\\", "\\\\").replace("$", "\\$");
    }

    // ============ 组合拆分工具（splitCombo/splitByAll 已随顶层组合层移除——组合在 Kotlin 方言引擎内处理） ============

    /**
     * 顶层（引号/花括号/[]()平衡组外）分隔符首次出现位置；-1 无。
     * legado RuleAnalyzer.splitRule：分隔符位于筛选器 [...]/(...) 平衡组内时不切分。
     */
    private static int topIndexOf(String rule, String sep) {
        char quote = 0;
        int depth = 0, sq = 0, pa = 0;
        for (int i = 0; i < rule.length(); i++) {
            char c = rule.charAt(i);
            if (quote != 0) {
                if (c == '\\') {
                    i++;
                    continue;
                }
                if (c == quote) quote = 0;
                continue;
            }
            // 引号外反斜杠同样吃掉下一字符：正则字面量内 \(\{\[ 是字面括号，
            // 计入平衡会令 depth/sq/pa 永久失衡、顶层 ## 定位失效
            // （VIP中文 chapterName JS 尾巴 ##(章)...##$1 $2$3 不拆 → illegal character: #）
            if (c == '\\') {
                i++;
                continue;
            }
            if (c == '\'' || c == '"') {
                quote = c;
                continue;
            }
            if (c == '{') depth++;
            else if (c == '}') depth--;
            else if (c == '[') sq++;
            else if (c == ']') sq--;
            else if (c == '(') pa++;
            else if (c == ')') pa--;
            if (depth == 0 && sq == 0 && pa == 0 && rule.startsWith(sep, i)) return i;
        }
        return -1;
    }

    // ============ 正则方言（对齐 analyzer.js#regexExtract；AllInOne 接 AnalyzeByRegex） ============

    /**
     * 纯正则提取：非 list 有捕获组取组 1，否则整个匹配；
     * list 时全量匹配，每个匹配产出携带组列表的 repr 条目（组 0 = 整个匹配，供字段规则 $N 引用
     * ——legado AnalyzeByRegex.getElements）。
     */
    private static Object regexExtract(String text, String pattern, boolean list) {
        if (pattern == null || pattern.isEmpty()) return list ? new ArrayList<Object>() : "";
        try {
            if (list) {
                Matcher m = Pattern.compile(pattern).matcher(text);
                List<Object> out = new ArrayList<>();
                int pos = 0;
                while (pos <= text.length() && m.find(pos)) {
                    Repr item = new Repr();
                    item.kind = "text";
                    item.text = m.group();
                    item.raw = m.group();
                    List<String> groups = new ArrayList<>(m.groupCount() + 1);
                    for (int g = 0; g <= m.groupCount(); g++) groups.add(m.group(g) == null ? "" : m.group(g));
                    item.groups = groups;
                    out.add(item);
                    // 空匹配推进一位（对齐 node re.lastIndex++ 防死循环）
                    int end = m.end();
                    pos = (end == m.start()) ? end + 1 : end;
                }
                return out;
            }
            Matcher m = Pattern.compile(pattern).matcher(text);
            if (!m.find()) return "";
            return m.groupCount() >= 1 && m.group(1) != null ? m.group(1) : m.group(0);
        } catch (Exception e) {
            Log.w(TAG, "regex failed: " + pattern + ": " + e.getMessage());
            return list ? new ArrayList<Object>() : "";
        }
    }

    // ============ repr 基础设施（对齐 analyzer.js#wrapItem / ensure* / getResult / getRaw） ============

    /** String/元素/节点/JSON 值 → repr（analyzeStr/analyzeList 入口统一化；node typeof content 分流） */
    private static Repr toRepr(Object content) {
        if (content instanceof Repr) return (Repr) content;
        return wrapItem(content, null);
    }

    /**
     * 列表元素 → repr（对齐 analyzer.js#wrapItem：html 元素复用上下文——Java 版 jsoup Element
     * 自带文档引用，无需 $ 实例；xml 节点携带 ownerDocument；正则 groups 条目原样透传）。
     */
    private static Repr wrapItem(Object el, Repr parent) {
        Repr c = new Repr();
        if (el == null) {
            c.kind = "text";
            c.text = "";
            c.raw = "";
            return c;
        }
        if (el instanceof Repr) return (Repr) el; // 正则 AllInOne 条目（node 按 kind==='text' && groups 判定）
        // Kotlin 方言引擎条目回流：ksoup 元素/节点 → 真 jsoup Element（toString=outerHtml 后重建，
        // JS LiveConnect 方法面与后续判型沿用 org.jsoup 类型）；kotlinx JsonElement → Gson 树
        if (el instanceof com.fleeksoft.ksoup.nodes.Element) {
            c.kind = "html";
            // 序列化重建须补 table 上下文：孤儿 <tr>/<td> 片段被 HTML5 解析器丢弃
            // （顶点系 bookList=tag.tr 条目事件——td 全丢致字段求值全空）；
            // 包裹后取条目元素自身做 root，对齐 legado 条目=元素引用语义
            String h = el.toString();
            String tn = ((com.fleeksoft.ksoup.nodes.Element) el).tagName();
            if ("tr".equals(tn)) {
                Element t = Jsoup.parse("<table>" + h + "</table>").selectFirst("tr");
                c.root = t != null ? t : Jsoup.parse(h);
            } else if ("td".equals(tn) || "th".equals(tn)) {
                Element t = Jsoup.parse("<table><tr>" + h + "</tr></table>").selectFirst(tn);
                c.root = t != null ? t : Jsoup.parse(h);
            } else {
                org.jsoup.nodes.Document doc = Jsoup.parse(h);
                // 完整页（含 <html>）保留 Document 根：对齐 vendored AnalyzeByJSoup#parseFragment——
                // 整页条目（单页书 chapterList=tag.html 等）取 body 首子元素会截断子树，
                // 后续字段规则（chapterName=h1@text 等）在首子元素范围内取空
                if (h.toLowerCase(Locale.ROOT).contains("<html")) {
                    c.root = doc;
                } else {
                    // 通用元素（a/div/dd 等）：parse 产物是 Document，须取 body 首子元素还原
                    // 条目自身——否则 root=#root Document，attr(key) 落空（chapterUrl=href
                    // 取空回退 pageUrl 事件，仅 text 类规则侥幸可用）
                    Element first = doc.body() != null && doc.body().children().size() > 0
                            ? doc.body().child(0) : null;
                    c.root = first != null ? first : doc;
                }
            }
            return c;
        }
        if (el instanceof com.fleeksoft.ksoup.nodes.TextNode) {
            c.kind = "text";
            c.text = el.toString();
            c.raw = c.text;
            return c;
        }
        if (el instanceof com.fleeksoft.ksoup.nodes.Node) {
            c.kind = "html";
            c.root = Jsoup.parse(el.toString());
            return c;
        }
        if (el instanceof kotlinx.serialization.json.JsonElement) {
            c.kind = "json";
            c.raw = el.toString();
            c.data = tryParseJson(c.raw);
            return c;
        }
        if (el instanceof Element) {
            c.kind = "html";
            c.root = (Element) el;
            c.raw = null;
            return c;
        }
        if (el instanceof org.w3c.dom.Node) {
            org.w3c.dom.Node n = (org.w3c.dom.Node) el;
            c.kind = "xml";
            if (n instanceof org.w3c.dom.Document) {
                c.w3cDoc = (org.w3c.dom.Document) n;
            } else {
                org.w3c.dom.Document od = n.getOwnerDocument();
                c.w3cDoc = od != null ? od : (parent != null ? parent.w3cDoc : null);
            }
            c.w3cNode = n;
            c.raw = null;
            return c;
        }
        if (el instanceof String) return makeContent(el);
        if (el instanceof Map || el instanceof List || el instanceof JsonElement) {
            c.kind = "json";
            c.data = toJsonTree(el);
            c.raw = GSON.toJson(c.data);
            return c;
        }
        String s = String.valueOf(el);
        c.kind = "text";
        c.text = s;
        c.raw = s;
        return c;
    }

    private static void ensureHtmlRoot(Repr content) {
        if ("html".equals(content.kind) && content.root == null) {
            content.root = Jsoup.parse(content.raw != null ? content.raw : "");
        }
    }

    /** repr → 可读文本（对齐 analyzer.js#getResult：regex/模板/JS result 绑定基准；元素 repr 取 outerHtml） */
    private static String getResult(Repr content) {
        if (content == null) return "";
        if ("text".equals(content.kind)) return content.text != null ? content.text : "";
        if ("json".equals(content.kind)) {
            if (content.raw != null) return content.raw;
            return content.data != null ? GSON.toJson(content.data) : "";
        }
        if ("html".equals(content.kind)) {
            if (content.raw != null) return content.raw;
            return content.root != null ? content.root.outerHtml() : "";
        }
        if ("xml".equals(content.kind)) {
            if (content.raw != null) return content.raw;
            return content.w3cNode != null ? xmlToString(content.w3cNode) : "";
        }
        return "";
    }

    private static String getRaw(Repr content) {
        return content.raw != null ? content.raw : getResult(content);
    }

    /** w3c Node → XML 文本（node String(xmlNode) 的 xmldom 序列化语义；供 repr 文本化兜底） */
    private static String xmlToString(org.w3c.dom.Node n) {
        try {
            javax.xml.transform.Transformer t = javax.xml.transform.TransformerFactory.newInstance().newTransformer();
            t.setOutputProperty(javax.xml.transform.OutputKeys.OMIT_XML_DECLARATION, "yes");
            java.io.StringWriter sw = new java.io.StringWriter();
            t.transform(new javax.xml.transform.dom.DOMSource(n), new javax.xml.transform.stream.StreamResult(sw));
            return sw.toString();
        } catch (Exception e) {
            return "";
        }
    }

    // ============ 绑定构建（对齐 template.js#runJs sandbox / evalExpr 逐名缺省） ============

    /**
     * 模板渲染 bindings（对齐 node render 的 {...ctx, result, data} 展开 + evalExpr 逐名缺省）：
     * ctx 条目 → extras（result/data，覆盖 ctx 同名）→ vars 变量池（node evalExpr：vars 优先于
     * key/source[expr] 等逐名缺省，page/searchPage 除外）→ 逐名缺省补齐。
     */
    private static Map<String, Object> buildRenderBindings(Map<String, Object> ctx, Map<String, Object> extras) {
        Map<String, Object> b = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : ctx.entrySet()) {
            if (e.getValue() != null) b.put(e.getKey(), e.getValue());
        }
        if (extras != null) b.putAll(extras);
        Map<String, Object> vars = varsOf(ctx, false);
        if (vars != null) {
            for (Map.Entry<String, Object> e : vars.entrySet()) {
                if (e.getValue() == null) continue;
                if ("page".equals(e.getKey()) || "searchPage".equals(e.getKey())) continue;
                b.put(e.getKey(), e.getValue());
            }
        }
        Object pg = ctx.get("page");
        b.put("page", pg != null ? pg : Integer.valueOf(1));
        b.put("searchPage", pg != null ? pg : Integer.valueOf(1));
        Map<String, Object> source = mapOrEmpty(ctx.get("source"));
        b.putIfAbsent("source", source);
        b.putIfAbsent("book", mapOrEmpty(ctx.get("book")));
        b.putIfAbsent("baseUrl", defaultStr(ctx.get("baseUrl"), mapGet(source, "bookSourceUrl")));
        b.putIfAbsent("chapter", mapOrEmpty(ctx.get("chapter")));
        b.putIfAbsent("key", defaultStr(ctx.get("key"), null));
        b.putIfAbsent("searchKey", defaultStr(ctx.get("key"), null));
        b.putIfAbsent("result", defaultStr(ctx.get("result"), null));
        // node evalExpr：src → ctx.result ?? ''
        b.putIfAbsent("src", defaultStr(ctx.get("result"), null));
        return b;
    }

    /**
     * JS 沙箱 bindings（对齐 template.js#runJs sandbox 逐名字段；vars 不注入——node 沙箱无 vars 名，
     * 变量池经 ctx.vars/java.put-get 访问）。java/cookie 桥对象由 ctx 携带时透传，
     * 缺省不注入（本批次未接宿主桥，JS 调用报错由分段置空兜底）。
     */
    private static Map<String, Object> buildJsBindings(Map<String, Object> ctx, Object resultBinding, Repr rootContent) {
        Map<String, Object> b = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : ctx.entrySet()) {
            if (e.getValue() != null) b.put(e.getKey(), e.getValue());
        }
        b.put("result", resultBinding);
        b.put("root", rootContent);
        Map<String, Object> source = mapOrEmpty(ctx.get("source"));
        b.putIfAbsent("source", source);
        b.putIfAbsent("book", mapOrEmpty(ctx.get("book")));
        b.putIfAbsent("baseUrl", defaultStr(ctx.get("baseUrl"), mapGet(source, "bookSourceUrl")));
        b.putIfAbsent("chapter", mapOrEmpty(ctx.get("chapter")));
        Object chTitle = mapGet(ctx.get("chapter"), "title");
        b.putIfAbsent("title", defaultStr(ctx.get("title"), chTitle));
        b.putIfAbsent("src", defaultStr(ctx.get("result"), null));
        Object pg = ctx.get("page");
        b.put("page", pg != null ? pg : Integer.valueOf(1));
        b.put("searchPage", pg != null ? pg : Integer.valueOf(1));
        b.putIfAbsent("key", defaultStr(ctx.get("key"), null));
        b.putIfAbsent("searchKey", defaultStr(ctx.get("key"), null));
        b.putIfAbsent("sourceKey", defaultStr(mapGet(source, "bookSourceUrl"), null));
        // cookie/cache 桥：JS 侧 cookie.removeCookie/cache.getFromMemory 等方法面（legado
        // CookieStore/CacheManager），既有 ctx 值经桥 backing 透传（node 版为空 Map 占位）
        b.putIfAbsent("cookie", new JsExtensions.CookieBridge(mapOrEmpty(ctx.get("cookie"))));
        b.putIfAbsent("cache", new JsExtensions.CacheBridge());
        b.putIfAbsent("ctx", ctx);
        return b;
    }

    /**
     * 带内嵌子规则求值的模板渲染（对齐 template.js#render 主循环 + analyzer 的 evalRule 注入）。
     * TemplateRenderer.render 无闭包钩子（@//开头表达式固定置空），故本地扫描：
     * {{@rule}}/{{//xpath}} 走 dispatch（legado makeUpRule isRule 语义），其余段调
     * TemplateRenderer.evalExpr（$. 查 data、纯变量查 bindings、表达式进 JS 沙箱）。
     */
    private static String renderWithRule(String tpl, Map<String, Object> bindings, Repr content, Map<String, Object> ctx) {
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
                Object v;
                if (expr.startsWith("@") || expr.startsWith("/")) {
                    v = dispatch(content, expr, ctx, false, false);
                } else {
                    v = TemplateRenderer.evalExpr(expr, bindings);
                }
                // 空值处理：null → ''（node: v == null ? '' : String(v)）
                out.append(v == null ? "" : String.valueOf(v));
            } catch (Exception e) {
                Log.w(TAG, "template render failed: " + expr + ": " + e.getMessage());
                // 单段求值失败该段置空，整条规则继续
            }
            i = close + 2;
        }
        return out.toString();
    }

    /** 对齐 template.js#matchDoubleBrace：从 start 找配对 }}（引号/转义/{}深度感知） */
    private static int matchDoubleBrace(String tpl, int start) {
        int depth = 0;
        char quote = 0;
        for (int i = start; i < tpl.length() - 1; i++) {
            char c = tpl.charAt(i);
            if (quote != 0) {
                if (c == '\\') {
                    i++;
                    continue;
                }
                if (c == quote) quote = 0;
                continue;
            }
            if (c == '\\') {
                i++;
                continue;
            }
            if (c == '\'' || c == '"' || c == '`') {
                quote = c;
                continue;
            }
            if (c == '{') depth++;
            if (c == '}') {
                if (depth > 0) {
                    depth--;
                    continue;
                }
                if (tpl.charAt(i + 1) == '}') return i;
            }
        }
        return -1;
    }

    // ============ 变量池与杂项 ============

    /** @get:{key} 替换（对齐 legado AnalyzeRule#get：特殊键与回退链，缺失空串） */
    private static String replaceGetVars(String rule, Map<String, Object> ctx) {
        Matcher m = GET_VAR.matcher(rule);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            m.appendReplacement(sb, Matcher.quoteReplacement(getVarString(m.group(1).trim(), ctx)));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /**
     * 变量池取值（对齐 legado AnalyzeRule#get）："bookName" 直取书本名、"title" 直取章节名；
     * 普通键按 章节变量 → 书内变量 → 书源变量 回退（每级空值降级），缺失空串。
     * 原 node 行为: 仅查 ctx.vars，无特殊键与书源变量回退。
     */
    private static String getVarString(String key, Map<String, Object> ctx) {
        if ("bookName".equals(key)) {
            Object n = mapGet(ctx.get("book"), "name");
            if (n != null) return String.valueOf(n);
        } else if ("title".equals(key)) {
            Object t = mapGet(ctx.get("chapter"), "title");
            if (t != null) return String.valueOf(t);
        }
        Map<String, Object> vars = varsOf(ctx, false);
        Object v = vars != null ? vars.get(key) : null;
        if (v == null || "".equals(v)) v = mapGet(ctx.get("source"), key);
        return v == null ? "" : String.valueOf(v);
    }

    /** ctx.vars 变量池获取（缺失时按 create 决定是否建池；node 版存哪就存哪——ctx.vars Map） */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> varsOf(Map<String, Object> ctx, boolean create) {
        if (ctx == null) return null;
        Object v = ctx.get("vars");
        if (v instanceof Map) return (Map<String, Object>) v;
        if (create) {
            Map<String, Object> m = new LinkedHashMap<>();
            ctx.put("vars", m);
            return m;
        }
        return null;
    }

    /**
     * JS result 首段绑定形态（对齐 node analyzer.js#makeElementResult）：
     * json 内容绑对象树（Map/List/String——JsEngine toJsValue 转 NativeObject/NativeArray），
     * 其余绑字符串。
     */
    private static Object jsResultOf(Repr content) {
        if ("json".equals(content.kind) && content.data != null) {
            return jsonToJava(content.data);
        }
        return jsValueToString(content);
    }

    /** JS 值 → 字符串（对齐 analyzer.js#jsValueToString：元素取 outerHtml，对象/数组 JSON 序列化） */
    static String jsValueToString(Object v) {
        if (v == null) return "";
        if (v instanceof String) return (String) v;
        if (v instanceof Element) return ((Element) v).outerHtml();
        if (v instanceof Repr) return getResult((Repr) v);
        if (v instanceof Number) return JsEngine.numToString(((Number) v).doubleValue());
        if (v instanceof Boolean) return String.valueOf(v);
        if (v instanceof Map || v instanceof List || v instanceof JsonElement) {
            try {
                return GSON.toJson(toJsonTree(v));
            } catch (Exception e) {
                return String.valueOf(v);
            }
        }
        return String.valueOf(v);
    }

    /** 求值结果 → 字符串（对齐 analyzeStr 出口：对象/数组取 JSON 文本，repr 取可读文本） */
    private static String stringifyOut(Object out) {
        if (out instanceof Repr) return getResult((Repr) out);
        if (out instanceof Map || out instanceof List || out instanceof JsonElement) {
            try {
                return GSON.toJson(toJsonTree(out));
            } catch (Exception e) {
                return String.valueOf(out);
            }
        }
        if (out instanceof Number) return JsEngine.numToString(((Number) out).doubleValue());
        return String.valueOf(out);
    }

    /** 对齐 analyzer.js#stringify：null→''、repr→可读文本、对象→JSON 文本（finalize 用） */
    private static String stringify(Object v) {
        if (v == null) return "";
        return stringifyOut(v);
    }

    private static JsonElement toJsonTree(Object v) {
        if (v instanceof JsonElement) return (JsonElement) v;
        try {
            return GSON.toJsonTree(sanitize(v, Collections.newSetFromMap(new IdentityHashMap<Object, Boolean>()), 0));
        } catch (StackOverflowError | Exception e) {
            // 防御：Error 不在 T4Actions 的 catch(Exception) 内，漏出即 FATAL 杀进程
            return com.google.gson.JsonNull.INSTANCE;
        }
    }

    /**
     * 对象图脱壳：仅保留 String/Number/Boolean/null + Map/List 递归容器 + JsonElement 树，
     * 断开自引用环并限深 32。JS/Rhino 对象可形成引用环（如 result.self=result），Gson 反射
     * 序列化断不了真实环 → StackOverflowError FATAL（2026-10-29 实测崩溃于 Gson
     * ReflectiveTypeAdapterFactory 循环递归）。
     */
    private static Object sanitize(Object v, Set<Object> seen, int depth) {
        if (v == null || v instanceof String || v instanceof Number
                || v instanceof Boolean || v instanceof Character) return v;
        if (v instanceof JsonElement) return v;
        if (depth >= 32) return String.valueOf(v);
        if (v instanceof Map) {
            if (!seen.add(v)) return null;
            try {
                Map<String, Object> out = new LinkedHashMap<>();
                for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                    out.put(String.valueOf(e.getKey()), sanitize(e.getValue(), seen, depth + 1));
                }
                return out;
            } finally {
                seen.remove(v);
            }
        }
        if (v instanceof List) {
            if (!seen.add(v)) return null;
            try {
                List<Object> out = new ArrayList<>();
                for (Object e : (List<?>) v) out.add(sanitize(e, seen, depth + 1));
                return out;
            } finally {
                seen.remove(v);
            }
        }
        return String.valueOf(v);
    }

    /** 对齐 analyzer.js#tryJsonArray：'[' 开头整串 JSON.parse → 数组（失败 null） */
    private static List<Object> tryJsonArray(String s) {
        if (s == null) return null;
        String t = s.trim();
        if (!t.startsWith("[")) return null;
        try {
            JsonElement v = JsonParser.parseString(t);
            if (!v.isJsonArray()) return null;
            List<Object> out = new ArrayList<>();
            for (JsonElement e : v.getAsJsonArray()) out.add(jsonToJava(e));
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    /** JsonElement → Java 原生值树（wrapItem 的 json 分支直接消费 Map/List） */
    private static Object jsonToJava(JsonElement el) {
        if (el == null || el.isJsonNull()) return null;
        if (el.isJsonPrimitive()) return primitiveToJava(el.getAsJsonPrimitive());
        if (el.isJsonArray()) {
            List<Object> out = new ArrayList<>();
            for (JsonElement e : el.getAsJsonArray()) out.add(jsonToJava(e));
            return out;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : el.getAsJsonObject().entrySet()) {
            out.put(e.getKey(), jsonToJava(e.getValue()));
        }
        return out;
    }

    /** list 模式：字符串按行拆为数组（对齐 analyzer.js#arrayOrSplit / legado getStringList 结果回 List） */
    private static List<Object> arrayOrSplit(Object v) {
        if (v instanceof List) return new ArrayList<Object>((List<?>) v);
        String s = v == null ? "" : String.valueOf(v);
        List<Object> out = new ArrayList<>();
        if (!s.isEmpty()) {
            for (String part : s.split("\n", -1)) out.add(part);
        }
        return out;
    }

    private static List<Object> toList(Object r) {
        if (r instanceof List) return new ArrayList<Object>((List<?>) r);
        List<Object> out = new ArrayList<>(1);
        if (r != null) out.add(r);
        return out;
    }

    private static boolean nonEmpty(Object r, boolean list) {
        if (list) return r instanceof List && !((List<?>) r).isEmpty();
        return r != null && !"".equals(r);
    }

    private static JsonElement tryParseJson(String text) {
        if (text == null) return null;
        try {
            return JsonParser.parseString(text);
        } catch (Exception e) {
            return null;
        }
    }

    private static Object mapGet(Object obj, String key) {
        if (!(obj instanceof Map)) return null;
        return ((Map<?, ?>) obj).get(key);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapOrEmpty(Object obj) {
        if (obj instanceof Map) return (Map<String, Object>) obj;
        return new LinkedHashMap<>();
    }

    private static String defaultStr(Object primary, Object fallback) {
        if (primary instanceof String && !((String) primary).isEmpty()) return (String) primary;
        if (primary != null) return String.valueOf(primary);
        return fallback != null ? String.valueOf(fallback) : "";
    }

    private static Integer tryParseInt(String s) {
        if (s == null || s.isEmpty()) return null;
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * 相对地址对基准绝对化（对齐 legado AnalyzeRule#getAbsoluteURL 的最小语义：
     * 无基准或解析失败时原样返回；URL 选项后缀 ",{...}" 不参与解析——
     * java.net.URL 拒绝时原样回落，不吞内容）。
     */
    private static String toAbsoluteUrl(String base, String url) {
        if (base == null || base.isEmpty() || url.isEmpty()) return url;
        try {
            return new java.net.URL(new java.net.URL(base), url).toString();
        } catch (Exception e) {
            return url;
        }
    }

    private static String truncate(String s, int len) {
        if (s == null) return "";
        return s.length() > len ? s.substring(0, len) : s;
    }

    /** 从 open（'{' 处）找配对 '}' 索引（引号内与嵌套深度不误判），未闭合返回 -1（对齐 analyzer.js#matchBrace） */
    private static int matchBrace(String s, int open) {
        int depth = 0;
        char quote = 0;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (quote != 0) {
                if (c == '\\') {
                    i++;
                    continue;
                }
                if (c == quote) quote = 0;
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

    // ============ 产物结构 ============

    /**
     * 内容 repr（对齐 analyzer.js 头部注释的四形态 + 正则 groups 条目）。
     * 字段按 kind 取用：html→root/raw；json→data/raw；xml→w3cDoc/w3cNode/raw；text→text/raw。
     */
    public static final class Repr {
        /** html / json / xml / text */
        public String kind;
        /** 原始文本（元素/节点条目为 null） */
        public String raw;
        /** html：jsoup 根上下文（文档根传 Document） */
        public Element root;
        /** json：Gson 解析产物 */
        public JsonElement data;
        /** xml：W3C 文档 */
        public org.w3c.dom.Document w3cDoc;
        /** xml：上下文节点 */
        public org.w3c.dom.Node w3cNode;
        /** text：文本 */
        public String text;
        /** 正则 list 条目捕获组（组 0 = 整个匹配；供字段规则 $N 引用） */
        public List<String> groups;
        /** Kotlin 方言引擎实例缓存（对齐 legado getAnalyzeByXxx 的 content 级复用，避免热路径重复 parse） */
        public transient Object engineJsoup;
        /** Kotlin JSON 引擎实例缓存（同上） */
        public transient Object engineJson;
    }

    /** JS 分段（对齐 splitSourceRuleJs 产物） */
    private static final class Seg {
        final boolean js;
        final String code;

        Seg(boolean js, String code) {
            this.js = js;
            this.code = code;
        }
    }

    /** ## 拆分产物：body + 净化段列表 */
    private static final class Replace {
        String body;
        final List<Spec> replaces = new ArrayList<>();
    }

    /** 单个净化段：match/replace/first（first=true 仅取首个匹配替换）；preEval=true 已预求值不再重算 */
    private static final class Spec {
        String match = "";
        String replace = "";
        boolean first;
        boolean preEval;
    }

    /** 组合拆分产物类（Combo/ComboResult）已删——顶层组合在 Kotlin 方言引擎内处理 */
}
