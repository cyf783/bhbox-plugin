package bh.box.plugin.red;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;

import androidx.annotation.Nullable;

import com.github.catvod.plugin.player.TrackInfo;
import com.github.catvod.plugin.player.bean.TrackInfoBean;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Util;

import com.xingin.openredplayercore.core.api.IMediaPlayer;
import com.xingin.openredplayercore.core.impl.redplayer.RedMediaPlayer;


import java.io.File;
import java.util.Map;

/**
 * RedPlayer（小红书 REDPlayer）实现，包装 RedMediaPlayer 适配 catvod Player 契约。
 * 参考 docs/RedPlayer.java 适配层。
 */
public class RedPlayer extends Player implements IMediaPlayer.OnErrorListener
        , IMediaPlayer.OnCompletionListener
        , IMediaPlayer.OnVideoSizeChangedListener
        , IMediaPlayer.OnPreparedListener
        , IMediaPlayer.OnSeekCompleteListener
        , IMediaPlayer.OnBufferingUpdateListener
        , IMediaPlayer.OnInfoListener {

    private final Context mAppContext;
    private final boolean mHardwareDecode;
    private final boolean mCacheEnabled;

    private RedMediaPlayer mMediaPlayer;
    private int mBufferedPercent;

    private static final String TAG = "RedPlayer";

    public RedPlayer(Context context, String decoder, String cache) {
        mAppContext = context.getApplicationContext();
        mHardwareDecode = RedPlayerFactory.CODEC_HARDWARE.equals(decoder);
        mCacheEnabled = RedPlayerFactory.CACHE_ON.equals(cache);
    }

    @Override
    public void initPlayer() {
        Log.i(TAG, "initPlayer, hardwareDecode=" + mHardwareDecode);
        mMediaPlayer = new RedMediaPlayer();
        setOptions();
        mMediaPlayer.setOnErrorListener(this);
        mMediaPlayer.setOnCompletionListener(this);
        mMediaPlayer.setOnInfoListener(this);
        mMediaPlayer.setOnPreparedListener(this);
        mMediaPlayer.setOnVideoSizeChangedListener(this);
        mMediaPlayer.setOnSeekCompleteListener(this);
        mMediaPlayer.setOnBufferingUpdateListener(this);
    }

    @Override
    public void setOptions() {
        // 默认 false（FFmpeg 软解），硬解码时开启 MediaCodec
        mMediaPlayer.setEnableMediaCodec(mHardwareDecode);
        // 默认不启用 REDPlayer 内部磁盘缓存：其缓存 key 基于 URL 路径，
        // 宿主 goproxy 的 URL 路径恒为 /proxy（身份在 query），所有请求
        // 会撞同一个缓存条目并被追加污染，导致 FFmpeg 解析到垃圾数据。
        // 仅当用户在插件参数中显式开启（适合非 proxy 直链场景）
        if (mCacheEnabled) {
            File cacheDir = new File(Path.player(), "redplayer");
            if (!cacheDir.exists()) cacheDir.mkdirs();
            mMediaPlayer.setVideoCacheDir(cacheDir.getAbsolutePath());
            Log.i(TAG, "video cache enabled: " + cacheDir.getAbsolutePath());
        }
    }

    // ── 数据源 ──

    @Override
    public void setDataSource(String path, Map<String, String> headers) {
        if (path == null) return;
        Log.i(TAG, "setDataSource: " + path);
        try {
            mMediaPlayer.setDataSource(path, headers);
        } catch (Exception e) {
            Log.e(TAG, "setDataSource failed", e);
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void setDataSource(AssetFileDescriptor fd) {
        // RedMediaPlayer 不支持 AssetFileDescriptor
        if (mEventListener != null) mEventListener.onError(-1, "RedPlayer 不支持 AssetFileDescriptor 数据源");
    }

    // ── 播放控制 ──

    @Override
    public void start() {
        if (mMediaPlayer == null) return;
        try {
            mMediaPlayer.start();
        } catch (IllegalStateException e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void pause() {
        if (mMediaPlayer == null) return;
        try {
            mMediaPlayer.pause();
        } catch (IllegalStateException e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void stop() {
        try {
            if (mMediaPlayer == null) return;
            mMediaPlayer.stop();
        } catch (IllegalStateException ignored) {
        }
    }

    @Override
    public void prepareAsync() {
        if (mMediaPlayer == null) return;
        Log.i(TAG, "prepareAsync");
        try {
            mMediaPlayer.prepareAsync();
        } catch (IllegalStateException e) {
            Log.e(TAG, "prepareAsync failed", e);
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void reset() {
        if (mMediaPlayer != null) {
            stop();
            mMediaPlayer.release();
            mMediaPlayer = null;
        }
        mBufferedPercent = 0;
    }

    @Override
    public boolean isPlaying() {
        if (mMediaPlayer == null) return false;
        return mMediaPlayer.isPlaying();
    }

    @Override
    public void seekTo(long time) {
        try {
            if (mMediaPlayer == null) return;
            if (time < 0 || time > getDuration()) return;
            mMediaPlayer.seekTo(time);
        } catch (IllegalStateException e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void release() {
        if (mMediaPlayer != null) {
            mMediaPlayer.setOnErrorListener(null);
            mMediaPlayer.setOnCompletionListener(null);
            mMediaPlayer.setOnInfoListener(null);
            mMediaPlayer.setOnPreparedListener(null);
            mMediaPlayer.setOnVideoSizeChangedListener(null);
            mMediaPlayer.setOnBufferingUpdateListener(null);
            mMediaPlayer.setOnSeekCompleteListener(null);
            reset();
        }
    }

    @Override
    public long getCurrentPosition() {
        if (mMediaPlayer == null) return 0;
        return mMediaPlayer.getCurrentPosition();
    }

    @Override
    public long getDuration() {
        if (mMediaPlayer == null) return 0;
        return mMediaPlayer.getDuration() < 0 ? 0 : mMediaPlayer.getDuration();
    }

    @Override
    public int getBufferedPercentage() {
        return mBufferedPercent;
    }

    @Override
    public void setSurface(Surface surface) {
        Log.i(TAG, "setSurface: " + surface + ", valid=" + (surface != null && surface.isValid()));
        if (mMediaPlayer == null) return;
        try {
            mMediaPlayer.setSurface(surface);
        } catch (Exception e) {
            Log.e(TAG, "setSurface failed", e);
        }
    }

    @Override
    public void setDisplay(SurfaceHolder holder) {
        if (holder == null) setSurface(null);
        else setSurface(holder.getSurface());
    }

    @Override
    public void setVolume(float v1, float v2) {
        if (mMediaPlayer != null) mMediaPlayer.setVolume(v1, v2);
    }

    @Override
    public void setLooping(boolean isLooping) {
        if (mMediaPlayer != null) mMediaPlayer.setLooping(isLooping);
    }

    @Override
    public void setSpeed(float speed) {
        if (mMediaPlayer != null) mMediaPlayer.setSpeed(speed);
    }

    @Override
    public float getSpeed() {
        if (mMediaPlayer == null) return 1.0f;
        float speed = mMediaPlayer.getSpeed(1.0f);
        return speed > 0 ? speed : 1.0f;
    }

    @Override
    public long getTcpSpeed() {
        return Util.getNetSpeed(mAppContext);
    }

    // ── 解码切换 ──

    @Override
    public void setDecodeMode(boolean useHardware) {
        if (mMediaPlayer != null) mMediaPlayer.setEnableMediaCodec(useHardware);
    }

    @Override
    public boolean isHardwareDecode() {
        return mHardwareDecode;
    }

    // ── 纯音频 / 内置字幕 / 轨道（RED SDK 无对应 API） ──

    @Override
    public void setAudioOnlyMode(boolean audioOnly) {
        // RedMediaPlayer 无音频渲染开关
    }

    @Override
    public void setOnTimedTextListener(@Nullable OnTimedTextListener listener) {
        // RedMediaPlayer 无内建字幕回调
    }

    @Override
    public void setTrack(@Nullable TrackInfoBean track) {
        // RedMediaPlayer 无轨道选择 API
    }

    @Override
    @Nullable
    public TrackInfo getTrackInfo() {
        return null;
    }

    @Override
    public void deselectTrack(@Nullable TrackInfoBean track) {
        // RedMediaPlayer 无轨道选择 API
    }

    // ── 事件回调（RED → catvod 事件码映射：701→35 缓冲开始，702→36 缓冲结束） ──

    @Override
    public void onCompletion(IMediaPlayer mp) {
        Log.i(TAG, "onCompletion");
        if (mEventListener != null) mEventListener.onCompletion();
    }

    @Override
    public boolean onError(IMediaPlayer mp, int what, int extra) {
        Log.e(TAG, "onError: what=" + what + ", extra=" + extra);
        // 出错后需要停止掉播放器
        stop();
        if (mEventListener != null) mEventListener.onError(what, "播放出错 (" + what + "," + extra + ")");
        return true;
    }

    @Override
    public void onPrepared(IMediaPlayer mp, com.xingin.openredplayercore.core.impl.RedPlayerEvent event) {
        Log.i(TAG, "onPrepared");
        if (mEventListener != null) {
            mEventListener.onPrepared();
            mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
        }
    }

    @Override
    public void onBufferingUpdate(IMediaPlayer mp, int percent) {
        mBufferedPercent = percent;
    }

    @Override
    public void onSeekComplete(IMediaPlayer mp) {
    }

    @Override
    public void onVideoSizeChanged(IMediaPlayer mp, int width, int height, int sar_num, int sar_den) {
        if (width != 0 && height != 0 && mEventListener != null) {
            mEventListener.onVideoSizeChanged(width, height);
        }
    }

    @Override
    public boolean onInfo(IMediaPlayer mp, int what, int extra, com.xingin.openredplayercore.core.impl.RedPlayerEvent event) {
        if (what == 701 || what == 702 || what == 3) Log.d(TAG, "onInfo: what=" + what + ", extra=" + extra);
        if (mEventListener == null) return false;
        switch (what) {
            case 701: // MEDIA_INFO_BUFFERING_START
                mEventListener.onInfo(PLAYER_INFO_BUFFERING_START, extra);
                break;
            case 702: // MEDIA_INFO_BUFFERING_END
                mEventListener.onInfo(PLAYER_INFO_BUFFERING_END, extra);
                break;
            default:
                mEventListener.onInfo(what, extra);
                break;
        }
        return false;
    }
}
