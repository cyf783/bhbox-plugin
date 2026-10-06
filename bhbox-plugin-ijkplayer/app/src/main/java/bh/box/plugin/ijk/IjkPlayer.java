package bh.box.plugin.ijk;

import static bh.box.plugin.ijk.IjkPlayerFactory.CODEC_HARDWARE;

import android.content.ContentResolver;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Surface;
import android.view.SurfaceHolder;

import androidx.annotation.Nullable;

import com.github.catvod.plugin.player.TrackInfo;
import com.github.catvod.plugin.player.bean.TrackInfoBean;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Util;

import java.io.File;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import tv.danmaku.ijk.media.player.IMediaPlayer;
import tv.danmaku.ijk.media.player.IjkMediaPlayer;
import tv.danmaku.ijk.media.player.IjkTimedText;
import tv.danmaku.ijk.media.player.misc.ITrackInfo;
import tv.danmaku.ijk.media.player.misc.IjkTrackInfo;

/**
 * IJK 播放器实现（原 IjkPlayerBase + IjkPlayerWrapper 合并）。
 * decoder / cacheEnabled / logLevel 由 IjkPlayerFactory 注入。
 */
public class IjkPlayer extends Player implements IMediaPlayer.OnErrorListener,
        IMediaPlayer.OnCompletionListener, IMediaPlayer.OnInfoListener,
        IMediaPlayer.OnBufferingUpdateListener, IMediaPlayer.OnPreparedListener,
        IMediaPlayer.OnVideoSizeChangedListener, IjkMediaPlayer.OnNativeInvokeListener {

    protected IjkMediaPlayer mMediaPlayer;
    private int mBufferedPercent;
    protected final Context mAppContext;
    private static int sLogLevel = IjkMediaPlayer.IJK_LOG_SILENT;

    private final String decoder;
    private final boolean cacheEnabled;

    public IjkPlayer(Context context, String decoder, boolean cacheEnabled) {
        mAppContext = context;
        this.decoder = decoder;
        this.cacheEnabled = cacheEnabled;
    }

    public static void setLogLevel(int level) {
        sLogLevel = level;
    }

    @Override
    public void initPlayer() {
        mMediaPlayer = new IjkMediaPlayer();
        IjkMediaPlayer.native_setLogLevel(sLogLevel);
        setOptions();
        mMediaPlayer.setOnErrorListener(this);
        mMediaPlayer.setOnCompletionListener(this);
        mMediaPlayer.setOnInfoListener(this);
        mMediaPlayer.setOnBufferingUpdateListener(this);
        mMediaPlayer.setOnPreparedListener(this);
        mMediaPlayer.setOnVideoSizeChangedListener(this);
        mMediaPlayer.setOnNativeInvokeListener(this);
    }

    @Override
    public void setOptions() {
        int mCurrentDecode = decoder.equals(CODEC_HARDWARE) ? 0 : 1;
        LinkedHashMap<String, String> options = null;
        if (options != null) {
            for (String key : options.keySet()) {
                String value = options.get(key);
                String[] opt = key.split("\\|");
                int category = Integer.parseInt(opt[0].trim());
                String name = opt[1].trim();
                try {
                    long valLong = Long.parseLong(value);
                    mMediaPlayer.setOption(category, name, valLong);
                } catch (Exception e) {
                    mMediaPlayer.setOption(category, name, value);
                }
            }
        } else {
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_CODEC, "skip_loop_filter", 48);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "fflags", "fastseek");
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "http-detect-range-support", 0);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "enable-accurate-seek", 0);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "framedrop", 1);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "max-buffer-size", 15 * 1024 * 1024);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec", mCurrentDecode);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec-hevc", mCurrentDecode);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec-all-videos", mCurrentDecode);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec-auto-rotate", mCurrentDecode);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec-handle-resolution-change", mCurrentDecode);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "opensles", 0);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "overlay-format", IjkMediaPlayer.SDL_FCC_RV32);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "reconnect", 1);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "soundtouch", 1);
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "start-on-prepared", 1);
        }
        // 在每个数据包之后启用 I/O 上下文的刷新
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "flush_packets", 1);
        // 当 CPU 处理不过来的时候的丢帧帧数，默认为 0，参数范围是 [-1, 120]
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "framedrop", 5);
        // 设置视频流格式
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "overlay-format", IjkMediaPlayer.SDL_FCC_RV32);
        // 开启内置字幕
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "subtitle", 1);
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "dns_cache_clear", 1);
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "dns_cache_timeout", -1);
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "safe", 0);
    }

    @Override
    public void setDataSource(String path, Map<String, String> headers) {
        try {
            if (path != null && !TextUtils.isEmpty(path)) {
                if (path.startsWith("rtsp") || path.startsWith("udp") || path.startsWith("rtp")) {
                    mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "infbuf", 1);
                    mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "rtsp_transport", "tcp");
                    mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "rtsp_flags", "prefer_tcp");
                    mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "probesize", 512 * 1000);
                    mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "analyzeduration", 2 * 1000 * 1000);
                } else if (!path.contains(".m3u8") && (path.contains(".mp4") || path.contains(".mkv") || path.contains(".avi"))) {
                    if (cacheEnabled) {
                        String cachePath = Path.ijk().getAbsolutePath();
                        String cacheMapPath = cachePath;
                        File cacheFile = new File(cachePath);
                        if (!cacheFile.exists()) cacheFile.mkdirs();
                        String tmpMd5 = Util.md5(path);
                        cachePath += tmpMd5 + ".file";
                        cacheMapPath += tmpMd5 + ".map";
                        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "cache_file_path", cachePath);
                        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "cache_map_path", cacheMapPath);
                        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "parse_cache_map", 1);
                        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "auto_save_map", 1);
                        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "cache_max_capacity", 60 * 1024 * 1024);
                        path = "ijkio:cache:ffio:" + path;
                    }
                }
            }
            setDataSourceHeader(headers);
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "protocol_whitelist", "ijkio,ffio,async,cache,crypto,file,dash,http,https,ijkhttphook,ijkinject,ijklivehook,ijklongurl,ijksegment,ijktcphook,pipe,rtp,tcp,tls,udp,ijkurlhook,data,concat,subfile,ffconcat");
        try {
            path = encodeSpaceChinese(path);
        } catch (Exception ignored) {
        }
        try {
            Uri uri = Uri.parse(path);
            if (ContentResolver.SCHEME_ANDROID_RESOURCE.equals(uri.getScheme())) {
                mMediaPlayer.setDataSource(RawDataSourceProvider.create(mAppContext, uri));
            } else {
                Map<String, String> copiedHeaders = headers == null ? null : new java.util.HashMap<>(headers);
                mMediaPlayer.setDataSource(mAppContext, uri, copiedHeaders);
            }
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void setDataSource(AssetFileDescriptor fd) {
        try {
            mMediaPlayer.setDataSource(new RawDataSourceProvider(fd));
        } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    private String encodeSpaceChinese(String str) throws UnsupportedEncodingException {
        Pattern p = Pattern.compile("[\u4e00-\u9fa5 ]+");
        Matcher m = p.matcher(str);
        StringBuffer b = new StringBuffer();
        while (m.find()) m.appendReplacement(b, URLEncoder.encode(m.group(0), "UTF-8"));
        m.appendTail(b);
        return b.toString();
    }

    private void setDataSourceHeader(Map<String, String> headers) {
        if (headers != null && !headers.isEmpty()) {
            Map<String, String> copiedHeaders = new LinkedHashMap<>(headers);
            String userAgent = copiedHeaders.get("User-Agent");
            if (!TextUtils.isEmpty(userAgent)) {
                mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "user_agent", userAgent);
                copiedHeaders.remove("User-Agent");
            }
            if (copiedHeaders.size() > 0) {
                StringBuilder sb = new StringBuilder();
                for (Map.Entry<String, String> entry : copiedHeaders.entrySet()) {
                    String value = entry.getValue();
                    if (!TextUtils.isEmpty(value)) {
                        sb.append(entry.getKey()).append(": ").append(value).append("\r\n");
                    }
                }
                mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "headers", sb.toString());
            }
        }
    }

    @Override
    public void pause() {
        try { mMediaPlayer.pause(); } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void start() {
        try { mMediaPlayer.start(); } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void stop() {
        try { mMediaPlayer.stop(); } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void prepareAsync() {
        try { mMediaPlayer.prepareAsync(); } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void reset() {
        if (mMediaPlayer == null) return;
        mMediaPlayer.reset();
        mMediaPlayer.setOnVideoSizeChangedListener(this);
        setOptions();
    }

    @Override
    public boolean isPlaying() { return mMediaPlayer != null && mMediaPlayer.isPlaying(); }

    @Override
    public void seekTo(long time) {
        try { mMediaPlayer.seekTo((int) time); } catch (Exception e) {
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void release() {
        mMediaPlayer.setOnErrorListener(null);
        mMediaPlayer.setOnCompletionListener(null);
        mMediaPlayer.setOnInfoListener(null);
        mMediaPlayer.setOnBufferingUpdateListener(null);
        mMediaPlayer.setOnPreparedListener(null);
        mMediaPlayer.setOnVideoSizeChangedListener(null);
        // 先置空再调用 native stop()，避免 native shutdown 期间其他线程仍持有引用导致竞态
        IjkMediaPlayer player = mMediaPlayer;
        mMediaPlayer = null;
        try {
            player.stop();
            player.reset();
            player.release();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    public long getCurrentPosition() { return mMediaPlayer != null ? mMediaPlayer.getCurrentPosition() : 0; }

    @Override
    public long getDuration() { return mMediaPlayer != null ? mMediaPlayer.getDuration() : -1; }

    @Override
    public int getBufferedPercentage() { return mBufferedPercent; }

    @Override
    public void setSurface(Surface surface) { if (mMediaPlayer != null) mMediaPlayer.setSurface(surface); }

    @Override
    public void setDisplay(SurfaceHolder holder) { if (mMediaPlayer != null) mMediaPlayer.setDisplay(holder); }

    @Override
    public void setVolume(float v1, float v2) { if (mMediaPlayer != null) mMediaPlayer.setVolume(v1, v2); }

    @Override
    public void setLooping(boolean isLooping) { if (mMediaPlayer != null) mMediaPlayer.setLooping(isLooping); }

    @Override
    public void setSpeed(float speed) { if (mMediaPlayer != null) mMediaPlayer.setSpeed(speed); }

    @Override
    public float getSpeed() { return mMediaPlayer != null ? mMediaPlayer.getSpeed() : 1.0f; }

    @Override
    public long getTcpSpeed() { return mMediaPlayer != null ? mMediaPlayer.getTcpSpeed() : 0; }

    @Override
    public boolean onError(IMediaPlayer mp, int what, int extra) {
        if (mEventListener != null) mEventListener.onError(-1, "播放地址加载失败");
        return true;
    }

    @Override
    public void onCompletion(IMediaPlayer mp) {
        if (mEventListener != null) mEventListener.onCompletion();
    }

    @Override
    public boolean onInfo(IMediaPlayer mp, int what, int extra) {
        if (mEventListener != null) mEventListener.onInfo(what, extra);
        return true;
    }

    @Override
    public void onBufferingUpdate(IMediaPlayer mp, int percent) {
        mBufferedPercent = percent;
    }

    @Override
    public void onPrepared(IMediaPlayer mp) {
        if (mEventListener != null) {
            mEventListener.onPrepared();
            if (!isVideo()) {
                mEventListener.onInfo(Player.PLAYER_INFO_RENDERING_START, 0);
            }
        }
    }

    private boolean isVideo() {
        IjkTrackInfo[] trackInfo = mMediaPlayer.getTrackInfo();
        if (trackInfo == null) return false;
        for (IjkTrackInfo info : trackInfo) {
            if (info.getTrackType() == ITrackInfo.MEDIA_TRACK_TYPE_VIDEO) return true;
        }
        return false;
    }

    @Override
    public void onVideoSizeChanged(IMediaPlayer mp, int width, int height, int sar_num, int sar_den) {
        int videoWidth = mp.getVideoWidth();
        int videoHeight = mp.getVideoHeight();
        if (videoWidth != 0 && videoHeight != 0 && mEventListener != null) {
            mEventListener.onVideoSizeChanged(videoWidth, videoHeight);
        }
    }

    @Override
    public boolean onNativeInvoke(int what, Bundle args) { return true; }

    @Override
    public void setTrack(@Nullable TrackInfoBean videoTrackBean) {
        if (videoTrackBean == null) return;
        if (videoTrackBean.selected) {
            selectTrack(videoTrackBean.type, videoTrackBean.trackId);
        } else {
            deselectTrackInternal(videoTrackBean.type, videoTrackBean.trackId);
        }
    }

    @Nullable
    @Override
    public TrackInfo getTrackInfo() {
        if (mMediaPlayer == null) return null;
        IjkTrackInfo[] trackInfo = mMediaPlayer.getTrackInfo();
        if (trackInfo == null) return null;
        TrackInfo data = new TrackInfo();
        int subtitleSelected = mMediaPlayer.getSelectedTrack(ITrackInfo.MEDIA_TRACK_TYPE_TIMEDTEXT);
        int audioSelected = mMediaPlayer.getSelectedTrack(ITrackInfo.MEDIA_TRACK_TYPE_AUDIO);
        int videoSelected = mMediaPlayer.getSelectedTrack(ITrackInfo.MEDIA_TRACK_TYPE_VIDEO);
        int index = 0;
        for (IjkTrackInfo info : trackInfo) {
            if (info.getTrackType() == ITrackInfo.MEDIA_TRACK_TYPE_AUDIO) {
                String trackName = (data.getAudio().size() + 1) + "：" + info.getInfoInline();
                TrackInfoBean t = new TrackInfoBean();
                t.name = trackName; t.type = info.getTrackType();
                t.language = info.getLanguage(); t.trackId = index;
                t.selected = index == audioSelected;
                data.addAudio(t);
            }
            if (info.getTrackType() == ITrackInfo.MEDIA_TRACK_TYPE_TIMEDTEXT) {
                String trackName = (data.getSubtitle().size() + 1) + "：" + info.getInfoInline();
                TrackInfoBean t = new TrackInfoBean();
                t.name = trackName; t.type = info.getTrackType();
                t.language = info.getLanguage(); t.trackId = index;
                t.selected = index == subtitleSelected;
                data.addSubtitle(t);
            }
            if (info.getTrackType() == ITrackInfo.MEDIA_TRACK_TYPE_VIDEO) {
                String trackName = (data.getVideo().size() + 1) + "：" + info.getInfoInline();
                TrackInfoBean t = new TrackInfoBean();
                t.name = trackName; t.type = info.getTrackType();
                t.language = info.getLanguage(); t.trackId = index;
                t.selected = index == videoSelected;
                data.addVideo(t);
            }
            index++;
        }
        return data;
    }

    @Override
    public void deselectTrack(@Nullable TrackInfoBean trackBean) {
        if (trackBean == null) return;
        deselectTrackInternal(trackBean.type, trackBean.trackId);
    }

    private void selectTrack(int type, int track) {
        if (mMediaPlayer == null) return;
        int selected = mMediaPlayer.getSelectedTrack(type);
        if (selected != track) {
            long position = getCurrentPosition();
            mMediaPlayer.selectTrack(track);
            if (position != 0) seekTo(position);
        }
    }

    private void deselectTrackInternal(int type, int track) {
        if (mMediaPlayer == null) return;
        int selected = mMediaPlayer.getSelectedTrack(type);
        if (selected == track) {
            long position = getCurrentPosition();
            mMediaPlayer.deselectTrack(track);
            if (position != 0) seekTo(position);
        }
    }

    @Override
    public void setAudioOnlyMode(boolean audioOnly) {
        mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "videotoolbox", audioOnly ? 0 : 1);
    }

    @Override
    public void setDecodeMode(boolean useHardware) {
        if (mMediaPlayer != null) {
            mMediaPlayer.setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec", useHardware ? 1 : 0);
        }
    }

    @Override
    public boolean isHardwareDecode() {
        return decoder.equals(CODEC_HARDWARE);
    }

    @Override
    public void setOnTimedTextListener(@Nullable final OnTimedTextListener listener) {
        if (listener == null) {
            mMediaPlayer.setOnTimedTextListener(null);
            return;
        }
        mMediaPlayer.setOnTimedTextListener(new IMediaPlayer.OnTimedTextListener() {
            @Override
            public void onTimedText(IMediaPlayer mp, IjkTimedText text) {
                if (text != null && text.getText() != null && !text.getText().isEmpty()) {
                    listener.onTimedText(text.getText());
                } else {
                    listener.onTimedTextCleared();
                }
            }
        });
    }
}
