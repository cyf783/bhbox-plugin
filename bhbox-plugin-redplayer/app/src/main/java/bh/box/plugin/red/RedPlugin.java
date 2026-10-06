package bh.box.plugin.red;

import android.util.Log;

import com.github.catvod.plugin.IPlayerPlugin;
import com.github.catvod.plugin.player.PlayerFactory;
import com.xingin.openredplayercore.core.impl.redplayer.RedMediaPlayer;

/**
 * RedPlayer（小红书 REDPlayer）播放器插件入口。
 * <p>
 * init()：预加载 9 个 native 库（c++_shared/ffmpeg/redbase/reddownload/redstrategycenter/
 * redsource/redrender/reddecoder/redplayer）。
 * 插件 DexClassLoader 的 librarySearchPath 已指向 filesDir/plugins/{id}/lib/{abi}
 * （PluginManager.extractFromApk 提取），System.loadLibrary 可直接命中。
 */
public class RedPlugin implements IPlayerPlugin {

    public static final String ID = "bh.box.plugin.red";

    @Override
    public PlayerFactory createFactory() {
        return new RedPlayerFactory();
    }

    @Override
    public void init() {
        try {
            RedMediaPlayer.loadLibrariesOnce(null, null);
            Log.i("RedPlayer", "native libs loaded");
        } catch (Throwable t) {
            Log.e("RedPlayer", "load native libs failed: " + Log.getStackTraceString(t));
        }
    }

    @Override
    public void install() {}

    @Override
    public void uninstall() {}
}
