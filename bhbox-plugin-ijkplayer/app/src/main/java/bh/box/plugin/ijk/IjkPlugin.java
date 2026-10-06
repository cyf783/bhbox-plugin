package bh.box.plugin.ijk;

import com.github.catvod.plugin.IPlayerPlugin;
import com.github.catvod.plugin.player.PlayerFactory;

import tv.danmaku.ijk.media.player.IjkMediaPlayer;

/**
 * IJK 播放器插件入口。
 * <p>
 * init()：注册工厂进宿主 Manager（快，立即执行）。
 * so 库由 IjkMediaPlayer 构造器内的 loadLibrariesOnce 兜底加载，
 * 无需额外的 start/stop 生命周期管理。
 */
public class IjkPlugin implements IPlayerPlugin {

    public static final String ID = "bh.box.plugin.ijk";

    @Override
    public PlayerFactory createFactory() {
        return new IjkPlayerFactory();
    }

    @Override
    public void init() {
        IjkMediaPlayer.loadLibrariesOnce(null);
    }

    @Override
    public void install() {}

    @Override
    public void uninstall() {}
}
