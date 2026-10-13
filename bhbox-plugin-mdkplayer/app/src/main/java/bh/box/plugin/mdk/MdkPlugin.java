package bh.box.plugin.mdk;

import com.github.catvod.plugin.IPlayerPlugin;
import com.github.catvod.plugin.player.PlayerFactory;

/**
 * MDK 播放器插件入口。
 * <p>
 * init()：显式按序加载 so（插件经 DexClassLoader 加载，无法借用宿主 so，六个 so 必须全部打进插件 APK）
 * 并应用 plugin.json 全局参数。so 顺序：依赖库先于 mdk。
 */
public class MdkPlugin implements IPlayerPlugin {

    public static final String ID = "bh.box.plugin.mdk";

    @Override
    public PlayerFactory createFactory() {
        return new MdkPlayerFactory();
    }

    @Override
    public void init() {
        System.loadLibrary("c++_shared");
        System.loadLibrary("ffmpeg");
        System.loadLibrary("ass");
        System.loadLibrary("dav1d");
        System.loadLibrary("mdk");
        System.loadLibrary("mdk-jni");
        // TODO: license key 以 BHBox 开源项目身份向作者申请到位后注入：
        // MdkPlayer.setLicense(key);（无 key 时 mdk 在末帧显示二维码水印，发版前必须解决）
    }

    @Override
    public void install() {
    }

    @Override
    public void uninstall() {
    }

    /** 应用日志级别参数（plugin.json logLevel，全局生效，在 create() 时重新读取） */
    static void applyLogLevel(String value) {
        int level = MdkPlayer.LOG_OFF;
        if ("错误".equals(value)) level = MdkPlayer.LOG_ERROR;
        else if ("警告".equals(value)) level = MdkPlayer.LOG_WARNING;
        else if ("信息".equals(value)) level = MdkPlayer.LOG_INFO;
        else if ("调试".equals(value)) level = MdkPlayer.LOG_DEBUG;
        MdkPlayer.setLogLevel(level);
    }
}
