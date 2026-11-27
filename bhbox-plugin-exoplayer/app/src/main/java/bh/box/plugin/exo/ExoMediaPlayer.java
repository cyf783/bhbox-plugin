package bh.box.plugin.exo;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;
import android.view.SurfaceHolder;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.text.Cue;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.drm.KeyRequestInfo;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.trackselection.MappingTrackSelector;

import com.github.catvod.plugin.player.TrackInfo;
import com.github.catvod.plugin.player.bean.TrackInfoBean;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Util;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@OptIn(markerClass = UnstableApi.class)
public class ExoMediaPlayer extends com.github.catvod.plugin.player.spi.Player implements Player.Listener {

    // catvod Player 事件常量（转发，避免与 media3 Player 类名冲突）
    private static final int PLAYER_INFO_RENDERING_START = com.github.catvod.plugin.player.spi.Player.PLAYER_INFO_RENDERING_START;
    private static final int PLAYER_INFO_BUFFERING_START = com.github.catvod.plugin.player.spi.Player.PLAYER_INFO_BUFFERING_START;
    private static final int PLAYER_INFO_BUFFERING_END = com.github.catvod.plugin.player.spi.Player.PLAYER_INFO_BUFFERING_END;
    private static final int PLAYER_INFO_VIDEO_ROTATION_CHANGED = com.github.catvod.plugin.player.spi.Player.PLAYER_INFO_VIDEO_ROTATION_CHANGED;

    protected Context mAppContext;
    protected ExoPlayer mMediaPlayer;
    protected MediaSource mMediaSource;
    protected ExoMediaSourceHelper mMediaSourceHelper;
    protected ExoTrackNameProvider trackNameProvider;
    private PlaybackParameters mSpeedPlaybackParameters;
    private boolean mIsPreparing;

    private LoadControl mLoadControl;
    private DefaultRenderersFactory mRenderersFactory;
    private DefaultTrackSelector mTrackSelector;

    private int errorCode = -100;
    private boolean decode = true;
    /** 细粒度解码模式（见 ExoRenderersFactory.MODE_*），默认硬解 */
    private int decodeMode = ExoRenderersFactory.MODE_HARDWARE;
    private boolean isTunnel = false;
    /** 音效控制器（preset/strength/nightMode 来自 plugin.json，session 挂载见 AudioFxController） */
    private AudioFxController mAudioFx;
    /** 缓冲策略档位（ExoPlayerFactory.BUFFER_*），initPlayer 时构建 LoadControl */
    private String bufferProfile = ExoPlayerFactory.BUFFER_STANDARD;
    /** 缓冲策略是否已应用（LoadControl 仅在首个 initPlayer 生效） */
    private boolean bufferApplied;
    /** 最近一次上报的视频宽度，0 表示纯音频 */
    private int mVideoWidth;
    /** 最近一次 setDataSource 下发的原始地址（错误日志上下文用） */
    private String mLastDataSource;
    /** 渲染器清单只打一次（用于确认 ffmpeg 扩展是否真的被反射加载） */
    private boolean renderersLogged;

    // ── 双实例预 prepare（下一集零感知切换，见 docs/BHBox双实例预prepare方案）──
    /** 主实例当前绑定的 Surface（setSurface 记录，swap 时转移给升级实例） */
    @Nullable
    private Surface mCurrentSurface;
    /** 预热实例：preloadNext 预读完成后在此 prepare 到 READY，切集命中直接 swap 跳过 prepare */
    @Nullable
    private ExoPlayer mWarmPlayer;
    @Nullable
    private String mWarmUrl;
    @Nullable
    private Map<String, String> mWarmHeaders;
    /** 预热实例是否已到 STATE_READY（可 swap）；prepare 失败/TTL 到期释放后复位 */
    private boolean mWarmReady;
    /** setDataSource 命中预热目标后置位，prepareAsync 时执行 swap */
    private boolean mPendingSwap;
    /** 预热 TTL：READY 后超过该时长未被切集使用则释放，归还解码器与内存 */
    private static final long WARM_TTL_MS = 5 * 60 * 1000;
    /** 预热 prepare 超时：迟迟不到 READY（源故障挂死）也释放，不长期占内存 */
    private static final long WARM_PREPARE_TIMEOUT_MS = 60 * 1000;
    /** 预热实例的全部操作收敛到主线程（ExoPlayer 仅允许创建线程访问） */
    private final Handler mMainHandler = new Handler(Looper.getMainLooper());
    @Nullable
    private Runnable mWarmTtlRunnable;
    /** 预热实例的静默监听器（仅记录 READY/错误）；swap 升级为主实例时必须换成 this，否则宿主收不到任何状态事件 */
    @Nullable
    private Player.Listener mWarmListener;

    public ExoMediaPlayer(Context context) {
        mAppContext = context.getApplicationContext();
        mMediaSourceHelper = ExoMediaSourceHelper.getInstance(context);
    }

    public ExoMediaPlayer(Context context, int decodeMode, boolean isTunnel) {
        this(context);
        this.decodeMode = decodeMode;
        this.decode = decodeMode == ExoRenderersFactory.MODE_HARDWARE;
        this.isTunnel = isTunnel;
    }

    /** 全参数构造（P1 扩展）：音效/夜间模式/缓冲策略 */
    public ExoMediaPlayer(Context context, int decodeMode, boolean isTunnel,
                          String soundEffect, String effectStrength, boolean nightMode, String bufferProfile) {
        this(context, decodeMode, isTunnel);
        this.mAudioFx = new AudioFxController(soundEffect, effectStrength, nightMode);
        this.bufferProfile = bufferProfile == null || bufferProfile.isEmpty()
                ? ExoPlayerFactory.BUFFER_STANDARD : bufferProfile;
    }

    @Override
    public void initPlayer() {
        if (mRenderersFactory == null) {
            // 视频解码策略跟随模式，音频恒定「MediaCodec 优先 + ffmpeg 兜底」（见 ExoRenderersFactory）
            mRenderersFactory = new ExoRenderersFactory(mAppContext, decodeMode).setEnableDecoderFallback(true);
        }
        if (mTrackSelector == null) {
            mTrackSelector = new DefaultTrackSelector(mAppContext);
            mTrackSelector.setParameters(mTrackSelector.buildUponParameters()
                    .setPreferredTextLanguage(Locale.getDefault().getISO3Language())
                    .setForceHighestSupportedBitrate(true)
                    .setTunnelingEnabled(isTunnel));
        }
        if (mLoadControl == null) {
            mLoadControl = buildLoadControl(bufferProfile);
        }

        mMediaPlayer = new ExoPlayer.Builder(mAppContext)
                .setLoadControl(mLoadControl)
                .setTrackSelector(mTrackSelector)
                .setRenderersFactory(mRenderersFactory)
                .build();

        setOptions();

        mMediaPlayer.addListener(ExoMediaPlayer.this);
        // 音效挂载：audio session 就绪/变更（蓝牙插拔、sink 重建）时重建效果链
        if (mAudioFx != null && mAudioFx.isActive()) {
            mMediaPlayer.addAnalyticsListener(new AnalyticsListener() {
                @Override
                public void onAudioSessionIdChanged(AnalyticsListener.EventTime eventTime, int audioSessionId) {
                    if (mAudioFx != null) mAudioFx.apply(audioSessionId);
                }
            });
        }
        // 缓冲策略按当前会话应用一次（LoadControl 每次构建都被新 Builder 引用，此处仅记日志）
        if (!bufferApplied) {
            bufferApplied = true;
            LOG.i("ExoMediaPlayer buffer profile=" + bufferProfile);
        }
        // DRM 会话诊断监听：provisioning / license 失败的根因只在 onDrmSessionManagerError 里
        // （fork 的 ExoPlayer.addListener 只收 Player.Listener，DRM 事件走 analytics 通道）
        mMediaPlayer.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onDrmSessionAcquired(AnalyticsListener.EventTime eventTime, int state) {
                LOG.i("ExoMediaPlayer drm session acquired, state=" + state);
            }

            @Override
            public void onDrmKeysLoaded(AnalyticsListener.EventTime eventTime, KeyRequestInfo keyRequestInfo) {
                LOG.i("ExoMediaPlayer drm keys loaded");
            }

            @Override
            public void onDrmSessionManagerError(AnalyticsListener.EventTime eventTime, Exception error) {
                LOG.e("ExoMediaPlayer drm session error" + getErrorChain(error));
            }
        });
    }

    public DefaultTrackSelector getTrackSelector() {
        return mTrackSelector;
    }

    /**
     * 缓冲策略三档（plugin.json buffer 参数）。
     * 省流：低水位小内存，弱网/流量场景；极速：高水位大预缓冲，大内存盒子起播后几乎不转圈；
     * 标准：贴近 media3 DefaultLoadControl 缺省值（back buffer 一律 0，不额外占内存）。
     */
    private static LoadControl buildLoadControl(String profile) {
        int minBufferMs;
        int maxBufferMs;
        int bufferForPlaybackMs;
        int bufferForPlaybackAfterRebufferMs;
        switch (profile == null ? "" : profile) {
            case ExoPlayerFactory.BUFFER_SAVE:
                minBufferMs = (int) TimeUnit.SECONDS.toMillis(15);
                maxBufferMs = (int) TimeUnit.SECONDS.toMillis(30);
                bufferForPlaybackMs = 1500;
                bufferForPlaybackAfterRebufferMs = 2500;
                break;
            case ExoPlayerFactory.BUFFER_FAST:
                minBufferMs = (int) TimeUnit.SECONDS.toMillis(50);
                maxBufferMs = (int) TimeUnit.SECONDS.toMillis(90);
                bufferForPlaybackMs = 5000;
                bufferForPlaybackAfterRebufferMs = 2500;
                break;
            default:
                minBufferMs = (int) TimeUnit.SECONDS.toMillis(30);
                maxBufferMs = (int) TimeUnit.SECONDS.toMillis(60);
                bufferForPlaybackMs = 2500;
                bufferForPlaybackAfterRebufferMs = 2500;
                break;
        }
        return new DefaultLoadControl.Builder()
                .setBufferDurationsMs(minBufferMs, maxBufferMs, bufferForPlaybackMs, bufferForPlaybackAfterRebufferMs)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();
    }

    @Override
    public void setDataSource(String path, Map<String, String> headers) {
        // 记录最近一次下发的地址：onPlayerError（尤其 1004 Malformed URL）时补齐上下文，
        // 否则该错误只有 cause 链没有 URL，无法定位是哪个源的哪条线路
        mLastDataSource = path;
        // 双实例预热命中判定：url + headers 均一致才可 swap（headers 参与 cache key，
        // 内容不同则预热实例的缓冲无法复用）；失配时预热已无意义，顺手释放
        boolean warmMatch = mWarmReady && path != null && path.equals(mWarmUrl)
                && sameHeaders(headers, mWarmHeaders);
        if (!warmMatch) {
            releaseWarm();
        }
        mPendingSwap = warmMatch;
        if (warmMatch) {
            // swap 路径不需要 MediaSource，prepareAsync 时直接接管预热实例
            mMediaSource = null;
            LOG.i("bh-warm match，切集将 swap");
            return;
        }
        // 开启边播缓存：DRM 内容在 helper 内自动排除；cache key（uri + 规范化 headers 后缀）
        // 与 preloadNext 预读一致，下一集预读数据由此直接命中
        mMediaSource = mMediaSourceHelper.getMediaSource(path, headers, true, errorCode);
        errorCode = -1;
    }

    // ── 下一集首屏数据预读 ──
    // 进程内单线程：预读纯 IO（经 CacheDataSource 落盘），不创建播放器实例、不占解码器
    private static final java.util.concurrent.ExecutorService sPreloadExecutor =
            java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "bh-exo-preload");
                t.setDaemon(true);
                return t;
            });
    /** 预读目标代际：换集/取消时递增，队列中的过期任务据此跳过 */
    private static volatile int sPreloadGeneration;

    @Override
    public boolean isPreloadSupported() {
        return true;
    }

    @Override
    public void preloadNext(String url, Map<String, String> headers, long positionMs) {
        if (url == null || url.length() == 0) return;
        final int generation = ++sPreloadGeneration;
        final ExoMediaSourceHelper helper = mMediaSourceHelper;
        // headers 与正式播放 setDataSource 收到的完全一致，保证 cache key 一致
        final Map<String, String> copiedHeaders = headers == null ? null : new java.util.HashMap<>(headers);
        sPreloadExecutor.execute(() -> {
            if (generation != sPreloadGeneration) return; // 已被新目标/取消覆盖
            long start = android.os.SystemClock.elapsedRealtime();
            int bytes = helper.preload(url, copiedHeaders, ExoMediaSourceHelper.PRELOAD_MAX_BYTES, positionMs);
            LOG.i("ExoPreload bytes=" + bytes + " pos=" + positionMs + "ms cost=" + (android.os.SystemClock.elapsedRealtime() - start) + "ms");
            if (generation != sPreloadGeneration || bytes <= 0) return;
            // 预读成功 → 预热实例 prepare 到 READY（双实例预 prepare），供切集时直接 swap
            mMainHandler.post(() -> {
                if (generation != sPreloadGeneration) return;
                startWarmPrepare(url, copiedHeaders, positionMs, generation);
            });
        });
    }

    @Override
    public void clearPreload() {
        // 仅取消在途预读任务：宿主切集序列是 clearPreload → setDataSource → prepareAsync，
        // 若在此释放预热实例会杀掉正待 swap 的 READY 实例。warm 生命周期由
        // setDataSource 失配释放 / 新 preloadNext 换目标释放 / TTL / release() 兜底
        sPreloadGeneration++;
        mMediaSourceHelper.cancelPreload();
    }

    // ── 预热实例管理（全部主线程执行） ──

    /**
     * 创建预热实例并 prepare 到 READY。与正式播放共用 cache factory/key（读穿预读落盘的数据），
     * 独立 LoadControl（缩小缓冲）与 TrackSelector（media3 禁止跨实例共享）。
     * playWhenReady=false：不渲染不发声不抢焦点，仅完成容器解析 + 解码器初始化 + 起播位置定位。
     */
    private void startWarmPrepare(String url, Map<String, String> headers, long positionMs, int generation) {
        releaseWarm();
        // 无真 Surface 时放弃预热：swap 需要在真 Surface 上 init 视频 codec
        if (mCurrentSurface == null) {
            LOG.i("bh-warm skip：无 Surface，降级纯预读");
            return;
        }
        try {
            DefaultTrackSelector selector = new DefaultTrackSelector(mAppContext);
            selector.setParameters(selector.buildUponParameters()
                    .setPreferredTextLanguage(Locale.getDefault().getISO3Language())
                    .setForceHighestSupportedBitrate(true)
                    .setTunnelingEnabled(isTunnel));
            ExoPlayer warm = new ExoPlayer.Builder(mAppContext)
                    .setLoadControl(buildWarmLoadControl())
                    .setTrackSelector(selector)
                    .setRenderersFactory(mRenderersFactory)
                    .build();
            warm.setPlayWhenReady(false);
            // 禁用视频轨道做 audio-only prepare：视频解码器不在预热期 init。
            // 原因（MTK 实测结论）：Surface BufferQueue 单 producer，预热实例无法绑宿主真 Surface
            // （DECODER_INIT_FAILED）；用独立 Surface init 后 swap 迁移真 Surface 又与 media3
            // renderer 输入流水线不兼容（迁移 flush 后 renderer 停止喂数据 → 画面冻结）。
            // audio-only 预热同样完成容器解析/分片缓冲/音频解码器/起播位置定位，
            // 视频解码器在 swap 后真 Surface 上走正统 init（无迁移）
            warm.setTrackSelectionParameters(warm.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true).build());
            warm.setMediaSource(mMediaSourceHelper.getMediaSource(url, headers, true, -1), positionMs);
            warm.prepare();
            mWarmPlayer = warm;
            mWarmUrl = url;
            mWarmHeaders = headers;
            mWarmReady = false;
            mWarmListener = new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(@Player.State int state) {
                    if (mWarmPlayer != warm) return;
                    if (state == Player.STATE_READY) {
                        mWarmReady = true;
                        scheduleWarmTtl(generation, WARM_TTL_MS);
                        LOG.i("bh-warm ready pos=" + warm.getCurrentPosition() + " dur=" + warm.getDuration());
                    }
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    if (mWarmPlayer != warm) return;
                    // 典型：低端设备 codec 并发实例不足 → 预热失败自动降级，纯预读数据仍在缓存
                    LOG.e("bh-warm prepare failed " + error.errorCode + " (" + error.getErrorCodeName() + ")，降级纯预读");
                    releaseWarm();
                }
            };
            warm.addListener(mWarmListener);
            scheduleWarmTtl(generation, WARM_PREPARE_TIMEOUT_MS);
            LOG.i("bh-warm prepare start pos=" + positionMs + " url=" + url);
        } catch (Throwable t) {
            LOG.e("bh-warm create failed " + Util.getRootCauseMessage(t));
            releaseWarm();
        }
    }

    /** 预热实例专用 LoadControl：缓冲档位取最小（省内存），起播水位与主实例一致 */
    private static LoadControl buildWarmLoadControl() {
        return new DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                        (int) TimeUnit.SECONDS.toMillis(15),
                        (int) TimeUnit.SECONDS.toMillis(30),
                        2500, 2500)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();
    }

    /** 释放预热实例并复位匹配状态（线程安全：非主线程时投递到主线程） */
    private void releaseWarm() {
        cancelWarmTtl();
        if (mWarmPlayer == null) return;
        Runnable release = () -> {
            ExoPlayer warm = mWarmPlayer;
            if (warm == null) return;
            mWarmPlayer = null;
            mWarmUrl = null;
            mWarmHeaders = null;
            mWarmReady = false;
            mWarmListener = null;
            try {
                warm.release();
            } catch (Throwable ignored) {
            }
            LOG.i("bh-warm released");
        };
        if (Looper.myLooper() == Looper.getMainLooper()) release.run();
        else mMainHandler.post(release);
    }

    private void scheduleWarmTtl(int generation, long delayMs) {
        cancelWarmTtl();
        mWarmTtlRunnable = () -> {
            if (generation != sPreloadGeneration) return;
            LOG.i("bh-warm ttl expired，释放预热实例");
            releaseWarm();
        };
        mMainHandler.postDelayed(mWarmTtlRunnable, delayMs);
    }

    private void cancelWarmTtl() {
        if (mWarmTtlRunnable != null) {
            mMainHandler.removeCallbacks(mWarmTtlRunnable);
            mWarmTtlRunnable = null;
        }
    }

    /** headers 相等判定（null 与空集等价；HashMap.equals 与顺序无关） */
    private static boolean sameHeaders(Map<String, String> a, Map<String, String> b) {
        if (a == null || a.isEmpty()) return b == null || b.isEmpty();
        return a.equals(b);
    }

    @Override
    public void setDataSource(AssetFileDescriptor fd) {
        //no support
    }

    @Override
    public void start() {
        if (mMediaPlayer == null)
            return;
        mMediaPlayer.setPlayWhenReady(true);
    }

    @Override
    public void pause() {
        if (mMediaPlayer == null)
            return;
        mMediaPlayer.setPlayWhenReady(false);
    }

    @Override
    public void stop() {
        if (mMediaPlayer == null)
            return;
        mMediaPlayer.stop();
    }

    @Override
    public void prepareAsync() {
        if (mMediaPlayer == null)
            return;
        if (mPendingSwap && mWarmPlayer != null) {
            swapWarmToMain();
            return;
        }
        mPendingSwap = false;
        if (mMediaSource == null) return;
        if (mSpeedPlaybackParameters != null) {
            mMediaPlayer.setPlaybackParameters(mSpeedPlaybackParameters);
        }
        mIsPreparing = true;
        mMediaPlayer.setMediaSource(mMediaSource);
        mMediaPlayer.prepare();
    }

    /**
     * swap：预热实例升级为主实例，跳过 prepare（容器解析/解码器初始化已在预热期完成）。
     * Surface 时序严格排序：先绑新实例 → 再解绑旧实例 → 最后释放旧实例，
     * 保证旧渲染链路释放前显示目标已移交（避免黑屏/卡死）。
     * 调用线程为主线程（宿主 prepareAsync 均在主线程）。
     */
    private void swapWarmToMain() {
        mPendingSwap = false;
        ExoPlayer warm = mWarmPlayer;
        ExoPlayer old = mMediaPlayer;
        if (warm == null || old == null) return;
        cancelWarmTtl();
        LOG.i("bh-warm swap url=" + mWarmUrl);
        // 先释放旧实例断开其解码器的 BufferQueue producer 连接（单 producer 模型），
        // warm 在真 Surface 上 init 视频 codec 才能成功。旧实例释放后 SurfaceView 保留最后帧，不黑屏
        old.setVideoSurface(null);
        old.removeListener(this);
        old.release();
        // 升级实例绑定真 Surface（video track 禁用中，此时尚不 init codec），
        // 再启用视频轨道走正统 codec init——数据全在缓存，无网络往返
        warm.setVideoSurface(mCurrentSurface);
        warm.setTrackSelectionParameters(warm.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, false).build());
        // 4) 角色互换
        mMediaPlayer = warm;
        mWarmPlayer = null;
        mWarmUrl = null;
        mWarmHeaders = null;
        mWarmReady = false;
        mIsPreparing = false;
        mMediaSource = null;
        // 关键：升级实例换上主监听器——warm 原本只挂静默监听，不换的话
        // BUFFERING/READY/ENDED/错误全部丢失，宿主播完收不到 onCompletion 会卡死
        if (mWarmListener != null) {
            warm.removeListener(mWarmListener);
            mWarmListener = null;
        }
        warm.addListener(this);
        // 倍速：预热实例未带播放参数，沿用原 prepareAsync 的恢复逻辑
        if (mSpeedPlaybackParameters != null) {
            warm.setPlaybackParameters(mSpeedPlaybackParameters);
        }
        // 直接起播：宿主换集路径不会再调 start()（其内部状态机认为本次 prepareAsync 已完成），
        // warm 保持 playWhenReady=false 的话首帧 pending、AudioTrack 不启动，表现为暂停/卡住。
        // media3 未配置 AudioAttributes，不参与宿主音频焦点管理，不会引发焦点抢占暂停；
        // 若宿主确有补暂停（mPendingPause），后续 pause() 在 true 起播后仍正常生效
        warm.setPlayWhenReady(true);
        // 5) 手动补发宿主状态机依赖的事件（跳过了真实 prepare 流程，宿主需离开 STATE_PREPARING）
        if (mEventListener != null) {
            mEventListener.onPrepared();
            mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
            VideoSize size = warm.getVideoSize();
            if (size.width > 0) {
                mVideoWidth = size.width;
                mEventListener.onVideoSizeChanged(size.width, size.height);
            }
        }
    }

    @Override
    public void reset() {
        if (mMediaPlayer != null) {
            mMediaPlayer.stop();
            mMediaPlayer.clearMediaItems();
            //保留 Surface 绑定：换集复用路径（releaseForEpisodeSwitch→startPlay）不再重建 RenderView，
            //旧集末帧冻结显示到新集首帧替换，消除黑屏一闪；SurfaceView 在 stop 后仍保留最后提交的帧
            mIsPreparing = false;
        }
    }

    @Override
    public void seekTo(long time) {
        if (mMediaPlayer == null)
            return;
        mMediaPlayer.seekTo(time);
    }

    @Override
    public void release() {
        clearPreload();
        // clearPreload 已收窄为取消预读任务，warm 释放由 release 兜底（页面退出最终出口）
        releaseWarm();
        mCurrentSurface = null;
        if (mMediaPlayer != null) {
            mMediaPlayer.removeListener(this);
            mMediaPlayer.release();
            mMediaPlayer = null;
        }
        if (mAudioFx != null) {
            mAudioFx.release();
        }
        mIsPreparing = false;
        mSpeedPlaybackParameters = null;
        mVideoWidth = 0;
        mLastDataSource = null;
    }

    @Override
    public long getCurrentPosition() {
        if (mMediaPlayer == null)
            return 0L;
        // 直播流 position 相对滑窗起点计算，窗口刷新/周期切换瞬间可能返回负值
        // （ExoPlayer issue #8849）；滑窗越短刷新越频繁。宿主 UI 直接透传该值，
        // 负数会显示成 00:00:-N，钳到 0。点播流 position 不会为负，钳制无副作用。
        return Math.max(0L, mMediaPlayer.getCurrentPosition());
    }

    @Override
    public long getDuration() {
        if (mMediaPlayer == null)
            return 0L;
        // 直播流（HLS 滑窗清单）：media3 的 getDuration 返回的是当前滑动窗口长度
        // （几个分片之和，正的小数值），宿主以 duration<=0 判定直播会漏掉这种情况。
        // 归零后与 ijk 直播行为对齐，宿主守卫即可正确识别。
        if (mMediaPlayer.isCurrentMediaItemLive())
            return 0L;
        return mMediaPlayer.getDuration();
    }

    @Override
    public int getBufferedPercentage() {
        if (mMediaPlayer == null)
            return 0;
        return mMediaPlayer.getBufferedPercentage();
    }

    @Override
    public boolean isPlaying() {
        if (mMediaPlayer == null)
            return false;
        switch (mMediaPlayer.getPlaybackState()) {
            case Player.STATE_BUFFERING:
            case Player.STATE_READY:
                return mMediaPlayer.getPlayWhenReady();
            case Player.STATE_IDLE:
            case Player.STATE_ENDED:
            default:
                return false;
        }
    }


    @Override
    public void setSurface(Surface surface) {
        // 记录最新 Surface：swap 时作为预热实例的迁移目标（宿主 addDisplay/rebindSurface 最终都落到这里）
        mCurrentSurface = surface;
        if (mMediaPlayer != null) {
            mMediaPlayer.setVideoSurface(surface);
        }
    }

    @Override
    public void setDisplay(SurfaceHolder holder) {
        if (holder == null)
            setSurface(null);
        else
            setSurface(holder.getSurface());
    }

    @Override
    public void setVolume(float leftVolume, float rightVolume) {
        if (mMediaPlayer != null) {
            mMediaPlayer.setVolume((leftVolume + rightVolume) / 2);
        }
    }

    @Override
    public void setLooping(boolean isLooping) {
        if (mMediaPlayer != null) {
            mMediaPlayer.setRepeatMode(isLooping ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
        }
    }

    @Override
    public void setOptions() {
        //准备好就开始播放
        if (mMediaPlayer != null) {
            mMediaPlayer.setPlayWhenReady(true);
        }
    }

    @Override
    public void setSpeed(float speed) {
        PlaybackParameters playbackParameters = new PlaybackParameters(speed, 1f);
        mSpeedPlaybackParameters = playbackParameters;
        if (mMediaPlayer != null) {
            mMediaPlayer.setPlaybackParameters(playbackParameters);
        }
    }

    @Override
    public float getSpeed() {
        if (mSpeedPlaybackParameters != null) {
            return mSpeedPlaybackParameters.speed;
        }
        return 1f;
    }

    @Override
    public long getTcpSpeed() {
        return Util.getNetSpeed(mAppContext);
    }

    @Override
    public void onTracksChanged(@NonNull Tracks tracks) {
        logRenderersOnce();
        if (trackNameProvider == null)
            trackNameProvider = new ExoTrackNameProvider();
    }

    @Override
    public void onPlaybackStateChanged(@Player.State int playbackState) {
        if (mEventListener == null) return;
        if (mIsPreparing) {
            if (playbackState == Player.STATE_READY) {
                mEventListener.onPrepared();
                mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
                mIsPreparing = false;
            }
            return;
        }
        switch (playbackState) {
            case Player.STATE_BUFFERING:
                mEventListener.onInfo(PLAYER_INFO_BUFFERING_START, getBufferedPercentage());
                break;
            case Player.STATE_READY:
                mEventListener.onInfo(PLAYER_INFO_BUFFERING_END, getBufferedPercentage());
                break;
            case Player.STATE_ENDED:
                mEventListener.onCompletion();
                break;
            case Player.STATE_IDLE:
                break;
        }
    }

    @Override
    public void onPlayerError(PlaybackException error) {
        errorCode = error.errorCode;
        LOG.e("ExoMediaPlayer onPlayerError: " + error.errorCode
                + " (" + error.getErrorCodeName() + ")" + getErrorChain(error)
                + (mLastDataSource == null ? "" : "\n  datasource=" + mLastDataSource));
        if (mEventListener != null) {
            mEventListener.onError(error.errorCode, Util.getRootCauseMessage(error));
        }
    }

    /** 错误 cause 链展开（DRM provisioning/license 失败的真正原因多在深层 cause 里） */
    private static String getErrorChain(Throwable error) {
        StringBuilder sb = new StringBuilder();
        Throwable cause = error;
        int depth = 0;
        while (cause != null && depth < 6) {
            sb.append("\n  <- ").append(cause.getClass().getSimpleName())
                    .append(": ").append(cause.getMessage());
            cause = cause.getCause();
            depth++;
        }
        return sb.toString();
    }

    @Override
    public void onVideoSizeChanged(VideoSize videoSize) {
        mVideoWidth = videoSize.width;
        if (mEventListener != null) {
            mEventListener.onVideoSizeChanged(videoSize.width, videoSize.height);
            if (videoSize.unappliedRotationDegrees > 0) {
                mEventListener.onInfo(PLAYER_INFO_VIDEO_ROTATION_CHANGED, videoSize.unappliedRotationDegrees);
            }
        }
    }

    @Override
    public void setTrack(@Nullable TrackInfoBean videoTrackBean) {
        if (videoTrackBean == null || mMediaPlayer == null) return;
        if (videoTrackBean.selected) {
            selectTrack(videoTrackBean.type, videoTrackBean.trackGroupId, videoTrackBean.trackId);
        } else {
            deselectTrackInternal(videoTrackBean.type, videoTrackBean.trackGroupId, videoTrackBean.trackId);
        }
    }

    /**
     * 打印一次渲染器清单：确认 FfmpegAudioRenderer / FfmpegVideoRenderer
     * 是否真的被 DefaultRenderersFactory 反射加载（R8 裁剪或 so 缺失时这里会看不到）。
     */
    private void logRenderersOnce() {
        if (renderersLogged || mTrackSelector == null) return;
        MappingTrackSelector.MappedTrackInfo info = mTrackSelector.getCurrentMappedTrackInfo();
        if (info == null) return;
        renderersLogged = true;
        StringBuilder sb = new StringBuilder("exo-renderers mode=").append(decodeMode);
        for (int i = 0; i < info.getRendererCount(); i++) {
            sb.append(" [").append(i).append(']').append(info.getRendererName(i));
        }
        LOG.i(sb.toString());
    }

    @Nullable
    @Override
    public TrackInfo getTrackInfo() {
        if (mMediaPlayer == null) return null;
        TrackInfo data = new TrackInfo();
        List<Tracks.Group> groups = mMediaPlayer.getCurrentTracks().getGroups();
        for (int i = 0; i < groups.size(); i++) {
            Tracks.Group trackGroup = groups.get(i);
            if (trackGroup.getType() == C.TRACK_TYPE_TEXT) {
                for (int j = 0; j < trackGroup.length; j++) {
                    String trackName = (data.getSubtitle().size() + 1) + "：" + trackNameProvider.getTrackName(trackGroup.getTrackFormat(j));
                    TrackInfoBean t = new TrackInfoBean();
                    t.name = trackName;
                    t.type = trackGroup.getType();
                    t.language = trackNameProvider.getTrackLanguage(trackGroup.getTrackFormat(j));
                    t.trackId = j;
                    t.selected = trackGroup.isTrackSelected(j);
                    t.trackGroupId = i;
                    data.addSubtitle(t);
                }
            }
            if (trackGroup.getType() == C.TRACK_TYPE_AUDIO) {
                for (int j = 0; j < trackGroup.length; j++) {
                    String trackName = (data.getAudio().size() + 1) + "：" + trackNameProvider.getTrackName(trackGroup.getTrackFormat(j));
                    TrackInfoBean t = new TrackInfoBean();
                    t.name = trackName;
                    t.type = trackGroup.getType();
                    t.language = trackNameProvider.getTrackLanguage(trackGroup.getTrackFormat(j));
                    t.trackId = j;
                    t.selected = trackGroup.isTrackSelected(j);
                    t.trackGroupId = i;
                    data.addAudio(t);
                }
            }
            if (trackGroup.getType() == C.TRACK_TYPE_VIDEO) {
                for (int j = 0; j < trackGroup.length; j++) {
                    String trackName = (data.getVideo().size() + 1) + "：" + trackNameProvider.getTrackName(trackGroup.getTrackFormat(j));
                    TrackInfoBean t = new TrackInfoBean();
                    t.name = trackName;
                    t.type = trackGroup.getType();
                    t.language = trackNameProvider.getTrackLanguage(trackGroup.getTrackFormat(j));
                    t.trackId = j;
                    t.selected = trackGroup.isTrackSelected(j);
                    t.trackGroupId = i;
                    data.addVideo(t);
                }
            }
        }
        return data;
    }

    @Override
    public void deselectTrack(@Nullable TrackInfoBean trackBean) {
        if (trackBean == null || mMediaPlayer == null) return;
        deselectTrackInternal(trackBean.type, trackBean.trackGroupId, trackBean.trackId);
    }

    public void selectTrack(int type, int group, int track) {
        if (mMediaPlayer == null) return;
        List<Integer> trackIndices = new ArrayList<>();
        selectTrack(group, track, trackIndices);
        setTrackParameters(group, trackIndices);
    }

    public void deselectTrackInternal(int type, int group, int track) {
        if (mMediaPlayer == null) return;
        List<Integer> trackIndices = new ArrayList<>();
        deselectTrack(group, track, trackIndices);
        setTrackParameters(group, trackIndices);
    }

    private void selectTrack(int group, int track, List<Integer> trackIndices) {
        if (mMediaPlayer == null) return;
        if (group >= mMediaPlayer.getCurrentTracks().getGroups().size()) return;
        Tracks.Group trackGroup = mMediaPlayer.getCurrentTracks().getGroups().get(group);
        for (int i = 0; i < trackGroup.length; i++) {
            if (i == track || trackGroup.isTrackSelected(i)) trackIndices.add(i);
        }
    }

    private void deselectTrack(int group, int track, List<Integer> trackIndices) {
        if (mMediaPlayer == null) return;
        if (group >= mMediaPlayer.getCurrentTracks().getGroups().size()) return;
        Tracks.Group trackGroup = mMediaPlayer.getCurrentTracks().getGroups().get(group);
        for (int i = 0; i < trackGroup.length; i++) {
            if (i != track && trackGroup.isTrackSelected(i)) trackIndices.add(i);
        }
    }

    private void setTrackParameters(int group, List<Integer> trackIndices) {
        if (mMediaPlayer == null) return;
        if (group >= mMediaPlayer.getCurrentTracks().getGroups().size()) return;
        mMediaPlayer.setTrackSelectionParameters(mMediaPlayer.getTrackSelectionParameters().buildUpon().setOverrideForType(new TrackSelectionOverride(mMediaPlayer.getCurrentTracks().getGroups().get(group).getMediaTrackGroup(), trackIndices)).build());
    }

    @Override
    public void setAudioOnlyMode(boolean audioOnly) {
        if (mMediaPlayer == null) return;
        // 通过 TrackSelectionParameters 禁用/启用视频轨道
        if (audioOnly) {
            mMediaPlayer.setTrackSelectionParameters(
                    mMediaPlayer.getTrackSelectionParameters().buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
                            .build());
        } else {
            mMediaPlayer.setTrackSelectionParameters(
                    mMediaPlayer.getTrackSelectionParameters().buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, false)
                            .build());
        }
    }

    @Override
    public void setDecodeMode(boolean useHardware) {
        // 下次 initPlayer 时生效（RenderersFactory 构建前）
        if (mMediaPlayer == null) {
            decode = useHardware;
            decodeMode = useHardware ? ExoRenderersFactory.MODE_HARDWARE : ExoRenderersFactory.MODE_SOFTWARE;
        }
    }

    @Override
    public boolean isHardwareDecode() {
        return decode;
    }

    @Override
    public void setOnTimedTextListener(@Nullable final OnTimedTextListener listener) {
        if (listener == null || mMediaPlayer == null) return;
        mMediaPlayer.addListener(new Player.Listener() {
            @Override
            public void onCues(@NonNull List<Cue> cues) {
                if (cues.isEmpty()) {
                    listener.onTimedTextCleared();
                    return;
                }
                StringBuilder sb = new StringBuilder();
                for (Cue cue : cues) {
                    if (cue.text != null) sb.append(cue.text);
                }
                if (sb.length() > 0) {
                    listener.onTimedText(sb.toString());
                } else {
                    listener.onTimedTextCleared();
                }
            }
        });
    }

}
