package bh.box.plugin.pyspider;

import com.github.catvod.Init;
import com.github.catvod.crawler.Spider;
import com.github.catvod.crawler.SpiderNull;
import com.github.catvod.plugin.ISpiderPlugin;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.Path;

import java.io.File;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Python Spider 插件入口类。
 *
 * 实现 SpiderPlugin 接口，作为 pyspider APK 插件的入口点。
 * PluginManager 通过 DexClassLoader 加载此类并调用 init() 初始化。
 *
 * 职责：
 * - 管理 Spider 实例缓存（按 api 地址去重）
 * - 委托 Loader 进行 Python 运行时初始化和 Spider 创建
 * - 处理代理请求转发
 */
public class PySpiderPlugin implements ISpiderPlugin {

    /** 已创建的 Spider 实例缓存，key=api 地址 */
    private final ConcurrentHashMap<String, Spider> spiders = new ConcurrentHashMap<>();
    /** 最近一次使用的 api 地址 */
    private String recent;
    /** Python 加载器 */
    private Loader loader;

    @Override
    public void init() {
        if (loader == null) loader = new Loader();
    }

    @Override
    public void install() {
        ChaquopyExtractor.ensureExtracted();
    }

    @Override
    public void uninstall() {
        Io.delete(new File(Path.getSystemFilesDir(), "chaquopy"));
    }

    @Override
    public Spider getSpider(String key, String api, String ext) {
        try {
            recent = key;
            if (spiders.containsKey(key)) return spiders.get(key);
            Spider spider = loader.spider(Init.context(), api);
            spider.init(Init.context(), ext);
            spider.siteKey = key;
            spiders.put(key, spider);
            return spider;
        } catch (Throwable e) {
            e.printStackTrace();
            return new SpiderNull();
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
        // 清理下载的脚本缓存
        Io.delete(Path.py());
    }
}
