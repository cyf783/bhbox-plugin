package bh.box.plugin.exo;

import androidx.annotation.NonNull;
import androidx.media3.common.C;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;

import java.io.IOException;

/**
 * HLS 加载错误策略：切片出错时快速重试，且不换码率（fallback）。
 * <p>
 * 说清楚它实际做了什么，别被「跳过坏切片」这几个字误导：
 * <ul>
 *   <li>{@link #getRetryDelayMsFor} —— 切片错误 500ms 就重试（默认 1000ms），起播/恢复更快。</li>
 *   <li>{@link #getFallbackSelectionFor} 返回 null —— 出错时不切 variant。默认行为是换个码率重试，
 *       而换码率意味着重新缓冲 + 分辨率跳变；网络抖动时来回切码率比原地重试更难受。
 *       <b>它不会「跳过坏切片」</b>：重试耗尽后照样按错误处理，坏得厉害的源救不回来。</li>
 * </ul>
 */
public class HlsErrorHandlingPolicy extends DefaultLoadErrorHandlingPolicy {

    private static final int MAX_RETRIES = 3;
    private static final long RETRY_DELAY_MS = 500;

    @Override
    public long getRetryDelayMsFor(@NonNull LoadErrorInfo loadErrorInfo) {
        if (isChunkError(loadErrorInfo)) {
            return RETRY_DELAY_MS;
        }
        return super.getRetryDelayMsFor(loadErrorInfo);
    }

    @Override
    public int getMinimumLoadableRetryCount(int dataType) {
        // 注：HLS 分片走的就是 DATA_TYPE_MEDIA，默认最小重试次数本来就是 3，
        // 这里写出来只是为了把「最多 3 次」这件事固定下来，防止上游默认值调整后行为漂移。
        if (dataType == C.DATA_TYPE_MEDIA) {
            return MAX_RETRIES;
        }
        return super.getMinimumLoadableRetryCount(dataType);
    }

    @Override
    public FallbackSelection getFallbackSelectionFor(@NonNull FallbackOptions fallbackOptions,
                                                    @NonNull LoadErrorInfo loadErrorInfo) {
        if (isChunkError(loadErrorInfo)) {
            // null = 不使用 fallback（不换码率），ExoPlayer 原地重试该切片
            return null;
        }
        return super.getFallbackSelectionFor(fallbackOptions, loadErrorInfo);
    }

    private boolean isChunkError(@NonNull LoadErrorInfo loadErrorInfo) {
        // 网络错误、404 等 IO 异常才走上面的策略；其它（如解码错误）交回默认实现
        return loadErrorInfo.exception instanceof IOException;
    }
}
