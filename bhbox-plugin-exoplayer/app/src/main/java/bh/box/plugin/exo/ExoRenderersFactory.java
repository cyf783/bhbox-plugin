package bh.box.plugin.exo;

import android.content.Context;
import android.os.Handler;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.Renderer;
import androidx.media3.exoplayer.audio.AudioRendererEventListener;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.video.VideoRendererEventListener;

import java.util.ArrayList;

/**
 * EXO 渲染器工厂：把「视频解码策略」与「音频解码策略」拆开控制。
 * <p>
 * 为什么不能只用 {@code setExtensionRendererMode()}：该开关对视频、音频是同一个值，
 * 而两边的诉求相反 ——
 * <ul>
 *   <li>视频：解码方式要跟随用户配置（硬解 / 系统软解 / ffmpeg 软解）。</li>
 *   <li>音频：应当恒定「MediaCodec 优先 + ffmpeg 兜底」。AC3/EAC3/DTS 这类没有系统解码器的
 *       音轨需要 {@code FfmpegAudioRenderer} 兜底才有声；但若跟着视频一起切成 PREFER，
 *       连 AAC/AAC-LC 这种本来硬解得好好的音轨也会被拉去 CPU 软解，白白耗电。</li>
 * </ul>
 * 因此音频固定 {@code EXTENSION_RENDERER_MODE_ON}，只有视频跟随模式变化。
 */
@OptIn(markerClass = UnstableApi.class)
public final class ExoRenderersFactory extends DefaultRenderersFactory {

    /** MediaCodec 优先；ffmpeg 仅在 MediaCodec 不支持该格式时兜底 */
    public static final int MODE_HARDWARE = 0;
    /**
     * 软解码：ffmpeg 扩展渲染器插到 MediaCodec 之前优先使用；同时 MediaCodec 也按
     * PREFER_SOFTWARE 排序，因此 ffmpeg 不可用时（非 arm64 / so 加载失败）自动落到
     * 系统软件解码器（c2.android.*），再不行回落硬解 —— 不会起播失败。
     */
    public static final int MODE_SOFTWARE = 1;

    private final int mode;

    public ExoRenderersFactory(Context context, int mode) {
        super(context);
        this.mode = mode;
    }

    @Override
    protected void buildVideoRenderers(Context context, int extensionRendererMode,
                                       MediaCodecSelector mediaCodecSelector,
                                       boolean enableDecoderFallback, Handler eventHandler,
                                       VideoRendererEventListener eventListener,
                                       long allowedVideoJoiningTimeMs,
                                       ArrayList<Renderer> out) {
        // PREFER_SOFTWARE 是「排序」不是「过滤」：设备没有对应软解器时自然回落硬解
        MediaCodecSelector selector = mode == MODE_HARDWARE
                ? mediaCodecSelector
                : MediaCodecSelector.PREFER_SOFTWARE;
        super.buildVideoRenderers(context,
                mode == MODE_SOFTWARE ? EXTENSION_RENDERER_MODE_PREFER : EXTENSION_RENDERER_MODE_ON,
                selector,
                enableDecoderFallback, eventHandler, eventListener, allowedVideoJoiningTimeMs, out);
    }

    @Override
    protected void buildAudioRenderers(Context context, int extensionRendererMode,
                                       MediaCodecSelector mediaCodecSelector,
                                       boolean enableDecoderFallback, AudioSink audioSink,
                                       Handler eventHandler,
                                       AudioRendererEventListener eventListener,
                                       ArrayList<Renderer> out) {
        super.buildAudioRenderers(context, EXTENSION_RENDERER_MODE_ON, mediaCodecSelector,
                enableDecoderFallback, audioSink, eventHandler, eventListener, out);
    }
}
