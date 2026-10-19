package bh.box.plugin.python;

import com.github.catvod.plugin.IRuntimePlugin;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Python 运行时插件：向其它插件提供 python 可执行入口。
 *
 * 源包为 musl 链接的 CPython 3.12（arm64 独立进程），目录布局与 DsPlayer
 * python-1.0.3 一致：bin/python3.12 + bin/ld-musl-aarch64.so.1 + lib/。
 *
 * 资产形态与解压：
 * - aapt2 默认忽略下划线开头目录（ignoreAssets pattern <dir>_*），会把
 *   pip/_internal、pip/_vendor 等运行时必需目录整体吞掉，且 AGP 8.5 无可覆盖
 *   入口——故构建期把 runtime/ 打成单个 python.zip 资产（app/build.gradle
 *   zipPythonRuntime 任务），宿主解压后由本插件在 install()/getExecutable()
 *   时二次解压到 assets 目录，指纹标记幂等。
 *
 * 启动障碍与解法：
 * - python3.12 的 ELF INTERP 硬编码 /lib/ld-musl-aarch64.so.1（Android 不存在），
 *   直接 exec 必 ENOENT → 经随包静态 musl 加载器显式加载；
 * - musl python 需要 PYTHONHOME 指向运行时根、LD_LIBRARY_PATH 指向 lib/；
 * - 随包 sitecustomize.py 会把 bin/py.sh 自愈重写为不含 export 的固定路由格式，
 *   因此 env 不能写进 py.sh（会被剥离），拆为两个 wrapper：
 *     py.sh    —— 与 sitecustomize 期望格式逐字节一致（幂等，仅 loader 路由），
 *                 供 shim 改写 sys.executable 后 pip/multiprocessing 子进程继承 env 使用；
 *     pyenv.sh —— export 全部所需 env 后 exec loader+python，为 getExecutable()
 *                 返回的完整入口，spawn 方无需感知环境变量。
 */
public class PythonRuntimePlugin implements IRuntimePlugin {

    private static final String ID = "bh.box.plugin.python";

    /** 运行时根目录（宿主解压后的 assets，python.zip 在此，bin/lib 解压到此） */
    private static File rootDir() {
        return new File(Path.getSystemPluginPath() + "/" + ID + "/assets");
    }

    @Override
    public void install() {
        ensureExtracted();
    }

    @Override
    public void init() {}

    @Override
    public void uninstall() {}

    @Override
    public String getExecutable() {
        File root = rootDir();
        if (!ensureExtracted()) return null;
        File loader = new File(root, "bin/ld-musl-aarch64.so.1");
        File python = new File(root, "bin/python3.12");
        if (!loader.exists() || !python.exists()) return null;
        if (!ensureWrappers(root, loader, python)) return null;
        python.setExecutable(true);
        loader.setExecutable(true);
        File entry = new File(root, "bin/pyenv.sh");
        entry.setExecutable(true);
        new File(root, "bin/py.sh").setExecutable(true);
        return entry.getAbsolutePath();
    }

    // ---------- 解压 ----------

    /** 指纹标记文件：记录已解压 zip 的 length:lastModified，插件更新后自动重解压 */
    private static File markerFile(File root) {
        return new File(root, "python.zip.fp");
    }

    /**
     * 确保 python.zip 已解压到根目录（幂等）。
     * @return true 表示 bin/python3.12 已就绪
     */
    private boolean ensureExtracted() {
        try {
            File root = rootDir();
            File zip = new File(root, "python.zip");
            if (!zip.exists()) {
                LOG.e("Python", "python.zip missing in " + root);
                return false;
            }
            String fp = zip.length() + ":" + zip.lastModified();
            File python = new File(root, "bin/python3.12");
            if (python.exists() && fp.equals(readMarker(root))) return true;

            // 清理旧版本残留（bin/lib 全删；保留 python.zip 与 wrapper 无需删）
            Io.delete(new File(root, "bin"));
            Io.delete(new File(root, "lib"));

            unzip(zip, root);
            if (!python.exists()) {
                LOG.e("Python", "unzip done but python3.12 missing");
                return false;
            }
            try (FileWriter writer = new FileWriter(markerFile(root))) {
                writer.write(fp);
            }
            LOG.d("Python", "runtime extracted to " + root);
            return true;
        } catch (Throwable e) {
            LOG.e("Python", "ensureExtracted: " + e.getMessage());
            return false;
        }
    }

    private String readMarker(File root) {
        try (FileReader reader = new FileReader(markerFile(root))) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[256];
            int n;
            while ((n = reader.read(buf)) > 0) sb.append(buf, 0, n);
            return sb.toString();
        } catch (IOException e) {
            return null;
        }
    }

    /** 解压 zip 到目标目录（条目路径为 bin/... lib/... 相对路径） */
    private static void unzip(File zip, File target) throws IOException {
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            byte[] buf = new byte[64 * 1024];
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                File out = new File(target, entry.getName());
                File parent = out.getParentFile();
                if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
                    throw new IOException("mkdirs failed: " + parent);
                }
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zis.read(buf)) > 0) os.write(buf, 0, n);
                }
                zis.closeEntry();
            }
        }
    }

    // ---------- wrapper ----------

    /** 生成两个 wrapper（内容与现存一致则跳过，路径变化时自动重写） */
    private boolean ensureWrappers(File root, File loader, File python) {
        // 与 sitecustomize.py _ensure_wrapper() 的 want 格式逐字节一致
        String router = "#!/system/bin/sh\nexec \"" + loader.getAbsolutePath() + "\" \""
                + python.getAbsolutePath() + "\" \"$@\"\n";
        String entry = "#!/system/bin/sh\n"
                // 宿主进程内 Chaquopy（pyspider）会 setenv PYTHONPATH 指向旧版 pyc 包（.imy），
                // 子进程继承后 CPython 从中读 encodings 必撞 pyc magic number 不匹配（init_fs_encoding Fatal），必须清掉
                + "unset PYTHONPATH\n"
                + "export PYTHONHOME=\"" + root.getAbsolutePath() + "\"\n"
                + "export LD_LIBRARY_PATH=\"" + new File(root, "lib").getAbsolutePath() + "\"\n"
                + "exec \"" + loader.getAbsolutePath() + "\" \"" + python.getAbsolutePath() + "\" \"$@\"\n";
        return writeIfChanged(new File(root, "bin/py.sh"), router)
                && writeIfChanged(new File(root, "bin/pyenv.sh"), entry);
    }

    private boolean writeIfChanged(File file, String want) {
        try {
            if (file.exists()) {
                StringBuilder sb = new StringBuilder();
                try (FileReader reader = new FileReader(file)) {
                    char[] buf = new char[4096];
                    int n;
                    while ((n = reader.read(buf)) > 0) sb.append(buf, 0, n);
                }
                if (sb.toString().equals(want)) return true;
            }
            try (FileWriter writer = new FileWriter(file)) {
                writer.write(want);
            }
            return true;
        } catch (IOException e) {
            LOG.e("Python", "write wrapper " + file.getName() + ": " + e.getMessage());
            return false;
        }
    }
}
