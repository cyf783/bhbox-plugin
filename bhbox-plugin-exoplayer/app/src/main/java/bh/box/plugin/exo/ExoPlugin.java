package bh.box.plugin.exo;

import com.github.catvod.plugin.IPlayerPlugin;
import com.github.catvod.plugin.player.PlayerFactory;

/**
 * EXO 播放器插件入口。
 * <p>
 * init()：注册工厂进宿主 Manager（快，立即执行）。
 * media3 为纯 Java 实现，无 so 库需要加载，无需额外生命周期管理。
 */
public class ExoPlugin implements IPlayerPlugin {

    public static final String ID = "bh.box.plugin.exo";

    @Override
    public PlayerFactory createFactory() {
        return new ExoPlayerFactory();
    }

    @Override
    public void init() {
    }

    @Override
    public void install() {
    }

    @Override
    public void uninstall() {
    }
}
