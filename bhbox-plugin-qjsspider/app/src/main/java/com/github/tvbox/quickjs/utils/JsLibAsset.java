package com.github.tvbox.quickjs.utils;

import com.github.catvod.utils.Io;
import com.github.catvod.utils.Path;

import java.io.File;

/**
 * 插件 assets 读取工具。
 *
 * 引擎运行于 qjsspider 插件中，宿主 APK 的 AssetManager 读不到插件 assets，
 * PluginManager 已将插件 APK 的 assets 解压到 filesDir/plugins/{id}/assets/，
 * 此处统一从解压目录读取。
 */
public class JsLibAsset {

    private static final String PLUGIN_ID = "bh.box.plugin.qjsspider";

    private static File assetsDir() {
        return new File(Path.getSystemPluginPath(), PLUGIN_ID + "/assets");
    }

    /** 读取插件 assets 下的文本文件，支持 "js/lib/xxx.js"、"assets/js/lib/xxx.js" 与 "assets://js/lib/xxx.js" 三种路径 */
    public static String read(String path) {
        File file = new File(assetsDir(), path.replace("assets://", "").replace("assets/", ""));
        String content = Io.read(file);
        return content;
    }

    public static String[] getFileNames(String folderPath) {
        File[] files = new File(assetsDir(), folderPath).listFiles();
        if (files == null) return new String[]{};
        String[] names = new String[files.length];
        for (int i = 0; i < files.length; i++) names[i] = files[i].getName();
        return names;
    }

    public static String readLib(String[] libs, String name) {
        for (String fileName : libs) {
            if (name.contains(fileName)) {
                return read("js/lib/" + fileName);
            }
        }
        return "";
    }
}
