package bh.box.plugin.legado.engine;

import org.mozilla.javascript.BaseFunction;
import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;
import org.mozilla.javascript.Undefined;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 书源 JS 侧 source 对象桥（对齐阅读 BaseSource 变量/登录信息 API 面）。社区源高频
 * source.getVariable()/setVariable()/put()/get()/getLoginHeader()/getLoginHeaderMap()/
 * putLoginHeader()/removeLoginHeader()/getLoginInfo(Map)/putLoginInfo()/removeLoginInfo()/
 * getKey()——Map 形态无方法面（Rhino 对 Java Map 不做属性点访问），须 ScriptableObject 桥：
 * - 属性键值（loginUrl/jsLib/bookSourceUrl 等）经 get(String,Scriptable) 透传
 * - 方法名兜底为 BaseFunction（Rhino 对 Java 实例方法不做自动暴露，须显式桥）
 * - 持久键名对齐阅读 SourceCacheProviders：sourceVariable_{key}/loginHeader_{key}/
 *   userInfo_{key}/v_{key}_{k}（进程内存活，宿主重启丢源级变量，与 node 版 T4 一致）
 */
public class SourceBridge extends ScriptableObject {

    /** 进程级存储：ns|key → 命名空间 Map */
    private static final Map<String, Map<String, Object>> STORE =
            new LinkedHashMap<>();

    private static final int MAX_ENTRIES = 500;

    private final String key;
    private final Map<String, Object> props;

    public SourceBridge(String key, Map<String, Object> props) {
        this.key = key == null ? "" : key;
        this.props = props != null ? props : new LinkedHashMap<String, Object>();
    }

    @Override
    public String getClassName() {
        return "SourceBridge";
    }

    /** legado BaseSource.getKey(): bookSourceUrl */
    public String jsGetKey() {
        Object u = props.get("bookSourceUrl");
        return u != null ? String.valueOf(u).trim() : key;
    }

    // ---------- 属性/方法统一探测 ----------

    @Override
    public Object get(String name, Scriptable start) {
        // 方法面优先（书源 JS 高频 source.xxx() 调用）
        BaseFunction fn = methodOf(String.valueOf(name));
        if (fn != null) return fn;
        // 属性透传（loginUrl/jsLib/bookSourceUrl/…）
        if (props.containsKey(name)) return props.get(name);
        return super.get(name, start);
    }

    @Override
    public boolean has(String name, Scriptable start) {
        if (methodOf(String.valueOf(name)) != null || props.containsKey(name)) return true;
        return super.has(name, start);
    }

    private BaseFunction methodOf(String name) {
        switch (name) {
            case "getKey":
            case "getKey2":
                return fn("getKey", ARGS0 -> getKey());
            case "getVariable":
                return fn("getVariable", ARGS0 -> str(ns("sourceVariable")));
            case "setVariable":
                return fn("setVariable", args -> {
                    if (args.length < 1 || args[0] == null) {
                        ns("sourceVariable").remove("value");
                    } else {
                        ns("sourceVariable").put("value", String.valueOf(args[0]));
                    }
                    return Undefined.instance;
                });
            case "getLoginHeader":
                return fn("getLoginHeader", ARGS0 -> str(ns("loginHeader")));
            case "getLoginHeaderMap":
                return fn("getLoginHeaderMap", ARGS0 -> jsonToNative(ns("loginHeader")));
            case "putLoginHeader":
                return fn("putLoginHeader", args -> {
                    if (args.length >= 1 && args[0] != null) {
                        ns("loginHeader").put("value", String.valueOf(args[0]));
                    }
                    return Undefined.instance;
                });
            case "removeLoginHeader":
                return fn("removeLoginHeader", args -> {
                    ns("loginHeader").remove("value");
                    return Undefined.instance;
                });
            case "getLoginInfo":
                return fn("getLoginInfo", ARGS0 -> str(ns("userInfo")));
            case "getLoginInfoMap":
                return fn("getLoginInfoMap", ARGS0 -> jsonToNative(ns("userInfo")));
            case "putLoginInfo":
                return fn("putLoginInfo", args -> {
                    if (args.length >= 1 && args[0] != null) {
                        ns("userInfo").put("value", String.valueOf(args[0]));
                    }
                    return Boolean.TRUE;
                });
            case "removeLoginInfo":
                return fn("removeLoginInfo", args -> {
                    ns("userInfo").remove("value");
                    return Undefined.instance;
                });
            case "put":
                return fn("put", args -> {
                    String k = args.length >= 1 ? String.valueOf(args[0]) : "";
                    Object v = args.length >= 2 && args[1] != null ? String.valueOf(args[1]) : "";
                    ns("v").put(k, v);
                    return v;
                });
            case "get":
                // 二义：source.get('k') 属性读（书源 JS 属性字典用法）
                return fn("get", args -> {
                    if (args.length < 1) return Undefined.instance;
                    String k = String.valueOf(args[0]);
                    // 属性优先（bookSourceUrl 等），缺省落源级保存数据
                    if (props.containsKey(k)) return props.get(k);
                    Object v = ns("v").get(k);
                    return v != null ? v : "";
                });
            default:
                return null;
        }
    }

    private interface Fn {
        Object run(Object[] args);
    }

    private BaseFunction fn(String name, Fn body) {
        return new BaseFunction() {
            @Override
            public Object call(Context cx, Scriptable scope, Scriptable thisObj, Object[] args) {
                return body.run(args);
            }
            @Override
            public String getFunctionName() {
                return name;
            }
        };
    }

    private String getKey() {
        Object u = props.get("bookSourceUrl");
        return u != null ? String.valueOf(u).trim() : key;
    }

    private Map<String, Object> ns(String namespace) {
        synchronized (STORE) {
            String k = namespace + "|" + getKey();
            Map<String, Object> m = STORE.get(k);
            if (m == null) {
                m = new LinkedHashMap<>();
                STORE.put(k, m);
                if (STORE.size() > MAX_ENTRIES) {
                    String oldest = STORE.keySet().iterator().next();
                    STORE.remove(oldest);
                }
            }
            return m;
        }
    }

    private String str(Map<String, Object> m) {
        Object v = m.get("value");
        return v != null ? String.valueOf(v) : "";
    }

    /** JSON 字符串 → NativeObject（getLoginHeaderMap/getLoginInfoMap；空/坏 → null 对齐阅读可空语义） */
    private Object jsonToNative(Map<String, Object> m) {
        String json = str(m);
        if (json.trim().isEmpty()) return null;
        try {
            com.google.gson.JsonElement el = com.google.gson.JsonParser.parseString(json);
            if (!el.isJsonObject()) return null;
            Context cx = Context.enter();
            try {
                Scriptable scope = cx.initStandardObjects();
                return cx.evaluateString(scope, "(" + json + ")", "source-bridge-json", 1, null);
            } finally {
                Context.exit();
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** Java 侧属性读（宿主代码用：prependJsLib 取 jsLib 等；Rhino 侧走 get(String,Scriptable)） */
    public Object getProperty(String name) {
        return props.get(name);
    }

    /** Java 侧方法面探测（防宿主代码误当 Map） */
    public boolean isBridge() {
        return true;
    }

    /** Java 侧变量直写（宿主/harness 用；JS 侧走 methodOf("setVariable")） */
    public void jsSetVariable(String json) {
        ns("sourceVariable").put("value", json == null ? "" : json);
    }

    /** Java 侧变量直读 */
    public String jsGetVariable() {
        return str(ns("sourceVariable"));
    }
}
