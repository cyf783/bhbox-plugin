package bh.box.plugin.pyspider;

import android.content.Context;
import android.os.Build;

import androidx.annotation.Keep;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Util;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;

/**
 * Python Spider 加载器。
 *
 * 负责初始化 Chaquopy Python 运行时并创建 Spider 实例。
 * 使用 LitePlatform（轻量 Chaquopy 平台）替代标准 AndroidPlatform，
 * 以适配免安装插件化场景——Python 资源从宿主预提取的 filesDir 加载，
 * 而非从 APK 的 nativeLibraryDir 加载。
 *
 * 调用链：PySpiderPlugin.getSpider() → Loader.spider() → init() → LitePlatform
 */
public class Loader {

    /** Python app 模块引用，用于调用 spider() 工厂方法 */
    private PyObject app;

    /** 初始化 Python 运行时（如果尚未启动），并加载 app 模块 */
    @Keep
    private void init(Context context) {
        if (Python.isStarted()) {
            app = Python.getInstance().getModule("app");
            return;
        }
        // Chaquopy 资源已在 PySpiderPlugin.install() 中提取
        Python.start(new LitePlatform(context));
        app = Python.getInstance().getModule("app");
    }

    /**
     * 创建 Spider 实例。
     * @param context 宿主上下文
     * @param api 爬虫源 API 地址
     */
    @Keep
    public Spider spider(Context context, String api) {
        api = Util.clanToAddress(api);
        if (app == null) init(context);
        PyObject obj = app.callAttr("spider", Path.py().getAbsolutePath(), api);
        return new Spider(app, obj, api);
    }

    /**
     * 轻量 Chaquopy Platform，用于插件化场景。
     *
     * 与标准 AndroidPlatform 的区别：
     * - getPath(): 从预提取的 filesDir 读取 build.json，构建 Python 路径
     * - onStart(): 将解压目录添加到 sys.path，修复符号可见性，预加载 native 扩展
     *
     * 前提：ChaquopyExtractor.ensureExtracted() 已将 .imy 解压到 filesDir/chaquopy/
     */
    private static class LitePlatform extends Python.Platform {

        private final Context context;
        private String abi;
        private JSONObject buildJson;
        private String pythonLibPath; // libpython*.so 完整路径，供 RTLD_GLOBAL 使用

        LitePlatform(Context context) {
            this.context = context.getApplicationContext();
        }

        @Override
        public String getPath() {
            try {
                File buildFile = new File(context.getFilesDir(), "chaquopy/build.json");
                byte[] bytes = readFully(buildFile);
                buildJson = new JSONObject(new String(bytes, "UTF-8"));

                loadNativeLibs();
                detectABI();

                File dir = new File(context.getFilesDir(), "chaquopy");
                return dir + "/stdlib-common.imy" + ":" +
                        dir + "/bootstrap.imy" + ":" +
                        dir + "/bootstrap-native/" + abi;
            } catch (Exception e) {
                throw new RuntimeException("LitePlatform.getPath failed", e);
            }
        }

        @Override
        public void onStart(Python py) {
            try {
                // 1. 将解压目录添加到 sys.path
                PyObject sys = py.getModule("sys");
                PyObject path = sys.get("path");
                File chaquopyDir = new File(context.getFilesDir(), "chaquopy");
                addToPath(path, new File(chaquopyDir, "app"));
                addToPath(path, new File(chaquopyDir, "requirements-common"));
                addToPath(path, new File(chaquopyDir, "requirements-" + abi));
                addToPath(path, new File(chaquopyDir, "stdlib-" + abi));

                // 2. 修复 ctypes.pythonapi 符号可见性（pycryptodome 等库依赖）
                fixPythonapi(py);

                // 3. 预加载 .so 到 dlopen 全局作用域（Python import 依赖此命名空间）
                preloadNativeExtensions(py);

                // 4. 初始化 SSL：设置 CA bundle 环境变量
                initSSL(py);
            } catch (Exception e) {
                throw new RuntimeException("LitePlatform.onStart failed", e);
            }
        }

        private void addToPath(PyObject path, File dir) {
            if (dir.exists() && dir.isDirectory()) {
                path.callAttr("append", dir.getAbsolutePath());
            }
        }

        /**
         * 修复 ctypes.pythonapi 的 Python C API 符号可见性。
         *
         * 问题：System.loadLibrary 以 RTLD_LOCAL 加载 libpython，导致
         * ctypes.pythonapi（初始化时用 dlopen(NULL)）找不到 Python C API 符号。
         * pycryptodome 等库通过 ctypes.pythonapi.PyObject_GetBuffer 访问 C API。
         *
         * 方案：用 RTLD_GLOBAL 重新打开 libpython，创建新 PyDLL 替换 pythonapi。
         */
        private void fixPythonapi(Python py) {
            if (pythonLibPath == null) return;
            try {
                PyObject ctypesMod = py.getModule("ctypes");
                int mode = 2 | 0x100; // RTLD_NOW | RTLD_GLOBAL
                // 将 Python C API 符号提升到全局作用域
                ctypesMod.callAttr("CDLL", pythonLibPath, mode);
                // 创建 PyDLL 替换 pythonapi（PyDLL 在调用时释放 GIL）
                PyObject pyDLL = ctypesMod.callAttr("PyDLL", pythonLibPath, mode);
                py.getModule("builtins").callAttr("setattr", ctypesMod, "pythonapi", pyDLL);
            } catch (Exception ignored) {}
        }

        /**
         * 用 ctypes.CDLL(RTLD_GLOBAL) 递归预加载所有 .so 文件。
         *
         * 必要性：System.load() 加载到 classloader namespace，Python 的 dlopen 看不到。
         * 通过 ctypes 在 dlopen namespace 以 RTLD_GLOBAL 加载，后续 import 可找到依赖。
         */
        private void preloadNativeExtensions(Python py) {
            PyObject ctypesMod = py.getModule("ctypes");
            int mode = 2 | 0x100; // RTLD_NOW | RTLD_GLOBAL
            String[] dirs = {"requirements-common", "requirements-" + abi, "stdlib-" + abi, "app"};
            File chaquopyDir = new File(context.getFilesDir(), "chaquopy");
            for (String dirName : dirs) {
                File dir = new File(chaquopyDir, dirName);
                if (dir.exists()) preloadSoRecursive(ctypesMod, mode, dir);
            }
        }

        private void preloadSoRecursive(PyObject ctypesMod, int mode, File dir) {
            File[] files = dir.listFiles();
            if (files == null) return;
            for (File file : files) {
                if (file.isDirectory()) {
                    preloadSoRecursive(ctypesMod, mode, file);
                } else if (file.getName().endsWith(".so")) {
                    try {
                        ctypesMod.callAttr("CDLL", file.getAbsolutePath(), mode);
                    } catch (Exception ignored) {}
                }
            }
        }

        /**
         * 初始化 SSL：设置 CA bundle 环境变量，覆盖所有 Python HTTP 库。
         *
         * 需要同时设置三个环境变量：
         * - REQUESTS_CA_BUNDLE：requests 库专用
         * - SSL_CERT_FILE：Python ssl 模块和 urllib.request 使用
         * - CURL_CA_BUNDLE：某些库（如 youtube-dl）也会读取
         *
         * Chaquopy 的 cacert.pem 位于 build/python/assets/release/chaquopy/cacert.pem
         */
        private void initSSL(Python py) {
            try {
                // 通过 certifi.where() 找到 cacert.pem 路径
                PyObject certifi = py.getModule("certifi");
                String cacertPath = certifi.callAttr("where").toString();

                // 设置所有相关的 CA bundle 环境变量
                PyObject os = py.getModule("os");
                PyObject environ = os.get("environ");
                environ.callAttr("__setitem__", "REQUESTS_CA_BUNDLE", cacertPath);
                environ.callAttr("__setitem__", "SSL_CERT_FILE", cacertPath);
                environ.callAttr("__setitem__", "CURL_CA_BUNDLE", cacertPath);

                LOG.d("PySpider", "SSL 初始化完成: REQUESTS_CA_BUNDLE=" + cacertPath);
            } catch (Exception e) {
                LOG.e("PySpider", "SSL 初始化失败: " + e.getMessage());
            }
        }

        private void detectABI() {
            String[] abis = Build.SUPPORTED_ABIS;
            for (String candidate : abis) {
                File testFile = new File(context.getFilesDir(), "chaquopy/stdlib-" + candidate + ".imy");
                if (testFile.exists()) {
                    abi = candidate;
                    return;
                }
            }
            throw new RuntimeException("None of this device's ABIs " + Arrays.toString(abis) + " are supported.");
        }

        /**
         * 加载 Chaquopy 所需的 native 库。
         * 顺序：crypto/ssl/sqlite 依赖 → libpython → chaquopy_java
         */
        private void loadNativeLibs() {
            String[] suffixes = {"chaquopy", "python"};
            String[] prefixes = {"crypto_", "ssl_", "sqlite3_"};
            for (String suffix : suffixes) {
                for (String prefix : prefixes) {
                    try { System.loadLibrary(prefix + suffix); } catch (UnsatisfiedLinkError ignored) {}
                }
            }
            try {
                String pyVer = buildJson.getString("python_version");
                System.loadLibrary("python" + pyVer);
                pythonLibPath = findLibPath("libpython" + pyVer + ".so");
            } catch (Exception e) {
                throw new RuntimeException("Failed to load python lib: " + e.getMessage(), e);
            }
            try { System.loadLibrary("chaquopy_java"); } catch (UnsatisfiedLinkError ignored) {}

            // 预加载 .so 到 classloader namespace (clns-10)
            // Python 运行时通过 System.loadLibrary 加载，其 dlopen 也在 clns-10 解析依赖
            preloadToClassLoaderNs();
        }

        /** 递归预加载 .so 到 classloader namespace，使 Python dlopen 可找到依赖 */
        private void preloadToClassLoaderNs() {
            File chaquopyDir = new File(context.getFilesDir(), "chaquopy");
            String[] dirs = {"requirements-common", "requirements-" + abi, "stdlib-" + abi, "app"};
            for (String dirName : dirs) {
                File dir = new File(chaquopyDir, dirName);
                if (dir.exists()) loadSoRecursive(dir);
            }
        }

        private void loadSoRecursive(File dir) {
            File[] files = dir.listFiles();
            if (files == null) return;
            for (File file : files) {
                if (file.isDirectory()) loadSoRecursive(file);
                else if (file.getName().endsWith(".so")) {
                    try { System.load(file.getAbsolutePath()); } catch (UnsatisfiedLinkError ignored) {}
                }
            }
        }

        /**
         * 查找已加载 .so 库的完整路径。
         * 优先从插件包的 nativeLibraryDir 查找，回退到 /proc/self/maps。
         */
        private String findLibPath(String libName) {
            try {
                File libDir = new File(context.getFilesDir(), "plugins/bh.box.plugin.pyspider/lib");
                if (libDir.exists() && libDir.isDirectory()) {
                    File found = findSoRecursive(libDir, libName);
                    if (found != null) return found.getAbsolutePath();
                }
            } catch (Exception ignored) {}
            try (java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.FileReader("/proc/self/maps"))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.contains(libName)) {
                        String[] parts = line.trim().split("\\s+");
                        if (parts.length >= 6) {
                            String p = parts[parts.length - 1];
                            if (p.endsWith(".so")) return p;
                        }
                    }
                }
            } catch (Exception ignored) {}
            return null;
        }

        private File findSoRecursive(File dir, String libName) {
            File[] files = dir.listFiles();
            if (files == null) return null;
            for (File file : files) {
                if (file.isDirectory()) {
                    File found = findSoRecursive(file, libName);
                    if (found != null) return found;
                } else if (file.getName().equals(libName)) {
                    return file;
                }
            }
            return null;
        }

        private static byte[] readFully(File file) throws Exception {
            try (FileInputStream fis = new FileInputStream(file)) {
                byte[] data = new byte[(int) file.length()];
                int offset = 0;
                while (offset < data.length) {
                    int n = fis.read(data, offset, data.length - offset);
                    if (n < 0) break;
                    offset += n;
                }
                return data;
            }
        }
    }
}
