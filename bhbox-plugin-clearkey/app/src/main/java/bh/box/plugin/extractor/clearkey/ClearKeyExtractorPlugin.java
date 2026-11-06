package bh.box.plugin.extractor.clearkey;

import android.text.TextUtils;

import com.github.catvod.exception.AppException;
import com.github.catvod.plugin.IExtractorPlugin;
import com.github.catvod.plugin.bean.UrlBean;
import com.github.catvod.utils.LOG;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * ClearKey 本地解密代理（IExtractorPlugin）。
 * <p>
 * 目标：让所有播放器内核（IJK/MPV/EXO/系统）都能播 ClearKey 加密的
 * <b>unfragmented CENC MP4</b>（如红果短剧源）。
 * <p>
 * 工作方式：
 * <ol>
 *   <li>{@link #canPlay} 命中带 {@code #KODIPROP:inputstream.adaptive.license_type=clearkey}
 *       且 license_key 为内联 keys JSON 的 URL（宿主 applyDrmKodiprop 或写源自行拼接）；</li>
 *   <li>{@link #getUrl} 先 Range 探测容器：fragmented MP4（fMP4/DASH）不拦截、原样返回
 *       （EXO 原生 DRM session 路径继续工作）；unfragmented 则启动「下载→CENC 解密→明文
 *       缓存文件」后台任务，立即返回 {@code http://127.0.0.1:port/ck/<id>} 代理地址；</li>
 *   <li>任意播放器请求代理地址时，若解密未完成则挂起等待，完成后按 Range 提供明文数据。</li>
 * </ol>
 * Widevine/PlayReady 无法经此代理（密钥不出 CDM），此类 URL 不会被本插件命中。
 */
public class ClearKeyExtractorPlugin implements IExtractorPlugin {

    public static final String ID = "bh.box.plugin.extractor.clearkey";

    private static final String TAG = "ClearKeyProxy";
    private static final int MAX_ENTRIES = 3;
    private static final int PROBE_MAX_BYTES = 2 * 1024 * 1024;
    private static final int PROBE_CHUNK = 256 * 1024;
    private static final String DEFAULT_UA =
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

    private final ConcurrentHashMap<String, ClearKeyEntry> entries = new ConcurrentHashMap<>();
    /** 访问顺序表，用于 LRU 淘汰 */
    private final Map<String, Long> lru = Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true));
    private RangeServer server;

    @Override
    public void install() {
    }

    @Override
    public void init() {
    }

    @Override
    public void uninstall() {
        stop(true);
    }

    @Override
    public boolean canPlay(String url) {
        if (TextUtils.isEmpty(url) || !url.contains(KodipropParser.PROP_MARKER)) return false;
        KodipropParser parsed = KodipropParser.parse(url);
        if (parsed == null) return false;
        String type = parsed.props.get("license_type");
        String key = parsed.props.get("license_key");
        return "clearkey".equalsIgnoreCase(TextUtils.isEmpty(type) ? "" : type.trim())
                && KodipropParser.isKeysJson(key);
    }

    @Override
    public boolean canParse(String url) {
        // KODIPROP 由宿主 applyDrmKodiprop 在 playerContent 结果上拼接，详情页阶段不存在
        return false;
    }

    @Override
    public UrlBean parse(UrlBean urls) {
        return null;
    }

    @Override
    public String getUrl(String url) throws AppException {
        KodipropParser parsed = KodipropParser.parse(url);
        if (parsed == null) return url;
        Map<String, byte[]> keys = KodipropParser.parseClearKeys(parsed.props.get("license_key"));
        if (keys == null) {
            LOG.e(TAG, "keys JSON 无有效密钥，降级原样返回（EXO 原生路径处理）");
            return url;
        }
        try {
            String id = entryId(parsed.cleanUrl, parsed.props.get("license_key"));
            ClearKeyEntry existing = entries.get(id);
            if (existing != null && existing.status() != ClearKeyEntry.STATUS_FAILED) {
                touch(id); // READY 或下载/解密进行中：直接复用
                return proxyUrl(id);
            }
            if (existing != null) {
                entries.remove(id); // 上次失败：清理后重建任务
                existing.deleteFiles();
            }
            int container = probeContainer(parsed.cleanUrl, downloadHeaders(parsed));
            if (container != CencDecryptor.PROBE_UNFRAGMENTED) {
                LOG.i(TAG, "非 unfragmented CENC 容器（probe=" + container + "），不拦截，交由 EXO 原生处理");
                return url;
            }
            File cacheDir = cacheDir();
            ClearKeyEntry entry = new ClearKeyEntry(id, parsed.cleanUrl, keys, downloadHeaders(parsed),
                    new File(cacheDir, id + ".mp4"));
            ClearKeyEntry raced = entries.putIfAbsent(id, entry);
            if (raced != null) {
                entry = raced;
            } else {
                evict();
                entry.launch();
            }
            return proxyUrl(id);
        } catch (Exception e) {
            // 任何异常都不阻断播放：降级原样返回（EXO 可继续走原生 KODIPROP 路径）
            LOG.e(TAG, "代理启动失败，降级原样返回: " + e.getMessage());
            return url;
        }
    }

    @Override
    public void stop(boolean isExit) {
        if (isExit) {
            for (ClearKeyEntry entry : entries.values()) entry.deleteFiles();
            entries.clear();
            lru.clear();
            if (server != null) server.close();
            LOG.i(TAG, "代理已停止并清理缓存");
        } else {
            // 切集/退出播放：仅取消未完成任务，已就绪文件保留（回看/重播免重复下载）
            for (ClearKeyEntry entry : entries.values()) {
                if (entry.status() != ClearKeyEntry.STATUS_READY) entry.cancel();
            }
        }
    }

    // ---------------- 内部 ----------------

    private String proxyUrl(String id) throws IOException {
        if (server == null) {
            synchronized (this) {
                if (server == null) {
                    server = new RangeServer(entries);
                }
            }
        }
        int port = server.start();
        return "http://127.0.0.1:" + port + "/ck/" + id;
    }

    /** 播放 headers：common → stream → license 依次覆盖（与 EXO 插件合并顺序一致） */
    private Map<String, String> downloadHeaders(KodipropParser parsed) {
        Map<String, String> headers = KodipropParser.parseJsonHeaders(parsed.props.get("common_headers"));
        headers.putAll(KodipropParser.parseJsonHeaders(parsed.props.get("stream_headers")));
        headers.putAll(KodipropParser.parseJsonHeaders(parsed.props.get("license_headers")));
        boolean hasUa = false;
        for (String name : headers.keySet()) {
            if ("User-Agent".equalsIgnoreCase(name)) hasUa = true;
        }
        if (!hasUa) headers.put("User-Agent", DEFAULT_UA);
        return headers;
    }

    /**
     * Range 探测容器类型：从头部逐段追加读取，直到 moov 可判定或达上限。
     * 服务器不支持 Range（返回 200）时按已读数据尽力判定，判定不了则 UNKNOWN（降级原样返回）。
     */
    private int probeContainer(String cleanUrl, Map<String, String> headers) {
        HttpURLConnection conn = null;
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream(PROBE_CHUNK * 2);
            long fetched = 0;
            boolean serverIgnoredRange = false;
            while (fetched < PROBE_MAX_BYTES) {
                long to = Math.min(fetched + PROBE_CHUNK, PROBE_MAX_BYTES) - 1;
                conn = (HttpURLConnection) new URL(cleanUrl).openConnection();
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(10_000);
                conn.setRequestMethod("GET");
                if (!serverIgnoredRange) conn.setRequestProperty("Range", "bytes=" + fetched + "-" + to);
                if (headers != null) {
                    for (Map.Entry<String, String> h : headers.entrySet()) {
                        if (!TextUtils.isEmpty(h.getKey()) && !TextUtils.isEmpty(h.getValue())) {
                            conn.setRequestProperty(h.getKey(), h.getValue());
                        }
                    }
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    LOG.e(TAG, "probe HTTP " + code);
                    return CencDecryptor.PROBE_UNKNOWN;
                }
                if (code == 200 && fetched > 0) {
                    // 服务器不支持 Range：只能用已读到的数据尽力判定
                    serverIgnoredRange = true;
                }
                InputStream in = conn.getInputStream();
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0 && buf.size() < PROBE_MAX_BYTES) buf.write(buffer, 0, n);
                in.close();
                conn.disconnect();
                conn = null;
                int result = CencDecryptor.probe(buf.toByteArray());
                if (result != CencDecryptor.PROBE_UNKNOWN) return result;
                if (serverIgnoredRange) break;
                if (buf.size() <= fetched) break; // 无新数据，防死循环
                fetched = buf.size();
            }
            return CencDecryptor.PROBE_UNKNOWN;
        } catch (Exception e) {
            LOG.e(TAG, "probe 异常: " + e.getMessage());
            return CencDecryptor.PROBE_UNKNOWN;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String entryId(String cleanUrl, String keysJson) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest((cleanUrl + "|" + keysJson).getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", digest[i]));
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf((cleanUrl + "|" + keysJson).hashCode());
        }
    }

    private void touch(String id) {
        synchronized (lru) {
            lru.put(id, System.currentTimeMillis());
        }
    }

    /** LRU 淘汰：超过上限时删除最旧的条目（跳过下载中的） */
    private void evict() {
        synchronized (lru) {
            while (entries.size() > MAX_ENTRIES) {
                String oldest = null;
                long oldestTime = Long.MAX_VALUE;
                for (Map.Entry<String, Long> e : lru.entrySet()) {
                    ClearKeyEntry entry = entries.get(e.getKey());
                    if (entry == null) continue;
                    if (entry.status() == ClearKeyEntry.STATUS_DOWNLOADING
                            || entry.status() == ClearKeyEntry.STATUS_STREAMING) continue;
                    if (e.getValue() < oldestTime) {
                        oldestTime = e.getValue();
                        oldest = e.getKey();
                    }
                }
                if (oldest == null) break; // 全部进行中，不再淘汰
                ClearKeyEntry removed = entries.remove(oldest);
                lru.remove(oldest);
                if (removed != null) removed.deleteFiles();
                Iterator<String> it = lru.keySet().iterator();
                while (it.hasNext()) {
                    if (entries.get(it.next()) == null) it.remove();
                }
            }
        }
    }

    private static File cacheDir() {
        File dir = new File(com.github.catvod.Init.context().getCacheDir(), "clearkey");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }
}
