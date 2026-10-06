package com.github.tvbox.quickjs.method;

import androidx.annotation.Keep;
import androidx.annotation.NonNull;

import com.github.catvod.Init;
import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.UriUtil;
import com.github.tvbox.quickjs.bean.Req;
import com.github.tvbox.quickjs.utils.Connect;
import com.github.tvbox.quickjs.utils.HtmlParser;
import com.github.tvbox.quickjs.utils.JSUtil;
import com.github.tvbox.quickjs.utils.Trans;
import com.whl.quickjs.wrapper.JSArray;
import com.whl.quickjs.wrapper.JSFunction;
import com.whl.quickjs.wrapper.JSMethod;
import com.whl.quickjs.wrapper.JSObject;
import com.whl.quickjs.wrapper.QuickJSContext;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URLEncoder;
import java.nio.charset.CharacterCodingException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.ExecutorService;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class Global {

    private final ExecutorService executor;
    private final QuickJSContext ctx;
    private final Timer timer;

    public static Global create(QuickJSContext ctx, ExecutorService executor) {
        return new Global(ctx, executor);
    }

    private Global(QuickJSContext ctx, ExecutorService executor) {
        this.executor = executor;
        this.timer = new Timer();
        this.ctx = ctx;
    }

    public void setProperty() {
        Map<String, List<Method>> methodGroups = new HashMap<>();
        for (Method method : getClass().getMethods()) {
            if (!method.isAnnotationPresent(JSMethod.class)) continue;
            methodGroups.computeIfAbsent(method.getName(), k -> new ArrayList<>()).add(method);
        }
        for (Map.Entry<String, List<Method>> entry : methodGroups.entrySet()) {
            List<Method> methods = entry.getValue();
            Object target = this;
            ctx.getGlobalObject().set(entry.getKey(), args -> dispatchOverloaded(methods, target, args));
        }
    }

    public void setProperty(String name, Class<?> clazz) {
        if (clazz == null) {
            throw new IllegalArgumentException("Class parameter cannot be null");
        }

        Object javaObj = null;
        try {
            javaObj = clazz.getDeclaredConstructor().newInstance();
        } catch (NoSuchMethodException e) {
            throw new RuntimeException("No default constructor found for class: " + clazz.getName(), e);
        } catch (InstantiationException | IllegalAccessException | InvocationTargetException e) {
            throw new RuntimeException("Failed to instantiate class: " + clazz.getName(), e);
        }

        JSObject jsObj = this.ctx.createJSObject();
        Map<String, List<Method>> methodGroups = new HashMap<>();
        for (Method method : clazz.getMethods()) {
            if (!method.isAnnotationPresent(JSMethod.class)) continue;
            methodGroups.computeIfAbsent(method.getName(), k -> new ArrayList<>()).add(method);
        }
        for (Map.Entry<String, List<Method>> entry : methodGroups.entrySet()) {
            List<Method> methods = entry.getValue();
            Object finalJavaObj = javaObj;
            jsObj.set(entry.getKey(), args -> dispatchOverloaded(methods, finalJavaObj, args));
        }
        ctx.getGlobalObject().set(name, jsObj);
        jsObj.release();
    }

    private static Object dispatchOverloaded(List<Method> methods, Object target, Object[] args) {
        Method[] sorted = methods.toArray(new Method[0]);
        Arrays.sort(sorted, (a, b) -> Integer.compare(b.getParameterCount(), a.getParameterCount()));
        for (Method method : sorted) {
            try {
                Object[] adapted = adaptArgs(args, method.getParameterTypes());
                if (adapted == null) continue;
                return method.invoke(target, adapted);
            } catch (IllegalArgumentException | InvocationTargetException | IllegalAccessException e) {
                Throwable cause = (e instanceof InvocationTargetException) ? e.getCause() : e;
                if (!(cause instanceof IllegalArgumentException)) {
                    LOG.e("dispatchOverloaded invoke error: " + method.getName() + " " + cause);
                }
            }
        }
        StringBuilder sb = new StringBuilder("dispatchOverloaded no match: methods=");
        for (Method m : sorted) sb.append(m.getName()).append('/').append(m.getParameterCount()).append(' ');
        sb.append("argCount=").append(args == null ? 0 : args.length);
        LOG.e(sb.toString());
        return null;
    }

    private static Object[] adaptArgs(Object[] args, Class<?>[] paramTypes) {
        Object[] in = (args == null) ? new Object[0] : args;
        int n = paramTypes.length;
        if (in.length < n) return null;
        Object[] out = new Object[n];
        for (int i = 0; i < n; i++) {
            Class<?> pt = paramTypes[i];
            Object v = (i < in.length) ? in[i] : null;
            try {
                out[i] = coerce(v, pt);
            } catch (Exception e) {
                return null;
            }
        }
        return out;
    }

    private static Object coerce(Object v, Class<?> pt) {
        if (v == null) {
            if (pt.isPrimitive()) {
                if (pt == boolean.class) return false;
                if (pt == int.class) return 0;
                if (pt == long.class) return 0L;
                if (pt == double.class) return 0d;
                if (pt == float.class) return 0f;
                if (pt == byte.class) return (byte) 0;
                if (pt == short.class) return (short) 0;
                if (pt == char.class) return '\0';
            }
            return null;
        }
        if (pt.isInstance(v)) return v;
        if (pt == String.class) return v.toString();
        if (pt == Boolean.class || pt == boolean.class) {
            if (v instanceof Boolean) return v;
            if (v instanceof Number) return ((Number) v).intValue() != 0;
            String s = v.toString().trim();
            if (s.isEmpty()) return false;
            return Boolean.parseBoolean(s) || s.equals("1");
        }
        if (pt == Integer.class || pt == int.class) {
            if (v instanceof Number) return ((Number) v).intValue();
            return Integer.parseInt(v.toString().trim());
        }
        if (pt == Long.class || pt == long.class) {
            if (v instanceof Number) return ((Number) v).longValue();
            return Long.parseLong(v.toString().trim());
        }
        if (pt == Double.class || pt == double.class) {
            if (v instanceof Number) return ((Number) v).doubleValue();
            return Double.parseDouble(v.toString().trim());
        }
        if (pt == Float.class || pt == float.class) {
            if (v instanceof Number) return ((Number) v).floatValue();
            return Float.parseFloat(v.toString().trim());
        }
        if (pt == Short.class || pt == short.class) {
            if (v instanceof Number) return ((Number) v).shortValue();
            return Short.parseShort(v.toString().trim());
        }
        if (pt == Byte.class || pt == byte.class) {
            if (v instanceof Number) return ((Number) v).byteValue();
            return Byte.parseByte(v.toString().trim());
        }
        if (pt == Character.class || pt == char.class) {
            String s = v.toString();
            return s.isEmpty() ? '\0' : s.charAt(0);
        }
        throw new IllegalArgumentException("cannot coerce " + v.getClass() + " to " + pt);
    }



    private void submit(Runnable runnable) {
        if (!executor.isShutdown()) executor.submit(runnable);
    }

    @Keep
    @JSMethod
    public String s2t(String text) {
        return Trans.s2t(false, text);
    }

    @Keep
    @JSMethod
    public String t2s(String text) {
        return Trans.t2s(false, text);
    }

    @Keep
    @JSMethod
    public String getProxy(Boolean local) {
        return Init.getServerAddress(local) + "proxy?do=js";
    }

    @Keep
    @JSMethod
    public String js2Proxy(Boolean dynamic, Integer siteType, String siteKey, String url, JSObject headers, String param) {
        return getProxy(!dynamic) + param + catvod(siteType, siteKey, url, headers);
    }

    @Keep
    @JSMethod
    public String js2Proxy(Boolean dynamic, Integer siteType, String siteKey, String url, JSObject headers) {
        LOG.d("js2Proxy: " + url);
        return getProxy(!dynamic) + catvod(siteType, siteKey, url, headers);
    }

    @Keep
    @JSMethod
    public JSArray batchFetch(JSObject options){
        Request request = new Request.Builder()
                .url(Init.getServerAddress(true) + "batchFetch")
                .post(RequestBody.create(options.stringify(), MediaType.get("application/json; charset=utf-8")))
                .build();
        String json = null;
        try {
            json = OkHttp.client().newCall(request).execute().body().string();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        return (JSArray) ctx.parse(json);
    }

    @Keep
    @JSMethod
    public Object setTimeout(JSFunction func, Integer delay) {
        func.hold();
        schedule(func, delay);
        return null;
    }

    @Keep
    @JSMethod
    public JSObject _http(String url, JSObject options) {
        JSFunction complete = options.getJSFunction("complete");
        if (complete == null) return req(url, options);
        Req req = Req.objectFrom(options.stringify());
        Connect.to(url, req).enqueue(getCallback(complete, req));
        return null;
    }

    @Keep
    @JSMethod
    public JSObject req(String url, JSObject options) {
        try {
            Req req = Req.objectFrom(options.stringify());
            Response res = Connect.to(url, req).execute();
            return Connect.success(ctx, req, res);
        } catch (Exception e) {
            return Connect.error(ctx);
        }
    }

    @Keep
    @JSMethod
    public String pd(String html, String rule, String urlKey) {
        return HtmlParser.parseDomForUrl(html, rule, urlKey);
    }

    @Keep
    @JSMethod
    public String pdfh(String html, String rule) {
        return HtmlParser.parseDomForUrl(html, rule, "");
    }

    @Keep
    @JSMethod
    public JSArray pdfa(String html, String rule) {
        return JSUtil.toArray(ctx, HtmlParser.parseDomForArray(html, rule));
    }

    @Keep
    @JSMethod
    public JSArray pdfl(String html, String rule, String texts, String urls, String urlKey) {
        return JSUtil.toArray(ctx, HtmlParser.parseDomForList(html, rule, texts, urls, urlKey));
    }

    @Keep
    @JSMethod
    public String joinUrl(String parent, String child) {
        return UriUtil.resolve(parent, child);
    }

    @Keep
    @JSMethod
    public String gbkDecode(JSArray buffer) throws CharacterCodingException {
        String result = JSUtil.decodeTo("GB2312", buffer);
        LOG.d("gbkDecode",String.format("text:%s\nresult:\n%s", buffer, result));
        return result;
    }

    @Keep
    @JSMethod
    public String md5X(String text) {
        String result = Crypto.md5(text);
        LOG.d("md5X",String.format("text:%s\nresult:\n%s", text, result));
        return result;
    }

    @Keep
    @JSMethod
    public String aesX(String mode, boolean encrypt, String input, boolean inBase64, String key, String iv, boolean outBase64) {
        String result = Crypto.aes(mode, encrypt, input, inBase64, key, iv, outBase64);
        LOG.d("aesX",String.format("mode:%s\nencrypt:%s\ninBase64:%s\noutBase64:%s\nkey:%s\niv:%s\ninput:\n%s\nresult:\n%s", mode, encrypt, inBase64, outBase64, key, iv, input, result));
        return result;
    }

    @Keep
    @JSMethod
    public String rsaX(String mode, boolean pub, boolean encrypt, String input, boolean inBase64, String key, boolean outBase64) {
        String result = Crypto.rsa(mode, pub, encrypt, input, inBase64, key, outBase64);
        LOG.d("rsaX",String.format("mode:%s\npub:%s\nencrypt:%s\ninBase64:%s\noutBase64:%s\nkey:\n%s\ninput:\n%s\nresult:\n%s", mode, pub, encrypt, inBase64, outBase64, key, input, result));
        return result;
    }

    private String catvod(Integer siteType, String siteKey, String url, JSObject headers) {
        return String.format("&from=catvod&siteType=%s&siteKey=%s&header=%s&url=%s", siteType, siteKey, URLEncoder.encode(headers.stringify()), URLEncoder.encode(url));
    }

    private Callback getCallback(JSFunction complete, Req req) {
        return new Callback() {
            @Override
            public void onResponse(@NonNull Call call, @NonNull Response res) {
                submit(() -> complete.call(Connect.success(ctx, req, res)));
            }

            @Override
            public void onFailure(@NonNull Call call, @NonNull IOException e) {
                submit(() -> complete.call(Connect.error(ctx)));
            }
        };
    }

    private void schedule(JSFunction func, int delay) {
        timer.schedule(new TimerTask() {
            @Override
            public void run() {
                submit(func::call);
            }
        }, delay);
    }
}
