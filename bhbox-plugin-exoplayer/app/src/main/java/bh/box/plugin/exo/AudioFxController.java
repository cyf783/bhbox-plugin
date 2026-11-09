package bh.box.plugin.exo;

import android.media.audiofx.AudioEffect;
import android.media.audiofx.BassBoost;
import android.media.audiofx.DynamicsProcessing;
import android.media.audiofx.Equalizer;
import android.media.audiofx.Virtualizer;
import android.os.Build;

import androidx.annotation.Nullable;

import com.github.catvod.utils.LOG;

/**
 * audiofx 音效链控制器：挂在 ExoPlayer 音频 session id 上，与解码渲染链解耦。
 * <p>
 * 为什么用 android.media.audiofx 而不是自定义 AudioProcessor 链：零新增依赖、API 9+、
 * 全机型一致；自定义链需 fork DefaultAudioSink 构建参数，风险收益不成比例。
 * <p>
 * 已知限制（物理约束，非 bug）：
 * <ul>
 *   <li>bitstream 直通输出（AC3/EAC3 passthrough、tunnel 模式）不经过本效果链，音效自动失效；</li>
 *   <li>效果器依赖设备 audiofx 实现，个别 OEM TV 静默 no-op，挂载结果会打日志便于排查。</li>
 * </ul>
 * 生命周期：session id 变更（路由切换、sink 重建）会多次回调 {@link #apply(int)}，
 * 内部先 release 再重建防泄漏；{@link #release()} 在播放器 release 时统一调用。
 */
final class AudioFxController {

    /** 音效预设 id（与 plugin.json sound_effect 参数 value 对应） */
    static final String OFF = "关闭";
    static final String CINEMA = "影院";
    static final String BASS = "重低音";
    static final String SURROUND = "3D环绕";
    static final String HIFI = "HiFi";
    static final String VOICE = "人声增强";

    /** 效果强度档位（与 plugin.json effect_strength 参数 value 对应） */
    static final String STRENGTH_LIGHT = "轻";
    static final String STRENGTH_STANDARD = "标准";
    static final String STRENGTH_STRONG = "强";

    /** strengthIndex → 缩放系数（基准预设值 × 系数，截断到效果器合法范围） */
    private static final float[] STRENGTH_SCALE = {0.6f, 1.0f, 1.4f};

    /** 标准十段中心频率（Hz），曲线定义点 */
    private static final float[] FREQ_GRID = {31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};
    /** 各预设十段增益（dB）；HiFi 全 0 = 平直参考（挂载不染色，作为后续微调起点） */
    private static final float[] EQ_CINEMA = {4, 3, 1, -1, -2, -1, 0, 1, 2, 3};
    private static final float[] EQ_BASS = {6, 6, 4, 1, 0, 0, 0, 0, 0, 0};
    private static final float[] EQ_SURROUND = {0, 0, 0, -1, -2, -2, -1, 0, 1, 1};
    private static final float[] EQ_HIFI = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
    private static final float[] EQ_VOICE = {-3, -3, -1, 0, 2, 3, 3, 2, 1, 1};

    /** BassBoost / Virtualizer 的 strength 合法范围（Android 文档固定值） */
    private static final short STRENGTH_MAX = 1000;

    private final String preset;
    private final int strengthIndex;
    /** 夜间模式：DynamicsProcessing 压限（仅 API 28+，低版本自动降级关闭） */
    private final boolean nightMode;

    @Nullable
    private Equalizer mEqualizer;
    @Nullable
    private BassBoost mBassBoost;
    @Nullable
    private Virtualizer mVirtualizer;
    @Nullable
    private DynamicsProcessing mDynamics;

    AudioFxController(String preset, String strength, boolean nightMode) {
        this.preset = preset == null || preset.isEmpty() ? OFF : preset;
        if (STRENGTH_LIGHT.equals(strength)) {
            this.strengthIndex = 0;
        } else if (STRENGTH_STRONG.equals(strength)) {
            this.strengthIndex = 2;
        } else {
            this.strengthIndex = 1;
        }
        this.nightMode = nightMode;
    }

    /** 是否有可挂载的效果（关闭档且无夜间模式时不占 audiofx 资源） */
    boolean isActive() {
        return !OFF.equals(preset) || nightMode;
    }

    /**
     * 挂载/重建效果链到指定 audio session。
     * audioSessionId=0（未就绪）忽略；已挂载链先释放再重建，保证 session 变更后效果仍生效。
     */
    void apply(int audioSessionId) {
        if (audioSessionId == 0) return;
        release();
        if (!isActive()) return;
        try {
            applyEq(audioSessionId);
            applyBass(audioSessionId);
            applyVirtualizer(audioSessionId);
            applyNightMode(audioSessionId);
            LOG.i("AudioFx preset=" + describe() + " nightMode=" + nightMode + " session=" + audioSessionId);
        } catch (Exception e) {
            // 效果器创建失败（OEM 裁剪 audiofx 等）不应影响播放，全链回滚
            LOG.e("AudioFx apply failed: " + e.getMessage());
            release();
        }
    }

    /** 释放全部效果器（幂等；session 重建与播放器 release 均走这里） */
    void release() {
        mEqualizer = releaseQuiet(mEqualizer);
        mBassBoost = releaseQuiet(mBassBoost);
        mVirtualizer = releaseQuiet(mVirtualizer);
        mDynamics = releaseQuiet(mDynamics);
    }

    private static <T extends AudioEffect> T releaseQuiet(@Nullable T effect) {
        if (effect == null) return null;
        try {
            effect.release();
        } catch (Exception ignored) {
        }
        return null;
    }

    /**
     * 均衡器：把十段标准曲线应用到设备 band。
     * 设备 band 数不定（5/10/…），按 getCenterFreq 就近插值，避免少段机型错频。
     */
    private void applyEq(int sessionId) {
        Equalizer eq = new Equalizer(0, sessionId);
        float[] curve = curveOf(preset);
        short[] range = eq.getBandLevelRange();
        short bands = eq.getNumberOfBands();
        for (short band = 0; band < bands; band++) {
            float hz = eq.getCenterFreq(band) / 1000f; // milliHz → Hz
            float db = interpolate(curve, hz) * STRENGTH_SCALE[strengthIndex];
            short milliDb = (short) Math.round(db * 100);
            if (milliDb < range[0]) milliDb = range[0];
            if (milliDb > range[1]) milliDb = range[1];
            try {
                eq.setBandLevel(band, milliDb);
            } catch (Exception e) {
                LOG.e("AudioFx eq band " + band + " failed: " + e.getMessage());
            }
        }
        eq.setEnabled(true);
        mEqualizer = eq;
    }

    private static float[] curveOf(String preset) {
        switch (preset) {
            case CINEMA:
                return EQ_CINEMA;
            case BASS:
                return EQ_BASS;
            case SURROUND:
                return EQ_SURROUND;
            case HIFI:
                return EQ_HIFI;
            case VOICE:
                return EQ_VOICE;
            default:
                return EQ_HIFI;
        }
    }

    /** 在 FREQ_GRID 上对曲线做线性插值（hz 低于 31 取首点，高于 16k 取尾点） */
    private static float interpolate(float[] curve, float hz) {
        if (hz <= FREQ_GRID[0]) return curve[0];
        for (int i = 1; i < FREQ_GRID.length; i++) {
            if (hz <= FREQ_GRID[i]) {
                float t = (hz - FREQ_GRID[i - 1]) / (FREQ_GRID[i] - FREQ_GRID[i - 1]);
                return curve[i - 1] + t * (curve[i] - curve[i - 1]);
            }
        }
        return curve[FREQ_GRID.length - 1];
    }

    /** 低频激励（‰）：仅 影院/重低音/3D环绕 挂载 */
    private void applyBass(int sessionId) {
        short base;
        switch (preset) {
            case CINEMA:
                base = 300;
                break;
            case BASS:
                base = 800;
                break;
            case SURROUND:
                base = 100;
                break;
            default:
                return;
        }
        BassBoost bass = new BassBoost(0, sessionId);
        bass.setStrength(scaleStrength(base));
        bass.setEnabled(true);
        mBassBoost = bass;
    }

    /** 虚拟环绕（‰）：仅 影院/重低音/3D环绕 挂载 */
    private void applyVirtualizer(int sessionId) {
        short base;
        switch (preset) {
            case CINEMA:
                base = 600;
                break;
            case BASS:
                base = 200;
                break;
            case SURROUND:
                base = 850;
                break;
            default:
                return;
        }
        Virtualizer vr = new Virtualizer(0, sessionId);
        vr.setStrength(scaleStrength(base));
        vr.setEnabled(true);
        mVirtualizer = vr;
    }

    private short scaleStrength(short base) {
        int scaled = Math.round(base * STRENGTH_SCALE[strengthIndex]);
        if (scaled < 0) scaled = 0;
        if (scaled > STRENGTH_MAX) scaled = STRENGTH_MAX;
        return (short) scaled;
    }

    /**
     * 夜间模式：单段压限器压低动态范围（爆炸声不炸耳、对白不糊）。
     * API 28+ 的 DynamicsProcessing；低版本无可用系统压限器，静默降级关闭。
     * 独立 try-catch：压限失败不应拖垮音效链其余部分。
     */
    private void applyNightMode(int sessionId) {
        if (!nightMode) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            LOG.i("AudioFx nightMode skipped: DynamicsProcessing requires API 28+ (current " + Build.VERSION.SDK_INT + ")");
            return;
        }
        // 部分 DSP 实现只支持频域变体（EffectDP: "variant 1 not available for creation"），
        // 时域优先失败时回退频域再试一次
        Exception firstError = null;
        for (int variant : new int[]{DynamicsProcessing.VARIANT_FAVOR_TIME_RESOLUTION,
                DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION}) {
            try {
                // 参数含义：variant / channelCount=立体声 / preEQ 关 / mbc 开·1 段 / postEQ 关 / limiter 关
                DynamicsProcessing.Config.Builder cfg = new DynamicsProcessing.Config.Builder(
                        variant, 2, false, 0, true, 1, false, 0, false);
                // MbcBand(enabled, cutoffHz, attackMs, releaseMs, ratio, threshold, kneeWidth, noiseGate, expanderRatio, preGain, postGain)
                DynamicsProcessing.MbcBand band = new DynamicsProcessing.MbcBand(
                        true, 20000f, 10f, 120f, 4f, -24f, 0f, -90f, 1f, 0f, 0f);
                DynamicsProcessing.Mbc mbc = new DynamicsProcessing.Mbc(true, true, 1);
                mbc.setBand(0, band);
                cfg.setMbcAllChannelsTo(mbc);
                cfg.setPreferredFrameDuration(10f);
                DynamicsProcessing dp = new DynamicsProcessing(0, sessionId, cfg.build());
                dp.setEnabled(true);
                mDynamics = dp;
                if (firstError != null) {
                    LOG.i("AudioFx nightMode fallback variant=" + variant + " ok");
                }
                return;
            } catch (Exception e) {
                if (firstError == null) firstError = e;
                LOG.e("AudioFx nightMode variant=" + variant + " failed: " + e.getMessage());
            }
        }
    }

    /** 诊断日志用 */
    private String describe() {
        return preset + "/strength=" + strengthIndex;
    }
}
