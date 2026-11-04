package bh.box.plugin.exo;

import android.text.TextUtils;
import android.util.Base64;

import com.github.catvod.utils.LOG;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * KODIPROP 写源协议解析器（与 FongMi OK 影视 / Kodi InputStream Adaptive 写源格式兼容）。
 * <p>
 * 源侧在播放 URL 后追加若干 {@code #KODIPROP:key=value} 键值对来描述 DRM 信息：
 * <pre>
 * https://cdn.example.com/video.mpd
 *   #KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
 *   #KODIPROP:inputstream.adaptive.license_key=https://license.example.com/widevine
 *   #KODIPROP:inputstream.adaptive.license_headers={'X-Token':'abc'}
 * </pre>
 * 解析后产出：干净播放 URL（剥离全部 KODIPROP 后缀）+ 键值表。
 * <p>
 * 宽容性约定（FongMi 生态源质量参差）：
 * <ul>
 *   <li>值仅在包含 '%' 时按 URL 编码 decode（避免裸 base64 里的 '+' 被 URLDecoder 转成空格），decode 失败保持原值；</li>
 *   <li>headers 类 JSON 值允许单引号写法（{@code 'X-Token':'abc'}），归一为双引号后再解析，失败仅记日志不抛出。</li>
 * </ul>
 */
final class KodiProps {

    private static final String TAG = "KodiProps";
    private static final String PROP_MARKER = "#KODIPROP:";
    /** Kodi 标准键前缀，解析时统一剥离，存取均用短键名 */
    private static final String PROP_PREFIX = "inputstream.adaptive.";

    /** 剥离 KODIPROP 后缀后的干净播放 URL */
    final String cleanUrl;
    /** 键值表（键已剥离 inputstream.adaptive. 前缀） */
    final Map<String, String> props;

    private KodiProps(String cleanUrl, Map<String, String> props) {
        this.cleanUrl = cleanUrl;
        this.props = props;
    }

    /**
     * 解析 URL 中的 KODIPROP 后缀。
     *
     * @return 无 KODIPROP 后缀时返回 null（调用方走原有零改动逻辑）
     */
    static KodiProps parse(String url) {
        if (TextUtils.isEmpty(url)) {
            return null;
        }
        int marker = url.indexOf(PROP_MARKER);
        if (marker < 0) {
            return null;
        }
        String cleanUrl = url.substring(0, marker).trim();
        // 兜底：剥掉尾部孤立的 '#'，防止脏写源把 fragment 当 URL 的一部分传给 media3
        while (cleanUrl.endsWith("#")) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.length() - 1).trim();
        }
        if (TextUtils.isEmpty(cleanUrl)) {
            LOG.e(TAG, "KODIPROP 后缀前无有效 URL，按无 DRM 处理");
            return null;
        }
        String body = url.substring(marker);
        Map<String, String> props = new HashMap<>();
        // 键值对之间以 # 分隔，每段形如 KODIPROP:key=value；非 KODIPROP 片段忽略并记日志
        String[] parts = body.split("#");
        for (String part : parts) {
            part = part.trim();
            if (part.isEmpty()) {
                continue;
            }
            if (!part.startsWith("KODIPROP:")) {
                LOG.e(TAG, "忽略非 KODIPROP 片段: " + part);
                continue;
            }
            part = part.substring("KODIPROP:".length()).trim();
            int eq = part.indexOf('=');
            if (eq <= 0) {
                LOG.e(TAG, "忽略无值的 KODIPROP 片段: " + part);
                continue;
            }
            String key = part.substring(0, eq).trim();
            if (key.startsWith(PROP_PREFIX)) {
                key = key.substring(PROP_PREFIX.length());
            }
            props.put(key, decodeValue(part.substring(eq + 1).trim()));
        }
        return new KodiProps(cleanUrl, props);
    }

    /** 取键值，兼容带/不带 inputstream.adaptive. 前缀两种写法 */
    String get(String key) {
        String value = props.get(key);
        if (value == null) {
            value = props.get(PROP_PREFIX + key);
        }
        return value;
    }

    /**
     * 值 decode：仅当包含 '%'（URL 编码特征）时按 UTF-8 decode。
     * 不做无条件 decode：裸 base64 / keys JSON 里的 '+' 会被 URLDecoder 转成空格。
     */
    private static String decodeValue(String value) {
        if (!value.contains("%")) {
            return value;
        }
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception e) {
            LOG.e(TAG, "KODIPROP 值 decode 失败，保持原值: " + value);
            return value;
        }
    }

    /**
     * 宽容解析 headers JSON 为键值表（供 license 请求头使用）。
     * 单引号键值先归一为双引号再走 {@link JSONObject}；解析失败返回空表并记日志。
     */
    static Map<String, String> parseJsonHeaders(String json) {
        Map<String, String> headers = new HashMap<>();
        if (TextUtils.isEmpty(json)) {
            return headers;
        }
        String normalized = json.trim().replace('\'', '"');
        try {
            JSONObject obj = new JSONObject(normalized);
            Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = obj.optString(key, null);
                if (!TextUtils.isEmpty(key) && !TextUtils.isEmpty(value)) {
                    headers.put(key.trim(), value.trim());
                }
            }
        } catch (JSONException e) {
            LOG.e(TAG, "headers JSON 解析失败（已按宽容规则归一单引号）: " + json);
        }
        return headers;
    }

    /** 是否为 ClearKey 内联 keys JSON（形如 {"keys":[{"kid":..,"k":..,"kty":"oct"}]}） */
    static boolean isKeysJson(String value) {
        if (value == null) {
            return false;
        }
        String trimmed = value.trim().replace('\'', '"');
        return trimmed.startsWith("{") && trimmed.contains("keys");
    }

    /**
     * 解析 ClearKey keys JSON 为 keyId/key 交替的字节数组对，供 Mp4Extractor 做
     * unfragmented CENC 的 extractor 层解密（不建 MediaDrm 会话）。
     * <p>
     * 兼容标准 JWK 形态（kid/k 为 base64url 无填充）及 key 别名；单个密钥解析失败跳过该条。
     * 无有效密钥时返回 null。
     */
    static byte[][] parseClearKeys(String json) {
        if (TextUtils.isEmpty(json)) {
            return null;
        }
        String normalized = json.trim().replace('\'', '"');
        try {
            JSONArray keys = new JSONObject(normalized).optJSONArray("keys");
            if (keys == null || keys.length() == 0) {
                return null;
            }
            List<byte[]> pairs = new ArrayList<>();
            for (int i = 0; i < keys.length(); i++) {
                JSONObject entry = keys.optJSONObject(i);
                if (entry == null) {
                    continue;
                }
                String kid = entry.optString("kid", null);
                String key = entry.optString("k", entry.optString("key", null));
                if (TextUtils.isEmpty(kid) || TextUtils.isEmpty(key)) {
                    LOG.e(TAG, "ClearKey 密钥条目缺少 kid/k，跳过: " + entry);
                    continue;
                }
                byte[] kidBytes = base64UrlDecode(kid);
                byte[] keyBytes = base64UrlDecode(key);
                if (kidBytes == null || keyBytes == null) {
                    LOG.e(TAG, "ClearKey kid/k base64url 解码失败，跳过");
                    continue;
                }
                pairs.add(kidBytes);
                pairs.add(keyBytes);
            }
            if (pairs.isEmpty()) {
                return null;
            }
            return pairs.toArray(new byte[0][]);
        } catch (JSONException e) {
            LOG.e(TAG, "ClearKey keys JSON 解析失败: " + e.getMessage());
            return null;
        }
    }

    /** base64url（无填充）解码，失败返回 null */
    private static byte[] base64UrlDecode(String value) {
        try {
            return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
