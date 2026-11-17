package bh.box.plugin.exo;

import android.content.Context;
import android.net.Uri;
import android.text.TextUtils;
import android.util.Base64;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.Util;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.datasource.rtmp.RtmpDataSource;
import androidx.media3.exoplayer.dash.DashMediaSource;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.rtsp.RtspMediaSource;
import androidx.media3.exoplayer.smoothstreaming.SsMediaSource;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.TsExtractor;

import com.github.catvod.net.OkHttp;
import com.bytevc2.exoplayer.ByteVc2ExtractorsFactory;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;
import com.google.common.net.HttpHeaders;

import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

@OptIn(markerClass = UnstableApi.class)
public final class ExoMediaSourceHelper {

    private static volatile ExoMediaSourceHelper sInstance;

    private final Context mAppContext;
    private final String mUserAgent;
    private Cache mCache;

    private ExoMediaSourceHelper(Context context) {
        mAppContext = context.getApplicationContext();
        mUserAgent = Util.getUserAgent(mAppContext, mAppContext.getApplicationInfo().name);
    }

    public static ExoMediaSourceHelper getInstance(Context context) {
        if (sInstance == null) {
            synchronized (ExoMediaSourceHelper.class) {
                if (sInstance == null) {
                    sInstance = new ExoMediaSourceHelper(context);
                }
            }
        }
        return sInstance;
    }

    public MediaSource getMediaSource(String uri, Map<String, String> headers, boolean isCache, int errorCode) {
        // KODIPROP（DRM 写源协议）解析：剥离后缀取干净 URL，无后缀时与旧版行为完全一致
        KodiProps kodi = KodiProps.parse(uri);
        String cleanUri = kodi == null ? uri : kodi.cleanUrl;
        Uri contentUri = Uri.parse(cleanUri);
        // scheme 必须 equalsIgnoreCase：Uri.getScheme() 保留原始大小写（"RTSP://" 拿到的是 "RTSP"）。
        // rtspt(RTSP over TLS) 也要认 —— 它是真实存在的 scheme，只判 rtsp 会漏。
        String scheme = contentUri.getScheme();
        if ("rtmp".equalsIgnoreCase(scheme)) {
            return new ProgressiveMediaSource.Factory(new RtmpDataSource.Factory())
                    .createMediaSource(MediaItem.fromUri(contentUri));
        } else if ("rtsp".equalsIgnoreCase(scheme) || "rtspt".equalsIgnoreCase(scheme)) {
            return new RtspMediaSource.Factory().createMediaSource(MediaItem.fromUri(contentUri));
        }
        Map<String, String> requestHeaders = toRequestHeaders(headers);
        int contentType = resolveContentType(cleanUri, kodi);
        // 每个 MediaSource 一套独立 factory：旧实现复用全局 factory + setHeaders()，
        // 后建源会把先建源的请求头覆盖掉（切线路/多线路探测时串头）。
        DataSource.Factory factory = createDataSourceFactory(requestHeaders);
        // DRM 计划：KODIPROP 带 license_type 时构建（未识别 type 时 plan 为 null，按无 DRM 播放）
        DrmPlan drmPlan = kodi == null ? null : buildDrmPlan(kodi);
        // DRM 内容强制不走边播缓存：加密分片落盘无意义且有密钥泄漏面
        boolean useCache = isCache && drmPlan == null;
        if (useCache) {
            factory = getCacheDataSourceFactory(factory, requestHeaders);
        }
        MediaItem mediaItem = drmPlan == null ? MediaItem.fromUri(contentUri) : drmPlan.mediaItem;
        if (errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED) {
            MediaItem.Builder builder = new MediaItem.Builder().setUri(Uri.parse(cleanUri.trim().replace("\\", "")));
            builder.setMimeType(MimeTypes.APPLICATION_M3U8);
            DefaultMediaSourceFactory fallbackFactory =
                    new DefaultMediaSourceFactory(createDataSourceFactory(requestHeaders), getExtractorsFactory());
            if (drmPlan != null) {
                fallbackFactory.setDrmSessionManagerProvider(drmPlan.provider);
            }
            return fallbackFactory.createMediaSource(builder.build());
        }
        switch (contentType) {
            case C.CONTENT_TYPE_SS:
                return applyDrm(new SsMediaSource.Factory(factory), drmPlan).createMediaSource(mediaItem);
            // 兜底：Util.inferContentType 对 rtsp/rtspt 返回该值。上面的 scheme 判断已覆盖，
            // 但保留这一支以防将来有人改了入口判断却没同步这里（RTSP 走了 Progressive 会直接起播失败）。
            case C.CONTENT_TYPE_RTSP:
                return new RtspMediaSource.Factory().createMediaSource(MediaItem.fromUri(contentUri));
            case C.CONTENT_TYPE_DASH:
                return applyDrm(new DashMediaSource.Factory(factory), drmPlan).createMediaSource(mediaItem);
            case C.CONTENT_TYPE_HLS:
                return applyDrm(new HlsMediaSource.Factory(factory)
                        .setLoadErrorHandlingPolicy(new HlsErrorHandlingPolicy()), drmPlan)
                        .createMediaSource(mediaItem);
            case C.CONTENT_TYPE_OTHER:
            default:
                // unfragmented CENC：把 ClearKey 密钥透传给 Mp4Extractor，在 extractor 层解密后按明文输出
                // ClearKey 分支保持纯 DefaultExtractorsFactory：ByteVc2ExtractorsFactory 不转发
                // setMp4ClearKeys，且 CENC 明文 MP4 也不需要 bytevc2 demux。
                ProgressiveMediaSource.Factory progressiveFactory =
                        drmPlan != null && drmPlan.mp4ClearKeys != null
                                ? new ProgressiveMediaSource.Factory(factory,
                                        getExtractorsFactory().setMp4ClearKeys(drmPlan.mp4ClearKeys))
                                : new ProgressiveMediaSource.Factory(factory,
                                        new ByteVc2ExtractorsFactory());
                return applyDrm(progressiveFactory, drmPlan).createMediaSource(mediaItem);
        }
    }

    /** DRM 模式下把会话管理提供者挂到 MediaSource 工厂上 */
    private static <F extends MediaSource.Factory> F applyDrm(F factory, DrmPlan drmPlan) {
        if (drmPlan != null) {
            factory.setDrmSessionManagerProvider(drmPlan.provider);
        }
        return factory;
    }

    /** 容器类型：KODIPROP 的 manifest_type 显式指定时优先，否则回落 URL 关键字推断 */
    private static int resolveContentType(String cleanUri, KodiProps kodi) {
        if (kodi != null) {
            String manifestType = kodi.get("manifest_type");
            if (!TextUtils.isEmpty(manifestType)) {
                String type = manifestType.trim().toLowerCase();
                if (type.contains("mpd") || type.contains("dash")) {
                    return C.CONTENT_TYPE_DASH;
                }
                if (type.contains("m3u8") || type.contains("hls")) {
                    return C.CONTENT_TYPE_HLS;
                }
                LOG.e("ExoMediaSourceHelper", "未识别的 manifest_type: " + manifestType + "，回落 URL 推断");
            }
        }
        return inferContentType(cleanUri);
    }

    /**
     * DRM 方案 UUID 映射（对齐 FongMi Drm.getUUID() 语义）。
     * 未识别的 type 返回 null → 整体按无 DRM 播放（不做硬抛错，避免单源毒死整条线路）。
     */
    private static UUID mapScheme(String licenseType) {
        if (TextUtils.isEmpty(licenseType)) {
            return null;
        }
        switch (licenseType.trim().toLowerCase()) {
            case "widevine":
            case "com.widevine.alpha":
                return C.WIDEVINE_UUID;
            case "clearkey":
            case "org.w3.clearkey":
                return C.CLEARKEY_UUID;
            case "playready":
            case "com.microsoft.playready":
                return C.PLAYREADY_UUID;
            default:
                return null;
        }
    }

    /**
     * 由 KODIPROP 键值构建 DRM 计划（MediaItem + 会话管理提供者）。
     * <p>
     * license_key 三种形态：
     * <ul>
     *   <li>http(s) URL → License Server 模式（DrmConfiguration.licenseUri）；</li>
     *   <li>keys JSON（{"keys":[...]}）→ ClearKey 静态密钥直供（licenseUri 非 http，
     *       由 {@link BhDrmSessionManagerProvider} 转 LocalMediaDrmCallback）；</li>
     *   <li>b64:/裸 base64 → PSSH 数据模式：不设 licenseUri，数据经 pssh 注入补齐 init data。</li>
     * </ul>
     */
    private DrmPlan buildDrmPlan(KodiProps kodi) {
        UUID scheme = mapScheme(kodi.get("license_type"));
        if (scheme == null) {
            LOG.e("ExoMediaSourceHelper", "未识别的 license_type: " + kodi.get("license_type") + "，按无 DRM 播放");
            return null;
        }
        String licenseKey = kodi.get("license_key");
        // license 请求头：common/stream 先并入，license_headers 最后 put 优先级最高
        Map<String, String> licenseHeaders = KodiProps.parseJsonHeaders(kodi.get("common_headers"));
        licenseHeaders.putAll(KodiProps.parseJsonHeaders(kodi.get("stream_headers")));
        licenseHeaders.putAll(KodiProps.parseJsonHeaders(kodi.get("license_headers")));
        MediaItem.DrmConfiguration.Builder drm = new MediaItem.DrmConfiguration.Builder(scheme)
                .setLicenseRequestHeaders(licenseHeaders)
                .setForceSessionsForAudioAndVideoTracks(true);
        if (!TextUtils.isEmpty(licenseKey)) {
            String key = licenseKey.trim();
            if (key.startsWith("http://") || key.startsWith("https://")) {
                drm.setLicenseUri(key);
            } else if (KodiProps.isKeysJson(key)) {
                // 单引号归一后直供 CDM（ClearKeyUtil 只认标准双引号 JSON）
                drm.setLicenseUri(key.replace('\'', '"'));
            }
            // 其余形态（b64:/裸 base64）= PSSH 数据，见 resolvePssh
        }
        byte[] pssh = resolvePssh(kodi);
        if (pssh == null && TextUtils.isEmpty(licenseKey)) {
            LOG.e("ExoMediaSourceHelper", "DRM 配置不完整：license_type=" + kodi.get("license_type")
                    + " 但既无 license_key 也无 pssh，按无 DRM 播放");
            return null;
        }
        // license 请求复用插件 OkHttp 连接池与 UA；流请求头不掺入（流头走 createDataSourceFactory）
        DataSource.Factory drmDataSourceFactory =
                new OkHttpDataSource.Factory(OkHttp.client()).setUserAgent(mUserAgent);
        MediaItem mediaItem = new MediaItem.Builder()
                .setUri(kodi.cleanUrl)
                .setDrmConfiguration(drm.build())
                .build();
        // ClearKey keys JSON：同时产出 extractor 层密钥（unfragmented CENC MP4 直接解密，
        // 无需 MediaDrm 会话；fMP4 场景下 provider 的 session 链路照常生效，互不干扰）
        byte[][] mp4ClearKeys = null;
        if (C.CLEARKEY_UUID.equals(scheme) && !TextUtils.isEmpty(licenseKey)
                && KodiProps.isKeysJson(licenseKey)) {
            mp4ClearKeys = KodiProps.parseClearKeys(licenseKey);
            if (mp4ClearKeys == null) {
                LOG.e("ExoMediaSourceHelper", "ClearKey keys JSON 无有效密钥，extractor 层解密不可用");
            }
        }
        return new DrmPlan(mediaItem,
                new BhDrmSessionManagerProvider(drmDataSourceFactory, pssh, scheme), mp4ClearKeys);
    }

    /** PSSH 数据解析：pssh= 键优先，其次 license_key 的 b64:/裸 base64 形态 */
    private static byte[] resolvePssh(KodiProps kodi) {
        String pssh = kodi.get("pssh");
        if (TextUtils.isEmpty(pssh)) {
            String licenseKey = kodi.get("license_key");
            if (TextUtils.isEmpty(licenseKey) || KodiProps.isKeysJson(licenseKey)) {
                return null;
            }
            String key = licenseKey.trim();
            if (key.startsWith("http://") || key.startsWith("https://")) {
                return null; // License URL，非 PSSH 数据
            }
            if (key.startsWith("b64:")) {
                pssh = key.substring(4);
            } else if (looksLikeBase64(key)) {
                pssh = key;
            } else {
                LOG.e("ExoMediaSourceHelper", "license_key 非 URL/JSON/base64，忽略: " + key);
                return null;
            }
        }
        try {
            return Base64.decode(pssh, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            LOG.e("ExoMediaSourceHelper", "PSSH base64 解码失败: " + pssh);
            return null;
        }
    }

    /** 裸 base64 识别：字符集受限、长度为 4 的倍数且非 http（License URL 已在上游排除） */
    private static boolean looksLikeBase64(String value) {
        if (value.length() < 16 || value.length() % 4 != 0) {
            return false;
        }
        return value.matches("[A-Za-z0-9+/]+={0,2}");
    }

    /** DRM 计划：携带 drmConfiguration 的 MediaItem + 会话管理提供者 + extractor 层 ClearKey */
    private static final class DrmPlan {
        final MediaItem mediaItem;
        final BhDrmSessionManagerProvider provider;
        /** unfragmented CENC 的 extractor 层密钥对（kid/key 交替），非 ClearKey keys JSON 时为 null */
        final byte[][] mp4ClearKeys;

        DrmPlan(MediaItem mediaItem, BhDrmSessionManagerProvider provider, byte[][] mp4ClearKeys) {
            this.mediaItem = mediaItem;
            this.provider = provider;
            this.mp4ClearKeys = mp4ClearKeys;
        }
    }

    private static synchronized DefaultExtractorsFactory getExtractorsFactory() {
        // 注意：libs/ 这套 aar（media3 1.11.0 基线）的 DefaultTsPayloadReaderFactory 只有
        // FLAG_IGNORE_AAC_STREAM / FLAG_IGNORE_H264_STREAM / FLAG_IGNORE_SPLICE_INFO_STREAM /
        // FLAG_OVERRIDE_CAPTION_DESCRIPTORS 四个官方 flag，没有 fork 定制的
        // FLAG_ENABLE_HDMV_DTS_AUDIO_STREAMS。代价：TS 容器里的 HDMV-DTS（蓝光原盘私有流）
        // 音轨不再被解析。要补回来得自己实现 TsPayloadReader.Factory 注入，场景小众，暂未做。
        // 时间戳搜索字节放大 3 倍：部分 TS 直播流前面塞了大量填充/PSI，
        // 按默认的 1 倍搜不到首个时间戳会起播慢或直接失败。
        return new DefaultExtractorsFactory()
                .setTsExtractorTimestampSearchBytes(TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES * 3);
    }

    /**
     * 容器类型推断，优先级：URL 关键字 &gt; media3 的 Util 兜底。
     * <p>
     * 比旧实现（只认 .mpd/.m3u8）多覆盖：{@code type=dash} / {@code format=hls} 这类参数式地址、
     * {@code live.php} 与 {@code /live/} 这类无扩展名的直播地址；
     * 并排除 .mp3/.m4a/.flac 等音频后缀被 {@code /live/} 规则误判成 HLS。
     */
    private static int inferContentType(String uri) {
        String lower = uri == null ? "" : uri.toLowerCase();
        if (lower.contains(".mpd") || lower.contains("type=mpd") || lower.contains("type=dash")
                || lower.contains("format=mpd") || lower.contains("format=dash")) {
            return C.CONTENT_TYPE_DASH;
        }
        if (isHlsUri(lower)) {
            return C.CONTENT_TYPE_HLS;
        }
        // 用原始 uri（不是 lower）：Util 内部比较本身大小写不敏感，没必要传改写过的串
        return Util.inferContentType(Uri.parse(uri));
    }

    private static boolean isHlsUri(String uri) {
        if (isAudioUri(uri)) {
            return false;
        }
        if (uri.contains("m3u8") || uri.contains("type=hls") || uri.contains("format=hls")) {
            return true;
        }
        return false;
    }

    private static boolean isAudioUri(String uri) {
        Uri parsedUri = Uri.parse(uri);
        String path = parsedUri.getPath();
        if (path == null) {
            path = uri;
        }
        path = path.toLowerCase();
        return path.endsWith(".mp3")
                || path.endsWith(".m4a")
                || path.endsWith(".aac")
                || path.endsWith(".flac")
                || path.endsWith(".wav")
                || path.endsWith(".ogg")
                || path.endsWith(".opus")
                || path.endsWith(".amr");
    }

    /**
     * 按 headers 建一套专属 factory（不再复用全局单例），UA 单独走 setUserAgent。
     * OkHttpClient 用宿主注入的 {@code OkHttp.client()} —— 全 App 共用一个连接池，
     * HLS 多分片时比每个源各建一个 client 省连接与 TLS 握手。
     */
    private DataSource.Factory createDataSourceFactory(Map<String, String> headers) {
        return createDataSourceFactory(headers, OkHttp.client());
    }

    /** preloadClient：预读专用短超时（connect 5s / read 10s）——源站故障时快速放弃，避免预读长挂占住同 key 缓存锁拖累起播；播放侧全局 client 不受影响 */
    private volatile OkHttpClient sPreloadClient;

    private OkHttpClient preloadClient() {
        OkHttpClient client = sPreloadClient;
        if (client == null) {
            synchronized (this) {
                if (sPreloadClient == null) {
                    sPreloadClient = OkHttp.client().newBuilder()
                            .connectTimeout(5, TimeUnit.SECONDS)
                            .readTimeout(10, TimeUnit.SECONDS)
                            .build();
                }
                client = sPreloadClient;
            }
        }
        return client;
    }

    private DataSource.Factory createDataSourceFactory(Map<String, String> headers, OkHttpClient client) {
        String userAgent = mUserAgent;
        Map<String, String> requestHeaders = new HashMap<>();
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String key = entry.getKey();
                String value = entry.getValue();
                if (TextUtils.isEmpty(key) || TextUtils.isEmpty(value)) {
                    continue;
                }
                if (HttpHeaders.USER_AGENT.equalsIgnoreCase(key)) {
                    userAgent = value.trim();
                } else {
                    requestHeaders.put(key, value.trim());
                }
            }
        }
        return new DefaultDataSource.Factory(mAppContext,
                new OkHttpDataSource.Factory(client)
                        .setUserAgent(userAgent)
                        .setDefaultRequestProperties(requestHeaders));
    }

    /** 过滤空键值，value 统一 trim */
    private static Map<String, String> toRequestHeaders(Map<String, String> headers) {
        Map<String, String> requestHeaders = new HashMap<>();
        if (headers == null) {
            return requestHeaders;
        }
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            String key = entry.getKey();
            String value = entry.getValue();
            if (TextUtils.isEmpty(key) || TextUtils.isEmpty(value)) {
                continue;
            }
            requestHeaders.put(key, value.trim());
        }
        return requestHeaders;
    }

    /**
     * 边播缓存数据源。cache key 改为「分片 uri + 规范化 headers 后缀」：
     * media3 默认 key 只认 uri，同一 URL 配不同 Referer/UA/token 的线路会互相读到对方写盘的数据。
     * 无 headers 时保持 media3 默认行为（key=uri），不改变原有命中语义。
     * <p>
     * 注：当前播放侧调用恒传 isCache=false，这里预先修对，将来开缓存即生效。
     */
    private DataSource.Factory getCacheDataSourceFactory(DataSource.Factory upstream, Map<String, String> headers) {
        if (mCache == null) {
            mCache = newCache();
        }
        CacheDataSource.Factory factory = new CacheDataSource.Factory()
                .setCache(mCache)
                .setUpstreamDataSourceFactory(upstream)
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
        String keySuffix = headerKeySuffix(headers);
        if (!keySuffix.isEmpty()) {
            factory.setCacheKeyFactory(dataSpec -> dataSpec.uri + keySuffix);
        }
        return factory;
    }

    /** headers → 磁盘缓存 key 后缀：排序 + trim + 大小写不敏感，保证同一线路稳定命中 */
    private static String headerKeySuffix(Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) {
            return "";
        }
        Map<String, String> sorted = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null) {
                sorted.put(entry.getKey().trim(), entry.getValue().trim());
            }
        }
        if (sorted.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : sorted.entrySet()) {
            sb.append('\n').append(entry.getKey()).append(':').append(entry.getValue()).append(';');
        }
        return sb.toString();
    }

    private Cache newCache() {
        return new SimpleCache(
                Path.exo(),//缓存目录
                new LeastRecentlyUsedCacheEvictor(512 * 1024 * 1024),//缓存大小，默认512M，使用LRU算法实现
                new StandaloneDatabaseProvider(mAppContext));
    }

    public void setCache(Cache cache) {
        this.mCache = cache;
    }

    // ── 下一集首屏数据预读 ──
    // 单例内只允许一个预读任务在途（由 ExoMediaPlayer 的单线程调度保证），取消经这两个标记生效：
    // sPreloadCancelled 由 readAll 循环检查，sPreloadSource 支持从外部关闭在途连接
    private volatile DataSource sPreloadSource;
    private volatile boolean sPreloadCancelled;

    /** 预读上限（单集），与方案文档一致 */
    public static final long PRELOAD_MAX_BYTES = 4L * 1024 * 1024;
    /** HLS playlist 读取上限（playlist 是文本，通常远小于该值） */
    private static final long PLAYLIST_MAX_BYTES = 512 * 1024;
    /** HLS 预读分片数 */
    private static final int HLS_PRELOAD_SEGMENTS = 2;

    /** 取消在途预读：置标记并关闭在途连接；已写入缓存的数据保留，由 LRU 淘汰策略管理 */
    public void cancelPreload() {
        sPreloadCancelled = true;
        DataSource ds = sPreloadSource;
        if (ds != null) {
            try {
                ds.close();
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * 预读下一集首屏数据（同步阻塞，必须由调用方在后台线程执行）：
     * 经 {@link #getCacheDataSourceFactory} 读穿写入 SimpleCache，与正式播放共用同一
     * cache key（分片 uri + 规范化 headers 后缀），切集起播时 CacheDataSource 直接命中。
     * progressive 读首段；HLS 读全量 playlist 后按 positionMs 定位起播分片，预读该分片起的
     * 2 个分片；其余类型跳过。
     *
     * @param positionMs 预计起播位置（历史进度/跳过片头取大者），0 表示从头播
     * @return 预读字节数，0 表示无可预读内容，-1 表示失败
     */
    public int preload(String uri, Map<String, String> headers, long bytes, long positionMs) {
        try {
            if (uri == null || uri.length() == 0 || bytes <= 0) return 0;
            Uri contentUri = Uri.parse(uri);
            String scheme = contentUri.getScheme();
            // 仅预读 http(s) 直链；本地代理/文件等地址起播本就无网络首缓冲
            if (scheme == null || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) return 0;
            sPreloadCancelled = false;
            Map<String, String> requestHeaders = toRequestHeaders(headers);
            // 按路径判断 HLS（query 中的 .m3u8 字样不代表内容是 playlist）
            String path = contentUri.getPath();
            if (path != null && path.toLowerCase().contains(".m3u8")) {
                return preloadHls(contentUri, requestHeaders, bytes, 0, positionMs, null);
            }
            // progressive 容器（mp4/mkv）需解析索引才能从播放时间定位字节偏移，成本过高：
            // 起播位置大于 0（续播/跳片头）时预读开头数据无法命中，放弃
            if (positionMs > 0) return 0;
            byte[] data = readIntoCache(contentUri, requestHeaders, bytes);
            return data == null ? -1 : data.length;
        } catch (Throwable t) {
            LOG.e("bh-preload error " + describeChain(t));
            return -1;
        }
    }

    /** 异常链摘要（类名+消息），预读失败时用于日志定位 */
    private static String describeChain(Throwable t) {
        StringBuilder sb = new StringBuilder();
        while (t != null) {
            sb.append(t.getClass().getSimpleName()).append(":").append(t.getMessage()).append(" <- ");
            t = t.getCause();
        }
        return sb.substring(0, sb.length() - 4);
    }

    /**
     * HLS 预读：读 playlist → 按 positionMs 跳过起播时间之前的分片 → 预读起播分片起的
     * {@value #HLS_PRELOAD_SEGMENTS} 个分片；条目仍是 m3u8（master playlist）时下钻一层
     * （master 无 EXTINF 时长，时间定位只在 media playlist 层生效）
     */
    private int preloadHls(Uri uri, Map<String, String> headers, long bytes, int depth, long positionMs, Uri inheritedMap) {
        byte[] data = readIntoCache(uri, headers, PLAYLIST_MAX_BYTES);
        if (data == null) return -1;
        String text = new String(data, 0, data.length).replace("\r", "");
        Uri first = null;
        java.util.List<Uri> segments = new java.util.ArrayList<>();
        double target = positionMs / 1000.0;
        double elapsed = 0; // 已扫过分片的累计播放时长（EXTINF）
        double curDur = 0;
        boolean isMediaPlaylist = text.contains("#EXTINF:"); // master playlist 无时长，时间过滤只对 media playlist 生效
        Uri mapSeg = inheritedMap; // fMP4 的 init 段（#EXT-X-MAP），起播必需但不出现在分片条目中；master 层继承的会被 media 层自声明的覆盖
        for (String line : text.split("\n")) {
            String t = line.trim();
            if (t.startsWith("#EXTINF:")) {
                int comma = t.indexOf(',');
                try {
                    curDur = Float.parseFloat(t.substring(8, comma > 0 ? comma : t.length()));
                } catch (Throwable ignored) {
                    curDur = 0;
                }
                continue;
            }
            if (t.startsWith("#EXT-X-MAP:")) {
                int i = t.indexOf("URI=\"");
                if (i >= 0) {
                    int j = t.indexOf('"', i + 5);
                    if (j > i + 5) mapSeg = resolve(uri, t.substring(i + 5, j));
                }
                continue;
            }
            if (t.length() == 0 || t.startsWith("#")) continue;
            Uri resolved = resolve(uri, t);
            double end = elapsed + curDur;
            elapsed = end;
            curDur = 0;
            if (resolved == null) continue;
            if (target > 0 && isMediaPlaylist && end <= target) continue; // 起播时间之前的分片不预读
            if (first == null) {
                first = resolved;
            } else if (segments.size() < HLS_PRELOAD_SEGMENTS - 1) {
                segments.add(resolved);
            }
            if (segments.size() >= HLS_PRELOAD_SEGMENTS - 1) break;
        }
        if (first == null) return 0;
        if (depth < 2 && first.toString().toLowerCase().contains(".m3u8")) {
            return preloadHls(first, headers, bytes, depth + 1, positionMs, mapSeg);
        }
        segments.add(0, first); // 共 HLS_PRELOAD_SEGMENTS 个分片
        long total = 0;
        // init 段读取失败不中断，分片缓存仍可命中后续 range 请求
        if (mapSeg != null) {
            byte[] initData = readIntoCache(mapSeg, headers, bytes);
            if (initData != null) total += initData.length;
        }
        for (Uri seg : segments) {
            if (sPreloadCancelled || total >= bytes) break;
            byte[] segData = readIntoCache(seg, headers, bytes - total);
            if (segData == null) return total > 0 ? (int) total : -1;
            total += segData.length;
        }
        return (int) total;
    }

    /** playlist 内相对地址 → 绝对 Uri；无法解析返回 null */
    private static Uri resolve(Uri base, String ref) {
        try {
            // android.net.Uri 无相对解析，走 java.net.URL
            return Uri.parse(new java.net.URL(new java.net.URL(base.toString()), ref).toString());
        } catch (Throwable t) {
            return null;
        }
    }

    /** 经 CacheDataSource 读穿写入 SimpleCache，读满 bytes / 流结束 / 取消即返回；失败返回 null */
    private byte[] readIntoCache(Uri uri, Map<String, String> requestHeaders, long bytes) {
        DataSource ds = getCacheDataSourceFactory(createDataSourceFactory(requestHeaders, preloadClient()), requestHeaders)
                .createDataSource();
        sPreloadSource = ds;
        try {
            ds.open(new DataSpec(uri, 0, bytes));
            byte[] buf = new byte[64 * 1024];
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            while (out.size() < bytes && !sPreloadCancelled) {
                int read = ds.read(buf, 0, buf.length);
                if (read == C.RESULT_END_OF_INPUT) break;
                out.write(buf, 0, read);
            }
            return out.toByteArray();
        } catch (Throwable t) {
            LOG.e("bh-preload read error " + describeChain(t));
            return null;
        } finally {
            sPreloadSource = null;
            try {
                ds.close();
            } catch (Throwable ignored) {
            }
        }
    }
}
