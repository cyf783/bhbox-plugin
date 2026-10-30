package bh.box.plugin.legado.t4;

import android.util.Base64;
import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;

import java.net.URL;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import bh.box.plugin.legado.engine.HttpFetcher;
import bh.box.plugin.legado.engine.JsEngine;
import bh.box.plugin.legado.engine.JsExtensions;
import bh.box.plugin.legado.engine.RuleAnalyzer;
import bh.box.plugin.legado.engine.TemplateRenderer;
import bh.box.plugin.legado.engine.UrlRule;

/**
 * T4 五动作：home / list / detail / search / play（legado 书源 → TVBox T4 JSON）
 * ——逐函数对齐 app/server/src/t4/index.js。
 *
 * 与 node 版差异：
 * - execMixed 以 RuleAnalyzer.evalRule 等价（JS 混排分段语义已对齐）；
 * - Promise.all 并发翻页以固定线程池 invokeAll 等价（按 URL 序合并）；
 * - console.warn 以 Log.w 承载。
 */
public final class T4Actions {

    private static final String TAG = "legado-t4";

    /** disableHtmlEscaping 对齐 node JSON.stringify 不转义 HTML 字符 */
    static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    // ============ 全局缓存（对齐 t4/index.js 顶部模块级 Map） ============

    /** TOC 缓存：md5(bookUrl) → { at, chapters }（P0 最简 TTL 缓存，reload 时清空） */
    private static final Map<String, Object[]> tocCache =
            Collections.synchronizedMap(new LinkedHashMap<String, Object[]>());
    private static final long TOC_TTL = 30 * 60 * 1000L;
    private static final int MAX_TOC_CACHE = 200;     // 目录缓存上限（千章大对象防内存膨胀，超限删最早）
    private static final int MAX_TOC_PAGES = 20;      // nextTocUrl 翻页上限（防死循环）
    private static final int MAX_CONTENT_PAGES = 10;  // nextContentUrl 翻页上限

    /** 源级持久变量池（legado variables 语义：java.put/get 与 @put/@get 跨请求共享，
     *  如七猫 searchUrl put 的 headers 变量在详情 tocUrl JS 里 java.get 复用） */
    private static final Map<String, Map<String, Object>> sourceVars =
            Collections.synchronizedMap(new LinkedHashMap<String, Map<String, Object>>());

    /** 书级变量快照：sk → Map(bookUrl → Map(key→val))。legado 里 put 变量存 book 实例
     *  （searchBook → 详情同一对象，变量随书走）；T4 请求无状态，以搜索阶段 bookItem
     *  执行前后的池 diff 作该书快照，详情阶段合并回放——否则多本书依次 put 同名变量
     *  （如阿巴 bid）在源级池互相覆盖，详情 java.get 串台 */
    private static final Map<String, Map<String, Map<String, Object>>> bookVars =
            Collections.synchronizedMap(new LinkedHashMap<String, Map<String, Map<String, Object>>>());
    private static final int MAX_BOOK_VARS = 300; // 每源书籍快照上限（超限删最早）

    /** 章节上下文缓存：md5(sk|chapterUrl) → { book, chapter:{title,index} }。play 阶段查回注入
     *  makeCtx——legado AnalyzeRule.chapter/book 绑定（正文规则 JS 的 chapter.title/title/book.name
     *  引用依赖此缓存）；T4 无状态，detail 目录阶段写入 */
    private static final Map<String, Map<String, Object>> chapterCtxs =
            Collections.synchronizedMap(new LinkedHashMap<String, Map<String, Object>>());
    private static final int MAX_CHAPTER_CTXS = 5000; // 章节上下文上限（超限删最早）

    /** 对齐 t4/index.js#clearCaches：reload 时清空目录/书快照/章节上下文缓存。
     *  注意 sourceVars 源级变量池 node 版不清（模块级 Map，clearCaches 不含它）——
     *  池键为 bookSourceUrl，换源后新键互不影响，旧键残留无副作用，语义等价保留。 */
    static void clearCaches() {
        tocCache.clear();
        bookVars.clear();
        chapterCtxs.clear();
    }

    private T4Actions() {}

    // ============ 每请求上下文（对齐 t4/index.js#makeCtx） ============

    /**
     * 书级快照合并视图（对齐 makeCtx 内 merged Map 的 get/has/set 覆盖语义）：
     * get/has 书级优先、源级兜底；put 双写两层（源级保持 play 等后续请求可见，
     * 与旧源级行为兼容；书级供同书再次详情复用）。迭代视图 = 书级层
     * （node merged 底层为书快照副本，迭代不含源级独有键——bookItem 池 diff 依赖此语义）。
     */
    private static final class MergedVars extends AbstractMap<String, Object> {
        private final Map<String, Object> book;   // 书级层（快照副本 + 本次 put 落点）
        private final Map<String, Object> source; // 源级池

        MergedVars(Map<String, Object> snap, Map<String, Object> source) {
            this.book = new LinkedHashMap<>(snap);
            this.source = source;
        }

        @Override
        public Object get(Object k) {
            return book.containsKey(k) ? book.get(k) : source.get(k);
        }

        @Override
        public boolean containsKey(Object k) {
            return book.containsKey(k) || source.containsKey(k);
        }

        @Override
        public Object put(String k, Object v) {
            Object old = book.put(k, v);
            source.put(k, v);
            return old;
        }

        @Override
        public Set<Entry<String, Object>> entrySet() {
            return book.entrySet();
        }
    }

    /**
     * 对齐 t4/index.js#makeCtx：每请求上下文（变量池 + java API）。
     * ctx 键：source/book/chapter/title/baseUrl/vars/key/page/java（cache 桥 Java 版未移植，JS 侧不依赖）。
     */
    static Map<String, Object> makeCtx(Map<String, Object> source, String baseUrl, String key,
                                       Integer page, Map<String, Object> book,
                                       Map<String, Object> chapter, String title,
                                       Map<String, Object> bookSnap) {
        String sk = SourceManager.strOrEmpty(SourceManager.mapGet(source, "bookSourceUrl")).trim();
        Map<String, Object> base = sourceVars.get(sk);
        if (base == null) {
            base = new LinkedHashMap<>();
            sourceVars.put(sk, base);
        }
        Map<String, Object> vars = bookSnap != null ? new MergedVars(bookSnap, base) : base;
        Map<String, Object> ctx = new LinkedHashMap<>();
        ctx.put("source", source);
        ctx.put("book", book != null ? book : new LinkedHashMap<String, Object>());
        ctx.put("chapter", chapter);
        ctx.put("title", title == null ? "" : title);
        ctx.put("baseUrl", (baseUrl != null && !baseUrl.isEmpty())
                ? baseUrl : SourceManager.mapGet(source, "bookSourceUrl"));
        ctx.put("vars", vars);
        ctx.put("key", key == null ? "" : key);
        ctx.put("page", page != null ? page : Integer.valueOf(1));
        // JsExtensions 构造时自动把自身注入 ctx["java"]（同 node createJavaApi(ctx)）
        ctx.put("java", new JsExtensions(ctx));
        return ctx;
    }

    // ============ 抓取与 URL 辅助 ============

    /**
     * 对齐 t4/index.js#fetchPage + http.js#fetchText：带书源默认头的抓取。
     * node fetchText 内部解析 options 尾巴（method/body/headers/charset/option.js）+
     * GET query 编码 + POST 表单三分支，Java 版在此逐项复刻（HttpFetcher 只承担原始抓取）。
     */
    static String fetchPage(Map<String, Object> ctx, String url) {
        UrlRule.Parsed p = UrlRule.parseUrlRule(String.valueOf(url));
        // legado AnalyzeUrl：相对 URL 先对 baseUrl 绝对化（书源 searchUrl/tocUrl 常写相对路径，
        // 顶点系 "/modules/article/search.php?q={{key}}" 事件）后再校验 http
        String u = absUrl(p.url, ctx.get("baseUrl"));
        if (!Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE).matcher(u).find()) {
            throw new RuntimeException("not http url: " + truncate(u, 100));
        }
        // legado UrlOption.js：解析完参数后执行，结果赋值给 url
        if (p.options.js != null && !p.options.js.isEmpty()) {
            try {
                Map<String, Object> b = new LinkedHashMap<>();
                b.put("result", u);
                b.put("baseUrl", u);
                Object java = ctx.get("java");
                if (java != null) b.put("java", java);
                Object out = JsEngine.eval(p.options.js, b);
                if (out != null && !String.valueOf(out).isEmpty()) u = String.valueOf(out);
            } catch (Exception e) {
                Log.w(TAG, "option.js failed: " + e.getMessage());
            }
        }
        Map<String, String> headers = new LinkedHashMap<>();
        if (p.options.headers != null) headers.putAll(p.options.headers);
        Map<String, String> srcHeaders = JsExtensions.parseSourceHeaders(ctx.get("source"), ctx);
        if (srcHeaders != null) headers.putAll(srcHeaders); // opts.headers 优先（opts 在后覆盖）
        String method = "POST".equalsIgnoreCase(p.options.method) ? "POST" : "GET";
        String body = null;
        if ("POST".equals(method)) {
            body = UrlRule.applyPostBody("POST", p.options.body != null ? p.options.body : "",
                    headers, p.options.charset);
        } else {
            // legado analyzeUrl：GET query 段按 option.charset 编码
            u = UrlRule.encodeUrlQuery(u, p.options.charset);
        }
        HttpFetcher.HttpResult r = HttpFetcher.fetch(u, method, headers, body, p.options.charset);
        return r.body;
    }

    /** 对齐 t4/index.js#absUrl：URL 绝对化（legado getAbsoluteURL：javascript: 丢弃） */
    static String absUrl(Object u, Object base) {
        if (u == null) return "";
        String s = String.valueOf(u).trim();
        if (s.isEmpty() || s.toLowerCase(Locale.ROOT).startsWith("javascript")) return "";
        try {
            return new URL(base != null ? new URL(String.valueOf(base)) : null, s).toString();
        } catch (Exception e) {
            return s;
        }
    }

    /**
     * 对齐 t4/index.js#absRule：URL 规则绝对化——拆出 options 尾巴，仅对 URL 部分做 base
     * 解析（避免 {} 被百分号编码）。optionsText 含首尾花括号，直接以逗号拼回。
     */
    static String absRule(String rule, Object base) {
        String[] parts = splitUrlRule(rule == null ? "" : rule);
        String abs = absUrl(parts[0], base);
        return parts[1] != null ? abs + "," + parts[1] : abs;
    }

    /** 对齐 urlrule.js#splitUrlRule：返回 [url, optionsText]（optionsText 含花括号，无则 null） */
    private static String[] splitUrlRule(String rule) {
        String r = String.valueOf(rule == null ? "" : rule);
        Matcher m = OPTIONS_START.matcher(r);
        if (m.find()) {
            int start = m.start();
            int end = matchBrace(r, start);
            if (end >= 0) {
                return new String[]{r.substring(0, start).trim(), r.substring(start + 1, end + 1)};
            }
        }
        return new String[]{r.trim(), null};
    }

    /** 对齐 urlrule.js#OPTIONS_START：/\s*,\s*(?=\{)/ */
    private static final Pattern OPTIONS_START = Pattern.compile("\\s*,\\s*(?=\\{)");

    /** 对齐 urlrule.js#matchBrace：从 ',' 后的 '{' 起配对扫描（忽略引号内内容） */
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

    /**
     * 对齐 t4/index.js#parseRulePrefix（legado WebBookRuleUtils.parseRulePrefix）：
     * 列表规则首字符 - → reverse 标记并剥离，+ → 仅剥离。
     */
    private static Map<String, Object> parseRulePrefix(String ruleStr) {
        String rule = ruleStr == null ? "" : String.valueOf(ruleStr);
        boolean reverse = false;
        if (rule.startsWith("-")) {
            reverse = true;
            rule = rule.substring(1);
        } else if (rule.startsWith("+")) {
            rule = rule.substring(1);
        }
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("rule", rule);
        out.put("reverse", reverse);
        return out;
    }

    /** 对齐 renderUrl 的 JS 形态判定：/<js>[\w\W]*?<\/js>|@js:/i */
    private static final Pattern JS_URL = Pattern.compile("<js>[\\w\\W]*?</js>|@js:", Pattern.CASE_INSENSITIVE);

    /**
     * 对齐 t4/index.js#renderUrl：URL 模板渲染——普通 {{}} 与 @js://<js> 两种形态
     * （legado analyzeJs：result 绑定整条规则原文，JS 段间非空文本段覆盖 result；
     * JS 后再做 {{}} 替换）。
     */
    static String renderUrl(Map<String, Object> ctx, Object tpl) {
        String s = tpl == null ? "" : String.valueOf(tpl);
        if (JS_URL.matcher(s).find()) {
            String rendered;
            try {
                // execMixed({...ctx, result: s}, s, s, 30000)：URL 构建含同步抓取，放宽超时
                Object out = RuleAnalyzer.evalRule(s, s, ctx);
                rendered = out == null ? "" : String.valueOf(out);
            } catch (Exception e) {
                rendered = null;
            }
            // node：JS 求值失败（含社区源伪 JS 写法）回退剥离 JS 标签的原文，由 URL 解析
            // 拆出可用段；evalRule 失败与成功空值在此合并回退（结果均为无效 URL 走空列表，殊途同归）
            if (rendered == null || rendered.isEmpty()) {
                rendered = s.replaceAll("(?i)</?js>", "").replaceFirst("(?i)^@js:", "");
            }
            if (rendered.contains("{{") && rendered.contains("}}")) {
                Map<String, Object> b = new LinkedHashMap<>(ctx);
                b.put("result", rendered);
                rendered = TemplateRenderer.render(rendered, b);
            }
            return rendered;
        }
        Map<String, Object> b = new LinkedHashMap<>(ctx);
        b.put("result", s);
        return TemplateRenderer.render(s, b);
    }

    // ============ home（对齐 t4/index.js#t4Home / parseExploreEntries） ============

    /** exploreUrl → { class: [{type_id, type_name}], list: [] } */
    public static Map<String, Object> t4Home(Map<String, Object> source) {
        List<Object> classes = new ArrayList<>();
        for (Map<String, Object> e : parseExploreEntries(source, null)) {
            LinkedHashMap<String, Object> pair = new LinkedHashMap<>();
            pair.put("u", e.get("url"));
            pair.put("t", e.get("title"));
            LinkedHashMap<String, Object> cls = new LinkedHashMap<>();
            cls.put("type_id", b64urlEncode(GSON.toJson(pair)));
            cls.put("type_name", e.get("title"));
            classes.add(cls);
        }
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("class", classes);
        out.put("list", new ArrayList<Object>());
        return out;
    }

    /**
     * 对齐 t4/index.js#parseExploreEntries：exploreUrl 解析（legado exploreKinds）——
     * <js>/@js: 开头先执行 JS，结果按 JSON 数组 [{title,url}] 或 `title::url`
     * （&&/换行分隔）解析。
     */
    static List<Map<String, Object>> parseExploreEntries(Map<String, Object> source, Map<String, Object> ctx) {
        Object raw = SourceManager.mapGet(source, "exploreUrl");
        List<Map<String, Object>> out = new ArrayList<>();
        if (raw == null) return out;
        String text = String.valueOf(raw).trim();
        // legado exploreKinds：<js>/@js: 开头 → 执行 JS，产物再走规则解析
        if (Pattern.compile("^<js>", Pattern.CASE_INSENSITIVE).matcher(text).find()
                || Pattern.compile("^@js:", Pattern.CASE_INSENSITIVE).matcher(text).find()) {
            String code = text.toLowerCase(Locale.ROOT).startsWith("@js:")
                    ? text.substring(4)
                    : text.substring(4, text.lastIndexOf('<'));
            try {
                Map<String, Object> execCtx = ctx != null ? ctx : makeCtx(source, null, null, null, null, null, null, null);
                Map<String, Object> b = new LinkedHashMap<>(execCtx);
                b.put("result", text);
                Object outJs = RuleAnalyzer.evalRule(text, text, b);
                text = outJs == null ? "" : String.valueOf(outJs).trim();
            } catch (Exception e) {
                Log.w(TAG, "exploreUrl js failed: " + e.getMessage());
                return out;
            }
        }
        if (text.startsWith("[")) {
            try {
                for (Object itemObj : parseJsonArrayLenient(text)) {
                    if (itemObj instanceof Map) {
                        Map<?, ?> item = (Map<?, ?>) itemObj;
                        pushEntry(out, item.get("title"), item.get("url"));
                    }
                }
                return out;
            } catch (Exception ignore) {
                // 落到行式解析
            }
        }
        // legado：split("(&&|\n)+") → title::url
        for (String line : text.split("(?:&&|\n)+")) {
            String l = line.trim();
            if (l.isEmpty()) continue;
            int idx = l.indexOf("::");
            if (idx > 0) pushEntry(out, l.substring(0, idx), l.substring(idx + 2));
        }
        return out;
    }

    private static void pushEntry(List<Map<String, Object>> out, Object title, Object url) {
        String t = title == null ? "" : String.valueOf(title).trim();
        String u = url == null ? "" : String.valueOf(url).trim();
        if (!t.isEmpty() && !u.isEmpty()) {
            LinkedHashMap<String, Object> e = new LinkedHashMap<>();
            e.put("title", t);
            e.put("url", u);
            out.add(e);
        }
    }

    /**
     * 对齐 t4/index.js#parseJsonArrayLenient：宽松 JSON 数组解析（legado 用 Gson lenient）——
     * 字符串值内的裸控制字符（多行 @js 分类 URL 是社区源常态）自动转义后重试。
     */
    private static List<Object> parseJsonArrayLenient(String text) throws Exception {
        try {
            return jsonToJava(JsonParser.parseString(text));
        } catch (Exception ignore) {
            // lenient 重试：字符串值内裸 \n \r \t 转义
        }
        StringBuilder out = new StringBuilder(text.length());
        boolean inStr = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (!inStr) {
                if (c == '"') inStr = true;
                out.append(c);
                continue;
            }
            if (c == '\\') {
                if (i + 1 >= text.length()) break;
                out.append(c).append(text.charAt(i + 1));
                i++;
                continue;
            }
            if (c == '"') {
                inStr = false;
                out.append(c);
            } else if (c == '\n') out.append("\\n");
            else if (c == '\r') out.append("\\r");
            else if (c == '\t') out.append("\\t");
            else out.append(c);
        }
        return jsonToJava(JsonParser.parseString(out.toString()));
    }

    /** JsonElement → Java 值树 List（exploreUrl JSON 数组形态；标量/嵌套递归展开） */
    private static List<Object> jsonToJava(JsonElement el) throws Exception {
        List<Object> out = new ArrayList<>();
        if (!el.isJsonArray()) throw new Exception("not a json array");
        for (JsonElement e : el.getAsJsonArray()) out.add(plainValue(e));
        return out;
    }

    private static Object plainValue(JsonElement el) {
        if (el == null || el.isJsonNull()) return null;
        if (el.isJsonPrimitive()) {
            com.google.gson.JsonPrimitive p = el.getAsJsonPrimitive();
            if (p.isBoolean()) return Boolean.valueOf(p.getAsBoolean());
            if (p.isNumber()) return p.getAsNumber();
            return p.getAsString();
        }
        if (el.isJsonArray()) {
            List<Object> arr = new ArrayList<>();
            for (JsonElement e : el.getAsJsonArray()) arr.add(plainValue(e));
            return arr;
        }
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : el.getAsJsonObject().entrySet()) {
            m.put(e.getKey(), plainValue(e.getValue()));
        }
        return m;
    }

    // ============ list（分类列表，对齐 t4/index.js#t4List） ============

    @SuppressWarnings("unchecked")
    public static Map<String, Object> t4List(Map<String, Object> source, String tid, Object pg) {
        Map<String, Object> entry = null;
        try {
            entry = (Map<String, Object>) GSON.fromJson(
                    new String(b64urlDecode(String.valueOf(tid)), java.nio.charset.StandardCharsets.UTF_8), Map.class);
        } catch (Exception ignore) {
        }
        if (entry == null || String.valueOf(entry.get("u") == null ? "" : entry.get("u")).trim().isEmpty()) {
            return emptyList(pg, null);
        }

        int page = Math.max(1, parseIntOr(pg, 1));
        Map<String, Object> ctx = makeCtx(source, null, null, page, null, null, null, null);
        String url = absRule(renderUrl(ctx, entry.get("u")), ctx.get("baseUrl"));
        // legado BookList 阶段：baseUrl 绑分类页地址——ruleExplore JS 从 baseUrl 提取分类参数
        ctx.put("baseUrl", url);
        String content;
        try {
            content = fetchPage(ctx, url);
        } catch (Exception e) {
            return emptyList(pg, e.getMessage());
        }

        // ruleExplore 缺省整体回退 ruleSearch（列表与字段规则须同源，否则字段全空）
        Map<String, Object> ruleExplore = mapOrEmpty(SourceManager.mapGet(source, "ruleExplore"));
        Map<String, Object> rule = (!ruleExplore.isEmpty()
                && (ruleExplore.get("bookList") != null || ruleExplore.get("name") != null))
                ? ruleExplore : mapOrEmpty(SourceManager.mapGet(source, "ruleSearch"));
        Map<String, Object> pre = parseRulePrefix(strOrEmpty(rule.get("bookList")));
        String listRule = String.valueOf(pre.get("rule"));
        boolean reverse = Boolean.TRUE.equals(pre.get("reverse"));
        List<Object> items = RuleAnalyzer.evalRuleList(listRule, RuleAnalyzer.makeContent(content), ctx);
        List<Object> list = new ArrayList<>();
        Set<String> seenUrls = new HashSet<>();
        for (Object item : items) {
            try {
                Map<String, Object> it = bookItem(source, ctx, item, rule);
                String bu = decodeBookId(strOrEmpty(it.get("vod_id"))).get("bookUrl");
                if (seenUrls.contains(bu)) continue; // legado distinctBy bookUrl
                seenUrls.add(bu);
                list.add(it);
            } catch (Exception e) {
                Log.w(TAG, "explore item failed: " + e.getMessage());
            }
        }
        if (reverse) Collections.reverse(list); // legado BookList：- 前缀倒序（去重后）
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("list", list);
        out.put("page", page);
        // 有数据即可继续翻页（legado 无 pagecount 概念）
        out.put("pagecount", !list.isEmpty() ? page + 1 : page);
        out.put("total", 0);
        out.put("limit", 0);
        return out;
    }

    /** 对齐 t4/index.js#emptyList */
    private static Map<String, Object> emptyList(Object pg, String err) {
        if (err != null) Log.w(TAG, "list failed: " + err);
        int page = Math.max(1, parseIntOr(pg, 1));
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("list", new ArrayList<Object>());
        out.put("page", page);
        out.put("pagecount", page);
        out.put("total", 0);
        out.put("limit", 0);
        return out;
    }

    /**
     * 对齐 t4/index.js#bookItem：列表元素 → T4 vod 条目（ruleSearch/ruleExplore 字段族）。
     * name 先于 bookUrl 求值（legado 字段顺序）：源用 name 规则 @put 写变量、bookUrl 规则 @get 读。
     */
    private static Map<String, Object> bookItem(Map<String, Object> source, Map<String, Object> ctx,
                                                Object item, Map<String, Object> rule) {
        // 变量池为请求级共享 Map（makeCtx 注入），字段求值期间 put 即写入；快照在 bookUrl 求值后全量记
        Object poolObj = ctx.get("vars");
        Map<String, Object> pool = poolObj instanceof Map ? (Map<String, Object>) poolObj : null;
        String name = evalField(item, rule.get("name"), ctx);
        // 字段求值顺序对齐 legado BookList#getSearchBook：name→author→kind→wordCount→
        // latestChapter→intro→coverUrl→bookUrl——bookUrl 最后（企鹅浏览等源 bookUrl 规则
        // {{book.kind}} 引用同条目先求值的 kind/变量，顺序错则 bookUrl 取空）
        String author = evalField(item, rule.get("author"), ctx);
        String kind = evalField(item, rule.get("kind"), ctx).replace("\n", ",");
        String wordCount = evalField(item, rule.get("wordCount"), ctx);
        // legado searchBook 实例语义：字段求值写回 book，后续 bookUrl {{book.kind}} 可引用
        Object bookObj = ctx.get("book");
        if (bookObj instanceof Map) {
            ((Map<String, Object>) bookObj).put("author", author);
            ((Map<String, Object>) bookObj).put("kind", kind);
            ((Map<String, Object>) bookObj).put("wordCount", wordCount);
        }
        String lastChapter = evalField(item, rule.get("lastChapter"), ctx);
        String intro = evalField(item, rule.get("intro"), ctx);
        String pic = absUrl(evalField(item, rule.get("coverUrl"), ctx), ctx.get("baseUrl"));
        // absRule 而非 absUrl：JS 生成的 bookUrl 常带 ,{...} options 尾巴，new URL 会把它编码成
        // %7B%22... 导致下游 parseOptions 解析不出。bookUrl 传 isUrl=true（legado BookList
        // getString0 只取收集列表第一项——.bookdesc@a@href 多 a 时仅首个为详情链接）
        String bookUrlRaw = RuleAnalyzer.evalRule(strOrEmpty(rule.get("bookUrl")), item, ctx, true);
        String bookUrl = absRule(bookUrlRaw, ctx.get("baseUrl"));
        if (bookUrl.isEmpty()) throw new RuntimeException("empty bookUrl");
        // 快照全量记（本条目求值结束时的池全量）：列表级 put（如潇社音乐 bookList 的 @js
        // java.put('json',...)，执行早于本条目基线）与条目级 put 都须随书传递——legado App
        // 变量绑书实例跨阶段存活，ruleToc @js java.get('json') 在 ChapterList 阶段仍可取。
        // 有意偏差：node 版 bookItem 按 before 基线 diff 记录，列表级 put 被判「未变」漏记
        // （潇社音乐 vod_play_url 空即此洞）；快照按 bookUrl 隔离回放（MergedVars），无跨书串台
        if (pool != null) {
            String sk = SourceManager.strOrEmpty(SourceManager.mapGet(source, "bookSourceUrl")).trim();
            Map<String, Map<String, Object>> bv = bookVars.get(sk);
            if (bv == null) {
                bv = new LinkedHashMap<>();
                bookVars.put(sk, bv);
            }
            if (!bv.containsKey(bookUrl) && bv.size() >= MAX_BOOK_VARS) {
                // 超限删最早（node: bv.delete(bv.keys().next().value)）
                String oldest = bv.keySet().iterator().next();
                bv.remove(oldest);
            }
            Map<String, Object> rec = bv.get(bookUrl);
            if (rec == null) {
                rec = new LinkedHashMap<>();
                bv.put(bookUrl, rec);
            }
            rec.putAll(pool);
        }
        LinkedHashMap<String, Object> it = new LinkedHashMap<>();
        it.put("vod_id", encodeBookId(bookUrl, name));
        it.put("vod_name", !name.isEmpty() ? name : "未知书名");
        it.put("vod_pic", pic);
        it.put("vod_remarks", !lastChapter.isEmpty() ? lastChapter : wordCount);
        it.put("vod_author", author);
        it.put("vod_class", kind);
        it.put("vod_content", intro);
        return it;
    }

    /** node: analyzeStr(item, rule[field] || '', ctx)——字段规则求值（空规则返回 ''） */
    private static String evalField(Object item, Object ruleField, Map<String, Object> ctx) {
        String rule = ruleField == null ? "" : String.valueOf(ruleField);
        if (rule.isEmpty()) return "";
        return RuleAnalyzer.evalRule(rule, item, ctx);
    }

    /**
     * 对齐 t4/index.js#encodeBookId：vod_id 复合编码 `url|base64url(书名)` —— legado BookInfo
     * 规则取空时继承搜索阶段书名（book.name 保留语义），T4 无状态故由搜索透传；旧格式（纯 URL）兼容。
     */
    static String encodeBookId(String bookUrl, String name) {
        return !name.isEmpty()
                ? bookUrl + "|" + b64urlEncode(name.getBytes(java.nio.charset.StandardCharsets.UTF_8))
                : bookUrl;
    }

    /** 对齐 t4/index.js#decodeBookId：→ { bookUrl, name } */
    static Map<String, String> decodeBookId(String ids) {
        String s = ids == null ? "" : String.valueOf(ids);
        int i = s.indexOf('|');
        if (i < 0) {
            LinkedHashMap<String, String> out = new LinkedHashMap<>();
            out.put("bookUrl", s);
            out.put("name", "");
            return out;
        }
        String name = "";
        try {
            name = new String(b64urlDecode(s.substring(i + 1)), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception ignore) {
            name = "";
        }
        LinkedHashMap<String, String> out = new LinkedHashMap<>();
        out.put("bookUrl", s.substring(0, i));
        out.put("name", name);
        return out;
    }

    // ============ detail（书籍信息 + 目录，对齐 t4/index.js#t4Detail） ============

    public static Map<String, Object> t4Detail(Map<String, Object> source, String ids) {
        Map<String, String> id = decodeBookId(ids);
        String bookUrl = id.get("bookUrl");
        String listName = id.get("name");
        if (bookUrl == null || bookUrl.isEmpty()) return emptyDetail(null);
        // legado BookInfo 阶段：baseUrl 绑 bookUrl；变量池回放该书搜索阶段快照（防多书同名变量串台）
        String sk = SourceManager.strOrEmpty(SourceManager.mapGet(source, "bookSourceUrl")).trim();
        Map<String, Object> snap = null;
        Map<String, Map<String, Object>> bv = bookVars.get(sk);
        if (bv != null) snap = bv.get(bookUrl);
        // legado BookInfo 阶段 book 为搜索传入实例：T4 以搜索书名 + bookUrl 重建（ruleBookInfo JS 引用 book.name）
        Map<String, Object> book = new LinkedHashMap<>();
        book.put("name", listName == null ? "" : listName);
        book.put("bookUrl", bookUrl);
        Map<String, Object> ctx = makeCtx(source, bookUrl, null, null, book, null, null, snap);
        Map<String, Object> info = mapOrEmpty(SourceManager.mapGet(source, "ruleBookInfo"));

        String content;
        try {
            content = fetchPage(ctx, bookUrl);
        } catch (Exception e) {
            return emptyDetail(e.getMessage());
        }
        RuleAnalyzer.Repr contentRepr = RuleAnalyzer.makeContent(content);

        // legado ruleBookInfo.init（BookInfo.analyzeBookInfo）：init 规则先执行，
        // 结果 setContent 作为新内容供其余字段规则解析（如 JSON 包裹 $.data 先重根）
        Object initRule = info.get("init");
        if (initRule != null && !String.valueOf(initRule).trim().isEmpty()) {
            String initOut = RuleAnalyzer.evalRule(String.valueOf(initRule).trim(), contentRepr, ctx);
            if (!initOut.isEmpty()) {
                contentRepr = RuleAnalyzer.makeContent(initOut, "json".equals(contentRepr.kind) ? "json" : null);
            }
        }

        String name = strOf(evalRuleTrim(contentRepr, info.get("name"), ctx));
        if (name.isEmpty()) name = listName == null ? "" : listName; // 规则取空时继承搜索书名
        // book 上下文补全（legado BookInfo：详情字段写回 book 实例）——字段先于 tocUrl 求值：
        // legado getBookInfo 顺序 name→author→kind→wordCount→lastChapter→intro→coverUrl→tocUrl，
        // 企鹅浏览等源 tocUrl 规则 {{book.kind}} 引用先求值的 kind
        book.put("name", name);
        book.put("author", evalRuleTrim(contentRepr, info.get("author"), ctx));
        book.put("kind", evalRuleTrim(contentRepr, info.get("kind"), ctx).replace("\n", ","));
        book.put("wordCount", evalRuleTrim(contentRepr, info.get("wordCount"), ctx));
        book.put("lastChapter", evalRuleTrim(contentRepr, info.get("lastChapter"), ctx));
        book.put("intro", evalRuleTrim(contentRepr, info.get("intro"), ctx));
        book.put("coverUrl", absUrl(evalRuleTrim(contentRepr, info.get("coverUrl"), ctx), bookUrl));
        // 目录：tocUrl 可与 bookUrl 不同（部分源书籍页与目录页分离）；absRule 保留 options 尾巴。
        // isUrl=true（legado BookInfo getString0 取第一项）；tocUrl 在全部字段之后（legado 同序）
        Object tocRule = info.get("tocUrl");
        String tocUrlRaw = tocRule != null ? RuleAnalyzer.evalRule(String.valueOf(tocRule), contentRepr, ctx, true).trim() : "";
        String tocUrl = !tocUrlRaw.isEmpty() ? absRule(tocUrlRaw, bookUrl) : bookUrl;
        List<Map<String, Object>> chapters = loadToc(ctx, tocUrl, mapOrEmpty(SourceManager.mapGet(source, "ruleToc")));
        // 书名与目录双空 → 页面无效（404/验证码等），返回空列表
        if (name.isEmpty() && chapters.isEmpty()) return emptyDetail(null);

        String author = strOf(book.get("author"));
        String kind = strOf(book.get("kind"));
        String wordCount = strOf(book.get("wordCount"));
        String intro = strOf(book.get("intro"));
        String lastChapter = strOf(book.get("lastChapter"));

        StringBuilder playUrl = new StringBuilder();
        for (Map<String, Object> c : chapters) {
            if (playUrl.length() > 0) playUrl.append('#');
            playUrl.append(String.valueOf(c.get("name")).replaceAll("[#＃$＄]", " "))
                    .append('$')
                    .append(encodeChapterUrl(String.valueOf(c.get("url"))));
        }
        LinkedHashMap<String, Object> vod = new LinkedHashMap<>();
        vod.put("vod_id", ids);
        vod.put("vod_name", !name.isEmpty() ? name : "未知书名");
        vod.put("vod_pic", absUrl(book.get("coverUrl"), bookUrl));
        vod.put("vod_actor", author);
        vod.put("vod_class", kind);
        vod.put("vod_remarks", wordCount);
        vod.put("vod_content", !intro.isEmpty() ? intro : lastChapter);
        long stype0 = numOrZero(SourceManager.mapGet(source, "bookSourceType"));
        vod.put("vod_play_from", stype0 == 1 ? "音频" : stype0 == 2 ? "漫画" : "正文");
        vod.put("vod_play_url", playUrl.toString());
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        List<Object> l = new ArrayList<>();
        l.add(vod);
        out.put("list", l);
        return out;
    }

    /** node: get(field) = analyzeStr(content, info[field]||'', ctx).trim()（空规则 → ''） */
    private static String evalRuleTrim(Object content, Object ruleField, Map<String, Object> ctx) {
        String rule = ruleField == null ? "" : String.valueOf(ruleField);
        if (rule.isEmpty()) return "";
        return RuleAnalyzer.evalRule(rule, content, ctx).trim();
    }

    private static String strOf(Object v) {
        return v == null ? "" : String.valueOf(v);
    }

    private static long numOrZero(Object v) {
        return v instanceof Number ? ((Number) v).longValue() : 0L;
    }

    /** 对齐 t4/index.js#emptyDetail */
    private static Map<String, Object> emptyDetail(String err) {
        if (err != null) Log.w(TAG, "detail failed: " + err);
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("list", new ArrayList<Object>());
        return out;
    }

    // ============ 目录抓取（对齐 t4/index.js#loadToc） ============

    /**
     * 对齐 t4/index.js#loadToc：抓取目录（nextTocUrl 翻页合并 + TTL 缓存）。
     * legado BookChapterList 语义：章节按 url 去重（distinctBy）；nextTocUrl 经 getStringList
     * 取列表——0 停止、1 顺链（visited 去重）、多个并发抓取按 URL 序合并（并发页不再递归）；
     * 列表前缀按 parseRulePrefix：- 前缀为页面倒序，无前缀/+ 为页面序。
     */
    private static List<Map<String, Object>> loadToc(Map<String, Object> ctx, String tocUrl,
                                                     Map<String, Object> rule) {
        Map<String, Object> source = mapOrEmpty(ctx.get("source"));
        String sk = SourceManager.strOrEmpty(SourceManager.mapGet(source, "bookSourceUrl")).trim();
        String cacheKey = SourceManager.md5(sk + "|" + tocUrl);
        Object[] cached = tocCache.get(cacheKey);
        if (cached != null && System.currentTimeMillis() - (Long) cached[0] < TOC_TTL) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> chapters = (List<Map<String, Object>>) cached[1];
            return chapters;
        }

        Object nameRuleObj = rule.get("chapterName");
        String nameRule = nameRuleObj != null ? String.valueOf(nameRuleObj) : "text";
        Object urlRuleObj = rule.get("chapterUrl");
        String urlRule = urlRuleObj != null ? String.valueOf(urlRuleObj) : "href";
        Map<String, Object> pre = parseRulePrefix(strOrEmpty(rule.get("chapterList")));
        String listRule = String.valueOf(pre.get("rule"));
        boolean reverse = Boolean.TRUE.equals(pre.get("reverse"));
        List<Map<String, Object>> chapters = new ArrayList<>();
        Set<String> seenUrls = new HashSet<>();
        List<String> visited = new ArrayList<>();
        visited.add(tocUrl);

        // 追加章节（按 url 去重 + 章节上下文缓存供 play 查回）；node 闭包 addChapter
        class TocAcc {
            Map<String, Object> add(String name, String u, Object book) {
                if (name == null || name.isEmpty() || seenUrls.contains(u)) return null;
                seenUrls.add(u);
                LinkedHashMap<String, Object> c = new LinkedHashMap<>();
                c.put("name", name);
                c.put("url", u);
                chapters.add(c);
                String ck = SourceManager.md5(sk + "|" + u);
                LinkedHashMap<String, Object> ch = new LinkedHashMap<>();
                ch.put("title", name);
                ch.put("index", chapters.size() - 1);
                LinkedHashMap<String, Object> cctx = new LinkedHashMap<>();
                cctx.put("book", book);
                cctx.put("chapter", ch);
                chapterCtxs.put(ck, cctx);
                if (chapterCtxs.size() > MAX_CHAPTER_CTXS) {
                    String oldest = chapterCtxs.keySet().iterator().next();
                    chapterCtxs.remove(oldest);
                }
                return c;
            }
        }
        TocAcc acc = new TocAcc();

        // 解析单页章节，返回该页内容 repr（供 nextTocUrl 求值）；node 闭包 parsePage
        class PageParser {
            RuleAnalyzer.Repr parse(String pageUrl, String body) {
                RuleAnalyzer.Repr content = RuleAnalyzer.makeContent(body);
                List<Object> items = RuleAnalyzer.evalRuleList(listRule, content, ctx);
                for (Object item : items) {
                    try {
                        String name = RuleAnalyzer.evalRule(nameRule, item, ctx).trim();
                        String cu = RuleAnalyzer.evalRule(urlRule, item, ctx).trim();
                        // absRule 拆 options 尾巴后仅对 URL 部分做 base 解析；
                        // legado：章节 url 取空时用 baseUrl（目录页地址）替代——单页书依赖此容错出目录
                        acc.add(name, !cu.isEmpty() ? absRule(cu, pageUrl) : pageUrl, ctx.get("book"));
                    } catch (Exception ignore) {
                        // 单条失败隔离
                    }
                }
                return content;
            }
        }
        PageParser parser = new PageParser();

        // 下一页 URL 列表（legado getStringList(nextTocUrl)：过滤当前页与已访问页）；node 闭包 nextUrlsOf
        class NextFinder {
            List<String> of(String pageUrl, RuleAnalyzer.Repr content) {
                Object nextRule = rule.get("nextTocUrl");
                if (nextRule == null) return new ArrayList<>();
                try {
                    JsExtensions java = (JsExtensions) ctx.get("java");
                    List<String> out = new ArrayList<>();
                    for (String s : java.getStringList(String.valueOf(nextRule), content)) {
                        String u = absUrl(s.trim(), pageUrl);
                        if (!u.isEmpty() && !u.equals(tocUrl) && !visited.contains(u)) out.add(u);
                    }
                    return out;
                } catch (Exception e) {
                    return new ArrayList<>();
                }
            }
        }
        NextFinder nextsOf = new NextFinder();

        // legado BookList 阶段：baseUrl 绑目录页地址（WebBook.getChapterList → baseUrl = book.tocUrl）
        ctx.put("baseUrl", tocUrl);
        String body = "";
        try {
            body = fetchPage(ctx, tocUrl);
        } catch (Exception e) {
            Log.w(TAG, "toc page failed: " + e.getMessage());
        }
        if (!body.isEmpty()) {
            RuleAnalyzer.Repr content = parser.parse(tocUrl, body);
            List<String> nexts = nextsOf.of(tocUrl, content);
            while (nexts.size() == 1) {
                // 单链顺翻（legado while 循环：visited 去重防死循环）
                String nextUrl = nexts.get(0);
                visited.add(nextUrl);
                if (visited.size() > MAX_TOC_PAGES) break;
                String nb;
                try {
                    nb = fetchPage(ctx, nextUrl);
                } catch (Exception e) {
                    Log.w(TAG, "toc page failed: " + e.getMessage());
                    break;
                }
                // 翻页后 baseUrl 对齐新页址（legado res.url 变更语义）
                ctx.put("baseUrl", nextUrl);
                content = parser.parse(nextUrl, nb);
                nexts = nextsOf.of(nextUrl, content);
            }
            if (nexts.size() > 1) {
                // 多下一页并发抓取解析，按 URL 序合并；并发页不再继续翻页（legado getNextUrl=false）。
                // node Promise.all → 固定线程池 invokeAll（Future 列表保序）
                ExecutorService pool = Executors.newFixedThreadPool(Math.min(nexts.size(), 6));
                try {
                    List<Callable<List<String[]>>> tasks = new ArrayList<>();
                    for (String u : nexts) {
                        tasks.add(() -> {
                            List<String[]> sub = new ArrayList<>();
                            RuleAnalyzer.Repr c = RuleAnalyzer.makeContent(fetchPage(ctx, u));
                            for (Object item : RuleAnalyzer.evalRuleList(listRule, c, ctx)) {
                                try {
                                    String name = RuleAnalyzer.evalRule(nameRule, item, ctx).trim();
                                    String cu = RuleAnalyzer.evalRule(urlRule, item, ctx).trim();
                                    if (!name.isEmpty()) {
                                        sub.add(new String[]{name, !cu.isEmpty() ? absRule(cu, u) : u});
                                    }
                                } catch (Exception ignore) {
                                    // 单条失败隔离
                                }
                            }
                            return sub;
                        });
                    }
                    try {
                        List<Future<List<String[]>>> fs = pool.invokeAll(tasks);
                        for (Future<List<String[]>> f : fs) {
                            try {
                                for (String[] p : f.get()) {
                                    acc.add(p[0], p[1], ctx.get("book"));
                                }
                            } catch (Exception e) {
                                Log.w(TAG, "toc page failed: " + e.getMessage());
                            }
                        }
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                    }
                } finally {
                    pool.shutdown();
                }
            }
        }
        if (reverse) Collections.reverse(chapters); // - 前缀：源目录页倒排，翻正
        if (!chapters.isEmpty()) {
            if (tocCache.size() >= MAX_TOC_CACHE) {
                String oldest = tocCache.keySet().iterator().next();
                tocCache.remove(oldest);
            }
            tocCache.put(cacheKey, new Object[]{System.currentTimeMillis(), chapters});
        }
        return chapters;
    }

    /** 对齐 t4/index.js#encodeChapterUrl：章节 URL 含 #/$ 时整体百分号编码（宿主按 # $ 切分会截断） */
    static String encodeChapterUrl(String u) {
        return Pattern.compile("[#＃$＄]").matcher(u).find()
                ? percentEncode(u)
                : u;
    }

    /** 对齐 t4/index.js#decodeChapterUrl */
    static String decodeChapterUrl(String u) {
        if (Pattern.compile("%23|%24").matcher(u).find()) {
            try {
                return java.net.URLDecoder.decode(u, "UTF-8");
            } catch (Exception e) {
                return u;
            }
        }
        return u;
    }

    /** 对齐 encodeURIComponent：unreserved 保留，其余 UTF-8 百分号编码（大写） */
    private static String percentEncode(String s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            if (cp < 128 && isUriUnreserved(cp)) {
                out.append((char) cp);
            } else {
                for (byte b : new String(Character.toChars(cp)).getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
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

    // ============ search（对齐 t4/index.js#t4Search） ============

    public static Map<String, Object> t4Search(Map<String, Object> source, String wd) {
        if (SourceManager.mapGet(source, "searchUrl") == null) return emptySearch();
        String key = wd == null ? "" : wd.trim();
        if (key.isEmpty()) return emptySearch();
        Map<String, Object> ctx = makeCtx(source, null, key, 1, null, null, null, null);
        String rendered = renderUrl(ctx, SourceManager.mapGet(source, "searchUrl"));
        String content;
        try {
            content = fetchPage(ctx, absRule(rendered, ctx.get("baseUrl")));
        } catch (Exception e) {
            Log.w(TAG, "search failed [" + SourceManager.mapGet(source, "bookSourceName") + "]: " + e.getMessage());
            return emptySearch();
        }
        Map<String, Object> rule = mapOrEmpty(SourceManager.mapGet(source, "ruleSearch"));
        Map<String, Object> pre = parseRulePrefix(strOrEmpty(rule.get("bookList")));
        String listRule = String.valueOf(pre.get("rule"));
        boolean reverse = Boolean.TRUE.equals(pre.get("reverse"));
        List<Object> items = RuleAnalyzer.evalRuleList(listRule, RuleAnalyzer.makeContent(content), ctx);
        List<Object> list = new ArrayList<>();
        Set<String> seenUrls = new HashSet<>();
        for (Object item : items) {
            try {
                Map<String, Object> it = bookItem(source, ctx, item, rule);
                String bu = decodeBookId(strOf(it.get("vod_id"))).get("bookUrl");
                if (seenUrls.contains(bu)) continue; // legado distinctBy bookUrl
                seenUrls.add(bu);
                list.add(it);
            } catch (Exception e) {
                Log.w(TAG, "search item failed: " + e.getMessage());
            }
        }
        if (reverse) Collections.reverse(list); // legado BookList：- 前缀倒序（去重后）
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("list", list);
        return out;
    }

    private static Map<String, Object> emptySearch() {
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("list", new ArrayList<Object>());
        return out;
    }

    // ============ play（正文 → novel:// / 音频直链，对齐 t4/index.js#t4Play） ============

    public static Map<String, Object> t4Play(Map<String, Object> source, String playUrl) {
        String chapterUrl = decodeChapterUrl(playUrl == null ? "" : playUrl);
        long stype = numOrZero(SourceManager.mapGet(source, "bookSourceType"));
        boolean isAudio = stype == 1;
        boolean isComic = stype == 2;
        if (chapterUrl.isEmpty()) {
            return isAudio ? audioResponse(source, "") : novelResponse("", "章节地址为空");
        }
        // 章节上下文查回：detail/loadToc 缓存该书与章节对象（legado AnalyzeRule.chapter/book 绑定）
        String sk = SourceManager.strOrEmpty(SourceManager.mapGet(source, "bookSourceUrl")).trim();
        Map<String, Object> cctx = chapterCtxs.get(SourceManager.md5(sk + "|" + chapterUrl));
        Map<String, Object> book = cctx != null ? mapOrEmpty(cctx.get("book")) : null;
        Map<String, Object> chapter = cctx != null ? mapOrEmpty(cctx.get("chapter")) : null;
        String title = chapter != null ? strOf(chapter.get("title")) : null;
        Map<String, Object> ctx = makeCtx(source, chapterUrl, null, null, book, chapter, title, null);
        Map<String, Object> rule = mapOrEmpty(SourceManager.mapGet(source, "ruleContent"));
        // legado WebBook.getContentAwait：content 规则为空 → 章节链接即播放地址（音频源常态）
        Object contentRule = rule.get("content");
        if (isAudio && (contentRule == null || String.valueOf(contentRule).trim().isEmpty())) {
            return audioResponse(source, splitAudioUrl(ctx, chapterUrl));
        }

        List<String> visited = new ArrayList<>();
        visited.add(chapterUrl);

        // 下一页 URL 列表（legado getStringList(nextContentUrl)）；node 闭包 nextUrlsOf
        class NextFinder {
            List<String> of(String pageUrl, RuleAnalyzer.Repr content) {
                Object nextRule = rule.get("nextContentUrl");
                if (nextRule == null) return new ArrayList<>();
                try {
                    JsExtensions java = (JsExtensions) ctx.get("java");
                    List<String> out = new ArrayList<>();
                    for (String s : java.getStringList(String.valueOf(nextRule), content)) {
                        String u = absUrl(s.trim(), pageUrl);
                        if (!u.isEmpty() && !u.equals(chapterUrl) && !visited.contains(u)) out.add(u);
                    }
                    return out;
                } catch (Exception e) {
                    return new ArrayList<>();
                }
            }
        }
        NextFinder nextsOf = new NextFinder();

        String text = "";
        String body;
        try {
            if (Pattern.compile("^data:", Pattern.CASE_INSENSITIVE).matcher(chapterUrl.trim()).find()) {
                // legado getByteArrayIfDataUri + StrResponse：data URL 剥 options 尾巴后 base64 解码
                // → hex 字符串作响应体（正文 JS 以 java.hexDecodeToString 还原载荷）
                String du = UrlRule.parseUrlRule(chapterUrl.trim()).url;
                Matcher m = Pattern.compile(";base64,([\\s\\S]*)$").matcher(du);
                body = m.find() ? hexLower(Base64.decode(m.group(1), Base64.DEFAULT)) : "";
            } else {
                body = fetchPage(ctx, chapterUrl);
            }
        } catch (Exception e) {
            return isAudio ? audioResponse(source, "") : novelResponse("", "抓取失败: " + e.getMessage());
        }
        {
            RuleAnalyzer.Repr content = RuleAnalyzer.makeContent(body);
            String part = readContent(content, contentRule, ctx);
            text = part;
            List<String> nexts = nextsOf.of(chapterUrl, content);
            while (nexts.size() == 1) {
                // 单链顺翻（legado while 循环：visited 去重防死循环）
                String nextUrl = nexts.get(0);
                visited.add(nextUrl);
                if (visited.size() > MAX_CONTENT_PAGES) break;
                String nb;
                try {
                    nb = fetchPage(ctx, nextUrl);
                } catch (Exception e) {
                    Log.w(TAG, "content page failed: " + e.getMessage());
                    break;
                }
                content = RuleAnalyzer.makeContent(nb);
                String p = readContent(content, contentRule, ctx);
                if (!p.isEmpty()) text = text.isEmpty() ? p : text + "\n" + p;
                nexts = nextsOf.of(nextUrl, content);
            }
            if (nexts.size() > 1) {
                // 多下一页并发抓取按序合并（legado mapAsync 保序；并发页不再递归翻页）
                ExecutorService pool = Executors.newFixedThreadPool(Math.min(nexts.size(), 6));
                try {
                    List<Callable<String>> tasks = new ArrayList<>();
                    for (String u : nexts) {
                        tasks.add(() -> readContent(RuleAnalyzer.makeContent(fetchPage(ctx, u)), contentRule, ctx));
                    }
                    try {
                        List<Future<String>> fs = pool.invokeAll(tasks);
                        for (Future<String> f : fs) {
                            try {
                                String p = f.get();
                                if (p != null && !p.isEmpty()) text = text.isEmpty() ? p : text + "\n" + p;
                            } catch (Exception e) {
                                Log.w(TAG, "content page failed: " + e.getMessage());
                            }
                        }
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                    }
                } finally {
                    pool.shutdown();
                }
            }
        }

        // legado contentLoadFinish：正文即播放 URL——音频源 ruleContent.content 解析产物是音频直链，
        // 交宿主播放器播放，不走 replaceRegex 正文净化
        if (isAudio) {
            return audioResponse(source, splitAudioUrl(ctx, text.trim()));
        }

        // replaceRegex 净化：格式 "正则##替换"（可多段）
        String cleaned = applyReplaceRegex(text, rule.get("replaceRegex"));
        // 漫画源（bookSourceType 2）→ pics:// 协议（宿主 ComicReadView）；提取失败落 novel:// 文字兜底
        return isComic ? comicResponse(ctx, cleaned) : novelResponse(cleaned, "");
    }

    /** node: read(repr) = analyzeStr(repr, rule.content||'', ctx) || ''（空规则 → ''） */
    private static String readContent(RuleAnalyzer.Repr repr, Object contentRule, Map<String, Object> ctx) {
        String rule = contentRule == null ? "" : String.valueOf(contentRule);
        if (rule.isEmpty()) return "";
        return RuleAnalyzer.evalRule(rule, repr, ctx);
    }

    /**
     * 对齐 t4/index.js#splitAudioUrl：音频直链规范化——拆 `url,{options}` 尾巴
     * （AnalyzeUrl 语义），URL 部分绝对化，返回 { url, headers }。
     */
    private static Map<String, Object> splitAudioUrl(Map<String, Object> ctx, String raw) {
        UrlRule.Parsed p = UrlRule.parseUrlRule(String.valueOf(raw));
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("url", absUrl(p.url, ctx.get("baseUrl")));
        out.put("headers", p.options.headers != null && !p.options.headers.isEmpty()
                ? p.options.headers : null);
        return out;
    }

    /**
     * 对齐 t4/index.js#audioResponse：音频直链响应（宿主 PlayContent.header 支持防盗链 UA/Referer；
     * flag 对齐 detail 的 vod_play_from）。入参为 url 字符串或 { url, headers }。
     */
    private static Map<String, Object> audioResponse(Map<String, Object> source, Object urlOrObj) {
        String url;
        Map<String, String> headers = null;
        if (urlOrObj instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) urlOrObj;
            url = strOf(m.get("url"));
            Object h = m.get("headers");
            if (h instanceof Map) {
                headers = new LinkedHashMap<>();
                for (Map.Entry<?, ?> e : ((Map<?, ?>) h).entrySet()) {
                    if (e.getKey() != null && e.getValue() != null) {
                        headers.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
                    }
                }
            }
        } else {
            url = strOf(urlOrObj);
        }
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("url", url == null ? "" : url);
        out.put("parse", 0);
        out.put("jx", 0);
        out.put("flag", "音频");
        // merged = {...parseSourceHeaders(source), ...(headers||{})}
        Map<String, String> merged = new LinkedHashMap<>(JsExtensions.parseSourceHeaders(source, null));
        if (headers != null) merged.putAll(headers);
        if (!merged.isEmpty()) out.put("header", merged);
        return out;
    }

    /**
     * 对齐 t4/index.js#applyReplaceRegex（legado replaceRegex）：match##replace
     * （replace 缺省删除；支持多组 ## 串联）。社区源常见 "##regex" 省略空 match 的
     * 纯删除形态，此时首段为正则。
     */
    static String applyReplaceRegex(String text, Object replaceRegex) {
        if (replaceRegex == null || text == null || text.isEmpty()) return text;
        String out = text;
        String spec = String.valueOf(replaceRegex).trim();
        try {
            List<String> parts = new ArrayList<>(Arrays.asList(spec.split("##", -1)));
            String match, replace;
            if (parts.get(0).isEmpty() && parts.size() >= 2) {
                match = parts.get(1);
                replace = String.join("##", parts.subList(2, parts.size()));
            } else {
                match = parts.get(0);
                replace = String.join("##", parts.subList(1, parts.size()));
            }
            if (match.isEmpty()) return text;
            Pattern p = Pattern.compile(match);
            Matcher m = p.matcher(out);
            out = m.replaceAll(jsReplacement(replace, m.groupCount()));
        } catch (Exception e) {
            Log.w(TAG, "replaceRegex failed: " + e.getMessage());
        }
        return out;
    }

    /**
     * JS 替换串语义 → Java replaceAll 替换串：$$ → 字面 $、$& → 整匹配（$0）、
     * $N（N ≤ 组数）→ 组引用（JS 同语义）、其余 $ 与 \ → 字面量转义。
     */
    private static String jsReplacement(String replace, int groupCount) {
        String r = replace == null ? "" : replace;
        StringBuilder sb = new StringBuilder(r.length());
        for (int i = 0; i < r.length(); i++) {
            char c = r.charAt(i);
            if (c == '\\') {
                sb.append("\\\\"); // JS 替换串 \ 为字面量
                continue;
            }
            if (c == '$') {
                char n = i + 1 < r.length() ? r.charAt(i + 1) : 0;
                if (n == '$') {
                    sb.append("\\$");
                    i++;
                    continue;
                }
                if (n == '&') {
                    sb.append("$0");
                    i++;
                    continue;
                }
                if (Character.isDigit(n)) {
                    int j = i + 1;
                    while (j < r.length() && Character.isDigit(r.charAt(j))) j++;
                    int num = Integer.parseInt(r.substring(i + 1, j));
                    if (num <= groupCount) {
                        sb.append(r, i, j); // 组引用，Java 同语义
                        i = j - 1;
                        continue;
                    }
                    // JS：无对应组时 $N 保留字面量 → Java 转义
                    sb.append("\\$").append(r, i + 1, j);
                    i = j - 1;
                    continue;
                }
                sb.append("\\$"); // 裸 $：JS 输出字面量，Java 抛错需转义
                continue;
            }
            sb.append(c);
        }
        return sb.toString();
    }

    /** 漫画正文 <img src> 提取（cap 防异常超长章节） */
    private static final Pattern IMG_SRC =
            Pattern.compile("<img[^>]*\\ssrc=[\"']?([^\"'\\s>]+)", Pattern.CASE_INSENSITIVE);
    /** 无 img 标签时的退路：规则产物为裸 http(s) URL 行（书源 JS 直出列表形态） */
    private static final Pattern BARE_URL_LINE =
            Pattern.compile("(?m)^\\s*(https?://\\S{8,})\\s*$");

    /**
     * 漫画响应：pics:// 协议（宿主 PlayFragment#handleComicContent → ComicReadView）。
     * 有意偏差：node 版对 type=2 同样落 novelResponse——宿主小说视图不渲染 &lt;img&gt;，
     * 漫画源不可读；Mobile 壳已有 pics:// 消费链路，此处按书源类型分发。
     * - 图片提取：&lt;img src&gt; 优先，退裸 URL 行；相对地址对章节 URL 绝对化，HTML 实体解码；
     * - 提取为空（正文是文字说明/错误信息）→ 落 novelResponse 原行为；
     * - header 传源默认头（对齐 audioResponse），宿主会把 Cookie/Referer/UA 追加到图片 URL。
     */
    private static Map<String, Object> comicResponse(Map<String, Object> ctx, String content) {
        List<String> urls = new ArrayList<>();
        if (content != null && !content.isEmpty()) {
            String base = strOf(ctx.get("baseUrl"));
            Matcher m = IMG_SRC.matcher(content);
            while (m.find() && urls.size() < 500) {
                String u = RuleAnalyzer.unescapeHtml(m.group(1)).trim();
                String abs = absUrl(u, base);
                if (abs.startsWith("http") && !urls.contains(abs)) urls.add(abs);
            }
            if (urls.isEmpty()) {
                Matcher b = BARE_URL_LINE.matcher(content);
                while (b.find() && urls.size() < 500) {
                    String abs = absUrl(b.group(1).trim(), base);
                    if (abs.startsWith("http") && !urls.contains(abs)) urls.add(abs);
                }
            }
        }
        if (urls.isEmpty()) return novelResponse(content, "");
        StringBuilder pic = new StringBuilder("pics://");
        for (int i = 0; i < urls.size(); i++) {
            if (i > 0) pic.append("&&");
            pic.append(urls.get(i));
        }
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("url", pic.toString());
        out.put("parse", 0);
        out.put("jx", 0);
        out.put("flag", "漫画");
        Map<String, String> merged = JsExtensions.parseSourceHeaders(ctx.get("source"), ctx);
        if (merged != null && !merged.isEmpty()) out.put("header", merged);
        return out;
    }

    /** 对齐 t4/index.js#novelResponse：novel:// 协议响应（对齐宿主 PlayFragment.handleNovelContent） */
    private static Map<String, Object> novelResponse(String content, String err) {
        LinkedHashMap<String, Object> payload = new LinkedHashMap<>();
        payload.put("title", "");
        payload.put("content", err != null && !err.isEmpty() ? "【加载失败】" + err : content);
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("url", "novel://" + GSON.toJson(payload));
        out.put("parse", 0);
        out.put("jx", 0);
        out.put("flag", "正文");
        return out;
    }

    // ============ 分发入口（对齐 t4/index.js#dispatchT4） ============

    /** query 参数（ac/ids/wd/play/t/pg，已解码；同名取首个，对齐 URLSearchParams.get） */
    public static Map<String, Object> dispatchT4(Map<String, Object> source, Map<String, String> query) {
        String ac = query.get("ac") == null ? "" : query.get("ac");
        String ids = query.get("ids");
        String wd = query.get("wd");
        String play = query.get("play");
        String t = query.get("t");
        String pg = query.get("pg");

        if (play != null && !play.isEmpty()) return t4Play(source, play);
        if (wd != null && !wd.isEmpty()) return t4Search(source, wd);
        if (ids != null && !ids.isEmpty()) return t4Detail(source, ids);
        if (t != null && !t.isEmpty()) return t4List(source, t, pg != null && !pg.isEmpty() ? pg : Integer.valueOf(1));
        if ("detail".equals(ac)) return emptyDetail(null); // 无参 detail 视为空
        return t4Home(source);
    }

    // ============ 工具 ============

    static String md5(String s) {
        return SourceManager.md5(s);
    }

    private static String strOrEmpty(Object v) {
        return SourceManager.strOrEmpty(v);
    }

    /** node Buffer.toString('base64url')：URL_SAFE 无 padding 无换行 */
    static String b64urlEncode(String s) {
        return b64urlEncode(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    static String b64urlEncode(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    static byte[] b64urlDecode(String s) {
        return Base64.decode(s, Base64.URL_SAFE | Base64.NO_WRAP);
    }

    /** bytes → 小写 hex（node Buffer.toString('hex')） */
    private static String hexLower(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static int parseIntOr(Object v, int def) {
        if (v == null) return def;
        if (v instanceof Number) return ((Number) v).intValue();
        try {
            return Math.max(Integer.parseInt(String.valueOf(v).trim()), 0);
        } catch (Exception e) {
            return def;
        }
    }

    private static Map<String, Object> mapOrEmpty(Object obj) {
        if (obj instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) obj;
            return m;
        }
        return new LinkedHashMap<>();
    }

    private static String truncate(String s, int len) {
        if (s == null) return "";
        return s.length() > len ? s.substring(0, len) : s;
    }
}
