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
 * drm:// 写源协议载荷解析（红果/番茄短剧 + FongMi 原生 DRM JSON 生态）。
 * <p>
 * URL 形态（四选一）：
 * <pre>
 * drm://eyJ1Ijoi... base64(JSON)                  —— 现网主流（push_agent 推送链路原样透传）
 * drm://json?d=&lt;URL编码的 JSON&gt;                   —— 方案文档约定的查询参数式
 * drm://widevine?u=&amp;lic=&amp;h=                      —— 方案文档约定的 License Server 查询式
 * drm://{"url":"...","drm":{...}}                 —— 裸 JSON（罕见，容忍）
 * </pre>
 * 载荷 JSON 有两大家族（字段并存时 FongMi 式优先）：
 * <ul>
 *   <li><b>简式</b>（红果果[短].js）：{@code u}=视频直链、{@code k}=密钥（32 位 hex /
 *       base64url 16 字节 / keys JSON）、{@code h}=可选 headers、{@code e}=预留（忽略）；</li>
 *   <li><b>FongMi 原生式</b>（Result.drm 全量打包）：{@code url}=视频/manifest 直链、
 *       {@code drm}={@code {type, key, header, forceKey}}——type 映射 scheme，key 三形态：
 *       keys JSON（ClearKey 静态密钥）、http URL（License Server）、b64:/裸 base64（PSSH）。</li>
 * </ul>
 * <p>
 * 与 EXO 插件 bh.box.plugin.exo.DrmPayload 同源实现（插件 APK 隔离加载，互不冲突）。
 * 本插件只接管 ClearKey 静态密钥形态（canPlay 语义）：unfragmented 容器走本地解密代理
 * （全内核可播），fMP4 原样返回交 EXO 原生处理；License/PSSH/明文形态不拦截。
 */
final class DrmPayload {

    private static final String TAG = "ClearKeyProxy";
    static final String SCHEME = "drm://";

    /** 载荷默认 UA：番茄小说/红果短剧 App UA（该 CDN 校验 UA，浏览器 UA 会 403） */
    static final String DEFAULT_UA =
            "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
    /** 载荷默认 Referer：红果视频 CDN 的已验证 Referer（红果果[短].js remoteRange 同款） */
    static final String DEFAULT_REFERER = "https://novel.snssdk.com/";

    /** 处置模式：clearkey 静态密钥（本插件接管）/ license 或 pssh（委托 EXO）/ 明文 */
    static final int MODE_CLEARKEY = 1;
    static final int MODE_KODIPROP = 2;
    static final int MODE_PLAIN = 3;

    /** 视频直链（必填） */
    final String url;
    /** 处置模式（MODE_*） */
    final int mode;
    /** license_type（KODIPROP 委托时使用） */
    final String licenseType;
    /** license_key 原文（KODIPROP 委托时使用） */
    final String licenseKey;
    /** pssh 数据（FongMi drm.pssh 显式提供时非空） */
    final byte[] pssh;
    /** kid(hex 小写) → 16 字节密钥；MODE_CLEARKEY 时非空 */
    final Map<String, byte[]> keys;
    /** 载荷自带 headers（UA/Referer 等），空表表示用默认 */
    final Map<String, String> headers;
    /** 原始载荷（日志用） */
    final String raw;

    private DrmPayload(String url, int mode, String licenseType, String licenseKey,
                       byte[] pssh, Map<String, byte[]> keys, Map<String, String> headers, String raw) {
        this.url = url;
        this.mode = mode;
        this.licenseType = licenseType;
        this.licenseKey = licenseKey;
        this.pssh = pssh;
        this.keys = keys;
        this.headers = headers;
        this.raw = raw;
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
        // 形态四：drm://<type>?u=..&lic=..&h=.. 查询参数式
        DrmPayload query = parseQueryForm(body);
        if (query != null) {
            return query;
        }
        String json = extractJson(body);
        if (TextUtils.isEmpty(json)) {
            return null;
        }
        try {
            JSONObject obj = new JSONObject(json);
            String mediaUrl = firstNonEmpty(obj.optString("url", ""), obj.optString("u", "")).trim();
            if (TextUtils.isEmpty(mediaUrl) || !(mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://"))) {
                LOG.e(TAG, "载荷缺有效 url/u 直链，忽略: " + json);
                return null;
            }
            Map<String, String> headers = parseHeaders(firstNonEmpty(obj.optString("h", ""), obj.optString("header", "")));
            int e = obj.optInt("e", 0);
            if (e != 0) {
                LOG.i(TAG + " 载荷 e=" + e + "（非 0，预留字段，暂不区分处理）");
            }
            JSONObject drmObj = obj.optJSONObject("drm");
            DrmPayload payload;
            if (drmObj != null) {
                payload = buildFromFongMi(mediaUrl, drmObj, headers, json);
            } else {
                payload = buildFromSimple(mediaUrl, obj.optString("k", "").trim(), headers, json);
            }
            if (payload != null) {
                LOG.i(TAG + " drm:// 载荷解析成功 mode=" + payload.mode + " u=" + payload.url
                        + (payload.keys != null ? " keys=" + payload.keys.size() : ""));
            }
            return payload;
        } catch (Exception e) {
            LOG.e(TAG, "载荷 JSON 解析失败: " + e.getMessage());
            return null;
        }
    }

    /** 查询参数式：drm://widevine?u=&lic=&h= */
    private static DrmPayload parseQueryForm(String body) {
        int q = body.indexOf('?');
        if (q < 0) {
            return null;
        }
        String head = body.substring(0, q).trim();
        if (head.isEmpty() || "json".equalsIgnoreCase(head)) {
            return null;
        }
        Map<String, String> params = parseQuery(body.substring(q + 1));
        if (params.isEmpty()) {
            return null;
        }
        String u = params.get("u");
        if (TextUtils.isEmpty(u) || !(u.startsWith("http://") || u.startsWith("https://"))) {
            LOG.e(TAG, "drm://" + head + "? 形态缺有效 u 参数");
            return null;
        }
        String lic = params.get("lic");
        String type = mapSchemeType(head);
        if (type == null) {
            LOG.e(TAG, "drm://" + head + "? 未识别的 scheme，忽略");
            return null;
        }
        Map<String, String> headers = parseHeaders(params.get("h"));
        if (!TextUtils.isEmpty(lic) && (lic.startsWith("http://") || lic.startsWith("https://"))) {
            return new DrmPayload(u, MODE_KODIPROP, type, lic, null, null, headers, body);
        }
        Map<String, byte[]> keys = parseKey(lic);
        if (keys != null) {
            return new DrmPayload(u, MODE_CLEARKEY, "clearkey", lic, null, keys, headers, body);
        }
        if ("com.widevine.alpha".equals(type)) {
            return new DrmPayload(u, MODE_KODIPROP, type, null, null, null, headers, body);
        }
        LOG.i(TAG + " drm://" + head + "? 载荷无有效密钥，按明文处理");
        return new DrmPayload(u, MODE_PLAIN, type, null, null, null, headers, body);
    }

    /** FongMi 原生 drm 对象 → 分流构建 */
    private static DrmPayload buildFromFongMi(String mediaUrl, JSONObject drmObj,
                                              Map<String, String> headers, String raw) {
        String type = mapSchemeType(drmObj.optString("type", "").trim());
        String key = drmObj.optString("key", "").trim();
        byte[] pssh = parsePssh(drmObj.optString("pssh", ""));
        if (type == null || (TextUtils.isEmpty(key) && pssh == null)) {
            LOG.i(TAG + " drm 对象 type 缺失或无 key/pssh，按明文处理");
            return new DrmPayload(mediaUrl, MODE_PLAIN, null, null, pssh, null, headers, raw);
        }
        if (key.startsWith("http://") || key.startsWith("https://")) {
            return new DrmPayload(mediaUrl, MODE_KODIPROP, type, key, pssh, null, headers, raw);
        }
        Map<String, byte[]> keys = parseKey(key);
        if (keys != null) {
            return new DrmPayload(mediaUrl, MODE_CLEARKEY, type, key, pssh, keys, headers, raw);
        }
        if (key.startsWith("b64:") || looksLikeBase64(key)) {
            byte[] psshData = key.startsWith("b64:") ? parsePssh(key.substring(4)) : parsePssh(key);
            if (psshData != null) {
                return new DrmPayload(mediaUrl, MODE_KODIPROP, type, key, psshData, null, headers, raw);
            }
        }
        LOG.e(TAG, "drm.key 形态无法识别，按明文处理: " + abbreviate(key));
        return new DrmPayload(mediaUrl, MODE_PLAIN, type, key, pssh, null, headers, raw);
    }

    /** 简式 k 密钥 → 分流构建 */
    private static DrmPayload buildFromSimple(String mediaUrl, String k,
                                              Map<String, String> headers, String raw) {
        Map<String, byte[]> keys = parseKey(k);
        if (keys != null) {
            return new DrmPayload(mediaUrl, MODE_CLEARKEY, "clearkey", k, null, keys, headers, raw);
        }
        if (!TextUtils.isEmpty(k)) {
            LOG.e(TAG, "载荷 k 密钥无法解析（hex/base64url/keys JSON 均不匹配），按明文处理");
        }
        return new DrmPayload(mediaUrl, MODE_PLAIN, "clearkey", null, null, null, headers, raw);
    }

    /** scheme 短名/全名 → KODIPROP license_type 规范值；未识别返回 null */
    private static String mapSchemeType(String type) {
        if (TextUtils.isEmpty(type)) {
            return null;
        }
        String low = type.toLowerCase();
        if (low.contains("clearkey")) return "clearkey";
        if (low.contains("widevine")) return "com.widevine.alpha";
        if (low.contains("playready")) return "com.microsoft.playready";
        return null;
    }

    /**
     * 转译为 KODIPROP URL（仅 clearkey 静态密钥形态，与宿主 applyDrmKodiprop / EXO KodiProps
     * 语义兼容）：url 作 cleanUrl；单密钥以全零 kid + keys JSON 内联（解密器对单密钥放宽为
     * 直接使用）；headers 以 stream_headers 承载。
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

    /** keys 表 → 内联 keys JSON（kid hex → b64url；k=b64url） */
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
        if (body.startsWith("{")) {
            return body;
        }
        int q = body.indexOf('?');
        String head = q < 0 ? body : body.substring(0, q);
        if ("json".equalsIgnoreCase(head) && q >= 0) {
            String query = body.substring(q + 1);
            if (query.startsWith("d=")) {
                return decodeComponent(query.substring(2));
            }
            LOG.e(TAG, "drm://json 形态缺 d 参数: " + body);
            return null;
        }
        byte[] decoded = tryBase64(body);
        if (decoded == null) {
            LOG.e(TAG, "drm:// 载荷既非 JSON 也非 base64: " + body);
            return null;
        }
        return new String(decoded);
    }

    /** a=1&b=2 查询串解析（URL decode） */
    private static Map<String, String> parseQuery(String query) {
        Map<String, String> out = new HashMap<>();
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            out.put(decodeComponent(pair.substring(0, eq)).trim(),
                    decodeComponent(pair.substring(eq + 1)).trim());
        }
        return out;
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

    private static String firstNonEmpty(String a, String b) {
        return !TextUtils.isEmpty(a) ? a : (b == null ? "" : b);
    }

    private static String abbreviate(String value) {
        if (value == null || value.length() <= 60) return value;
        return value.substring(0, 60) + "…(" + value.length() + ")";
    }

    /** 载荷 headers 字段（headers JSON）→ 键值表；空/失败返回空表 */
    private static Map<String, String> parseHeaders(String json) {
        Map<String, String> out = new HashMap<>();
        if (TextUtils.isEmpty(json)) {
            return out;
        }
        String body = json.trim();
        if (body.startsWith("{")) {
            try {
                JSONObject obj = new JSONObject(body.replace('\'', '"'));
                Iterator<String> it = obj.keys();
                while (it.hasNext()) {
                    String key = it.next();
                    String value = obj.optString(key, null);
                    if (!TextUtils.isEmpty(key) && !TextUtils.isEmpty(value)) {
                        out.put(key.trim(), value.trim());
                    }
                }
            } catch (Exception e) {
                LOG.e(TAG, "载荷 headers 解析失败，忽略: " + abbreviate(json));
            }
        }
        return out;
    }

    /** PSSH base64 解析：b64: 前缀剥离 + 标准/URL-safe 容忍；失败返回 null */
    private static byte[] parsePssh(String value) {
        if (TextUtils.isEmpty(value)) {
            return null;
        }
        String data = value.startsWith("b64:") ? value.substring(4) : value;
        if (data.startsWith("http://") || data.startsWith("https://")) {
            return null;
        }
        byte[] decoded = tryBase64(data);
        if (decoded == null || decoded.length < 32) {
            return null;
        }
        return decoded;
    }

    /** 裸 base64 识别（对齐 KodipropParser 宽容规则）：字符集受限、4 的倍数、≥16 */
    private static boolean looksLikeBase64(String value) {
        if (value.length() < 16 || value.length() % 4 != 0) {
            return false;
        }
        return value.matches("[A-Za-z0-9+/]+={0,2}");
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
        if (k.startsWith("{")) {
            return parseKeysJson(k);
        }
        if (isHex16(k)) {
            byte[] key = hexToBytes(k);
            if (key != null) {
                Map<String, byte[]> out = new HashMap<>();
                out.put(toHex(new byte[16]), key);
                return out;
            }
        }
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
