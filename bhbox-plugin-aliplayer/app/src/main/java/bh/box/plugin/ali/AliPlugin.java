package bh.box.plugin.ali;

import android.util.Log;

import com.github.catvod.plugin.IPlayerPlugin;
import com.github.catvod.plugin.player.PlayerFactory;

/**
 * AliYunPlayer 播放器插件入口。
 * 阿里云播放器 SDK 通过 Gradle 依赖注入，无需手动加载 native 库。
 */
public class AliPlugin implements IPlayerPlugin {

    public static final String ID = "bh.box.plugin.ali";

    @Override
    public PlayerFactory createFactory() {
        return new AliPlayerFactory();
    }

    @Override
    public void init() {
        Log.i("AliPlayer", "plugin initialized");
    }

    @Override
    public void install() {}

    @Override
    public void uninstall() {}
}
