package bh.box.plugin.ali;

import android.content.Context;

import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Plugin;

import java.util.Arrays;
import java.util.List;

public class AliPlayerFactory implements PlayerFactory {

    public static final int ID = 5;

    public static final String CODEC_HARDWARE = "硬解码";
    public static final String CODEC_SOFTWARE = "软解码";

    private String mDecoder = CODEC_HARDWARE;

    @Override
    public int getId() { return ID; }

    @Override
    public String getName() { return "AliYun"; }

    @Override
    public Player create(Context context) {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(AliPlugin.ID);
        if (bean != null && bean.getParams() != null) {
            for (ApkParam param : bean.getParams()) {
                if ("decoder".equals(param.getId())) {
                    mDecoder = CODEC_SOFTWARE.equals(param.getValue()) ? CODEC_SOFTWARE : CODEC_HARDWARE;
                    break;
                }
            }
        }
        return new AliPlayer(context, mDecoder);
    }

    @Override
    public List<String> decoders() {
        return Arrays.asList(CODEC_HARDWARE, CODEC_SOFTWARE);
    }

    @Override
    public void setDecoder(String decoder) { this.mDecoder = decoder; }

    @Override
    public void setDotPort(boolean enable, int port) { /* AliYun 不支持 dot-port */ }

    @Override
    public void toggleDotPort(boolean enable) { /* AliYun 不支持 dot-port */ }
}