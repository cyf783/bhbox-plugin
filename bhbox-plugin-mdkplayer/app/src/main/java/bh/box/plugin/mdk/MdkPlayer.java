package bh.box.plugin.mdk;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.Surface;
import android.view.SurfaceHolder;

import androidx.annotation.Nullable;

import com.github.catvod.plugin.player.TrackInfo;
import com.github.catvod.plugin.player.bean.TrackInfoBean;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Util;

import java.util.Map;

/**
 * MDK 播放器实现（JNI 直驱，无官方 Java 层）。
 * <p>
 * 事件码转换在 Java 层完成：mdk JNI 事件 → 宿主 {@link EventListener}。
 * prepare 语义（回退方案 §4.3，真机已验证）：prepareAsync() = setMedia(url, headers) +
 * setState(Playing)（mdk 加载完成自动出画），onPrepared ← MediaStatus::Loaded；start() 幂等。
 */
public class MdkPlayer extends Player {

    // ── 与 MDKPlayerJNI.cpp 事件枚举对齐 ──
    private static final int MEDIA_ERROR = -1;
    private static final int MEDIA_INFO = 0;
    private static final int MEDIA_PREPARED = 1;
    private static final int MEDIA_PLAYBACK_COMPLETE = 2;
    private static final int MEDIA_BUFFERING_UPDATE = 3;
    private static final int MEDIA_VIDEO_SIZE_CHANGED = 4;

    /** 默认模式字幕文本轮询间隔（ms）——onSubtitleText 回调依赖渲染管线，改主动查询 subtitleText() */
    private static final long TEXT_POLL_INTERVAL = 250;

    // ── mdk PlaybackState（MDK_State）──
    private static final int STATE_STOPPED = 0;
    private static final int STATE_PLAYING = 1;
    private static final int STATE_PAUSED = 2;

    // ── mdk MediaType（MDK_MediaType：Video=0/Audio=1/Subtitle=3）──
    private static final int TYPE_VIDEO = 0;
    private static final int TYPE_AUDIO = 1;
    private static final int TYPE_SUBTITLE = 3;

    // ── mdk 日志级别（MDK_LogLevel）──
    static final int LOG_OFF = 0;
    static final int LOG_ERROR = 1;
    static final int LOG_WARNING = 2;
    static final int LOG_INFO = 3;
    static final int LOG_DEBUG = 4;

    public static final String CODEC_HARDWARE = "硬解码";
    public static final String CODEC_SOFTWARE = "软解码";
    private static final String[] DECODERS_HW = {"AMediaCodec", "FFmpeg"};
    private static final String[] DECODERS_SW = {"FFmpeg"};

    /** license key（MdkPlugin.init() 注入，per-player setProperty） */
    private static String sLicense = "";

    private final Handler mHandler;
    private final Context mAppContext;
    private long mNativePtr;
    private Surface mSurface; // 已绑定 surface（重复绑定防护）
    private String mUrl;
    private String mHeaders;
    private boolean mHardware = true;
    private float mSpeed = 1.0f;
    private int mBufferedPercent;
    private volatile boolean mReleased;
    private OnTimedTextListener mTimedTextListener;
    // 默认模式字幕文本轮询（文本变化才外传，对齐 mpv sub-text 查询语义）
    private boolean mPolling;
    private String mLastText = "";
    private final Runnable mTextPoller = new Runnable() {
        @Override
        public void run() {
            if (!mPolling || mNativePtr == 0) return;
            String text = nativeSubtitleText(mNativePtr);
            if (text == null) text = "";
            if (!text.equals(mLastText)) {
                mLastText = text;
                if (mTimedTextListener != null) mTimedTextListener.onTimedText(text);
            }
            mHandler.postDelayed(this, TEXT_POLL_INTERVAL);
        }
    };
    // 激活轨道记录（mdk v0.39 无查询 API；默认第一轨激活，setTrack/deselectTrack 同步维护）
    private int mSelAudio;
    private int mSelVideo;
    private int mSelSubtitle;

    public MdkPlayer(Context context, String decoder) {
        mAppContext = context;
        mHardware = !CODEC_SOFTWARE.equals(decoder);
        mHandler = new Handler(Looper.getMainLooper()) {
            @Override
            public void handleMessage(Message msg) {
                MdkPlayer.this.onNativeEvent(msg);
            }
        };
    }

    /** license 注入（TODO：key 到位后由 MdkPlugin.init() 调用） */
    static void setLicense(String key) {
        sLicense = key == null ? "" : key;
    }

    /** 全局日志级别（MDK_setLogLevel），静态生效 */
    public static void setLogLevel(int level) {
        nativeSetLogLevel(level);
    }

    // ── JNI 回调入口（native 线程 → 主线程 Handler）──

    /** 由 libmdk-jni.so 调用（PostEvent），签名与 C++ GetStaticMethodID 对齐，不可改 */
    private static void postEventFromNative(Object self, int what, int arg1, int arg2, Object obj) {
        MdkPlayer player = (MdkPlayer) self;
        if (player == null || player.mHandler == null || player.mReleased)
            return;
        Message msg = player.mHandler.obtainMessage(what, arg1, arg2, obj);
        player.mHandler.sendMessage(msg);
    }

    private void onNativeEvent(Message msg) {
        if (mReleased || mEventListener == null)
            return;
        switch (msg.what) {
            case MEDIA_PREPARED:
                mEventListener.onPrepared();
                // mdk v0.39.0 无首帧渲染事件，以 Prepared 近似（同 EXO 先例；音频源宿主依赖此信号）
                mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
                break;
            case MEDIA_PLAYBACK_COMPLETE:
                mEventListener.onCompletion();
                break;
            case MEDIA_ERROR:
                String detail = msg.obj instanceof String ? (String) msg.obj : null;
                mEventListener.onError(msg.arg1, detail != null ? detail : "播放地址加载失败");
                break;
            case MEDIA_INFO:
                if (msg.arg1 == 701) mEventListener.onInfo(PLAYER_INFO_BUFFERING_START, 0);
                else if (msg.arg1 == 702) mEventListener.onInfo(PLAYER_INFO_BUFFERING_END, 0);
                break;
            case MEDIA_BUFFERING_UPDATE:
                mBufferedPercent = Math.max(0, Math.min(100, msg.arg1));
                break;
            case MEDIA_VIDEO_SIZE_CHANGED:
                mEventListener.onVideoSizeChanged(msg.arg1, msg.arg2);
                break;
        }
    }

    // ── Player 契约实现 ──

    @Override
    public void initPlayer() {
        mReleased = false;
        mNativePtr = nativeCreate();
        if (!sLicense.isEmpty()) nativeSetProperty(mNativePtr, "license", sLicense);
        // 关闭内核画面渲染仅外传文本，避免与宿主字幕浮层双显（mdk 0.39 libass 渲染 mov_text
        // 无输出，真机已验证，故仅保留宿主渲染一条路径）
        nativeSetProperty(mNativePtr, "subtitle", "0");
        // 起播缓冲（bufferRange，格式"minMs+maxMs"）：默认 minMs=1000 攒 1 秒数据即开播，
        // 换集后队列常只有一个分片，网络供给稍慢就耗尽进 Buffering（前 2~3 秒播一下停一下）；
        // 提到 2s 起播门限 + 10s 预读上限（mdk 文档：maxMs 大值推荐且不影响延迟）
        nativeSetProperty(mNativePtr, "buffer", "2000+10000");
        nativeSetDecoders(mNativePtr, mHardware ? DECODERS_HW : DECODERS_SW);
    }

    @Override
    public void setDataSource(String path, Map<String, String> headers) {
        mUrl = path;
        mHeaders = joinHeaders(headers);
    }

    @Override
    public void setDataSource(AssetFileDescriptor fd) {
        // mdk 无 FD 数据源且 FileDescriptor 拿不到原始路径；本地文件场景宿主走 String path，
        // 此处兜底报错（IJK/EXO 均有真实实现，MDK 一期不支持）
        if (mEventListener != null) mEventListener.onError(-1, "MDK: 不支持 AssetFileDescriptor 数据源");
    }

    @Override
    public void prepareAsync() {
        if (mNativePtr == 0 || mUrl == null) return;
        nativeSetMedia(mNativePtr, mUrl, mHeaders);
        // 回退方案（§4.3，真机已验证）：prepare() 加载不播但 Prepared 标志不触发宿主 UI，
        // 改为直接 Playing（mdk 加载完成自动出画，onPrepared 由 Loaded 状态回发）；start() 幂等
        // 注意：字幕轨激活只能在 Loaded 后（§onMediaStatus）——setMedia 后 open 中途调用
        // setActiveTracks 会破坏 FrameReader 初始化（真机实测 read packet error 时长 0）
        nativeSetState(mNativePtr, STATE_PLAYING);
        // 启动字幕文本轮询（内核渲染已关，文本统一经 subtitleText() 外传宿主）
        if (!mPolling) {
            mPolling = true;
            mLastText = "";
            mHandler.postDelayed(mTextPoller, TEXT_POLL_INTERVAL);
        }
    }

    @Override
    public void start() {
        if (mNativePtr != 0) nativeSetState(mNativePtr, STATE_PLAYING);
    }

    @Override
    public void pause() {
        if (mNativePtr != 0) nativeSetState(mNativePtr, STATE_PAUSED);
    }

    @Override
    public void stop() {
        mPolling = false;
        if (mNativePtr != 0) nativeSetState(mNativePtr, STATE_STOPPED);
    }

    @Override
    public void reset() {
        mPolling = false;
        if (mNativePtr != 0) {
            nativeSetState(mNativePtr, STATE_STOPPED);
            nativeSetMedia(mNativePtr, null, null);
        }
        mUrl = null;
        mHeaders = null;
        mSurface = null;
        mBufferedPercent = 0;
        mSpeed = 1.0f;
        mSelAudio = 0;
        mSelVideo = 0;
        mSelSubtitle = 0;
    }

    @Override
    public boolean isPlaying() {
        return mNativePtr != 0 && nativeState(mNativePtr) == STATE_PLAYING;
    }

    @Override
    public void seekTo(long time) {
        if (mNativePtr != 0) nativeSeek(mNativePtr, time);
    }

    @Override
    public long getCurrentPosition() {
        return mNativePtr == 0 ? 0 : nativePosition(mNativePtr);
    }

    @Override
    public long getDuration() {
        return mNativePtr == 0 ? 0 : nativeGetDuration(mNativePtr);
    }

    @Override
    public int getBufferedPercentage() {
        return mBufferedPercent;
    }

    @Override
    public void setSurface(Surface surface) {
        // 同一 Surface 重复绑定跳过重绑（SurfaceView/TextureView 的 surfaceChanged 在布局/
        // PiP 动画中连发，JNI 每次产生新 ANativeWindow 包装指针会让 mdk 误判换源而全量重建 GL），
        // 但尺寸变化仍需下发——走 mdk resizeSurface 轻量路径，只更新尺寸不重建
        if (surface == mSurface) {
            if (mNativePtr != 0 && surface != null) nativeResizeSurface(mNativePtr);
            return;
        }
        mSurface = surface;
        if (mNativePtr != 0) nativeSetSurface(mNativePtr, surface, -1, -1);
    }

    @Override
    public void setDisplay(SurfaceHolder holder) {
        setSurface(holder == null ? null : holder.getSurface());
    }

    @Override
    public void setVolume(float left, float right) {
        if (mNativePtr != 0) nativeSetVolume(mNativePtr, left, right);
    }

    @Override
    public void setLooping(boolean isLooping) {
        if (mNativePtr != 0) nativeSetProperty(mNativePtr, "loop", isLooping ? "-1" : "0");
    }

    @Override
    public void setSpeed(float speed) {
        mSpeed = speed;
        if (mNativePtr != 0) nativeSetSpeed(mNativePtr, speed);
    }

    @Override
    public float getSpeed() {
        return mSpeed;
    }

    @Override
    public long getTcpSpeed() {
        // mdk 无网速 API，复用宿主全局流量采样（同 AliPlayer 兜底路径）
        return mAppContext == null ? 0 : Util.getNetSpeed(mAppContext);
    }

    @Override
    public void setDecodeMode(boolean useHardware) {
        mHardware = useHardware;
        if (mNativePtr != 0) nativeSetDecoders(mNativePtr, useHardware ? DECODERS_HW : DECODERS_SW);
    }

    @Override
    public boolean isHardwareDecode() {
        return mHardware;
    }

    @Override
    public void setAudioOnlyMode(boolean audioOnly) {
        // property "video"="none" 禁用视频渲染（纯音频），恢复传空串
        if (mNativePtr != 0) nativeSetProperty(mNativePtr, "video", audioOnly ? "none" : "");
    }

    @Override
    public void setTrack(TrackInfoBean track) {
        if (track == null || mNativePtr == 0) return;
        nativeSetTrack(mNativePtr, track.type, track.trackId);
        switch (track.type) {
            case TYPE_AUDIO: mSelAudio = track.trackId; break;
            case TYPE_VIDEO: mSelVideo = track.trackId; break;
            case TYPE_SUBTITLE: mSelSubtitle = track.trackId; break;
        }
    }

    @Nullable
    @Override
    public TrackInfo getTrackInfo() {
        if (mNativePtr == 0) return null;
        String[] rows = nativeGetTrackInfo(mNativePtr);
        if (rows == null || rows.length == 0) return null;
        TrackInfo data = new TrackInfo();
        int audioNo = 0, videoNo = 0, subtitleNo = 0;
        for (String row : rows) {
            String[] f = row.split("\t", -1); // type|index|language|codec
            if (f.length < 4) continue;
            int type = Integer.parseInt(f[0]);
            int index = Integer.parseInt(f[1]);
            String label = f[2].isEmpty() ? f[3] : f[2]; // 语言优先，无语言用编码名
            TrackInfoBean t = new TrackInfoBean();
            t.type = type;
            t.trackId = index;
            t.language = f[2];
            t.selected = isSelected(type, index);
            if (type == TYPE_AUDIO) {
                t.name = (++audioNo) + "：" + label;
                data.addAudio(t);
            } else if (type == TYPE_VIDEO) {
                t.name = (++videoNo) + "：" + label;
                data.addVideo(t);
            } else if (type == TYPE_SUBTITLE) {
                t.name = (++subtitleNo) + "：" + label;
                data.addSubtitle(t);
            }
        }
        return data;
    }

    private boolean isSelected(int type, int index) {
        if (type == TYPE_AUDIO) return index == mSelAudio;
        if (type == TYPE_VIDEO) return index == mSelVideo;
        if (type == TYPE_SUBTITLE) return index == mSelSubtitle;
        return false;
    }

    @Override
    public void deselectTrack(@Nullable TrackInfoBean track) {
        // 宿主唯一场景为关闭字幕轨（IJK deselectTrackInternal 同款语义）
        if (track == null || track.type != TYPE_SUBTITLE || mNativePtr == 0) return;
        nativeSetTrack(mNativePtr, TYPE_SUBTITLE, -1);
        mSelSubtitle = -1;
    }

    @Override
    public void setOnTimedTextListener(OnTimedTextListener listener) {
        // 默认模式：文本经 250ms 轮询 subtitleText() 外传（同 mpv sub-text 查询语义）；libass 模式内核渲染不外传
        mTimedTextListener = listener;
    }

    @Override
    public void setOptions() {
        // 空实现（配置走 property/decoder，无 IJK 式 option 表）
    }

    @Override
    public void release() {
        mReleased = true;
        mPolling = false;
        mEventListener = null; // 先摘 listener 防 native 回调竞态
        mHandler.removeCallbacksAndMessages(null);
        if (mNativePtr != 0) {
            nativeDestroy(mNativePtr);
            mNativePtr = 0;
        }
    }

    private static String joinHeaders(Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) return null;
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (sb.length() > 0) sb.append("\r\n");
            sb.append(e.getKey()).append(": ").append(e.getValue());
        }
        return sb.toString();
    }

    // ── native 方法（JNI 符号名依赖，不能混淆）──

    private native long nativeCreate();

    private native void nativeDestroy(long ptr);

    private native void nativeSetMedia(long ptr, String url, String headers);

    private native void nativeSetState(long ptr, int state);

    private native int nativeState(long ptr);

    private native void nativeSetSurface(long ptr, Surface surface, int w, int h);

    /** 同一 surface 的尺寸变化：查 ANativeWindow 当前尺寸后走 mdk resizeSurface 轻量路径 */
    private native void nativeResizeSurface(long ptr);

    private native long nativeGetDuration(long ptr);

    private native long nativePosition(long ptr);

    private native void nativeSeek(long ptr, long ms);

    private native void nativeSetSpeed(long ptr, float speed);

    private native void nativeSetProperty(long ptr, String key, String value);

    private native void nativeSetVolume(long ptr, float left, float right);

    private native void nativeSetDecoders(long ptr, String[] names);

    private native String[] nativeGetTrackInfo(long ptr);

    private native void nativeSetTrack(long ptr, int type, int index);

    private native String nativeSubtitleText(long ptr);

    private static native void nativeSetLogLevel(int level);
}
