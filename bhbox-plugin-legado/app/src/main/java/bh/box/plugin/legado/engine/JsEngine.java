package bh.box.plugin.legado.engine;

import org.mozilla.javascript.BaseFunction;
import org.mozilla.javascript.Context;
import org.mozilla.javascript.ContextFactory;
import org.mozilla.javascript.NativeArray;
import org.mozilla.javascript.NativeObject;
import org.mozilla.javascript.Script;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;
import org.mozilla.javascript.Undefined;
import org.mozilla.javascript.Wrapper;

import com.google.gson.GsonBuilder;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Rhino JS 求值核心（对齐 app/server/src/engine/template.js#runJs 的 vm 沙箱执行段，
 * jslet.js 的 runJs 调用落点；@js 规则与 {{}} 模板统一经此执行）。
 *
 * 与 node 版分工：
 * - node runJs 的沙箱缺省字段（java/source/book/result/baseUrl/page/key/... 的 || {} / ?? ''）
 *   与 jsLib 前置拼接由调用方注入 bindings（bindings 即合并后的执行上下文）
 * - String.prototype.getBytes 原型补丁（node 侧补 V8 缺失的 LiveConnect 语义）不移植——
 *   Rhino 原生字符串无 getBytes，社区源该写法由后续批次按需补 prologue
 *
 * 作用域每次 eval 新建（同 node vm.createContext 每次新建，各次求值互不串扰）；
 * 编译产物全局缓存复用（同 node scriptCache，上限 300，超出删最早）。
 */
public final class JsEngine {

    private JsEngine() {}

    /** 对齐 template.js#runJs：编译缓存上限 300（同规则高频复用，超限删最早） */
    private static final int MAX_SCRIPT_CACHE = 300;

    /** 对齐 rhinoDialect 的两条正则：\[([^[\]]*)\]\s*=> 与 \{([^{}]*)\}\s*=> */
    private static final Pattern ARROW_BRACKET = Pattern.compile("\\[([^\\[\\]]*)\\]\\s*=>");
    private static final Pattern ARROW_BRACE = Pattern.compile("\\{([^{}]*)\\}\\s*=>");

    /**
     * 全局 ContextFactory：languageVersion = VERSION_ES6（对齐 node vm 的现代语法支持）；
     * Android ART 无法加载 Rhino 优化器生成的 JVM 字节码，解释模式运行（legado 同款 -1）。
     */
    private static final ContextFactory FACTORY = new ContextFactory() {
        @Override
        protected void onContextCreated(Context cx) {
            cx.setLanguageVersion(Context.VERSION_ES6);
            cx.setOptimizationLevel(-1);
            ensureRegExpProxy(cx);
            super.onContextCreated(cx);
        }
    };

    /** Rhino 1.9 的 RegExpProxy 经 ServiceLoader（线程上下文 ClassLoader）装配：宿主动态
     *  加载插件时该装配链读不到插件 APK 内的 META-INF/services 描述符（Context 类静态
     *  初始化先于本类 static 块或使用非 TCCL 加载器），regExpProxy 恒 null → 所有 JS 正则
     *  字面量抛 "Regular expressions are not available."。此处绕开 ServiceLoader：以插件
     *  ClassLoader 直接实例化官方 RegExpLoaderImpl，逐 Context 反射注入 package-private
     *  字段 regExpProxy（无 public setter）。 */
    private static volatile Object REGEXP_PROXY;

    private static void ensureRegExpProxy(Context cx) {
        try {
            if (REGEXP_PROXY == null) {
                ClassLoader cl = JsEngine.class.getClassLoader();
                Class<?> impl = Class.forName("org.mozilla.javascript.regexp.RegExpLoaderImpl", true, cl);
                // RegExpLoaderImpl 是工厂：newProxy() 产出 RegExpImpl（RegExpProxy 实现）
                REGEXP_PROXY = ((org.mozilla.javascript.RegExpLoader) impl.getDeclaredConstructor().newInstance()).newProxy();
            }
            java.lang.reflect.Field f = Context.class.getDeclaredField("regExpProxy");
            f.setAccessible(true);
            if (f.get(cx) == null) f.set(cx, REGEXP_PROXY);
        } catch (Throwable e) {
            android.util.Log.w("legado-engine", "regexp proxy inject failed: " + e);
        }
    }

    static {
        Thread t = Thread.currentThread();
        ClassLoader old = t.getContextClassLoader();
        ClassLoader own = JsEngine.class.getClassLoader();
        if (own != null && own != old) t.setContextClassLoader(own);
        try {
            ContextFactory.initGlobal(FACTORY);
        } finally {
            if (own != null && own != old) t.setContextClassLoader(old);
        }
    }

    /** 对齐 template.js#runJs scriptCache：插入序 LinkedHashMap，删最早即迭代器首个 */
    private static final Map<String, Script> SCRIPT_CACHE =
            Collections.synchronizedMap(new LinkedHashMap<String, Script>(64, 0.75f));

    /**
     * 求值 JS 片段（对齐 template.js#runJs：vm.Script 编译缓存 + runInContext）。
     *
     * @param code     JS 源码（jsLib 共享作用域以 lib 前置拼接，由调用方完成，同 node 注释）
     * @param bindings 注入为作用域变量的执行上下文（null 值不注入，JS 侧视为 undefined）
     * @return 求值结果展开为 Java 类型；脚本返回 undefined / 空 → null
     * @throws org.mozilla.javascript.RhinoException 编译或运行错误（由 render 等调用方捕获置空，同 node 向上抛）
     */
    public static Object eval(final String code, final Map<String, Object> bindings) {
        // Context.call(ContextAction) 在 Rhino 1.7.15 已过时（隐式取全局 factory），改挂自持 FACTORY
        return FACTORY.call(cx -> {
            // 对齐 runJs：Rhino 方言预处理后的完整代码作为缓存 key（同规则高频复用，源间互不串扰）
            String src = rhinoDialect(code);
            Script script = SCRIPT_CACHE.get(src);
            if (script == null) {
                script = cx.compileString(src, "legado-eval.js", 1, null);
                synchronized (SCRIPT_CACHE) {
                    if (SCRIPT_CACHE.size() >= MAX_SCRIPT_CACHE) {
                        // node: scriptCache.delete(scriptCache.keys().next().value)
                        SCRIPT_CACHE.remove(SCRIPT_CACHE.keySet().iterator().next());
                    }
                    SCRIPT_CACHE.put(src, script);
                }
            }
            Scriptable scope = cx.initStandardObjects();
            if (bindings != null) {
                // Map/List 值转 JS 原生对象（NativeObject/NativeArray）：Rhino 对 Java Map 的
                // 注入包装不支持属性点访问（book.kind/source.bookSourceUrl 取 undefined），
                // legado JS 里 book.xxx/source.xxx 面极广，须展开为 JS 对象树；
                // 环检测 + 深度限制防 ctx 自引用爆栈，叶级 Java 对象（Element 等）保留 LiveConnect
                java.util.IdentityHashMap<Object, Boolean> seen = new java.util.IdentityHashMap<>();
                for (Map.Entry<String, Object> e : bindings.entrySet()) {
                    if (e.getKey() == null || e.getValue() == null) continue;
                    Object v = e.getValue();
                    if (v instanceof Map || v instanceof List) {
                        try {
                            v = toJsValue(cx, scope, v, seen, 0);
                        } catch (Throwable ignore) {
                            v = e.getValue(); // 转换失败保留原值（LiveConnect 兜底）
                        }
                    }
                    // "java" 桥以 READONLY|PERMANENT 固化：JS 解析任意顶层包标识符
                    // （org/com/net 等，如 org.jsoup.Jsoup）会触发 LiveConnect 把同名顶层包
                    // 写入 scope，覆盖已注入的 java 绑定 → 后续 java.ajax 报
                    // "Cannot call property ajax in object [JavaPackage java]"；
                    // READONLY 使该写入失效。其余绑定名与顶层包无冲突，照常 put。
                    if ("java".equals(e.getKey())) {
                        ((ScriptableObject) scope).defineProperty(scope, "java", v,
                                ScriptableObject.READONLY | ScriptableObject.PERMANENT);
                    } else {
                        scope.put(e.getKey(), scope, v);
                    }
                }
                // legado 全局面补缺：书源 JS 普遍直接调 cookie.*/cache.*（legado CookieStore/
                // CacheManager 全局），调用方未注入时补默认桥，避免 ReferenceError 炸穿模板段
                if (!bindings.containsKey("cookie")) {
                    scope.put("cookie", scope, new JsExtensions.CookieBridge(null));
                }
                if (!bindings.containsKey("cache")) {
                    scope.put("cache", scope, new JsExtensions.CacheBridge());
                }
                // source.getKey()/getKey2() 方法桥（legado BookSource.getKey=bookSourceUrl）：
                // source 以 JS 对象或 Java Map 注入（gson 树为 NativeJavaObject，属性探测会抛），
                // 胶水整体 try/catch 兜底
                cx.evaluateString(scope,
                        "try { if (typeof source === 'object' && source !== null"
                                + " && typeof source.getKey !== 'function') {"
                                + "source.getKey = function(){ return (this.bookSourceUrl || this.get) ? (this.bookSourceUrl || this.get('bookSourceUrl') || '') : ''; };"
                                + "source.getKey2 = source.getKey; } } catch (e) {}",
                        "legado-glue.js", 1, null);
                // result 双形态：RuleAnalyzer 把 HTML 首段绑成 jsoup Element（供
                // result.select(...).first() 使用），但社区源同样高频裸用
                // result.match/replace/split（官方 evalJS 的 result 是文本）。
                // 这里包一层 JS String 对象：字符串方法走 String.prototype，
                // Element 方法代理回原对象，两种写法同时可用。
                // 内容优先用 __resultText（原始响应文本），避免 jsoup outerHtml
                // 重新格式化后改变正则匹配结果。
                cx.evaluateString(scope,
                        "(function(){ try {"
                                + " var r = result;"
                                // 注意：Rhino 对顶层 NativeJavaObject 执行 typeof r 会抛
                                // 「Document 类型的 JavaScript 值无效」，只能按属性判断。
                                + " if (typeof r.outerHtml !== 'undefined' && typeof r.match === 'undefined') {"
                                + "  var s = (typeof __resultText === 'string' && __resultText.length) ? __resultText : String(r);"
                                + "  var w = new String(s);"
                                + "  ['select','selectFirst','attr','text','html','outerHtml','children',"
                                + "  'child','getElementsByTag','getAllElements','parent','parents',"
                                + "  'nextElementSibling','previousElementSibling','first','last','size',"
                                + "  'hasAttr','hasClass','absUrl','id','className','tagName','data','val']"
                                + "  .forEach(function(n){"
                                + "   if (typeof r[n] !== 'undefined') {"
                                + "    w[n] = function(){ return r[n].apply(r, arguments); };"
                                + "   }"
                                + "  });"
                                + "  w.__element = r;"
                                + "  result = w;"
                                + " }"
                                + "} catch(e){} })();",
                        "legado-result-glue.js", 1, null);
                // JSON 内容的首段 result 是对象树（NativeObject），社区源同样会裸用
                // result.replace(/null/g,'') 这类字符串方法（乐乎文章 ruleExplore.bookList）。
                // 对象本身保持可点访问/JSONPath 求值，只补挂字符串方法代理到原始响应文本。
                // 独立 try/catch：Rhino 对 Java 对象做 typeof 会抛异常，不能影响上一段胶水。
                cx.evaluateString(scope,
                        "(function(){ try {"
                                + " var r = result;"
                                + " if (r && typeof r === 'object' && typeof r.replace === 'undefined'"
                                + " && typeof __resultText === 'string' && __resultText.length) {"
                                + "  ['match','replace','split','substring','substr','indexOf','lastIndexOf',"
                                + "  'slice','trim','toLowerCase','toUpperCase','charAt','concat',"
                                + "  'includes','startsWith','endsWith']"
                                + "  .forEach(function(n){"
                                + "   try { r[n] = function(){ return String.prototype[n].apply(__resultText, arguments); }; } catch(e){}"
                                + "  });"
                                + " }"
                                + "} catch(e){} })();",
                        "legado-result-json-glue.js", 1, null);
            }
            return expand(script.exec(cx, scope));
        });
    }

    /**
     * 对齐 template.js#rhinoDialect：无括号解构箭头参数补括号（legado 魔改 Rhino 支持
     * [a,b]=>、{a}=>；[...]=>/{...}=> 在合法 ES 中均为语法错误（数组/块后不得跟 =>），
     * 故转换恒安全，官方 Rhino 同样需要）。
     */
    private static String rhinoDialect(String code) {
        if (code == null || !code.contains("=>")) return code;
        code = ARROW_BRACKET.matcher(code).replaceAll("([$1])=>");
        return ARROW_BRACE.matcher(code).replaceAll("({$1})=>");
    }

    /**
     * 求值结果展开为 Java 类型：NativeObject→LinkedHashMap、NativeArray→ArrayList、
     * Wrapper（LiveConnect 包装）→unwrap 后递归展开、undefined/空 → null、
     * 其余（含 NativeFunction）→ String.valueOf（node String(v) 语义）。
     */
    private static Object expand(Object v) {
        if (v == null || v == Undefined.instance) return null;
        if (v instanceof Wrapper) return expand(((Wrapper) v).unwrap());
        if (v instanceof NativeArray) {
            NativeArray arr = (NativeArray) v;
            int len = (int) arr.getLength();
            ArrayList<Object> out = new ArrayList<>(len);
            for (int i = 0; i < len; i++) {
                Object e = arr.get(i, arr);
                out.add(e == Scriptable.NOT_FOUND ? null : expand(e));
            }
            return out;
        }
        if (v instanceof NativeObject) {
            Map<?, ?> obj = (NativeObject) v;
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : obj.entrySet()) {
                out.put(String.valueOf(e.getKey()), expand(e.getValue()));
            }
            return out;
        }
        if (v instanceof Number) return numToString(((Number) v).doubleValue());
        if (v instanceof Boolean) return String.valueOf(v);
        // Java 集合原样透传（unwrap 后的 LiveConnect 产物——书源 JS 返回
        // Packages.java.util.ArrayList 场景）：元素保持原始形态（jsoup Element 等条目
        // 供 list 模式逐条 wrapItem；此前落 String.valueOf 串成单条目致字段全串）
        if (v instanceof List) return v;
        return String.valueOf(v);
    }

    /**
     * 对齐 JS Number→String 语义：整数值（Rhino 加法等算术产物）不出科学计数法
     * （Java String.valueOf(double) 对 1e7~1e21 出 E 记法，JS 仅 ≥1e21 才出；
     * QQ 阅读书源 1100000000+bid → "1.154855723E9" 事件，legado 输出 "1154855723"）。
     */
    public static String numToString(double d) {
        if (!Double.isNaN(d) && !Double.isInfinite(d)
                && d == Math.rint(d) && Math.abs(d) < 9.007199254740992E15)
            return String.valueOf((long) d);
        return String.valueOf(d);
    }

    /** Map/List → JS 原生对象树（环检测 + 深度限制；叶级非容器值原样——LiveConnect/字符串/数字） */
    private static Object toJsValue(Context cx, Scriptable scope, Object v,
                                    java.util.IdentityHashMap<Object, Boolean> seen, int depth) {
        if (v == null || !(v instanceof Map) && !(v instanceof List)) return v;
        if (depth > 8 || seen.containsKey(v)) return null; // 自引用/超深 → 截断为 undefined
        seen.put(v, Boolean.TRUE);
        if (v instanceof Map) {
            NativeObject no = (NativeObject) cx.newObject(scope);
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                no.put(String.valueOf(e.getKey()), no, toJsValue(cx, scope, e.getValue(), seen, depth + 1));
            }
            // 对齐 node makeElementResult（String(obj)=JSON 文本协议）：Rhino String(NativeObject)
            // 默认产 "[object Object]"，喜马拉雅 nextTocUrl JSON.parse(String(result)) 依赖此协议；
            // 闭包捕获原 Java Map（与属性树同源），JS 侧改属性不同步为既有语义（node 同款）
            final Map<?, ?> src = (Map<?, ?>) v;
            no.put("toString", no, new BaseFunction() {
                @Override
                public Object call(Context cx2, Scriptable scope2, Scriptable thisObj, Object[] args) {
                    try {
                        return new GsonBuilder().disableHtmlEscaping().create().toJson(src);
                    } catch (Exception e) {
                        return "[object Object]";
                    }
                }
            });
            seen.remove(v);
            return no;
        }
        List<?> list = (List<?>) v;
        NativeArray arr = (NativeArray) cx.newArray(scope, list.size());
        for (int i = 0; i < list.size(); i++) {
            arr.put(i, arr, toJsValue(cx, scope, list.get(i), seen, depth + 1));
        }
        seen.remove(v);
        return arr;
    }
}
