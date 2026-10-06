package bh.box.plugin.php;

import com.github.catvod.plugin.IRuntimePlugin;
import com.github.catvod.utils.Path;

import java.io.File;

/**
 * PHP 运行时插件：向其它插件提供 php 可执行文件。
 * 二进制位于插件 assets，随插件加载由宿主解压到 filesDir/plugins/<id>/assets/。
 */
public class PhpRuntimePlugin implements IRuntimePlugin {

    private static final String ID = "bh.box.plugin.php";
    private static final String BIN_NAME = "php";

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
