package bh.box.plugin.pyspider;

import com.github.catvod.Init;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;

import org.json.JSONObject;

import java.io.File;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Chaquopy Python 运行时资源提取器。
 *
 * 从插件已提取的 assets 目录（filesDir/plugins/{id}/assets/chaquopy/）读取 Chaquopy 资源，
 * 处理增量更新后复制到 filesDir/chaquopy/，并解压 .imy 文件供 LitePlatform 使用。
 *
 * 调用时机：在 Loader.init() 中 Python.start() 之前调用。
 */
public class ChaquopyExtractor {

    private static final String PLUGIN_ID = "bh.box.plugin.pyspider";

    private static final String[] EXTRACT_IMYS = {
            "app.imy", "requirements-common.imy",
            "requirements-arm64-v8a.imy", "stdlib-arm64-v8a.imy"
    };

    /**
     * 提取 Chaquopy 资源，确保 filesDir/chaquopy/ 目录就绪。
     *
     * @return true 表示提取成功或已就绪
     */
    public static boolean ensureExtracted() {
        try {
            File chaquopyDir = new File(Path.getSystemFilesDir(), "chaquopy");

            LOG.d("PySpider", "Chaquopy 资源提取中...");
            // 快速判断：chaquopy 目录已存在且核心文件就绪，跳过提取
            if (isChaquopyReady(chaquopyDir)) return true;

            LOG.d("PySpider", "Chaquopy 提取目录: " + chaquopyDir.getAbsolutePath());
            File assetsChaquopyDir = new File(
                    Path.getSystemFilesDir(), "plugins/" + PLUGIN_ID + "/assets/chaquopy");

            if (!assetsChaquopyDir.exists()) {
                LOG.e("PySpider", "Chaquopy assets 目录不存在: " + assetsChaquopyDir.getAbsolutePath());
                return false;
            }

            chaquopyDir.mkdirs();

            // 1. 复制 build.json
            File buildJsonSrc = new File(assetsChaquopyDir, "build.json");
            File buildJsonDest = new File(chaquopyDir, "build.json");
            if (buildJsonSrc.exists()) {
                Io.copy(buildJsonSrc, buildJsonDest);
            }

            // 2. 增量更新：根据 build.json 中的 hash 判断是否需要复制
            String buildJsonStr = Io.read(buildJsonDest);
            if (buildJsonStr.isEmpty()) {
                LOG.e("PySpider", "build.json 为空");
                return false;
            }

            JSONObject buildJson = new JSONObject(buildJsonStr);
            JSONObject assetsMap = buildJson.getJSONObject("assets");

            android.content.SharedPreferences sp = Init.context().getSharedPreferences("chaquopy", 0);
            android.content.SharedPreferences.Editor editor = sp.edit();

            java.util.Iterator<String> keys = assetsMap.keys();
            while (keys.hasNext()) {
                String assetPath = keys.next();
                String hash = assetsMap.getString(assetPath);
                String spKey = "asset." + assetPath;
                File destFile = new File(chaquopyDir, assetPath);

                if (destFile.exists() && sp.getString(spKey, "").equals(hash)) continue;

                File srcFile = new File(assetsChaquopyDir, assetPath);
                if (srcFile.exists()) {
                    destFile.getParentFile().mkdirs();
                    Io.copy(srcFile, destFile);
                    editor.putString(spKey, hash);
                }
            }

            editor.apply();

            // 3. 解压 .imy 文件
            for (String imyName : EXTRACT_IMYS) {
                extractImyContents(chaquopyDir, imyName);
            }

            return true;
        } catch (Exception e) {
            LOG.e("PySpider", "Chaquopy 资源提取失败: " + e.getMessage());
            return false;
        }
    }

    /** 快速判断 chaquopy 目录是否已就绪（核心 .imy 文件和解压目录都存在） */
    private static boolean isChaquopyReady(File chaquopyDir) {
        if (!chaquopyDir.exists()) return false;
        if (!new File(chaquopyDir, "build.json").exists()) return false;
        for (String imyName : EXTRACT_IMYS) {
            File imyFile = new File(chaquopyDir, imyName);
            if (!imyFile.exists()) return false;
            String dirName = imyName.replace(".imy", "");
            if (!new File(chaquopyDir, dirName).exists()) return false;
        }
        return true;
    }

    /** 解压 .imy 文件（ZIP 格式）到同名目录，供 Python 运行时加载 */
    private static void extractImyContents(File chaquopyDir, String imyName) {
        File imyFile = new File(chaquopyDir, imyName);
        if (!imyFile.exists()) return;

        String dirName = imyName.replace(".imy", "");
        File extractDir = new File(chaquopyDir, dirName);

        try (ZipFile zip = new ZipFile(imyFile)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) continue;

                File destFile = new File(extractDir, entry.getName());
                if (destFile.exists() && destFile.length() == entry.getSize()) continue;

                destFile.getParentFile().mkdirs();
                Io.write(destFile, zip.getInputStream(entry));
            }
        } catch (Exception e) {
            LOG.e("PySpider", "extractImy " + imyName + ": " + e.getMessage());
        }
    }
}
