package bh.box.plugin.extractor.clearkey;

import android.text.TextUtils;

import android.util.Base64;

import com.github.catvod.utils.LOG;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLDecoder;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * KODIPROP 写源协议解析器（与 EXO 插件 KodiProps 语义一致）。
 * <p>
 * URL 形态：
 * <pre>
 * https://cdn.example.com/video.mp4
 *   #KODIPROP:inputstream.adaptive.license_type=clearkey
 *   #KODIPROP:inputstream.adaptive.license_key=%7B%22keys%22%3A...%7D
 *   #KODIPROP:inputstream.adaptive.stream_headers=%7B%22User-Agent%22%3A...%7D
 * </pre>
 * 宽容性约定：
 * <ul>
 *   <li>值仅在包含 '%' 时 URL decode（避免裸 base64 的 '+' 被转空格），失败保持原值；</li>
 *   <li>headers/keys JSON 允许单引号写法，归一为双引号后再解析。</li>
 * </ul>
 */
final class KodipropParser {

    private static final String TAG = "ClearKeyProxy";
    static final String PROP_MARKER = "#KODIPROP:";
    private static final String PROP_PREFIX = "inputstream.adaptive.";

    /** 解析结果：干净 URL + 短键键值表 */
    final String cleanUrl;
    final Map<String, String> props;

    private KodipropParser(String cleanUrl, Map<String, String> props) {
        this.cleanUrl = cleanUrl;
        this.props = props;
    }

    /** 解析 KODIPROP 后缀；无后缀或无有效 URL 时返回 null */
    static KodipropParser parse(String url) {
        if (TextUtils.isEmpty(url)) return null;
        int marker = url.indexOf(PROP_MARKER);
        if (marker < 0) return null;
        String cleanUrl = url.substring(0, marker).trim();
        while (cleanUrl.endsWith("#")) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.length() - 1).trim();
        }
        if (TextUtils.isEmpty(cleanUrl)) return null;
        Map<String, String> props = new LinkedHashMap<>();
        for (String part : url.substring(marker).split("#")) {
            part = part.trim();
            if (part.isEmpty() || !part.startsWith("KODIPROP:")) continue;
            part = part.substring("KODIPROP:".length()).trim();
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String key = part.substring(0, eq).trim();
            if (key.startsWith(PROP_PREFIX)) key = key.substring(PROP_PREFIX.length());
            props.put(key, decodeValue(part.substring(eq + 1).trim()));
        }
        return new KodipropParser(cleanUrl, props);
    }

    private static String decodeValue(String value) {
        if (!value.contains("%")) return value;
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    /** 是否为 ClearKey 内联 keys JSON（{"keys":[...]}），license URL 形态不算 */
    static boolean isKeysJson(String value) {
        if (TextUtils.isEmpty(value)) return false;
        String trimmed = value.trim().replace('\'', '"');
        return trimmed.startsWith("{") && trimmed.contains("keys");
    }

    /**
     * 解析 ClearKey keys JSON 为 kid(hex 小写) → 16 字节密钥 的有序表。
     * 兼容标准 JWK（kty/k/kid base64url）及 key 别名；单条失败跳过。无有效密钥返回 null。
     */
    static Map<String, byte[]> parseClearKeys(String json) {
        if (TextUtils.isEmpty(json)) return null;
        try {
            JSONArray keys = new JSONObject(json.trim().replace('\'', '"')).optJSONArray("keys");
            if (keys == null || keys.length() == 0) return null;
            Map<String, byte[]> out = new LinkedHashMap<>();
            for (int i = 0; i < keys.length(); i++) {
                JSONObject entry = keys.optJSONObject(i);
                if (entry == null) continue;
                String kid = entry.optString("kid", null);
                String key = entry.optString("k", entry.optString("key", null));
                if (TextUtils.isEmpty(kid) || TextUtils.isEmpty(key)) continue;
                byte[] kidBytes = base64UrlDecode(kid);
                byte[] keyBytes = base64UrlDecode(key);
                if (kidBytes == null || keyBytes == null) {
                    LOG.e(TAG, "ClearKey kid/k base64url 解码失败，跳过");
                    continue;
                }
                out.put(toHex(kidBytes), keyBytes);
            }
            return out.isEmpty() ? null : out;
        } catch (Exception e) {
            LOG.e(TAG, "ClearKey keys JSON 解析失败: " + e.getMessage());
            return null;
        }
    }

    /** headers JSON（单引号宽容）→ 键值表；失败返回空表 */
    static Map<String, String> parseJsonHeaders(String json) {
        Map<String, String> headers = new LinkedHashMap<>();
        if (TextUtils.isEmpty(json)) return headers;
        try {
            JSONObject obj = new JSONObject(json.trim().replace('\'', '"'));
            java.util.Iterator<String> it = obj.keys();
            while (it.hasNext()) {
                String key = it.next();
                String value = obj.optString(key, null);
                if (!TextUtils.isEmpty(key) && !TextUtils.isEmpty(value)) headers.put(key.trim(), value.trim());
            }
        } catch (Exception e) {
            LOG.e(TAG, "headers JSON 解析失败: " + json);
        }
        return headers;
    }

    private static byte[] base64UrlDecode(String value) {
        try {
            return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
