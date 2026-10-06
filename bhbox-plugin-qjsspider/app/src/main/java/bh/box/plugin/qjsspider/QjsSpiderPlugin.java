package bh.box.plugin.qjsspider;

import com.github.catvod.Init;
import com.github.catvod.crawler.Spider;
import com.github.catvod.crawler.SpiderNull;
import com.github.catvod.plugin.ISpiderPlugin;
import com.github.tvbox.quickjs.crawler.JsSpider;
import com.github.tvbox.quickjs.utils.Module;
import com.whl.quickjs.android.QuickJSLoader;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * QuickJS Spider 插件入口类。
 *
 * 实现 SpiderPlugin 接口，作为 qjsspider APK 插件的入口点。
 * PluginManager 通过 DexClassLoader 加载此类并调用 init() 初始化。
 *
 * 职责：
 * - 加载 libquickjs-android-wrapper.so（QuickJSLoader.init）
 * - 管理 JsSpider 实例缓存（按站点 key 去重）
 * - 处理代理请求转发与资源清理
 */
public class QjsSpiderPlugin implements ISpiderPlugin {

    /** 已创建的 Spider 实例缓存，key=站点唯一标识 */
    private final ConcurrentHashMap<String, Spider> spiders = new ConcurrentHashMap<>();
    /** 最近一次使用的站点 key（用于 proxyInvoke 定位） */
    private String recent;

    @Override
    public void init() {
        // DexClassLoader 的 nativeLibraryDir 指向插件解压的 lib/ 目录，可找到 wrapper so
        QuickJSLoader.init();
    }

    @Override
    public void install() {
    }

    @Override
    public void uninstall() {
        Module.get().clear();
    }

    @Override
    public Spider getSpider(String key, String api, String ext) {
        try {
            recent = key;
            if (spiders.containsKey(key)) return spiders.get(key);
            Spider spider = new JsSpider(key, api, ext);
            spider.siteKey = key;
            spider.init(Init.context(), ext);
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
    }
}
