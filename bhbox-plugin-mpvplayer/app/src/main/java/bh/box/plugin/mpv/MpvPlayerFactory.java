package bh.box.plugin.mpv;

import android.content.Context;
import android.net.Uri;

import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.plugin.player.spi.Player;
import com.github.catvod.utils.Plugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Arrays;
import java.util.List;

/**
 * MPV 播放器工厂。从 PluginCache 读取 params 配置，创建 MpvPlayer 实例。
 */
public class MpvPlayerFactory implements PlayerFactory {

    public static final int ID = 3;
    public static final String ID_PLUGIN = MpvPlugin.ID;

    public static final String CODEC_HARDWARE = "硬解码";
    public static final String CODEC_SOFTWARE = "软解码";
    private String mDecoder = CODEC_HARDWARE;
    private boolean mGpuNext = false;
    private boolean mVulkan = false;
    private boolean mAudioPassthrough = true;
    // true=libass 特效渲染；false=默认，宿主统一渲染（sub-text 转发）
    private boolean mLibassSubtitle = false;
    private String mMpvConfPath = null;

    @Override
    public int getId() { return ID; }

    @Override
    public String getName() { return "MPV"; }

    @Override
    public Player create(Context context) {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(ID_PLUGIN);
        if (bean != null && bean.getParams() != null) {
            for (ApkParam param : bean.getParams()) {
                String val = param.getValue();
                switch (param.getId()) {
                    case "decoder":
                        mDecoder = (val != null && val.equals(CODEC_SOFTWARE)) ? CODEC_SOFTWARE : CODEC_HARDWARE;
                        break;
                    case "gpu_next":
                        mGpuNext = Boolean.parseBoolean(val);
                        break;
                    case "vulkan":
                        mVulkan = Boolean.parseBoolean(val);
                        break;
                    case "audio_passthrough":
                        mAudioPassthrough = val == null || Boolean.parseBoolean(val);
                        break;
                    case "libass_subtitle":
                        mLibassSubtitle = "libass".equals(val);
                        break;
                    case "mpv_conf":
                        if (val != null && !val.isEmpty()) {
                            importMpvConf(context, Uri.parse(val));
                        }
                        break;
                }
            }
        }
        return new MpvPlayer(context, mDecoder, mGpuNext, mVulkan, mAudioPassthrough, mLibassSubtitle, mMpvConfPath);
    }

    @Override
    public List<String> decoders() {
        return Arrays.asList(CODEC_HARDWARE, CODEC_SOFTWARE);
    }

    @Override
    public void setDecoder(String decoder) { this.mDecoder = decoder; }

    @Override
    public void setDotPort(boolean enable, int port) { /* mpv 暂不支持 dot-port */ }

    @Override
    public void toggleDotPort(boolean enable) { /* mpv 暂不支持 dot-port */ }

    private void importMpvConf(Context context, Uri uri) {
        try (InputStream in = context.getContentResolver().openInputStream(uri)) {
            File confDir = new File(context.getFilesDir(), "mpv");
            if (!confDir.exists()) confDir.mkdirs();
            File confFile = new File(confDir, "mpv.conf");
            try (FileOutputStream out = new FileOutputStream(confFile)) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = in.read(buf)) != -1) out.write(buf, 0, len);
            }
            mMpvConfPath = confFile.getAbsolutePath();
        } catch (Exception ignored) {
            mMpvConfPath = null;
        }
    }
}
