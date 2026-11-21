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
 *       {@code drm}={@code {type, key, header, forceKey}}——type 映射 scheme（widevine/clearkey/
 *       playready），key 三形态：keys JSON（ClearKey 静态密钥）、http URL（License Server）、
 *       b64:/裸 base64（PSSH 数据），header=流请求头。也可只含 drm 对象（无 url 字段时取 u）。</li>
 * </ul>
 * <p>
 * 解析产物分流（由 {@link ExoMediaSourceHelper} 执行）：
 * <ul>
 *   <li>ClearKey 静态密钥（keys JSON 或 hex/b64 单密钥）→ extractor 层 {@code setMp4ClearKeys}
 *       软件解密（fork UnfragCencDecryptor 对单密钥放宽为直接使用首密钥，kid 缺失用全零占位）；</li>
 *   <li>License Server（key=http URL）/ PSSH 数据（b64:）→ KODIPROP 后缀 URL 委托
 *       {@link KodiProps}→{@code buildDrmPlan} 既有链路（MediaDrm 会话，Dash/Hls 工厂消费）；</li>
 *   <li>无密钥 → 明文直链。</li>
 * </ul>
 */
final class DrmPayload {

    private static final String TAG = "DrmPayload";
    static final String SCHEME = "drm://";

    /** 载荷默认 UA：番茄小说/红果短剧 App UA（该 CDN 校验 UA，浏览器 UA 会 403） */
    static final String DEFAULT_UA =
            "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";

    /** scheme 映射结果：clearkey 静态密钥（extractor 层直解） */
    static final int MODE_CLEARKEY = 1;
    /** license server / PSSH 数据（KODIPROP 委托 MediaDrm 会话链路） */
    static final int MODE_KODIPROP = 2;
    /** 无密钥（明文直链） */
    static final int MODE_PLAIN = 3;

    /** 视频直链（必填） */
    final String url;
    /** 处置模式（MODE_*） */
    final int mode;
    /** license_type（KODIPROP 委托时使用，如 com.widevine.alpha / clearkey）；简式恒 clearkey */
    final String licenseType;
    /** license_key 原文（KODIPROP 委托时使用：License URL / b64: PSSH / keys JSON） */
    final String licenseKey;
    /** pssh 数据（FongMi drm.pssh 显式提供时非空；KODIPROP 委托时以 pssh= 键追加） */
    final byte[] pssh;
    /** extractor 层密钥对（kid,key 交替，各 16 字节）；MODE_CLEARKEY 时非空 */
    final byte[][] mp4ClearKeys;
    /** 载荷自带 headers（UA/Referer 等），空表表示用默认 */
    final Map<String, String> headers;
    /** 原始载荷（日志与 clearkey 插件转译用） */
    final String raw;

    private DrmPayload(String url, int mode, String licenseType, String licenseKey,
                       byte[] pssh, byte[][] mp4ClearKeys, Map<String, String> headers, String raw) {
        this.url = url;
        this.mode = mode;
        this.licenseType = licenseType;
        this.licenseKey = licenseKey;
        this.pssh = pssh;
        this.mp4ClearKeys = mp4ClearKeys;
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
        // 形态四：drm://<type>?u=..&lic=..&h=.. 查询参数式（License Server 场景）
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
            // 直链：FongMi 式 url 字段优先，回落简式 u（两家族字段并存时取先命中者）
            String mediaUrl = firstNonEmpty(obj.optString("url", ""), obj.optString("u", "")).trim();
            if (TextUtils.isEmpty(mediaUrl) || !(mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://"))) {
                LOG.e(TAG, "载荷缺有效 url/u 直链，忽略: " + json);
                return null;
            }
            Map<String, String> headers = parseHeaders(firstNonEmpty(obj.optString("h", ""), obj.optString("header", "")));
            // e 为预留字段（加密模式标记），当前生态恒为 0；非 0 仅记日志不改行为
            int e = obj.optInt("e", 0);
            if (e != 0) {
                LOG.i(TAG + " 载荷 e=" + e + "（非 0，预留字段，暂不区分处理）");
            }
            // FongMi 原生 drm 对象优先，回落简式 k
            JSONObject drmObj = obj.optJSONObject("drm");
            DrmPayload payload;
            if (drmObj != null) {
                payload = buildFromFongMi(mediaUrl, drmObj, headers, json);
            } else {
                payload = buildFromSimple(mediaUrl, obj.optString("k", "").trim(), headers, json);
            }
            if (payload != null) {
                LOG.i(TAG + " drm:// 载荷解析成功 mode=" + payload.mode + " u=" + payload.url
                        + (payload.mp4ClearKeys != null ? " keys=" + payload.mp4ClearKeys.length / 2 : "")
                        + (payload.licenseKey != null ? " lic=" + abbreviate(payload.licenseKey) : ""));
            }
            return payload;
        } catch (Exception e) {
            LOG.e(TAG, "载荷 JSON 解析失败: " + e.getMessage());
            return null;
        }
    }

    /**
     * 查询参数式：drm://widevine?u=&lt;直链&gt;&lic=&lt;license URL&gt;&h=&lt;headers JSON&gt;。
     * type 可 widevine/clearkey/playready（或完整 UUID 小写）；lic 缺省按 PSSH 数据模式（KODIPROP 委托）。
     */
    private static DrmPayload parseQueryForm(String body) {
        int q = body.indexOf('?');
        if (q < 0) {
            return null;
        }
        String head = body.substring(0, q).trim();
        if (head.isEmpty() || "json".equalsIgnoreCase(head)) {
            return null; // json 形态由 extractJson 处理
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
        // lic 为 http URL → KODIPROP 委托；为 hex/b64/keys JSON → clearkey extractor 直解
        if (!TextUtils.isEmpty(lic) && (lic.startsWith("http://") || lic.startsWith("https://"))) {
            return new DrmPayload(u, MODE_KODIPROP, type, lic, null, null, headers, body);
        }
        byte[][] keys = parseKey(lic);
        if (keys != null) {
            return new DrmPayload(u, MODE_CLEARKEY, "clearkey", lic, null, keys, headers, body);
        }
        // 无 lic 或不可解析：widevine 走 PSSH 数据模式（manifest 自带 pssh）委托；clearkey 按明文
        if ("com.widevine.alpha".equals(type)) {
            return new DrmPayload(u, MODE_KODIPROP, type, null, null, null, headers, body);
        }
        LOG.i(TAG + " drm://" + head + "? 载荷无有效密钥，按明文播放");
        return new DrmPayload(u, MODE_PLAIN, type, null, null, null, headers, body);
    }

    /** FongMi 原生 drm 对象 → 分流构建 */
    private static DrmPayload buildFromFongMi(String mediaUrl, JSONObject drmObj,
                                              Map<String, String> headers, String raw) {
        String type = mapSchemeType(drmObj.optString("type", "").trim());
        String key = drmObj.optString("key", "").trim();
        // drm.pssh 显式数据（forceKey 跳过 manifest PSSH 查找的语义）
        byte[] pssh = parsePssh(drmObj.optString("pssh", ""));
        // 无 type 视为无 DRM（FongMi 语义：Drm bean 只在有 drm 字段时存在，type 必填）
        if (type == null || (TextUtils.isEmpty(key) && pssh == null)) {
            LOG.i(TAG + " drm 对象 type 缺失或无 key/pssh，按明文播放");
            return new DrmPayload(mediaUrl, MODE_PLAIN, null, null, pssh, null, headers, raw);
        }
        // key 形态分流：http URL → KODIPROP 委托（MediaDrm 会话）
        if (key.startsWith("http://") || key.startsWith("https://")) {
            return new DrmPayload(mediaUrl, MODE_KODIPROP, type, key, pssh, null, headers, raw);
        }
        // keys JSON / hex / base64 密钥 → clearkey extractor 直解（type 非 clearkey 的 hex/b64
        // 密钥无 MediaDrm 意义，按 clearkey 处理）
        byte[][] mp4Keys = parseKey(key);
        if (mp4Keys != null) {
            return new DrmPayload(mediaUrl, MODE_CLEARKEY, type, key, pssh, mp4Keys, headers, raw);
        }
        // b64:/裸 base64 且非 16 字节密钥 → PSSH 数据模式，KODIPROP 委托
        if (key.startsWith("b64:") || looksLikeBase64(key)) {
            byte[] psshData = key.startsWith("b64:") ? parsePssh(key.substring(4)) : parsePssh(key);
            if (psshData != null) {
                return new DrmPayload(mediaUrl, MODE_KODIPROP, type, key, psshData, null, headers, raw);
            }
        }
        LOG.e(TAG, "drm.key 形态无法识别（非 URL/keys JSON/密钥/PSSH），按明文播放: " + abbreviate(key));
        return new DrmPayload(mediaUrl, MODE_PLAIN, type, key, pssh, null, headers, raw);
    }

    /** 简式 k 密钥 → 分流构建（k 为 keys JSON/hex/b64 密钥，全部按 clearkey 直解） */
    private static DrmPayload buildFromSimple(String mediaUrl, String k,
                                              Map<String, String> headers, String raw) {
        byte[][] keys = parseKey(k);
        if (keys != null) {
            return new DrmPayload(mediaUrl, MODE_CLEARKEY, "clearkey", k, null, keys, headers, raw);
        }
        if (!TextUtils.isEmpty(k)) {
            LOG.e(TAG, "载荷 k 密钥无法解析（hex/base64url/keys JSON 均不匹配），按明文播放");
        }
        return new DrmPayload(mediaUrl, MODE_PLAIN, "clearkey", null, null, null, headers, raw);
    }

    /** scheme 短名/全名/UUID → KODIPROP license_type 规范值；未识别返回 null */
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

    /** KODIPROP 后缀 URL（MODE_KODIPROP 委托用）：license_type/license_key/pssh/stream_headers */
    String toKodipropUrl() {
        StringBuilder sb = new StringBuilder(url);
        if (!TextUtils.isEmpty(licenseType)) {
            sb.append("#KODIPROP:inputstream.adaptive.license_type=").append(licenseType);
        }
        if (!TextUtils.isEmpty(licenseKey)) {
            sb.append("#KODIPROP:inputstream.adaptive.license_key=").append(android.net.Uri.encode(licenseKey));
        }
        if (pssh != null) {
            sb.append("#KODIPROP:inputstream.adaptive.pssh=")
                    .append(android.net.Uri.encode(Base64.encodeToString(pssh, Base64.NO_WRAP)));
        }
        if (!headers.isEmpty()) {
            sb.append("#KODIPROP:inputstream.adaptive.stream_headers=")
                    .append(android.net.Uri.encode(new JSONObject(headers).toString()));
        }
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

    /** 日志缩略：超 60 字符截断 */
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
        // FongMi header 是 JSON 对象字面量，简式 h 可能是字符串化的 JSON
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
            return null; // License URL，非 PSSH 数据
        }
        byte[] decoded = tryBase64(data);
        if (decoded == null || decoded.length < 32) {
            return null; // PSSH box 最短 32 字节（size+type+version+systemID+count）
        }
        return decoded;
    }

    /** 裸 base64 识别（对齐 KodiProps.looksLikeBase64）：字符集受限、4 的倍数、≥16 */
    private static boolean looksLikeBase64(String value) {
        if (value.length() < 16 || value.length() % 4 != 0) {
            return false;
        }
        return value.matches("[A-Za-z0-9+/]+={0,2}");
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
