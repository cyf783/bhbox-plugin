package bh.box.plugin.red;

import android.content.Context;

import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Plugin;

import java.util.Arrays;
import java.util.List;

/**
 * RedPlayer 播放器工厂（随插件 APK 加载，注册进宿主 Manager）。
 * 配置读取方式与 IJK/MPV 工厂一致：从 PluginCache 读取 params。
 */
public class RedPlayerFactory implements PlayerFactory {

    public static final int ID = 4;

    public static final String CODEC_HARDWARE = "硬解码";
    public static final String CODEC_SOFTWARE = "软解码";
    public static final String CACHE_ON = "开启";
    public static final String CACHE_OFF = "关闭";

    private String mDecoder = CODEC_HARDWARE;
    private String mCache = CACHE_OFF;

    @Override
    public int getId() {
        return ID;
    }

    @Override
    public String getName() {
        return "RED";
    }

    @Override
    public Player create(Context context) {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(RedPlugin.ID);
        if (bean != null && bean.getParams() != null) {
            for (ApkParam param : bean.getParams()) {
                switch (param.getId()) {
                    case "decoder":
                        mDecoder = CODEC_SOFTWARE.equals(param.getValue()) ? CODEC_SOFTWARE : CODEC_HARDWARE;
                        break;
                    case "cache":
                        mCache = CACHE_ON.equals(param.getValue()) ? CACHE_ON : CACHE_OFF;
                        break;
                }
            }
        }
        return new RedPlayer(context, mDecoder, mCache);
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
    public void setDotPort(boolean enable, int port) { /* RED 暂不支持 dot-port */ }

    @Override
    public void toggleDotPort(boolean enable) { /* RED 暂不支持 dot-port */ }
}
