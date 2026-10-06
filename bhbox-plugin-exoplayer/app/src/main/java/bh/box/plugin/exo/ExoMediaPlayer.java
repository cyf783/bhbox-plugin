package bh.box.plugin.exo;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
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
    /** 最近一次上报的视频宽度，0 表示纯音频 */
    private int mVideoWidth;
    /** 渲染器清单只打一次（用于确认 ffmpeg 扩展是否真的被反射加载） */
    private boolean renderersLogged;

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
            mLoadControl = new DefaultLoadControl();
        }

        mMediaPlayer = new ExoPlayer.Builder(mAppContext)
                .setLoadControl(mLoadControl)
                .setTrackSelector(mTrackSelector)
                .setRenderersFactory(mRenderersFactory)
                .build();

        setOptions();

        mMediaPlayer.addListener(ExoMediaPlayer.this);
    }

    public DefaultTrackSelector getTrackSelector() {
        return mTrackSelector;
    }

    @Override
    public void setDataSource(String path, Map<String, String> headers) {
        mMediaSource = mMediaSourceHelper.getMediaSource(path, headers, false, errorCode);
        errorCode = -1;
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
        if (mMediaSource == null) return;
        if (mSpeedPlaybackParameters != null) {
            mMediaPlayer.setPlaybackParameters(mSpeedPlaybackParameters);
        }
        mIsPreparing = true;
        mMediaPlayer.setMediaSource(mMediaSource);
        mMediaPlayer.prepare();
    }

    @Override
    public void reset() {
        if (mMediaPlayer != null) {
            mMediaPlayer.stop();
            mMediaPlayer.clearMediaItems();
            mMediaPlayer.setVideoSurface(null);
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
        if (mMediaPlayer != null) {
            mMediaPlayer.removeListener(this);
            mMediaPlayer.release();
            mMediaPlayer = null;
        }
        mIsPreparing = false;
        mSpeedPlaybackParameters = null;
        mVideoWidth = 0;
    }

    @Override
    public long getCurrentPosition() {
        if (mMediaPlayer == null)
            return 0L;
        return mMediaPlayer.getCurrentPosition();
    }

    @Override
    public long getDuration() {
        if (mMediaPlayer == null)
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
        LOG.e("ExoMediaPlayer onPlayerError: " + error.errorCode);
        if (mEventListener != null) {
            mEventListener.onError(error.errorCode, Util.getRootCauseMessage(error));
        }
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
