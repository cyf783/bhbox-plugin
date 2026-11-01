package bh.box.plugin.legado.engine;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 书籍 JS 侧 book 对象桥（对齐阅读 Book 实例方法面）：社区源高频
 * book.getVariable("custom")/putCustomVariable(v)/bookUrl/tocUrl/name 等引用。
 * Map 形态无法承载方法，属性经透传 Map，方法面桥到 bookVars 池由 T4Actions 注入。
 */
public class BookBridge extends ScriptableObject {

    /** 进程级存储：sk|bookUrl → 自定义变量值（legado book.putCustomVariable/getVariable("custom")） */
    private static final Map<String, String> CUSTOM_VARS = new LinkedHashMap<>();

    private static final int MAX_ENTRIES = 500;

    private final Map<String, Object> props;

    public BookBridge(Map<String, Object> props) {
        this.props = props != null ? props : new LinkedHashMap<String, Object>();
    }

    @Override
    public String getClassName() {
        return "BookBridge";
    }

    /** JS 属性读（book.bookUrl/name/tocUrl/…透传） */
    @Override
    public Object get(String name, Scriptable start) {
        if ("getVariable".equals(name) || "putCustomVariable".equals(name)
                || "getCustomVariable".equals(name)) {
            final String m = String.valueOf(name);
            return new org.mozilla.javascript.BaseFunction() {
                @Override
                public Object call(Context cx, Scriptable scope, Scriptable thisObj, Object[] args) {
                    switch (m) {
                        case "getVariable":
                            return args.length >= 1 ? getVariable(args[0]) : "";
                        case "putCustomVariable":
                            putCustomVariable(args.length >= 1 ? args[0] : null);
                            return org.mozilla.javascript.Undefined.instance;
                        default:
                            return getCustomVariable();
                    }
                }
            };
        }
        if (props.containsKey(name)) return props.get(name);
        if ("bookUrl".equals(name)) return getBookUrl();
        return super.get(name, start);
    }

    /** JS 属性写（preUpdateJs 改写 book.bookUrl/tocUrl——爱丽丝切站源依赖） */
    @Override
    public void put(String name, Scriptable start, Object value) {
        if (value != null) {
            props.put(String.valueOf(name), String.valueOf(value));
        }
    }

    @Override
    public boolean has(String name, Scriptable start) {
        return props.containsKey(name) || "bookUrl".equals(name) || "getVariable".equals(name)
                || "putCustomVariable".equals(name) || "getCustomVariable".equals(name)
                || super.has(name, start);
    }

    /** 属性透传（name/bookUrl/tocUrl/author/kind…宿主侧） */
    public Object get(String k) {
        return props.get(String.valueOf(k));
    }

    public String getBookUrl() {
        Object v = props.get("bookUrl");
        return v != null ? String.valueOf(v) : "";
    }

    // ---------- 自定义变量（legado Book.putCustomVariable / getVariable("custom")） ----------

    public String getVariable(Object name) {
        if (name != null && "custom".equals(String.valueOf(name))) {
            return getCustomVariable();
        }
        return "";
    }

    public String getCustomVariable() {
        synchronized (CUSTOM_VARS) {
            String v = CUSTOM_VARS.get(customKey());
            return v != null ? v : "";
        }
    }

    public void putCustomVariable(Object value) {
        synchronized (CUSTOM_VARS) {
            String k = customKey();
            if (value == null || String.valueOf(value).isEmpty()) {
                CUSTOM_VARS.remove(k);
            } else {
                CUSTOM_VARS.put(k, String.valueOf(value));
                if (CUSTOM_VARS.size() > MAX_ENTRIES) {
                    String oldest = CUSTOM_VARS.keySet().iterator().next();
                    CUSTOM_VARS.remove(oldest);
                }
            }
        }
    }

    private String customKey() {
        Object u = props.get("bookUrl");
        return u != null ? String.valueOf(u) : String.valueOf(props.hashCode());
    }
}
