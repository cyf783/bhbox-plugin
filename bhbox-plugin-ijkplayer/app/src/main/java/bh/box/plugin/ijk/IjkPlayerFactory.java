package bh.box.plugin.ijk;

import android.content.Context;

import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Plugin;

import java.util.Arrays;
import java.util.List;

import tv.danmaku.ijk.media.player.IjkMediaPlayer;

/**
 * IJK 播放器工厂（随插件 APK 加载，注册进宿主 Manager）。
 * 配置读取方式参考 NodeJsPlugin：从 PluginCache 读取 params，同时融合 PlayerConfig 运行时配置。
 */
public class IjkPlayerFactory implements PlayerFactory {

    public static final int ID = 1;

    private String mDecoder = CODEC_HARDWARE;
    private boolean mCacheEnabled = false;
    private int mLogLevel = IjkMediaPlayer.IJK_LOG_SILENT;

    public static final String CODEC_HARDWARE = "硬解码";
    public static final String CODEC_SOFTWARE = "软解码";

    @Override
    public int getId() {
        return ID;
    }

    @Override
    public String getName() {
        return "IJK";
    }

    @Override
    public Player create(Context context) {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(IjkPlugin.ID);
        if (bean != null && bean.getParams() != null) {
            for (ApkParam param : bean.getParams()) {
                switch (param.getId()) {
                    case "decoder":
                        mDecoder = param.getValue() != null ? param.getValue() : CODEC_HARDWARE;
                        break;
                    case "cache":
                        mCacheEnabled = Boolean.parseBoolean(param.getValue());
                        break;
                    case "logLevel":
                        mLogLevel = parseLogLevel(param.getValue());
                        break;
                }
            }
        }
        IjkPlayer.setLogLevel(mLogLevel);
        return new IjkPlayer(context, mDecoder, mCacheEnabled);
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
        IjkMediaPlayer.setDotPort(enable, port);
    }

    @Override
    public void toggleDotPort(boolean enable) {
        IjkMediaPlayer.toggleDotPort(enable);
    }

    private static int parseLogLevel(String value) {
        if (value == null) return IjkMediaPlayer.IJK_LOG_SILENT;
        switch (value) {
            case "错误": return IjkMediaPlayer.IJK_LOG_ERROR;
            case "警告": return IjkMediaPlayer.IJK_LOG_WARN;
            case "信息": return IjkMediaPlayer.IJK_LOG_INFO;
            case "调试": return IjkMediaPlayer.IJK_LOG_DEBUG;
            default: return IjkMediaPlayer.IJK_LOG_SILENT;
        }
    }
}
