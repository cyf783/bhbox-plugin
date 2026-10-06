package bh.box.plugin.exo;

import android.content.Context;
import android.net.Uri;
import android.text.TextUtils;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.Util;
import androidx.media3.database.StandaloneDatabaseProvider;
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
import androidx.media3.extractor.ExtractorsFactory;
import androidx.media3.extractor.ts.TsExtractor;

import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.Path;
import com.google.common.net.HttpHeaders;

import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

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
        Uri contentUri = Uri.parse(uri);
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
        int contentType = inferContentType(uri);
        // 每个 MediaSource 一套独立 factory：旧实现复用全局 factory + setHeaders()，
        // 后建源会把先建源的请求头覆盖掉（切线路/多线路探测时串头）。
        DataSource.Factory factory = createDataSourceFactory(requestHeaders);
        if (isCache) {
            factory = getCacheDataSourceFactory(factory, requestHeaders);
        }
        if (errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED) {
            MediaItem.Builder builder = new MediaItem.Builder().setUri(Uri.parse(uri.trim().replace("\\", "")));
            builder.setMimeType(MimeTypes.APPLICATION_M3U8);
            return new DefaultMediaSourceFactory(createDataSourceFactory(requestHeaders), getExtractorsFactory())
                    .createMediaSource(builder.build());
        }
        switch (contentType) {
            case C.CONTENT_TYPE_SS:
                return new SsMediaSource.Factory(factory).createMediaSource(MediaItem.fromUri(contentUri));
            // 兜底：Util.inferContentType 对 rtsp/rtspt 返回该值。上面的 scheme 判断已覆盖，
            // 但保留这一支以防将来有人改了入口判断却没同步这里（RTSP 走了 Progressive 会直接起播失败）。
            case C.CONTENT_TYPE_RTSP:
                return new RtspMediaSource.Factory().createMediaSource(MediaItem.fromUri(contentUri));
            case C.CONTENT_TYPE_DASH:
                return new DashMediaSource.Factory(factory).createMediaSource(MediaItem.fromUri(contentUri));
            case C.CONTENT_TYPE_HLS:
                return new HlsMediaSource.Factory(factory)
                        .setLoadErrorHandlingPolicy(new HlsErrorHandlingPolicy())
                        .createMediaSource(MediaItem.fromUri(contentUri));
            case C.CONTENT_TYPE_OTHER:
            default:
                return new ProgressiveMediaSource.Factory(factory).createMediaSource(MediaItem.fromUri(contentUri));
        }
    }

    private static synchronized ExtractorsFactory getExtractorsFactory() {
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
                new OkHttpDataSource.Factory(OkHttp.client())
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
}
