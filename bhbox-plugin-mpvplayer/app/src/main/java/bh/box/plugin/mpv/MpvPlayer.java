package bh.box.plugin.mpv;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;

import androidx.annotation.Nullable;

import com.github.catvod.plugin.player.TrackInfo;
import com.github.catvod.plugin.player.bean.TrackInfoBean;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Util;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;

import is.xyz.mpv.MPVLib;

/**
 * MPV 播放器实现，通过 MPVLib 的 enqueueCommand / setOptionString 控制原生层。
 */
public class MpvPlayer extends Player implements MPVLib.EventObserver {

    private final Context mAppContext;
    private final boolean mGpuNext;
    private final boolean mVulkan;
    private final boolean mAudioPassthrough;
    // true=libass 渲染特效字幕到画面；false=默认，字幕文本经 sub-text 走宿主显示
    private final boolean mLibassSubtitle;
    @Nullable
    private final String mMpvConfPath;

    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private boolean mIsPrepared = false;
    private int mBufferedPercent = 0;
    private long mDuration = 0;
    private boolean mHardwareDecode = true;
    // mpv 原始 track-id 映射（列表索引 -> mpv track-id）
    private final LinkedHashMap<Integer, Integer> mAudioIds = new LinkedHashMap<>();
    private final LinkedHashMap<Integer, Integer> mSubIds = new LinkedHashMap<>();

    /**
     * 安全地在工作线程或主线程均可调用。
     * 使用匿名内部类而非 lambda，避免 ProGuard 将 runnable 内联后在 mpv 线程直接执行。
     */
    private void runOnUiThread(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            r.run();
        } else {
            mHandler.post(r);
        }
    }

    // ── 内容类型常量 ──
    private static final String TAG = "MpvPlayer";
    private static final int CONTENT_TYPE_OTHER = 0;
    private static final int CONTENT_TYPE_DASH  = 1;
    private static final int CONTENT_TYPE_HLS   = 2;

    // ── demuxer lavf 选项常量 ──
    private static final String HLS_LAVF_FORMAT = "hls";
    private static final String DASH_LAVF_FORMAT = "dash";
    private static final String HLS_LAVF_OPTION_NO_HTTP_PERSISTENT = "http_persistent=0";
    private static final String HLS_LAVF_OPTION_NON_STANDARD_URI =
            "extension_picky=0," + HLS_LAVF_OPTION_NO_HTTP_PERSISTENT;

    // headers 未携带 UA 时的默认值（浏览器风格，与 Exo/IJK 默认行为对齐，避免 mpv 默认 UA 被 CDN 拒绝）
    private static final String DEFAULT_USER_AGENT =
            "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + "; " + Build.MODEL
                    + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

    // ── 构造函数 ──
    public MpvPlayer(Context context, String decoder, boolean gpuNext,
                     boolean vulkan, boolean audioPassthrough, boolean libassSubtitle,
                     @Nullable String mpvConfPath) {
        this.mAppContext = context.getApplicationContext();
        this.mGpuNext = gpuNext;
        this.mVulkan = vulkan;
        this.mAudioPassthrough = audioPassthrough;
        this.mLibassSubtitle = libassSubtitle;
        this.mMpvConfPath = mpvConfPath;
        this.mHardwareDecode = decoder.equals(MpvPlayerFactory.CODEC_HARDWARE);
    }

    // ── 生命周期 ──

    @Override
    public void initPlayer() {
        mIsPrepared = false;
        mDuration = 0;
        MPVLib.create(mAppContext);
        MPVLib.init();
        MPVLib.addObserver(this);
        applyStaticOptions();
        observeProperties();
    }

    @Override
    public void release() {
        MPVLib.removeObserver(this);
        try { MPVLib.enqueueCommand(99L, "stop"); } catch (Exception ignored) {}
        try { MPVLib.detachSurface(); } catch (Exception ignored) {}
        try { MPVLib.destroy(); } catch (Exception ignored) {}
        mIsPrepared = false;
    }

    @Override
    public void reset() {
        try { MPVLib.enqueueCommand(98L, "stop"); } catch (Exception ignored) {}
        mIsPrepared = false;
        mDuration = 0;
        mBufferedPercent = 0;
    }

    // ── 数据源 ──

    @Override
    public void setDataSource(String path, Map<String, String> headers) {
        if (path == null) return;
        try {
            // libmpv.so 无 demuxer-header 选项，改用真实存在的 user-agent / referrer / http-header-fields 注入请求头，
            // 使 UA/Referer 随 HLS 子请求（m3u8 + .ts）一起发送，避免被 CDN 拒绝。
            String ua = headers != null ? headers.get("User-Agent") : null;
            if (ua == null || ua.isEmpty()) ua = DEFAULT_USER_AGENT;
            MPVLib.setOptionString("user-agent", ua);
            if (headers != null) {
                String referer = headers.get("Referer");
                if (referer != null && !referer.isEmpty()) {
                    MPVLib.setOptionString("referrer", referer);
                }
                StringBuilder sb = new StringBuilder();
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    String key = e.getKey();
                    if ("User-Agent".equalsIgnoreCase(key) || "Referer".equalsIgnoreCase(key)) continue;
                    if (e.getValue() != null && !e.getValue().isEmpty()) {
                        if (sb.length() > 0) sb.append(",");
                        sb.append(key).append(": ").append(e.getValue());
                    }
                }
                if (sb.length() > 0) {
                    // http-header-fields 为逗号分隔的 list 选项（含逗号的 header 值极少见）
                    MPVLib.setOptionString("http-header-fields", sb.toString());
                }
            }
            String encoded = encodePath(path);
            MPVLib.setOptionString("force-seekable", "yes");
            MPVLib.enqueueCommand(1L, "loadfile", encoded);
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void setDataSource(android.content.res.AssetFileDescriptor fd) {
        try {
            File tempFile = new File(mAppContext.getCacheDir(), "mpv_temp_" + System.currentTimeMillis());
            try (InputStream in = fd.createInputStream();
                 FileOutputStream out = new FileOutputStream(tempFile)) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = in.read(buf)) != -1) out.write(buf, 0, len);
            }
            setDataSource("file://" + tempFile.getAbsolutePath(), null);
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    // ── 播放控制 ──

    @Override
    public void prepareAsync() { /* loadfile 已在 setDataSource 中调用，mpv 自动 prepare */ }

    @Override
    public void start() {
        // playlist-play-index +1 在单文件时会尝试播放不存在的下一条目，改为直接设 pause=no
        try { MPVLib.setOptionString("pause", "no"); } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void pause() {
        try { MPVLib.enqueueCommand(3L, "cycle", "pause"); } catch (Exception ignored) {}
    }

    @Override
    public void stop() {
        try { MPVLib.enqueueCommand(4L, "stop"); } catch (Exception ignored) {}
        mIsPrepared = false;
        mDuration = 0;
    }

    @Override
    public boolean isPlaying() {
        Boolean playing = MPVLib.getPropertyBoolean("pause");
        return playing != null && !playing;
    }

    @Override
    public void seekTo(long time) {
        try {
            double seconds = time / 1000.0;
            MPVLib.enqueueCommand(5L, "seek", String.valueOf(seconds), "absolute");
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public long getCurrentPosition() {
        Double t = MPVLib.getPropertyDouble("playback-time");
        return t != null ? Math.round(t * 1000) : 0;
    }

    @Override
    public long getDuration() { return mDuration; }

    @Override
    public int getBufferedPercentage() { return mBufferedPercent; }

    @Override
    public void setSurface(Surface surface) {
        if (surface == null) {
            try { MPVLib.detachSurface(); } catch (Exception ignored) {}
        } else {
            // attachSurface 会在已有 surface 时追加绑定（双 surface 冲突），replaceSurface 正确替换
            try { MPVLib.replaceSurface(surface); } catch (Exception e) {
                try { MPVLib.attachSurface(surface); } catch (Exception ignored) {}
            }
        }
    }

    @Override
    public void setDisplay(SurfaceHolder holder) {
        setSurface(holder != null ? holder.getSurface() : null);
    }

    @Override
    public void setVolume(float v1, float v2) {
        try {
            float vol = Math.max(0f, Math.min(100f, v1 * 100f));
            MPVLib.setOptionString("volume", String.valueOf((int) vol));
        } catch (Exception ignored) {}
    }

    @Override
    public void setLooping(boolean isLooping) {
        try { MPVLib.setOptionString("loop-file", isLooping ? "inf" : "no"); } catch (Exception ignored) {}
    }

    @Override
    public void setSpeed(float speed) {
        try { MPVLib.setOptionString("speed", String.valueOf(speed)); } catch (Exception ignored) {}
    }

    @Override
    public float getSpeed() {
        Double s = MPVLib.getPropertyDouble("speed");
        return s != null ? s.floatValue() : 1.0f;
    }

    @Override
    public long getTcpSpeed() {
        return Util.getNetSpeed(mAppContext);
    }

    @Override
    public void setOptions() { /* mpv 通过 initPlayer 统一配置 */ }

    // ── 解码切换 ──

    @Override
    public void setDecodeMode(boolean useHardware) {
        mHardwareDecode = useHardware;
        try {
            String hwdec = useHardware ? "hw" : "no";
            MPVLib.setOptionString("hwdec", hwdec);
        } catch (Exception ignored) {}
    }

    @Override
    public boolean isHardwareDecode() { return mHardwareDecode; }

    // ── 音频模式 ──

    @Override
    public void setAudioOnlyMode(boolean audioOnly) {
        try {
            MPVLib.setOptionString("vo", audioOnly ? "null" : "auto");
        } catch (Exception ignored) {}
    }

    // ── 字幕 ──

    @Nullable
    private OnTimedTextListener mTimedTextListener;

    @Override
    public void setOnTimedTextListener(@Nullable OnTimedTextListener listener) {
        mTimedTextListener = listener;
    }

    // ── 轨道管理 ──

    @Nullable
    private TrackInfo mTrackInfoCache;

    @Override
    @Nullable
    public TrackInfo getTrackInfo() {
        return mTrackInfoCache;
    }

    @Override
    public void setTrack(@Nullable TrackInfoBean track) {
        if (track == null) return;
        try {
            if (track.selected) {
                switch (track.type) {
                    case 1: // audio
                        Integer aid = mAudioIds.get(track.trackId);
                        if (aid != null) MPVLib.enqueueCommand(10L, "set", "audio", String.valueOf(aid));
                        break;
                    case 2: // subtitle
                        Integer sid = mSubIds.get(track.trackId);
                        if (sid != null) MPVLib.enqueueCommand(11L, "set", "sub", String.valueOf(sid));
                        break;
                }
            } else {
                deselectTrackInternal(track.type, track.trackId);
            }
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void deselectTrack(@Nullable TrackInfoBean track) {
        if (track == null) return;
        try {
            deselectTrackInternal(track.type, track.trackId);
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    private void deselectTrackInternal(int type, int trackId) {
        try {
            if (type == 1) { // audio
                Integer aid = mAudioIds.get(trackId);
                if (aid != null) {
                    int current = MPVLib.getPropertyInt("audio-id");
                    if (current == aid) MPVLib.enqueueCommand(12L, "set", "audio", "no");
                }
            } else if (type == 2) { // subtitle
                Integer sid = mSubIds.get(trackId);
                if (sid != null) {
                    int curSub = MPVLib.getPropertyInt("sub-id");
                    if (curSub == sid) MPVLib.enqueueCommand(13L, "set", "sub", "no");
                }
            }
        } catch (Exception ignored) {}
    }

    // ── 私有方法 ──

    private void applyStaticOptions() {
        MPVLib.setOptionString("hwdec", mHardwareDecode ? "hw" : "no");
        if (mGpuNext) MPVLib.setOptionString("vo", "gpu-next");
        if (mVulkan) MPVLib.setOptionString("gpu-context", "vulkan");
        MPVLib.setOptionString("ao", "audiotrack");
        MPVLib.setOptionString("audio-exclusive", mAudioPassthrough ? "yes" : "no");
        MPVLib.setOptionString("tls-verify", "no");
        MPVLib.setOptionString("keep-aspect-ratio", "yes");
        // m3u8 内 ts 已是代理地址，不设 proxy-url 避免二次代理；UA/Referer 由 setDataSource 注入
        // 默认（非 libass）时隐藏内建字幕，文本经 sub-text 走宿主 SimpleSubtitleView 显示，避免重复
        if (!mLibassSubtitle) MPVLib.setOptionString("sub-visibility", "no");
        if (mMpvConfPath != null) {
            MPVLib.setOptionString("config", "yes");
            MPVLib.setOptionString("config-dir", new File(mMpvConfPath).getParent());
        }
    }

    private void observeProperties() {
        MPVLib.observeProperty("duration", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE);
        MPVLib.observeProperty("playback-time", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE);
        // 缓冲百分比（标量 INT64）。demuxer-cache-state 是 node map 属性，native 层无对应分发，不能观察
        MPVLib.observeProperty("cache-buffering-state", MPVLib.MpvFormat.MPV_FORMAT_INT64);
        MPVLib.observeProperty("video-params/w", MPVLib.MpvFormat.MPV_FORMAT_INT64);
        MPVLib.observeProperty("video-params/h", MPVLib.MpvFormat.MPV_FORMAT_INT64);
        MPVLib.observeProperty("video-params/aspect", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE);
        MPVLib.observeProperty("track-list/count", MPVLib.MpvFormat.MPV_FORMAT_INT64);
        if (!mLibassSubtitle) MPVLib.observeProperty("sub-text", MPVLib.MpvFormat.MPV_FORMAT_STRING);
    }

    private String encodePath(String path) {
        try {
            if (path.contains(".") && !path.contains("://")) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < path.length(); i++) {
                    char c = path.charAt(i);
                    if ((c >= '\u4e00' && c <= '\u9fa5') || c == ' ') {
                        sb.append(java.net.URLEncoder.encode(String.valueOf(c), "UTF-8"));
                    } else {
                        sb.append(c);
                    }
                }
                return sb.toString();
            }
            return path;
        } catch (Exception ignored) {
            return path;
        }
    }

    // ── MPVLib.EventObserver 回调 ──

    @Override
    public void eventProperty(String property) { /* 忽略无值属性变化 */ }

    @Override
    public void eventProperty(String property, long value) {
        if (("video-params/w".equals(property) || "video-params/h".equals(property)) && mIsPrepared) {
            runOnUiThread(this::updateVideoSize);
        } else if ("track-list/count".equals(property) && value > 0) {
            // 轨道数量变化（文件加载/外部字幕添加）时刷新轨道信息
            runOnUiThread(this::updateTrackInfo);
        } else if ("cache-buffering-state".equals(property)) {
            // 缓冲百分比，控制器轮询 getBufferedPercentage 时读取
            mBufferedPercent = (int) value;
        }
    }

    @Override
    public void eventProperty(String property, boolean value) {
        // mpv 的 pause 属性反映播放/暂停状态而非缓冲状态，错用会频繁重置 STATE_PLAYING → STATE_BUFFERING
    }

    @Override
    public void eventProperty(String property, double value) {
        switch (property) {
            case "duration":
                if (value > 0) mDuration = Math.round(value * 1000);
                break;
        }
    }

    @Override
    public void eventProperty(String property, String value) {
        // 默认（非 libass）时，sub-text 即当前字幕文本，转发宿主显示；空文本走 onTimedText 清屏（宿主 cleared 为空实现）
        if ("sub-text".equals(property)) {
            final String text = value == null ? "" : value;
            runOnUiThread(() -> {
                if (mTimedTextListener != null) mTimedTextListener.onTimedText(text);
            });
        }
    }

    @Override
    public void event(int eventId) {
        switch (eventId) {
            case MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED:
                runOnUiThread(() -> {
                    if (mEventListener != null) {
                        mIsPrepared = true;
                        updateVideoSize();
                        // 先构建轨道缓存再回调 onPrepared：宿主在回调内同步读 getTrackInfo 做内置字幕适配
                        updateTrackInfo();
                        mEventListener.onPrepared();
                        mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
                    }
                });
                break;
            case MPVLib.MpvEvent.MPV_EVENT_VIDEO_RECONFIG:
                runOnUiThread(() -> {
                    if (mEventListener != null)
                        mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
                    updateVideoSize();
                });
                break;
            case MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART:
                // seek 或 resume 后播放恢复，发送 BUFFERING_END 让状态机退出缓冲
                runOnUiThread(() -> {
                    if (mEventListener != null) {
                        mEventListener.onInfo(PLAYER_INFO_BUFFERING_END, 0);
                        mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
                    }
                    updateVideoSize();
                });
                break;
            case MPVLib.MpvEvent.MPV_EVENT_SEEK:
                // seek 操作开始，通知 UI 进入缓冲状态
                runOnUiThread(() -> {
                    if (mEventListener != null)
                        mEventListener.onInfo(PLAYER_INFO_BUFFERING_START, 0);
                });
                break;
        }
    }

    @Override
    public void eventCommandReply(long requestId, int error) { /* 命令完成回调 */ }

    @Override
    public void eventEndFile(int reason, int error, @Nullable String errorString) {
        // mpv 事件回调在工作线程，通过 runOnUiThread 切换到主线程再触发 UI 回调
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (mEventListener == null) return;
                switch (reason) {
                    case MPVLib.MpvEndFileReason.MPV_END_FILE_REASON_EOF:
                        mEventListener.onCompletion();
                        break;
                    case MPVLib.MpvEndFileReason.MPV_END_FILE_REASON_ERROR:
                        mEventListener.onError(error, errorString != null ? errorString : "播放出错");
                        break;
                    case MPVLib.MpvEndFileReason.MPV_END_FILE_REASON_STOP:
                        // 用户主动停止，不触发回调
                        break;
                }
            }
        });
    }

    // ── 内部辅助方法 ──

    private void updateVideoSize() {
        if (!mIsPrepared) return;
        Integer w = MPVLib.getPropertyInt("video-params/w");
        Integer h = MPVLib.getPropertyInt("video-params/h");
        if (w != null && h != null && w > 0 && h > 0) {
            if (mEventListener != null) {
                mEventListener.onVideoSizeChanged(w, h);
            }
        }
    }

    private void updateTrackInfo() {
        try {
            Integer count = MPVLib.getPropertyInt("track-list/count");
            if (count == null || count <= 0) {
                Log.d(TAG, "updateTrackInfo: track-list/count unavailable");
                return;
            }
            TrackInfo info = new TrackInfo();
            mAudioIds.clear();
            mSubIds.clear();
            for (int i = 0; i < count; i++) {
                String prefix = "track-list/" + i + "/";
                String type = MPVLib.getPropertyString(prefix + "type");
                if (type == null) continue;
                Integer mpvId = MPVLib.getPropertyInt(prefix + "id");
                String lang = MPVLib.getPropertyString(prefix + "lang");
                String codec = MPVLib.getPropertyString(prefix + "codec");
                if (codec == null) codec = "";
                boolean selected = "yes".equals(MPVLib.getPropertyString(prefix + "selected"));

                TrackInfoBean bean = new TrackInfoBean();
                bean.trackId = i; // 列表索引作为 trackId
                bean.language = lang;
                bean.selected = selected;

                if ("audio".equals(type)) {
                    bean.type = 1;
                    bean.name = (info.getAudio().size() + 1) + ": " + codec +
                            (lang != null ? " (" + lang + ")" : "");
                    if (mpvId != null) mAudioIds.put(i, mpvId);
                    info.addAudio(bean);
                } else if ("sub".equals(type)) {
                    bean.type = 2;
                    bean.name = (info.getSubtitle().size() + 1) + ": " +
                            (lang != null ? lang : "subtitle");
                    if (mpvId != null) mSubIds.put(i, mpvId);
                    info.addSubtitle(bean);
                } else if ("video".equals(type)) {
                    bean.type = 3;
                    Integer width = MPVLib.getPropertyInt(prefix + "width");
                    Integer height = MPVLib.getPropertyInt(prefix + "height");
                    bean.name = (info.getVideo().size() + 1) + ": " + codec + " " +
                            (width != null ? width : 0) + "x" + (height != null ? height : 0);
                    info.addVideo(bean);
                }
            }
            mTrackInfoCache = info;
            Log.d(TAG, "updateTrackInfo: audio=" + info.getAudio().size()
                    + " video=" + info.getVideo().size()
                    + " subtitle=" + info.getSubtitle().size());
        } catch (Exception e) {
            Log.d(TAG, "updateTrackInfo error: " + e.getMessage());
        }
    }
}
