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

    /**
     * 进程级变量池：bookKey + '\0' + 变量名 → 值。
     * 对齐 legado BaseBook.putVariable/getVariable 的按书隔离 key-value 语义；
     * "custom" 是其中一个保留键（putCustomVariable/getCustomVariable 走同一池）。
     */
    private static final Map<String, String> CUSTOM_VARS = new LinkedHashMap<>();
    private static final String VAR_SEP = "\u0000";

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
        if ("getVariable".equals(name) || "putVariable".equals(name)
                || "putCustomVariable".equals(name) || "getCustomVariable".equals(name)
                || "setReverseToc".equals(name) || "getReverseToc".equals(name)) {
            final String m = String.valueOf(name);
            return new org.mozilla.javascript.BaseFunction() {
                @Override
                public Object call(Context cx, Scriptable scope, Scriptable thisObj, Object[] args) {
                    switch (m) {
                        case "getVariable":
                            return args.length >= 1 ? getVariable(args[0]) : "";
                        case "putVariable":
                            // 社区源 book.putVariable("序", i) / putVariable("元", "…") 两参
                            return putVariable(args.length >= 1 ? args[0] : null,
                                    args.length >= 2 ? args[1] : null) ? Boolean.TRUE : Boolean.FALSE;
                        case "putCustomVariable":
                            putCustomVariable(args.length >= 1 ? args[0] : null);
                            return org.mozilla.javascript.Undefined.instance;
                        case "setReverseToc":
                            setReverseToc(args.length >= 1 ? args[0] : null);
                            return org.mozilla.javascript.Undefined.instance;
                        case "getReverseToc":
                            return isReverseToc() ? Boolean.TRUE : Boolean.FALSE;
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
                || "putVariable".equals(name) || "putCustomVariable".equals(name)
                || "getCustomVariable".equals(name) || "setReverseToc".equals(name)
                || "getReverseToc".equals(name) || super.has(name, start);
    }

    /** 属性透传（name/bookUrl/tocUrl/author/kind…宿主侧） */
    public Object get(String k) {
        return props.get(String.valueOf(k));
    }

    public String getBookUrl() {
        Object v = props.get("bookUrl");
        return v != null ? String.valueOf(v) : "";
    }

    // ---------- 自定义变量（legado BaseBook.putVariable/getVariable） ----------

    /** JS book.getVariable(key)：读回 putVariable 写入的值，缺省空串 */
    public String getVariable(Object name) {
        if (name == null) return "";
        synchronized (CUSTOM_VARS) {
            String v = CUSTOM_VARS.get(varKey(name));
            return v != null ? v : "";
        }
    }

    public String getCustomVariable() {
        return getVariable("custom");
    }

    public void putCustomVariable(Object value) {
        putVariable("custom", value);
    }

    /**
     * 社区源 {@code book.setReverseToc(true)}（言情小说 ruleBookInfo.name 等）：
     * 按书隔离的目录倒序标记，T4Actions.loadToc 收尾读取并翻正。
     * 官方当前 KMP 源码未定义该方法，属旧版/社区扩展 API，做无害兼容。
     */
    public void setReverseToc(Object value) {
        boolean rev;
        if (value instanceof Boolean) {
            rev = (Boolean) value;
        } else if (value instanceof Number) {
            rev = ((Number) value).doubleValue() != 0;
        } else {
            String s = value == null ? "" : String.valueOf(value);
            rev = "true".equalsIgnoreCase(s) || "1".equals(s);
        }
        putVariable("reverseToc", rev ? "1" : ""); // 空值删除，等于置回 false
    }

    public boolean isReverseToc() {
        return "1".equals(getVariable("reverseToc"));
    }

    /**
     * 对齐 legado RuleDataInterface.putVariable：按书隔离的 key-value 变量池，
     * 空值删除；返回是否存在（书源通常忽略返回值）。
     */
    public boolean putVariable(Object key, Object value) {
        if (key == null) return false;
        String k = varKey(key);
        String v = stringify(value);
        synchronized (CUSTOM_VARS) {
            boolean existed = CUSTOM_VARS.containsKey(k);
            if (v.isEmpty()) {
                CUSTOM_VARS.remove(k);
            } else {
                CUSTOM_VARS.put(k, v);
                if (CUSTOM_VARS.size() > MAX_ENTRIES) {
                    String oldest = CUSTOM_VARS.keySet().iterator().next();
                    CUSTOM_VARS.remove(oldest);
                }
            }
            return existed;
        }
    }

    /**
     * JS 数字经 Rhino 回传多为 Double（3 → 3.0），而书源拿 getVariable 的结果当索引/拼接，
     * "3.0" 会破坏语义；对齐官方 String 参数，整数值去掉 ".0"。
     */
    private static String stringify(Object value) {
        if (value == null) return "";
        if (value instanceof Number) {
            double d = ((Number) value).doubleValue();
            if (!Double.isInfinite(d) && !Double.isNaN(d)
                    && d == Math.rint(d) && Math.abs(d) < 9.007199254740992E15) {
                return String.valueOf((long) d);
            }
        }
        return String.valueOf(value);
    }

    private String varKey(Object name) {
        return customKey() + VAR_SEP + String.valueOf(name);
    }

    private String customKey() {
        Object u = props.get("bookUrl");
        return u != null ? String.valueOf(u) : String.valueOf(props.hashCode());
    }
}
