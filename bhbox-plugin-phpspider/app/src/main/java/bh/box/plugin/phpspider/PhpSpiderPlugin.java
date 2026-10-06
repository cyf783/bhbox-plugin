package bh.box.plugin.phpspider;

import com.github.catvod.Init;
import com.github.catvod.crawler.Spider;
import com.github.catvod.crawler.SpiderNull;
import com.github.catvod.plugin.IRuntimePlugin;
import com.github.catvod.plugin.ISpiderPlugin;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Plugin;

import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PHP Spider 插件入口类。
 *
 * 与 PySpiderPlugin 架构一致：
 * - 管理 Spider 实例缓存（按 api 地址去重）
 * - 委托 PhpServerManager 管理 PHP 内置服务器生命周期
 * - 每个 Spider 实例通过 T4 协议 HTTP 请求调用对应 PHP 脚本
 */
public class PhpSpiderPlugin implements ISpiderPlugin {

    private static final String ID = "bh.box.plugin.phpspider";

    /** 已创建的 Spider 实例缓存，key=api 地址 */
    private final ConcurrentHashMap<String, Spider> spiders = new ConcurrentHashMap<>();
    /** 最近一次使用的站点 key（用于 proxyInvoke 定位） */
    private String recent;
    /** PHP 服务器管理器 */
    private PhpServerManager serverManager;

    @Override
    public void init() {
        this.serverManager = new PhpServerManager();
    }

    @Override
    public void install() {}

    @Override
    public void uninstall() {}

    @Override
    public Spider getSpider(String key, String api, String ext) {
        try {
            recent = key;

            // 确保 PHP 服务器已启动
            ensureServerRunning();

            // 缓存：相同 key 不重复创建
            if (spiders.containsKey(key)) return spiders.get(key);

            // 创建 Spider 桥接实例
            Spider spider = new PhpSpider(Init.context(), serverManager.getBaseUrl(), api);
            spider.init(Init.context(), ext);
            spider.siteKey = key;
            spiders.put(key, spider);
            return spider;
        } catch (Throwable e) {
            e.printStackTrace();
            return new SpiderNull();
        }
    }

    private void ensureServerRunning() {
        if (serverManager.isRunning()) return;
        synchronized (this) {
            if (serverManager.isRunning()) return;

            File phpBinary = resolveBinary();
            if (phpBinary == null) return;

            File docRoot = Path.php();
            docRoot.mkdirs();

            // 部署 lib/ 依赖文件到 document root
            deployLibFiles(docRoot);

            serverManager.start(phpBinary, docRoot);
        }
    }

    /** 从自身 plugin.json 的 depends 声明定位运行时插件提供的 php 可执行文件 */
    private File resolveBinary() {
        ApkPluginBean self = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<String> depends = self == null ? null : self.getDepends();
        if (depends == null || depends.isEmpty()) {
            LOG.e("PHP", "plugin.json 未声明 depends，无法定位 php 二进制");
            return null;
        }
        IRuntimePlugin runtime = Plugin.getRuntimePluginById(depends.get(0));
        File bin = new File(runtime.getExecutable());
        // init 并行加载的极端时序兜底：依赖插件可能仍在解压 assets，等待落盘（最多 5s）
        long deadline = System.currentTimeMillis() + 5_000;
        while (!bin.exists() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(200); } catch (InterruptedException e) { break; }
        }
        if (!bin.exists()) LOG.e("PHP", "运行时插件未安装或缺少 php，请先安装: " + depends);
        return bin.exists() ? bin : null;
    }

    /**
     * 将插件 assets 中的 lib/ 依赖文件部署到 document root。
     *
     * BaseSpider 脚本通过 require_once __DIR__ . '/lib/spider.php' 引入依赖，
     * 这些文件需要与脚本在同一目录结构下。
     */
    private void deployLibFiles(File docRoot) {
        File libDir = new File(docRoot, "lib");
        File spiderLib = new File(libDir, "spider.php");
        if (spiderLib.exists()) return; // 已部署

        // 从插件 assets 复制（PluginManager 解压后的路径）
        File assetsLibDir = new File(
                Path.getSystemPluginPath() + "/" + ID + "/assets/lib");
        if (assetsLibDir.isDirectory()) {
            com.github.catvod.utils.Io.copyDir(assetsLibDir, libDir);
        }
    }

    @Override
    public Object[] proxyInvoke(Map<String, String> params) {
        try {
            return spiders.get(recent).proxyLocal(params);
        } catch (Throwable e) {
            e.printStackTrace();
            return null;
        }
    }

    @Override
    public void clear() {
        for (Spider spider : spiders.values()) {
            try { spider.destroy(); } catch (Exception ignored) {}
        }
        spiders.clear();
        if (serverManager != null) {
            serverManager.stop();
        }
        // 清理下载的脚本缓存
        Io.delete(Path.php());
    }
}
