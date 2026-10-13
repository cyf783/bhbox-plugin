package bh.box.plugin.mdk;

import android.content.Context;

import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.utils.Plugin;

import java.util.Arrays;
import java.util.List;

/**
 * MDK 播放器工厂（随插件 APK 加载，注册进宿主 Manager，ID=7）。
 * 配置读取方式与 IjkPlayerFactory 一致：从 PluginCache 读取 plugin.json params。
 */
public class MdkPlayerFactory implements PlayerFactory<MdkPlayer> {

    /** 宿主固定分配：IJK=1、EXO=2、MPV=3、RED=4、ALI=5、VLC=6（预留），MDK=7，与用户播放配置持久化绑定 */
    public static final int ID = 7;

    private String mDecoder = MdkPlayer.CODEC_HARDWARE;

    @Override
    public int getId() {
        return ID;
    }

    @Override
    public String getName() {
        return "MDK";
    }

    @Override
    public MdkPlayer create(Context context) {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(MdkPlugin.ID);
        if (bean != null && bean.getParams() != null) {
            for (ApkParam param : bean.getParams()) {
                switch (param.getId()) {
                    case "decoder":
                        mDecoder = param.getValue() != null ? param.getValue() : MdkPlayer.CODEC_HARDWARE;
                        break;
                    case "logLevel":
                        MdkPlugin.applyLogLevel(param.getValue());
                        break;
                }
            }
        }
        return new MdkPlayer(context, mDecoder);
    }

    @Override
    public List<String> decoders() {
        return Arrays.asList(MdkPlayer.CODEC_HARDWARE, MdkPlayer.CODEC_SOFTWARE);
    }

    @Override
    public void setDecoder(String decoder) {
        this.mDecoder = decoder;
    }

    @Override
    public void setDotPort(boolean enable, int port) {
        // 空实现（同 EXO 先例，mdk 无对应能力）
    }

    @Override
    public void toggleDotPort(boolean enable) {
        // 空实现
    }
}
