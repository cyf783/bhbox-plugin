package bh.box.plugin.exo;

import android.content.Context;

import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Plugin;

import java.util.Arrays;
import java.util.List;

/**
 * EXO 播放器工厂（随插件 APK 加载，注册进宿主 Manager）。
 * 配置读取方式同 IjkPlayerFactory：从 PluginCache 读取 params。
 */
public class ExoPlayerFactory implements PlayerFactory {

    public static final int ID = 2;

    public static final String CODEC_HARDWARE = "硬解码";
    /**
     * 软解码 = ffmpeg 扩展渲染器优先（CPU 解码，性能开销大，仅在硬解异常时选用）。
     * ffmpeg 不可用时（非 arm64 / so 加载失败）自动退化为 MediaCodec 软解器排序，不会起播失败。
     */
    public static final String CODEC_SOFTWARE = "软解码";

    private String mDecoder = CODEC_HARDWARE;
    private boolean mTunnel = false;

    /** 配置值 → ExoRenderersFactory.MODE_* */
    private static int modeOf(String decoder) {
        if (CODEC_SOFTWARE.equals(decoder)) return ExoRenderersFactory.MODE_SOFTWARE;
        return ExoRenderersFactory.MODE_HARDWARE;
    }

    @Override
    public int getId() {
        return ID;
    }

    @Override
    public String getName() {
        return "EXO";
    }

    @Override
    public Player create(Context context) {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(ExoPlugin.ID);
        if (bean != null && bean.getParams() != null) {
            for (ApkParam param : bean.getParams()) {
                switch (param.getId()) {
                    case "decoder":
                        mDecoder = param.getValue() != null ? param.getValue() : CODEC_HARDWARE;
                        break;
                    case "tunnel":
                        mTunnel = Boolean.parseBoolean(param.getValue());
                        break;
                }
            }
        }
        return new ExoMediaPlayer(context, modeOf(mDecoder), mTunnel);
    }

    @Override
    public List<String> decoders() {
        return Arrays.asList(CODEC_HARDWARE, CODEC_SOFTWARE);
    }

    @Override
    public void setDecoder(String decoder) {
        this.mDecoder = decoder;
    }

    @Override
    public void setDotPort(boolean enable, int port) {
    }

    @Override
    public void toggleDotPort(boolean enable) {
    }
}
