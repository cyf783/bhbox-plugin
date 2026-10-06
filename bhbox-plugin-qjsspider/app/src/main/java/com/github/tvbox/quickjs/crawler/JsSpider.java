package com.github.tvbox.quickjs.crawler;

import android.content.Context;
import android.util.Base64;

import com.github.catvod.utils.Json;
import com.github.catvod.utils.UriUtil;
import com.github.tvbox.quickjs.bean.Res;
import com.github.tvbox.quickjs.method.Async;
import com.github.tvbox.quickjs.method.Console;
import com.github.tvbox.quickjs.method.Global;
import com.github.tvbox.quickjs.method.Local;
import com.github.tvbox.quickjs.utils.JSUtil;
import com.github.tvbox.quickjs.utils.JsLibAsset;
import com.github.tvbox.quickjs.utils.Module;
import com.whl.quickjs.wrapper.JSArray;
import com.whl.quickjs.wrapper.JSObject;
import com.whl.quickjs.wrapper.ModuleLoader;
import com.whl.quickjs.wrapper.QuickJSContext;

import org.json.JSONArray;

import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import java9.util.concurrent.CompletableFuture;

public class JsSpider extends com.github.catvod.crawler.Spider {

    private final ExecutorService executor;
    private QuickJSContext ctx;
    private JSObject jsObject;
    private final String key;
    private final String api;
    private boolean cat;

    public JsSpider(String key, String api) throws Exception {
        this.executor = Executors.newSingleThreadExecutor();
        this.key = key;
        this.api = api;
        initializeJS();
    }

    private void submit(Runnable runnable) {
        executor.submit(runnable);
    }

    private <T> Future<T> submit(Callable<T> callable) {
        return executor.submit(callable);
    }

    private Object call(String func, Object... args) throws Exception {
        //return executor.submit((Function.call(jsObject, func, args))).get();
        return CompletableFuture.supplyAsync(() -> Async.run(jsObject, func, args), executor).join().get();
    }

    @Override
    public void init(Context context, String extend) throws Exception {
        if (cat) call("init", submit(() -> cfg(extend)).get());
        else call("init", Json.valid(extend) ? ctx.parse(extend) : extend);
    }

    @Override
    public String homeContent(boolean filter) throws Exception {
        return (String) call("home", filter);
    }

    @Override
    public String homeVideoContent() throws Exception {
        return (String) call("homeVod");
    }

    @Override
    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) throws Exception {
        JSObject obj = submit(() -> JSUtil.toObj(ctx, extend)).get();
        return (String) call("category", tid, pg, filter, obj);
    }

    @Override
    public String detailContent(List<String> ids) throws Exception {
        return (String) call("detail", ids.get(0));
    }

    @Override
    public String searchContent(String key, boolean quick) throws Exception {
        return (String) call("search", key, quick);
    }

    @Override
    public String searchContent(String key, boolean quick, String pg) throws Exception {
        return (String) call("search", key, quick, pg);
    }

    @Override
    public String searchContentPage(String key, boolean quick, String pg) throws Exception {
        return (String) call("search", key, quick, pg);
    }

    @Override
    public String playerContent(String flag, String id, List<String> vipFlags) throws Exception {
        JSArray array = submit(() -> JSUtil.toArray(ctx, vipFlags)).get();
        return (String) call("play", flag, id, array);
    }

    @Override
    public String liveContent(String url) throws Exception {
        return (String) call("live", url);
    }

    @Override
    public boolean manualVideoCheck() throws Exception {
        return (Boolean) call("sniffer");
    }

    @Override
    public boolean isVideoFormat(String url) throws Exception {
        return (Boolean) call("isVideo", url);
    }

    @Override
    public Object[] proxyLocal(Map<String, String> params) throws Exception {
        if ("catvod".equals(params.get("from"))) return proxy2(params);
        else return submit(() -> proxy1(params)).get();
    }

    @Override
    public String action(String action) throws Exception {
        return (String) call("action", action);
    }

    @Override
    public String action(String action,String value) throws Exception {
        return (String) call("action", action, value);
    }

    @Override
    public void destroy() {
        try {
            call("destroy");
        } catch (Throwable e) {
            e.printStackTrace();
        }
        submit(() -> {
            try {
                executor.shutdownNow();
            } catch (Throwable e) {
                e.printStackTrace();
            }

            jsObject.release();
            ctx.destroy();
        });
    }

    private void initializeJS() throws Exception {
        submit(() -> {
            createCtx();
            createObj();
            return null;
        }).get();
    }

    private void createCtx() {
        ctx = QuickJSContext.create();
        ctx.setConsole(new Console());
        ctx.evaluate(JsLibAsset.read("js/lib/http.js"));
        Global global = Global.create(ctx, executor);
        global.setProperty();
        global.setProperty("local", Local.class);
        ctx.setModuleLoader(new ModuleLoader() {
            @Override
            public String moduleNormalizeName(String baseModuleName, String moduleName) {
                return UriUtil.resolve(baseModuleName, moduleName);
            }

            @Override
            public byte[] getModuleBytecode(String moduleName) {
                String content = Module.get().fetch(moduleName);
                content = content.replace("__JS_SPIDER__", "globalThis.__JS_SPIDER__");
                if(content.startsWith("//DRPY")){
                    return Base64.decode(content.substring(6), Base64.URL_SAFE);
                } else if(content.startsWith("//bb")){
                    return Module.get().bb(content);
                } else {
                    return ctx.compileModule(content, moduleName);
                }
            }

            @Override
            public boolean isBytecodeMode() {
                return true;
            }

            @Override
            public String getModuleStringCode(String var1) {
                return null;
            }
        });
    }

    private void createObj() {
        String spider = "__JS_SPIDER__";
        String global = "globalThis." + spider;
        String content = Module.get().fetch(api);
        if (content.startsWith("//bb")) {
            cat = true;
            ctx.execute(Module.get().bb(content));
        } else {
            cat = content.contains("__jsEvalReturn");
            if(content.contains(spider) && !content.contains(global)) {
                ctx.evaluateModule(content.replace(spider, global), api);
            }
            ctx.evaluateModule(String.format(JsLibAsset.read("js/lib/spider.js"), api));
        }
        jsObject = (JSObject) ctx.getProperty(ctx.getGlobalObject(), spider);
    }

    private JSObject cfg(String ext) {
        JSObject cfg = ctx.createJSObject();
        cfg.set("stype", 3);
        cfg.set("skey", key);
        if (Json.invalid(ext)) cfg.set("ext", ext);
        else cfg.set("ext", (JSObject) ctx.parse(ext));
        return cfg;
    }

    private Object[] proxy1(Map<String, String> params) throws Exception {
        JSObject object = JSUtil.toObj(ctx, params);
        JSONArray array = new JSONArray(((JSArray) jsObject.getJSFunction("proxy").call(object)).stringify());
        Map<String, String> headers = array.length() > 3 ? Json.toMap(array.optString(3)) : null;
        boolean base64 = array.length() > 4 && array.optInt(4) == 1;
        Object[] result = new Object[4];
        result[0] = array.optInt(0);
        result[1] = array.optString(1);
        result[2] = getStream(array.opt(2), base64);
        result[3] = headers;
        return result;
    }

    private Object[] proxy2(Map<String, String> params) throws Exception {
        String url = params.get("url");
        String header = params.get("header");
        JSArray array = submit(() -> JSUtil.toArray(ctx, Arrays.asList(url.split("/")))).get();
        Object object = submit(() -> ctx.parse(header)).get();
        String json = (String) call("proxy", array, object);
        Res res = Res.objectFrom(json);
        Object[] result = new Object[3];
        result[0] = res.getCode();
        result[1] = res.getContentType();
        result[2] = res.getStream();
        return result;
    }

    private ByteArrayInputStream getStream(Object o, boolean base64) {
        if (o instanceof JSONArray) {
            JSONArray a = (JSONArray) o;
            byte[] bytes = new byte[a.length()];
            for (int i = 0; i < a.length(); i++) bytes[i] = (byte) a.optInt(i);
            return new ByteArrayInputStream(bytes);
        } else {
            String content = o.toString();
            if (base64 && content.contains("base64,")) content = content.split("base64,")[1];
            return new ByteArrayInputStream(base64 ? Base64.decode(content,Base64.DEFAULT | Base64.NO_WRAP) : content.getBytes());
        }
    }
}
