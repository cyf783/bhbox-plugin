package bh.box.plugin.node;

import com.github.catvod.plugin.IRuntimePlugin;
import com.github.catvod.utils.Path;

import java.io.File;

/**
 * Node.js 运行时插件：向其它插件提供 node 可执行文件。
 * 二进制位于插件 assets，随插件加载由宿主解压到 filesDir/plugins/<id>/assets/。
 */
public class NodeRuntimePlugin implements IRuntimePlugin {

    private static final String ID = "bh.box.plugin.node";
    private static final String BIN_NAME = "node24-arm64";

    @Override
    public void install() {}

    @Override
    public void init() {}

    @Override
    public void uninstall() {}

    @Override
    public String getExecutable() {
        File file = new File(Path.getSystemPluginPath() + "/" + ID + "/assets", BIN_NAME);
        if (!file.exists()) return null;
        file.setExecutable(true);
        return file.getAbsolutePath();
    }
}
