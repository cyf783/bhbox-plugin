package bh.box.plugin.mpv;

import static bh.box.plugin.mpv.MpvPlayerFactory.ID_PLUGIN;

import com.github.catvod.utils.LOG;

import com.github.catvod.plugin.IPlayerPlugin;
import com.github.catvod.plugin.player.PlayerFactory;
import com.github.catvod.utils.Path;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

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
     * 按依赖顺序加载 .so 文件。
     * 优先 System.loadLibrary：宿主 DexClassLoader 的 librarySearchPath 已指向插件提取目录
     * （新宿主为 lib_<apk md5>[_代数] 指纹目录，旧宿主为固定 lib/ 目录），可直接命中。
     * 加载失败时回退为扫描插件 lib 目录后 System.load，兼容两种宿主目录结构。
     */
    private static void loadNativeLibs() {
        for (String name : NATIVE_LIB_ORDER) {
            try {
                System.loadLibrary(name.substring(0, name.length() - 3)); // 去掉 ".so" 后缀
                LOG.d("MpvPlayer", "  loaded: " + name);
                continue;
            } catch (UnsatisfiedLinkError e) {
                LOG.d("MpvPlayer", "  loadLibrary miss: " + name + ", fallback to scan");
            }
            File so = findSoFile(name);
            if (so == null) {
                LOG.e("MpvPlayer", "  not found: " + name
                        + "；abis: " + Arrays.toString(android.os.Build.SUPPORTED_ABIS));
                continue;
            }
            try {
                System.load(so.getAbsolutePath());
                LOG.d("MpvPlayer", "  loaded: " + so.getAbsolutePath());
            } catch (UnsatisfiedLinkError e) {
                LOG.e("MpvPlayer", "  failed to load " + name + ": " + e.getMessage());
            }
        }
    }

    /**
     * 在插件目录中查找 so 文件：先查固定 lib/{abi}/（旧宿主），再查 lib_ 开头的指纹目录
     * （新宿主，可能存在多代，按修改时间新→旧取最新命中的）。
     */
    private static File findSoFile(String name) {
        File pluginDir = new File(Path.getSystemFilesDir(), "plugins/" + ID_PLUGIN);
        List<File> dirs = new ArrayList<>();
        for (String abi : android.os.Build.SUPPORTED_ABIS) {
            dirs.add(new File(pluginDir, "lib/" + abi));
        }
        File[] children = pluginDir.listFiles();
        if (children != null) {
            Arrays.sort(children, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File child : children) {
                if (!child.isDirectory() || !child.getName().startsWith("lib_")) continue;
                for (String abi : android.os.Build.SUPPORTED_ABIS) {
                    dirs.add(new File(child, abi));
                }
            }
        }
        for (File dir : dirs) {
            File so = new File(dir, name);
            if (so.exists()) return so;
        }
        return null;
    }

    @Override
    public void install() {}

    @Override
    public void uninstall() {}
}
