package bh.box.plugin.mpv;

import static bh.box.plugin.mpv.MpvPlayerFactory.ID_PLUGIN;

import android.util.Log;

import com.github.catvod.plugin.IPlayerPlugin;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.utils.Path;

import java.io.File;
import java.util.Arrays;

/**
 * MPV 播放器插件入口。
 * so 库由 MPVLib.create() 懒加载，无需额外生命周期管理。
 */
public class MpvPlugin implements IPlayerPlugin {

    public static final String ID = "bh.box.plugin.mpv";

    /** 原生库加载顺序（先编译/先依赖） */
    static final String[] NATIVE_LIB_ORDER = {
            "libc++_shared.so",
            "libavutil.so",
            "libavcodec.so",
            "libavformat.so",
            "libavfilter.so",
            "libswscale.so",
            "libswresample.so",
            "libavdevice.so",
            "libmpv.so",
            "libplayer.so",
    };

    @Override
    public PlayerFactory createFactory() {
        return new MpvPlayerFactory();
    }

    @Override
    public void init() {
        // 在插件初始化阶段加载原生库，确保后续 MpvPlayer 实例可直接使用
        loadNativeLibs();
    }

    /**
     * 查找插件 lib 目录并按依赖顺序加载 .so 文件。
     * PluginManager.extractFromApk() 已将 .so 提取到 filesDir/plugins/{id}/lib/{abi}/。
     */
    private static void loadNativeLibs() {
        File pluginDir = new File(Path.getSystemFilesDir(), "plugins/" + ID_PLUGIN);
        String libDir = null;
        for (String abi : android.os.Build.SUPPORTED_ABIS) {
            File soDir = new File(pluginDir, "lib/" + abi);
            if (new File(soDir, "libplayer.so").exists()) {
                libDir = soDir.getAbsolutePath();
                break;
            }
        }
        if (libDir == null) {
            Log.e("MpvPlayer", "libplayer.so not found under: " + pluginDir.getAbsolutePath()
                    + "；abis: " + Arrays.toString(android.os.Build.SUPPORTED_ABIS));
            return;
        }
        Log.d("MpvPlayer", "loading native libs from: " + libDir);
        for (String name : NATIVE_LIB_ORDER) {
            File so = new File(libDir, name);
            if (so.exists()) {
                Log.d("MpvPlayer", "  loading: " + name);
                try {
                    System.load(so.getAbsolutePath());
                } catch (UnsatisfiedLinkError e) {
                    Log.e("MpvPlayer", "  failed to load " + name + ": " + e.getMessage());
                }
            } else {
                Log.d("MpvPlayer", "  skip (not found): " + name);
            }
        }
    }

    @Override
    public void install() {}

    @Override
    public void uninstall() {}
}
