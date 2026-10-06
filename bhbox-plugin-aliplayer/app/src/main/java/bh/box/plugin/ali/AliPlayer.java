package bh.box.plugin.ali;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;

import androidx.annotation.Nullable;

import com.aliyun.player.AliPlayerGlobalSettings;
import com.aliyun.player.IPlayer;
import com.aliyun.player.bean.ErrorInfo;
import com.aliyun.player.bean.InfoBean;
import com.aliyun.player.bean.InfoCode;
import com.aliyun.player.nativeclass.MediaInfo;
import com.aliyun.player.nativeclass.PlayerConfig;
import com.aliyun.player.source.UrlSource;
import com.github.catvod.plugin.player.TrackInfo;
import com.github.catvod.plugin.player.bean.TrackInfoBean;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Util;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class AliPlayer extends Player
        implements IPlayer.OnErrorListener,
                   IPlayer.OnCompletionListener,
                   IPlayer.OnInfoListener,
                   IPlayer.OnPreparedListener,
                   IPlayer.OnStateChangedListener,
                   IPlayer.OnVideoSizeChangedListener,
                   IPlayer.OnLoadingStatusListener,
                   IPlayer.OnSeekCompleteListener,
                   IPlayer.OnSubtitleDisplayListener {

    private static final String TAG = "AliPlayer";

    private final Context mAppContext;
    private final boolean mHardwareDecode;

    private com.aliyun.player.AliPlayer mMediaPlayer;
    private OnTimedTextListener mTimedTextListener;
    private final Map<String, String> mHeaders = new HashMap<>();
    private UrlSource mMediaSource;
    private long mCurrentPosition = 0;
    private int mBufferPercent = 0;
    private long mNetSpeedLong = 0;
    private boolean mIsWaitingSeek = false;
    private int mPlayState = IPlayer.unknow;
    private MediaInfo mMediaInfo;
    private int mPendingSubtitleId = -1;
    // HLS 内嵌字幕走 addExtSubtitle 通道（5.4.6 的 selectTrack 对 webvtt rendition 无效）
    private final Map<Integer, String> mExtSubtitleUrls = new HashMap<>();
    private final Map<Integer, Integer> mAddedExtSubtitles = new HashMap<>();
    private boolean mSubtitleUrlsResolved = false;
    private boolean mResolvingSubtitleUrls = false;
    private int mActiveExtSubtitleIdx = -1;
    private int mAddingExtNativeIdx = -1;

    public AliPlayer(Context context, String decoder) {
        mAppContext = context.getApplicationContext();
        mHardwareDecode = AliPlayerFactory.CODEC_HARDWARE.equals(decoder);
    }

    @Override
    public void initPlayer() {
        Log.i(TAG, "initPlayer, hardwareDecode=" + mHardwareDecode);
        mMediaPlayer = com.aliyun.player.AliPlayerFactory.createAliPlayer(mAppContext);
        AliPlayerGlobalSettings.setUseHttp2(true);
        setOptions();
        registerListeners();
    }

    private void registerListeners() {
        mMediaPlayer.setOnErrorListener(this);
        mMediaPlayer.setOnCompletionListener(this);
        mMediaPlayer.setOnInfoListener(this);
        mMediaPlayer.setOnPreparedListener(this);
        mMediaPlayer.setOnVideoSizeChangedListener(this);
        mMediaPlayer.setOnStateChangedListener(this);
        mMediaPlayer.setOnSeekCompleteListener(this);
        mMediaPlayer.setOnSubtitleDisplayListener(this);
    }


    @Override
    public void setOptions() {
        mMediaPlayer.selectTrack(com.aliyun.player.nativeclass.TrackInfo.AUTO_SELECT_INDEX);
        mMediaPlayer.enableHardwareDecoder(mHardwareDecode);
        mMediaPlayer.setAutoPlay(true);
    }

    @Override
    public void setDataSource(String path, Map<String, String> headers) {
        if (path == null) return;
        Log.i(TAG, "setDataSource: " + path);
        if (headers != null) {
            mHeaders.clear();
            mHeaders.putAll(headers);
        }
        mMediaSource = new UrlSource();
        mMediaSource.setUri(path);
    }

    @Override
    public void setDataSource(AssetFileDescriptor fd) {
        if (mEventListener != null) {
            mEventListener.onError(-1, "AliYunPlayer 不支持 AssetFileDescriptor 数据源");
        }
    }

    @Override
    public void prepareAsync() {
        Log.i(TAG, "prepareAsync");
        try {
            if (mMediaPlayer == null) throw new IllegalStateException("player not initialized");
            if (!mHeaders.isEmpty() && mMediaPlayer.getConfig() != null) {
                String[] itemsArray = new String[mHeaders.size()];
                int i = 0;
                PlayerConfig config = mMediaPlayer.getConfig();
                for (Map.Entry<String, String> entry : mHeaders.entrySet()) {
                    if (TextUtils.equals(entry.getKey(), "User-Agent")) {
                        config.mUserAgent = entry.getValue();
                    } else {
                        itemsArray[i++] = entry.getKey() + ":" + entry.getValue();
                    }
                }
                config.setCustomHeaders(itemsArray);
                mMediaPlayer.setConfig(config);
            }
            mMediaPlayer.setDataSource(mMediaSource);
            mMediaPlayer.prepare();
            mIsWaitingSeek = false;
        } catch (IllegalStateException e) {
            Log.e(TAG, "prepareAsync failed", e);
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void start() {
        if (mMediaPlayer == null) return;
        try {
            mMediaPlayer.start();
        } catch (IllegalStateException e) {
            Log.e(TAG, "start failed", e);
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void pause() {
        if (mMediaPlayer == null) return;
        try {
            mMediaPlayer.pause();
        } catch (IllegalStateException e) {
            Log.e(TAG, "pause failed", e);
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void stop() {
        try {
            if (mMediaPlayer == null) return;
            mMediaPlayer.stop();
        } catch (IllegalStateException ignored) {}
    }

    @Override
    public void reset() {
        if (mMediaPlayer != null) {
            stop();
            mMediaPlayer.release();
            mMediaPlayer = null;
        }
        mMediaSource = null;
        mMediaInfo = null;
        mPlayState = IPlayer.unknow;
        mPendingSubtitleId = -1;
        mExtSubtitleUrls.clear();
        mAddedExtSubtitles.clear();
        mSubtitleUrlsResolved = false;
        mResolvingSubtitleUrls = false;
        mActiveExtSubtitleIdx = -1;
        mAddingExtNativeIdx = -1;
        mBufferPercent = 0;
        mCurrentPosition = 0;
    }

    @Override
    public boolean isPlaying() {
        if (mMediaPlayer == null) return false;
        return mPlayState == IPlayer.started;
    }

    @Override
    public void seekTo(long time) {
        try {
            if (mMediaPlayer == null) return;
            if (time < 0 || time > getDuration()) return;
            mIsWaitingSeek = true;
            mMediaPlayer.seekTo(time);
        } catch (IllegalStateException e) {
            Log.e(TAG, "seekTo failed", e);
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    @Override
    public void release() {
        if (mMediaPlayer != null) {
            mMediaPlayer.setOnErrorListener(null);
            mMediaPlayer.setOnCompletionListener(null);
            mMediaPlayer.setOnInfoListener(null);
            mMediaPlayer.setOnLoadingStatusListener(null);
            mMediaPlayer.setOnStateChangedListener(null);
            mMediaPlayer.setOnPreparedListener(null);
            mMediaPlayer.setOnVideoSizeChangedListener(null);
            mMediaPlayer.setOnSubtitleDisplayListener(null);
            reset();
        }
    }

    @Override
    public long getCurrentPosition() {
        if (mMediaPlayer == null) return 0;
        return mCurrentPosition;
    }

    @Override
    public long getDuration() {
        if (mMediaPlayer == null) return 0;
        long duration = mMediaPlayer.getDuration();
        return duration < 0 ? 0 : duration;
    }

    @Override
    public int getBufferedPercentage() { return mBufferPercent; }

    @Override
    public void setSurface(Surface surface) {
        if (mMediaPlayer == null) return;
        if (surface != null && !surface.isValid()) return;
        mMediaPlayer.setSurface(surface);
    }

    @Override
    public void setDisplay(SurfaceHolder holder) {
        if (holder == null) setSurface(null);
        else setSurface(holder.getSurface());
    }

    @Override
    public void setVolume(float v1, float v2) {
        if (mMediaPlayer != null) mMediaPlayer.setVolume((v1 + v2) / 2);
    }

    @Override
    public void setLooping(boolean isLooping) {
        if (mMediaPlayer != null) mMediaPlayer.setLoop(isLooping);
    }

    @Override
    public void setSpeed(float speed) {
        if (mMediaPlayer != null) mMediaPlayer.setSpeed(speed);
    }

    @Override
    public void setOnTimedTextListener(@Nullable OnTimedTextListener listener) {
        mTimedTextListener = listener;
    }

    @Override
    public float getSpeed() {
        if (mMediaPlayer == null) return 1.0f;
        return mMediaPlayer.getSpeed();
    }

    @Override
    public long getTcpSpeed() {
        return mNetSpeedLong > 0 ? mNetSpeedLong / 10L : Util.getNetSpeed(mAppContext);
    }

    @Override
    public void setDecodeMode(boolean useHardware) {
        if (mMediaPlayer != null) mMediaPlayer.enableHardwareDecoder(useHardware);
    }

    @Override
    public boolean isHardwareDecode() { return mHardwareDecode; }

    @Override
    public void setAudioOnlyMode(boolean audioOnly) { /* AliYunPlayer 无纯音频模式 API */ }

    @Override
    public void setTrack(@Nullable TrackInfoBean track) {
        if (track == null || mMediaPlayer == null) return;
        Log.e(TAG, "setTrack: id=" + track.trackId + ", type=" + track.type + ", name=" + track.name);
        try {
            if (track.type == 2) {
                requestSubtitle(track.trackId);
            }else{
                mMediaPlayer.selectTrack(track.trackId);
            }
        } catch (Exception e) {
            Log.e(TAG, "setTrack failed", e);
            if (mEventListener != null) mEventListener.onError(-1, Util.getRootCauseMessage(e));
        }
    }

    /**
     * Ali SDK 5.4.6 对 HLS 内嵌 webvtt 字幕轨：prepared 时已默认标记选中，
     * 重复 selectTrack 同轨会被静默忽略且字幕数据流不启动；
     * 先切到其他字幕轨再切回目标，强制触发真实切换以启动字幕加载。
     */
    private void forceSelectSubtitle(int targetId) {
        // 回退走原生 selectTrack 时先关闭激活的 ext 字幕，防止双字幕叠加及状态残留
        if (mActiveExtSubtitleIdx >= 0) {
            try {
                mMediaPlayer.selectExtSubtitle(mActiveExtSubtitleIdx, false);
            } catch (Exception ignored) {}
            mActiveExtSubtitleIdx = -1;
        }
        com.aliyun.player.nativeclass.TrackInfo cur =
                mMediaPlayer.currentTrack(com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE);
        if (cur == null || cur.getIndex() != targetId) {
            mMediaPlayer.selectTrack(targetId);
            return;
        }
        int otherId = -1;
        if (mMediaInfo != null) {
            for (com.aliyun.player.nativeclass.TrackInfo info : mMediaInfo.getTrackInfos()) {
                if (info.getType() == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE
                        && info.getIndex() != targetId) {
                    otherId = info.getIndex();
                    break;
                }
            }
        }
        if (otherId >= 0) {
            Log.e(TAG, "forceSelectSubtitle: " + targetId + " is current, switch to " + otherId + " then back");
            mMediaPlayer.selectTrack(otherId);
            mMediaPlayer.selectTrack(targetId);
        } else {
            Log.e(TAG, "forceSelectSubtitle: no other subtitle track, select " + targetId);
            mMediaPlayer.selectTrack(targetId);
        }
    }

    /** 字幕轨切换入口：优先走 ext 字幕通道，解析中挂起，失败回退 selectTrack */
    private void requestSubtitle(int nativeIdx) {
        if (mMediaPlayer == null) return;
        if (mExtSubtitleUrls.containsKey(nativeIdx)) {
            applyExtSubtitle(nativeIdx);
            return;
        }
        if (!mSubtitleUrlsResolved) {
            mPendingSubtitleId = nativeIdx;
            resolveSubtitleUrls();
            return;
        }
        Log.e(TAG, "requestSubtitle: fallback to selectTrack " + nativeIdx);
        forceSelectSubtitle(nativeIdx);
    }

    /** 解析 master playlist 中 EXT-X-MEDIA TYPE=SUBTITLES 的 URI（按声明顺序对应 native 字幕轨） */
    private void resolveSubtitleUrls() {
        if (mSubtitleUrlsResolved || mResolvingSubtitleUrls) return;
        final String masterUrl = mMediaSource == null ? null : mMediaSource.getUri();
        boolean hasSub = false;
        if (mMediaInfo != null) {
            for (com.aliyun.player.nativeclass.TrackInfo info : mMediaInfo.getTrackInfos()) {
                if (info.getType() == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE) {
                    hasSub = true;
                    break;
                }
            }
        }
        if (!hasSub || masterUrl == null || !masterUrl.startsWith("http")) {
            mSubtitleUrlsResolved = true;
            return;
        }
        mResolvingSubtitleUrls = true;
        final String ua = mHeaders.get("User-Agent");
        new Thread(() -> {
            try {
                List<String> uris = parseSubtitleRenditionUris(fetchText(masterUrl, ua));
                URI base = URI.create(masterUrl);
                List<com.aliyun.player.nativeclass.TrackInfo> subs = new ArrayList<>();
                for (com.aliyun.player.nativeclass.TrackInfo info : mMediaInfo.getTrackInfos()) {
                    if (info.getType() == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE) subs.add(info);
                }
                for (int i = 0; i < subs.size() && i < uris.size(); i++) {
                    String resolved;
                    try {
                        resolved = String.valueOf(base.resolve(uris.get(i)));
                    } catch (Exception e) {
                        resolved = uris.get(i);
                    }
                    // 5.4.6 addExtSubtitle 仅支持单文件字幕（vtt/srt），不支持 m3u8 playlist；
                    // 字幕 playlist 若只含单个分段，改用分段文件地址
                    if (resolved.contains(".m3u8")) {
                        try {
                            List<String> segs = parseSegmentUris(fetchText(resolved, ua));
                            if (segs.size() == 1) {
                                try {
                                    resolved = String.valueOf(new URI(resolved).resolve(segs.get(0)));
                                } catch (Exception ignored) {}
                                Log.e(TAG, "resolveSubtitleUrls: use segment " + resolved);
                            } else if (segs.size() > 1) {
                                Log.e(TAG, "resolveSubtitleUrls: " + segs.size() + " segments, keep m3u8");
                            }
                        } catch (Exception e) {
                            Log.e(TAG, "resolveSubtitleUrls: fetch subtitle playlist failed", e);
                        }
                    }
                    mExtSubtitleUrls.put(subs.get(i).getIndex(), resolved);
                }
                Log.e(TAG, "resolveSubtitleUrls: " + mExtSubtitleUrls);
            } catch (Exception e) {
                Log.e(TAG, "resolveSubtitleUrls failed", e);
            } finally {
                mResolvingSubtitleUrls = false;
                mSubtitleUrlsResolved = true;
            }
            new Handler(Looper.getMainLooper()).post(() -> {
                if (mMediaPlayer == null) return;
                if (mPendingSubtitleId >= 0) {
                    int id = mPendingSubtitleId;
                    mPendingSubtitleId = -1;
                    if (mExtSubtitleUrls.containsKey(id)) applyExtSubtitle(id);
                    else forceSelectSubtitle(id);
                }
            });
        }, "ali-sub-resolve").start();
    }

    private static String fetchText(String url, String ua) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        if (ua != null && !ua.isEmpty()) conn.setRequestProperty("User-Agent", ua);
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private static List<String> parseSubtitleRenditionUris(String masterText) {
        List<String> uris = new ArrayList<>();
        for (String line : masterText.split("\n")) {
            line = line.trim();
            if (line.startsWith("#EXT-X-MEDIA:") && line.contains("TYPE=SUBTITLES")) {
                java.util.regex.Matcher m =
                        java.util.regex.Pattern.compile("URI=\"([^\"]+)\"").matcher(line);
                if (m.find()) uris.add(m.group(1));
            }
        }
        return uris;
    }

    private static List<String> parseSegmentUris(String playlistText) {
        List<String> uris = new ArrayList<>();
        for (String line : playlistText.split("\n")) {
            line = line.trim();
            if (!line.isEmpty() && !line.startsWith("#")) uris.add(line);
        }
        return uris;
    }

    /** 启用指定内嵌字幕轨对应的 ext 字幕：已添加过的直接启用，否则 addExtSubtitle */
    private void applyExtSubtitle(int nativeIdx) {
        if (mMediaPlayer == null) return;
        String url = mExtSubtitleUrls.get(nativeIdx);
        if (url == null) return;
        Integer addedIdx = mAddedExtSubtitles.get(nativeIdx);
        if (mActiveExtSubtitleIdx >= 0 && (addedIdx == null || addedIdx != mActiveExtSubtitleIdx)) {
            try {
                mMediaPlayer.selectExtSubtitle(mActiveExtSubtitleIdx, false);
            } catch (Exception ignored) {}
            mActiveExtSubtitleIdx = -1;
        }
        if (addedIdx != null) {
            Log.e(TAG, "applyExtSubtitle: enable ext " + addedIdx + " for native " + nativeIdx);
            mMediaPlayer.selectExtSubtitle(addedIdx, true);
            mActiveExtSubtitleIdx = addedIdx;
        } else {
            Log.e(TAG, "applyExtSubtitle: addExtSubtitle " + url);
            mAddingExtNativeIdx = nativeIdx;
            mMediaPlayer.addExtSubtitle(url);
        }
    }

    @Override
    public void deselectTrack(@Nullable TrackInfoBean track) { /* AliYunPlayer 不支持取消选择轨道 */ }

    public TrackInfo getTrackInfo() {
        if (mMediaPlayer == null || mMediaInfo == null) return null;
        TrackInfo data = new TrackInfo();
        com.aliyun.player.nativeclass.TrackInfo currentSubtitle =
                mMediaPlayer.currentTrack(com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE);
        // 字幕走 ext 通道切换时 currentTrack 不反映实际显示轨，用激活映射反查修正
        if (mActiveExtSubtitleIdx >= 0) {
            for (Map.Entry<Integer, Integer> e : mAddedExtSubtitles.entrySet()) {
                if (e.getValue() == mActiveExtSubtitleIdx) {
                    for (com.aliyun.player.nativeclass.TrackInfo info : mMediaInfo.getTrackInfos()) {
                        if (info.getType() == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE
                                && info.getIndex() == e.getKey()) {
                            currentSubtitle = info;
                            break;
                        }
                    }
                    break;
                }
            }
        }
        com.aliyun.player.nativeclass.TrackInfo currentAudio =
                mMediaPlayer.currentTrack(com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_AUDIO);
        com.aliyun.player.nativeclass.TrackInfo currentVideo =
                mMediaPlayer.currentTrack(com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_VIDEO);
        for (com.aliyun.player.nativeclass.TrackInfo info : mMediaInfo.getTrackInfos()) {
            com.aliyun.player.nativeclass.TrackInfo.Type type = info.getType();
            if (type == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE) {
                //字幕
                String trackName = (data.getSubtitle().size() + 1) + "：" + info.getDescription();
                TrackInfoBean t = new TrackInfoBean();
                t.name = trackName;
                t.type = 2;
                t.language = info.getSubtitleLang();
                t.trackId = info.getIndex();
                currentSubtitle = currentSubtitle==null ? info : currentSubtitle;
                t.selected = info.getIndex()==currentSubtitle.getIndex();
                data.addSubtitle(t);
            } else if (type == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_AUDIO) {
                //音轨
                String trackName = (data.getAudio().size() + 1) + "：" + info.getDescription();
                TrackInfoBean t = new TrackInfoBean();
                t.name = trackName;
                t.type = 1;
                t.language = info.getAudioLang();
                t.trackId = info.getIndex();
                currentAudio = currentAudio==null ? info : currentAudio;
                t.selected = info.getIndex()==currentAudio.getIndex();
                data.addAudio(t);
            } else if (type == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_VIDEO
                || type == com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_VOD) {
                //视轨
                TrackInfoBean t = new TrackInfoBean();
                t.type = 3;
                t.trackId = info.getIndex();
                currentVideo = currentVideo==null ? info : currentVideo;
                t.selected = info.getIndex()==currentVideo.getIndex();
                if (info.getVideoBitrate() > 0) {
                    t.name = (info.getVideoBitrate() / 1000) + "kbps";
                } else if (!TextUtils.isEmpty(info.getVodDefinition())) {
                    t.name = info.getVodDefinition();
                } else {
                    t.name = "\uFF1A\u672a\u77e5";
                }
                data.addVideo(t);
            }
        }
        return data;
    }

    @Override
    public void onError(ErrorInfo errorInfo) {
        Log.e(TAG, "onError: code=" + errorInfo.getCode().getValue() + ", msg=" + errorInfo.getMsg());
        stop();
        if (mEventListener != null) mEventListener.onError(errorInfo.getCode().getValue(), errorInfo.getMsg());
    }

    @Override
    public void onCompletion() {
        Log.i(TAG, "onCompletion");
        stop();
        if (mEventListener != null) mEventListener.onCompletion();
    }

    @Override
    public void onInfo(InfoBean infoBean) {
        if (mIsWaitingSeek) return;
        InfoCode code = infoBean.getCode();
        long value = infoBean.getExtraValue();
        if (code == InfoCode.CurrentDownloadSpeed) {
            mNetSpeedLong = value;
        } else if (code == InfoCode.CurrentPosition) {
            mCurrentPosition = value;
        }
    }

    @Override
    public void onPrepared() {
        Log.i(TAG, "onPrepared");
        start();
        mMediaInfo = mMediaPlayer.getMediaInfo();
        if (mEventListener != null) {
            mEventListener.onPrepared();
            mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
        }
        com.aliyun.player.nativeclass.TrackInfo currentSubtitle =
                mMediaPlayer.currentTrack(com.aliyun.player.nativeclass.TrackInfo.Type.TYPE_SUBTITLE);
        if (currentSubtitle != null) requestSubtitle(currentSubtitle.getIndex());
    }

    @Override
    public void onVideoSizeChanged(int width, int height) {
        if (width != 0 && height != 0 && mEventListener != null) mEventListener.onVideoSizeChanged(width, height);
    }

    @Override
    public void onStateChanged(int state) {
        mPlayState = state;
        if (state == IPlayer.started) {
            if (mEventListener != null) mEventListener.onInfo(PLAYER_INFO_RENDERING_START, 0);
        } else if (state == IPlayer.completion) {
            if (mEventListener != null) mEventListener.onCompletion();
        }
    }

    @Override
    public void onLoadingBegin() {
        if (mEventListener != null) mEventListener.onInfo(PLAYER_INFO_BUFFERING_START, mBufferPercent);
    }

    @Override
    public void onLoadingProgress(int percent, float netSpeed) { mBufferPercent = percent; }

    @Override
    public void onLoadingEnd() {
        if (mEventListener != null) mEventListener.onInfo(PLAYER_INFO_BUFFERING_END, mBufferPercent);
    }

    @Override
    public void onSeekComplete() { mIsWaitingSeek = false; }

    @Override
    public void onSubtitleExtAdded(int trackIndex, String url) {
        Log.e(TAG, "onSubtitleExtAdded: index=" + trackIndex + ", url=" + url);
        if (trackIndex < 0) {
            // addExtSubtitle 失败（负 index 为错误码），移除映射让后续走 selectTrack 回退
            int nativeIdx = mAddingExtNativeIdx;
            mAddingExtNativeIdx = -1;
            if (nativeIdx >= 0) mExtSubtitleUrls.remove(nativeIdx);
            Log.e(TAG, "onSubtitleExtAdded: add failed for native " + nativeIdx);
            return;
        }
        if (mMediaPlayer == null) return;
        if (mAddingExtNativeIdx >= 0) {
            mAddedExtSubtitles.put(mAddingExtNativeIdx, trackIndex);
            mAddingExtNativeIdx = -1;
        }
        mMediaPlayer.selectExtSubtitle(trackIndex, true);
        mActiveExtSubtitleIdx = trackIndex;
    }

    @Override
    public void onSubtitleShow(int trackIndex, long id, String text) {
        Log.e(TAG, "onSubtitleShow: " + text);
        if (mTimedTextListener == null) return;
        if (text != null && !text.isEmpty()) {
            mTimedTextListener.onTimedText(text);
        } else {
            mTimedTextListener.onTimedTextCleared();
        }
    }

    @Override
    public void onSubtitleHide(int trackIndex, long id) {
        if (mTimedTextListener != null) mTimedTextListener.onTimedTextCleared();
    }

    @Override
    public void onSubtitleHeader(int trackIndex, String header) {
        Log.e(TAG, "onSubtitleHeader: index=" + trackIndex);
    }
}