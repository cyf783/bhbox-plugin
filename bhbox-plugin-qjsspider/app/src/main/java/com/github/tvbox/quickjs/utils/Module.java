package com.github.tvbox.quickjs.utils;

import android.net.Uri;
import android.text.TextUtils;
import android.util.Base64;

import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Util;
import com.google.common.net.HttpHeaders;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;

import okhttp3.Headers;
import okhttp3.Request;
import okhttp3.Response;

public class Module {

    private final ConcurrentHashMap<String, String> cache;
    private final String[] libs;

    public void clear() {
        cache.clear();
    }

    private static class Loader {
        static volatile Module INSTANCE = new Module();
    }

    public static Module get() {
        return Loader.INSTANCE;
    }

    public Module() {
        this.cache = new ConcurrentHashMap<>();
        this.libs = JsLibAsset.getFileNames("js/lib");
    }

    public String fetch(String name) {
        if (cache.containsKey(name)) return cache.get(name);
        String content;
        if (name.startsWith("drpy2") || (name.startsWith("assets") && name.contains("drpy2.js"))) content = JsLibAsset.read("js/lib/drpy2.min.js");
        else if (name.startsWith("http")) content = request(name);
        else if (name.startsWith("file://")) content = Io.readSDFileText(name.replace("file://", ""));
        else if (name.startsWith("assets")) content = JsLibAsset.read(name);
        else if (name.startsWith("lib/")) content = JsLibAsset.read("js/" + name);
        else content = JsLibAsset.readLib(libs, name);
        cache.put(name, content);
        return content;
    }

    private String request(String url) {
        try {
            // 指向自家 server 的历史固化端口地址，动态重写到当前端口
            url = Util.clanToAddress(url);
            Uri uri = Uri.parse(url);
            File file = new File(Path.js().getAbsolutePath()+ Util.md5(url)+"_"+uri.getLastPathSegment());
            if (file.exists()) return Io.read(file);
            Response response = OkHttp.client().newCall(new Request.Builder().url(url).headers(Headers.of(HttpHeaders.USER_AGENT, "Mozilla/5.0")).build()).execute();
            if (response.code() != 200) {
                String js = JsLibAsset.readLib(libs,uri.getPath());
                if(!TextUtils.isEmpty(js)){
                    new Thread(() -> Io.write(file, js)).start();
                    return js;
                }else{
                    return "";
                }
            };
            byte[] data = response.body().bytes();
            boolean cache = !"127.0.0.1".equals(uri.getHost());
            if (cache) new Thread(() -> Io.write(file, data)).start();
            return new String(data, StandardCharsets.UTF_8);
        } catch (Exception e) {
            e.printStackTrace();
            return "";
        }
    }

    public byte[] bb(String content) {
        byte[] bytes = Base64.decode(content.substring(4), Base64.DEFAULT);
        byte[] newBytes = new byte[bytes.length - 4];
        newBytes[0] = 1;
        System.arraycopy(bytes, 5, newBytes, 1, bytes.length - 5);
        return newBytes;
    }
}
