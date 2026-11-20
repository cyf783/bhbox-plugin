package bh.box.plugin.exo;

import android.text.TextUtils;

import android.util.Base64;

import com.github.catvod.utils.LOG;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * drm:// 写源协议载荷解析（红果/番茄短剧生态，字段语义对齐 drpy 红果果[短].js）。
 * <p>
 * URL 形态（三选一）：
 * <pre>
 * drm://eyJ1Ijoi... base64url(JSON)          —— 现网主流（push_agent 推送链路原样透传）
 * drm://json?d=&lt;URL编码的 JSON&gt;             —— 方案文档约定的查询参数式
 * drm://{"u":"...","k":"..."}                —— 裸 JSON（罕见，容忍）
 * </pre>
 * 载荷 JSON 字段：
 * <ul>
 *   <li>{@code u}：视频直链（必填，http/https，unfragmented CENC MP4 为主）；</li>
 *   <li>{@code k}：内容密钥，三形态——32 位 hex（单密钥，kid 未知）、base64url 16 字节
 *       （单密钥）、{@code {"keys":[{"kid":..,"k":..}]}} JSON（多密钥）；缺省按明文播放；</li>
 *   <li>{@code e}：预留（当前恒为 0，忽略）；</li>
 *   <li>{@code h}：可选 headers JSON（覆盖默认 UA 等）。</li>
 * </ul>
 * <p>
 * 解析产物经 {@link ExoMediaSourceHelper} 接到 extractor 层 {@code setMp4ClearKeys}
 * （fork 的 {@code UnfragmentedCencDecryptor} 对「仅一对密钥」放宽为直接使用首密钥，
 * 与 clearkey 插件 CencDecryptor.matchKey 语义一致）——不建 MediaDrm 会话，纯软件解密，
 * unfragmented CENC MP4 场景最稳。
 */
final class DrmPayload {

    private static final String TAG = "DrmPayload";
    static final String SCHEME = "drm://";

    /** 载荷默认 UA：番茄小说/红果短剧 App UA（该 CDN 校验 UA，浏览器 UA 会 403） */
    static final String DEFAULT_UA =
            "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";

    /** 视频直链（必填） */
    final String url;
    /** extractor 层密钥对（kid,key 交替，各 16 字节）；载荷无 k 时为 null（按明文播放） */
    final byte[][] mp4ClearKeys;
    /** 载荷自带 headers（UA/Referer 等），空表表示用默认 */
    final Map<String, String> headers;

    private DrmPayload(String url, byte[][] mp4ClearKeys, Map<String, String> headers) {
        this.url = url;
        this.mp4ClearKeys = mp4ClearKeys;
        this.headers = headers;
    }

    /**
     * 解析 drm:// URL。
     *
     * @return 非 drm:// 或载荷不合法时返回 null（调用方按普通 URL 继续原有逻辑）
     */
    static DrmPayload parse(String url) {
        if (TextUtils.isEmpty(url) || !url.startsWith(SCHEME)) {
            return null;
        }
        String body = url.substring(SCHEME.length()).trim();
        if (body.isEmpty()) {
            LOG.e(TAG, "drm:// 后无载荷: " + url);
            return null;
        }
        String json = extractJson(body);
        if (TextUtils.isEmpty(json)) {
            return null;
        }
        try {
            JSONObject obj = new JSONObject(json);
            String u = obj.optString("u", "").trim();
            if (TextUtils.isEmpty(u) || !(u.startsWith("http://") || u.startsWith("https://"))) {
                LOG.e(TAG, "载荷缺有效 u 直链，忽略: " + json);
                return null;
            }
            // e 为预留字段（加密模式标记），当前生态恒为 0；非 0 仅记日志不改行为
            int e = obj.optInt("e", 0);
            if (e != 0) {
                LOG.i(TAG + " 载荷 e=" + e + "（非 0，预留字段，暂不区分处理）");
            }
            Map<String, String> headers = parseHeaders(obj.optString("h", ""));
            byte[][] keys = parseKey(obj.optString("k", "").trim());
            if (keys == null && !TextUtils.isEmpty(obj.optString("k", ""))) {
                LOG.e(TAG, "载荷 k 密钥无法解析（hex/base64url/keys JSON 均不匹配），按明文播放");
            }
            LOG.i(TAG + " drm:// 载荷解析成功 u=" + u + " keys=" + (keys == null ? 0 : keys.length / 2));
            return new DrmPayload(u, keys, headers);
        } catch (Exception e) {
            LOG.e(TAG, "载荷 JSON 解析失败: " + e.getMessage());
            return null;
        }
    }

    /** 从 body 提取载荷 JSON 字符串：裸 JSON / base64 / json?d= 三形态 */
    private static String extractJson(String body) {
        // 形态 3：裸 JSON
        if (body.startsWith("{")) {
            return body;
        }
        // 形态 2：drm://json?d=<URL编码 JSON>（方案文档约定）
        int q = body.indexOf('?');
        String head = q < 0 ? body : body.substring(0, q);
        if ("json".equalsIgnoreCase(head) && q >= 0) {
            String query = body.substring(q + 1);
            // 取 d 参数（不严格 parse query，载荷内不该再出现 &）
            if (query.startsWith("d=")) {
                return decodeComponent(query.substring(2));
            }
            LOG.e(TAG, "drm://json 形态缺 d 参数: " + body);
            return null;
        }
        // 形态 1：base64（现网主流）
        byte[] decoded = tryBase64(body);
        if (decoded == null) {
            LOG.e(TAG, "drm:// 载荷既非 JSON 也非 base64: " + body);
            return null;
        }
        return new String(decoded);
    }

    /** base64 解码：先标准，失败再 URL-safe 无填充 */
    private static byte[] tryBase64(String value) {
        try {
            return Base64.decode(value, Base64.DEFAULT);
        } catch (IllegalArgumentException ignored) {
        }
        try {
            return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String decodeComponent(String value) {
        try {
            return java.net.URLDecoder.decode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    /** 载荷 h 字段（headers JSON）→ 键值表；空/失败返回空表 */
    private static Map<String, String> parseHeaders(String json) {
        Map<String, String> out = new HashMap<>();
        if (TextUtils.isEmpty(json)) {
            return out;
        }
        try {
            JSONObject obj = new JSONObject(json.replace('\'', '"'));
            Iterator<String> it = obj.keys();
            while (it.hasNext()) {
                String key = it.next();
                String value = obj.optString(key, null);
                if (!TextUtils.isEmpty(key) && !TextUtils.isEmpty(value)) {
                    out.put(key.trim(), value.trim());
                }
            }
        } catch (Exception e) {
            LOG.e(TAG, "载荷 h headers 解析失败，忽略: " + json);
        }
        return out;
    }

    /**
     * 载荷 k 密钥 → kid/key 交替对（各 16 字节）。
     * 三形态：32 位 hex（单密钥）、base64url 16 字节（单密钥）、keys JSON（多密钥）。
     * 单密钥形态 kid 未知 → 16 字节 0 占位（fork 解密器对单密钥放宽为直接使用）。
     */
    private static byte[][] parseKey(String k) {
        if (TextUtils.isEmpty(k)) {
            return null;
        }
        // 形态 3：keys JSON
        if (k.startsWith("{")) {
            return parseKeysJson(k);
        }
        // 形态 1：32 位 hex
        if (k.length() == 32 && k.matches("[0-9a-fA-F]{32}")) {
            byte[] key = hexToBytes(k);
            if (key != null) {
                return new byte[][]{new byte[16], key};
            }
        }
        // 形态 2：base64url 16 字节
        byte[] decoded = tryBase64(k);
        if (decoded != null && decoded.length == 16) {
            return new byte[][]{new byte[16], decoded};
        }
        return null;
    }

    /** {"keys":[{"kid":..,"k":..,"kty":"oct"}]} → kid/key 交替对（kid hex 或 base64url 均容忍） */
    private static byte[][] parseKeysJson(String json) {
        try {
            JSONArray keys = new JSONObject(json.replace('\'', '"')).optJSONArray("keys");
            if (keys == null || keys.length() == 0) {
                return null;
            }
            java.util.List<byte[]> pairs = new java.util.ArrayList<>();
            for (int i = 0; i < keys.length(); i++) {
                JSONObject entry = keys.optJSONObject(i);
                if (entry == null) continue;
                String kid = entry.optString("kid", null);
                String key = entry.optString("k", entry.optString("key", null));
                if (TextUtils.isEmpty(kid) || TextUtils.isEmpty(key)) continue;
                byte[] kidBytes = isHex16(kid) ? hexToBytes(kid) : tryBase64(kid);
                byte[] keyBytes = isHex16(key) ? hexToBytes(key) : tryBase64(key);
                if (kidBytes == null || kidBytes.length != 16 || keyBytes == null || keyBytes.length != 16) {
                    LOG.e(TAG, "keys JSON 密钥条目 kid/k 解码失败，跳过: " + entry);
                    continue;
                }
                pairs.add(kidBytes);
                pairs.add(keyBytes);
            }
            return pairs.isEmpty() ? null : pairs.toArray(new byte[0][]);
        } catch (Exception e) {
            LOG.e(TAG, "keys JSON 解析失败: " + e.getMessage());
            return null;
        }
    }

    private static boolean isHex16(String value) {
        return value != null && value.length() == 32 && value.matches("[0-9a-fA-F]{32}");
    }

    private static byte[] hexToBytes(String hex) {
        try {
            int len = hex.length() / 2;
            byte[] out = new byte[len];
            for (int i = 0; i < len; i++) {
                out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            }
            return out;
        } catch (Exception e) {
            return null;
        }
    }
}
