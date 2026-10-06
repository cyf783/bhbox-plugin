package com.github.tvbox.quickjs.utils;

import android.util.Base64;

import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Json;
import com.github.tvbox.quickjs.bean.Req;
import com.google.common.net.HttpHeaders;
import com.whl.quickjs.wrapper.JSObject;
import com.whl.quickjs.wrapper.QuickJSContext;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

import okhttp3.Call;
import okhttp3.FormBody;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class Connect {

    public static Call to(String url, Req req) {
        OkHttpClient client = OkHttp.client(req.isRedirect(), req.getTimeout());
        return client.newCall(getRequest(url, req, Headers.of(req.getHeader())));
    }

    public static JSObject success(QuickJSContext ctx, Req req, Response res) {
        try {
            JSObject jsObject = ctx.createJSObject();
            JSObject jsHeader = ctx.createJSObject();
            setHeader(ctx, res, jsHeader);
            jsObject.set("code", res.code());
            jsObject.set("headers", jsHeader);
            byte[] bytes = decompressIfNeeded(res);
            if (req.getBuffer() == 0) jsObject.set("content", new String(bytes, req.getCharset()));
            if (req.getBuffer() == 1) jsObject.set("content", JSUtil.toArray(ctx, bytes));
            if (req.getBuffer() == 2) jsObject.set("content", Base64.encodeToString(bytes, Base64.DEFAULT | Base64.NO_WRAP));
            return jsObject;
        } catch (Exception e) {
            return error(ctx);
        }
    }

    private static byte[] decompressIfNeeded(Response res) throws Exception {
        byte[] bytes = res.body().bytes();
        String encoding = res.header(HttpHeaders.CONTENT_ENCODING);
        if (encoding != null && encoding.contains("gzip")) {
            return ungzip(bytes);
        }
        return bytes;
    }

    private static byte[] ungzip(byte[] compressed) throws Exception {
        ByteArrayInputStream bis = new ByteArrayInputStream(compressed);
        GZIPInputStream gis = new GZIPInputStream(bis);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int len;
        while ((len = gis.read(buffer)) != -1) {
            bos.write(buffer, 0, len);
        }
        gis.close();
        bis.close();
        bos.close();
        return bos.toByteArray();
    }

    public static JSObject error(QuickJSContext ctx) {
        JSObject jsObject = ctx.createJSObject();
        JSObject jsHeader = ctx.createJSObject();
        jsObject.set("headers", jsHeader);
        jsObject.set("content", "");
        jsObject.set("code", "");
        return jsObject;
    }

    private static Request getRequest(String url, Req req, Headers headers) {
        if (req.getMethod().equalsIgnoreCase("post")) {
            return new Request.Builder().url(url).headers(headers).post(getPostBody(req, headers.get(HttpHeaders.CONTENT_TYPE))).build();
        } else if (req.getMethod().equalsIgnoreCase("header")) {
            return new Request.Builder().url(url).headers(headers).head().build();
        } else {
            return new Request.Builder().url(url).headers(headers).get().build();
        }
    }

    private static RequestBody getPostBody(Req req, String contentType) {
        if (req.getData() != null && contentType != null && contentType.contains("application/x-www-form-urlencoded")) return getFormBody(req);
        if (req.getData() != null && "json".equals(req.getPostType())) return getJsonBody(req);
        if (req.getData() != null && "form".equals(req.getPostType())) return getFormBody(req);
        if (req.getData() != null && "form-data".equals(req.getPostType())) return getFormDataBody(req);
        if (req.getData() != null && "raw".equals(req.getPostType())) return getRawBody(req);
        if (req.getBody() != null && contentType != null) return RequestBody.create(req.getBody(), MediaType.get(contentType));
        return RequestBody.create("", null);
    }

    private static RequestBody getJsonBody(Req req) {
        return RequestBody.create(req.getData().toString(), MediaType.get("application/json; charset=utf-8"));
    }

    private static RequestBody getRawBody(Req req) {
        return RequestBody.create(req.getData().toString(), MediaType.get("application/json; charset=utf-8"));
    }

    private static RequestBody getFormBody(Req req) {
        FormBody.Builder builder = new FormBody.Builder();
        Map<String, String> params = Json.toMap(req.getData());
        for (String key : params.keySet()) builder.add(key, params.get(key));
        return builder.build();
    }

    private static RequestBody getFormDataBody(Req req) {
        String boundary = "--dio-boundary-" + new SecureRandom().nextInt(42949) + "" + new SecureRandom().nextInt(67296);
        MultipartBody.Builder builder = new MultipartBody.Builder(boundary).setType(MultipartBody.FORM);
        Map<String, String> params = Json.toMap(req.getData());
        for (String key : params.keySet()) builder.addFormDataPart(key, params.get(key));
        return builder.build();
    }



    private static void setHeader(QuickJSContext ctx, Response res, JSObject object) {
        for (Map.Entry<String, List<String>> entry : res.headers().toMultimap().entrySet()) {
            if (entry.getValue().size() == 1) object.set(entry.getKey(), entry.getValue().get(0));
            if (entry.getValue().size() >= 2) object.set(entry.getKey(), JSUtil.toArray(ctx, entry.getValue()));
        }
    }
}
