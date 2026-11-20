package bh.box.plugin.extractor.clearkey;

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
 * drm://eyJ1Ijoi... base64(JSON)             —— 现网主流（push_agent 推送链路原样透传）
 * drm://json?d=&lt;URL编码的 JSON&gt;             —— 方案文档约定的查询参数式
 * drm://{"u":"...","k":"..."}                —— 裸 JSON（罕见，容忍）
 * </pre>
 * 载荷 JSON 字段：
 * <ul>
 *   <li>{@code u}：视频直链（必填，http/https，unfragmented CENC MP4 为主）；</li>
 *   <li>{@code k}：内容密钥，三形态——32 位 hex（单密钥，kid 未知）、base64url 16 字节
 *       （单密钥）、{@code {"keys":[{"kid":..,"k":..}]}} JSON（多密钥）；缺省按明文播放；</li>
 *   <li>{@code e}：预留（当前恒为 0，忽略）；</li>
 *   <li>{@code h}：可选 headers JSON（覆盖默认 UA/Referer）。</li>
 * </ul>
 * <p>
 * 与 EXO 插件 bh.box.plugin.exo.DrmPayload 同源实现（插件 APK 隔离加载，互不冲突）。
 * 本插件把载荷转译为 KODIPROP URL：unfragmented 容器走本地解密代理（全内核可播），
 * fMP4 原样返回交 EXO 原生 ClearKey session（EXO 插件入口同样识别 drm:// 原始形态）。
 */
final class DrmPayload {

    private static final String TAG = "ClearKeyProxy";
    static final String SCHEME = "drm://";

    /** 载荷默认 UA：番茄小说/红果短剧 App UA（该 CDN 校验 UA，浏览器 UA 会 403） */
    static final String DEFAULT_UA =
            "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
    /** 载荷默认 Referer：红果视频 CDN 的已验证 Referer（红果果[短].js remoteRange 同款） */
    static final String DEFAULT_REFERER = "https://novel.snssdk.com/";

    /** 视频直链（必填） */
    final String url;
    /** kid(hex 小写) → 16 字节密钥；载荷无 k 时为 null（按明文播放） */
    final Map<String, byte[]> keys;
    /** 载荷自带 headers（UA/Referer 等），空表表示用默认 */
    final Map<String, String> headers;

    private DrmPayload(String url, Map<String, byte[]> keys, Map<String, String> headers) {
        this.url = url;
        this.keys = keys;
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
            Map<String, byte[]> keys = parseKey(obj.optString("k", "").trim());
            if (keys == null && !TextUtils.isEmpty(obj.optString("k", ""))) {
                LOG.e(TAG, "载荷 k 密钥无法解析（hex/base64url/keys JSON 均不匹配），按明文处理");
            }
            LOG.i(TAG + " drm:// 载荷解析成功 u=" + u + " keys=" + (keys == null ? 0 : keys.size()));
            return new DrmPayload(u, keys, headers);
        } catch (Exception e) {
            LOG.e(TAG, "载荷 JSON 解析失败: " + e.getMessage());
            return null;
        }
    }

    /**
     * 转译为 KODIPROP URL（与宿主 applyDrmKodiprop / EXO KodiProps 语义兼容）：
     * u 作 cleanUrl；单密钥以全零 kid + keys JSON 内联（解密器对单密钥放宽为直接使用）；
     * headers 以 stream_headers 承载（载荷 h > 默认 UA/Referer）。
     */
    String toKodipropUrl() {
        StringBuilder sb = new StringBuilder(url);
        sb.append("#KODIPROP:inputstream.adaptive.license_type=clearkey");
        sb.append("#KODIPROP:inputstream.adaptive.license_key=").append(buildKeysJson());
        Map<String, String> merged = buildHeaders();
        if (!merged.isEmpty()) {
            sb.append("#KODIPROP:inputstream.adaptive.stream_headers=")
                    .append(android.net.Uri.encode(new JSONObject(merged).toString()));
        }
        return sb.toString();
    }

    /** 下载 headers：载荷 h > 默认 UA/Referer（供代理下载与 Range 探测） */
    Map<String, String> buildHeaders() {
        Map<String, String> merged = new HashMap<>(headers);
        boolean hasUa = false;
        boolean hasReferer = false;
        for (String name : merged.keySet()) {
            if ("User-Agent".equalsIgnoreCase(name)) hasUa = true;
            if ("Referer".equalsIgnoreCase(name)) hasReferer = true;
        }
        if (!hasUa) merged.put("User-Agent", DEFAULT_UA);
        if (!hasReferer) merged.put("Referer", DEFAULT_REFERER);
        return merged;
    }

    /** keys 表 → 内联 keys JSON（kid=全零 hex 转 b64url；k=b64url） */
    private String buildKeysJson() {
        StringBuilder sb = new StringBuilder("{\"keys\":[");
        boolean first = true;
        for (Map.Entry<String, byte[]> entry : keys.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            byte[] kid = hexToBytes(entry.getKey());
            String kidB64 = kid != null ? Base64.encodeToString(kid, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING) : "";
            String keyB64 = Base64.encodeToString(entry.getValue(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            sb.append("{\"kid\":\"").append(kidB64).append("\",\"k\":\"").append(keyB64).append("\",\"kty\":\"oct\"}");
        }
        sb.append("]}");
        return sb.toString();
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
     * 载荷 k 密钥 → kid(hex 小写) → 16 字节密钥 表。
     * 三形态：32 位 hex（单密钥）、base64url 16 字节（单密钥）、keys JSON（多密钥）。
     * 单密钥形态 kid 未知 → 16 字节 0 占位（CencDecryptor.matchKey 对单密钥放宽为直接使用）。
     */
    private static Map<String, byte[]> parseKey(String k) {
        if (TextUtils.isEmpty(k)) {
            return null;
        }
        // 形态 3：keys JSON
        if (k.startsWith("{")) {
            return parseKeysJson(k);
        }
        // 形态 1：32 位 hex
        if (isHex16(k)) {
            byte[] key = hexToBytes(k);
            if (key != null) {
                Map<String, byte[]> out = new HashMap<>();
                out.put(toHex(new byte[16]), key);
                return out;
            }
        }
        // 形态 2：base64url 16 字节
        byte[] decoded = tryBase64(k);
        if (decoded != null && decoded.length == 16) {
            Map<String, byte[]> out = new HashMap<>();
            out.put(toHex(new byte[16]), decoded);
            return out;
        }
        return null;
    }

    /** {"keys":[{"kid":..,"k":..,"kty":"oct"}]} → kid(hex) → key 表（kid hex 或 base64url 均容忍） */
    private static Map<String, byte[]> parseKeysJson(String json) {
        try {
            JSONArray keys = new JSONObject(json.replace('\'', '"')).optJSONArray("keys");
            if (keys == null || keys.length() == 0) {
                return null;
            }
            Map<String, byte[]> out = new java.util.LinkedHashMap<>();
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
                out.put(toHex(kidBytes), keyBytes);
            }
            return out.isEmpty() ? null : out;
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

    private static String toHex(byte[] bytes) {
        return KodipropParser.toHex(bytes);
    }
}
