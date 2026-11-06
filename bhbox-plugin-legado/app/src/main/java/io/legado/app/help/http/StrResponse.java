package io.legado.app.help.http;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 对齐 legado {@code io.legado.app.help.http.StrResponse} 的 JS 可达面。
 *
 * <p>社区书源 loginCheckJs 直接用
 * {@code Packages.io.legado.app.help.http.StrResponse(url, html)} 重建解密后的响应
 * （聚合书库等），Rhino LiveConnect 按完整包名解析 Java 类；插件原先只有
 * {@code bh.box.plugin.legado.engine.JsExtensions.StrResponse}（内部 result 绑定用），
 * 该路径解析成 JavaPackage 对象，调用时报「StrResponse 不是函数，它是 object」。
 *
 * <p>包名必须与官方一致且不得被 R8 混淆（见 proguard-rules.pro 的 keeppackagenames）。
 * toString 返回 body：T4Actions.runLoginCheckJs 用 JS 返回值 String.valueOf 替换响应，
 * 与插件内部 StrResponse 的语义保持一致。
 */
public class StrResponse {

    private final String url;
    private final String body;

    /** 官方构造器 {@code StrResponse(url: String, body: String?)} */
    public StrResponse(String url, String body) {
        this.url = url == null ? "" : url;
        this.body = body == null ? "" : body;
    }

    /** 兼容只传 body 的写法 */
    public StrResponse(String body) {
        this("", body);
    }

    public String url() {
        return url;
    }

    public String body() {
        return body;
    }

    public int code() {
        return 200;
    }

    public String header(String name) {
        return "";
    }

    public Map<String, String> cookies() {
        return new LinkedHashMap<String, String>();
    }

    /** 官方字段同名方法面（Java 字段/方法共存时 Rhino 返回 FieldAndMethods） */
    public String getUrl() {
        return url;
    }

    @Override
    public String toString() {
        return body;
    }
}
