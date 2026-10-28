package bh.box.plugin.legado;

import android.text.TextUtils;

import com.github.catvod.plugin.IRuntimePlugin;
import com.github.catvod.plugin.IServicePlugin;
import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Path;
import com.github.catvod.utils.Plugin;
import com.google.gson.JsonObject;

import java.io.File;
import java.util.List;

/**
 * Legado 书源插件入口类（阅读APP书源 → T4 小说服务）。
 *
 * 与 CatSpiderPlugin 架构一致，但为纯 Service 插件（无 Spider 桥）：
 * - start(): 读 params（网络书源 URL 多行 + 本地书源文件）→ 依赖 node 运行时插件启动 legado-server.cjs
 * - 宿主把 http://127.0.0.1:9930/config 当订阅配置拉取，得到每个启用书源对应的 type=4 站点
 * - 之后 home/list/detail/search/play 全部走宿主原生 T4 HTTP 通道直连 node 服务
 *
 * params 仅在 start 时注入（环境变量 LEGADO_PARAMS），修改参数后需停止再启动插件。
 */
public class LegadoPlugin implements IServicePlugin {

    private static final String ID = "bh.box.plugin.legado";

    /** node 服务管理器 */
    private LegadoServerManager serverManager;
    /** 网络书源订阅地址（多行，每行一个 http(s):// URL；localFile 参数经 /file/ 端点转换后并入） */
    private String remoteUrls;

    @Override
    public void init() {
        this.serverManager = new LegadoServerManager();
    }

    @Override
    public void install() {
        // 无额外部署：legado-server.cjs 与预置依赖随 APK assets 自动释放
    }

    @Override
    public void uninstall() {}

    /** 从自身 plugin.json 的 params 声明读取用户配置（id: remoteUrls / localFile） */
    private void loadApkParams() {
        remoteUrls = null;
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<ApkParam> params = bean == null ? null : bean.getParams();
        if (params == null) return;
        for (ApkParam param : params) {
            if (param == null || TextUtils.isEmpty(param.getValue())) continue;
            if ("remoteUrls".equals(param.getId())) {
                remoteUrls = param.getValue();
            } else if ("localFile".equals(param.getId())) {
                String url = toFileServerUrl(param.getValue());
                if (url != null) {
                    // 本地书源并入 remoteUrls 走 http 通道加载（本机回环，无路径/权限问题）
                    remoteUrls = remoteUrls == null ? url : remoteUrls + "\n" + url;
                }
            }
        }
    }

    /**
     * 本地书源参数 → 本机文件服务地址。宿主 9978 /file/ 端点以 sdcard 根为基准提供本地文件
     * （宝盒/bookSource.json → http://127.0.0.1:9978/file/宝盒/bookSource.json），与
     * ApiLoadHelper/UrlHelper 消费 /file/ 地址的生态一致；参数值兼容 file:// 前缀与
     * 绝对路径（剥挂载根成相对段），已是 http(s) URL 则原样返回。
     */
    private String toFileServerUrl(String raw) {
        if (TextUtils.isEmpty(raw)) return null;
        String s = raw.trim();
        if (s.startsWith("http://") || s.startsWith("https://")) return s;
        if (s.startsWith("file://")) s = s.substring("file://".length());
        while (s.startsWith("/")) s = s.substring(1);
        return "http://127.0.0.1:9978/file/" + s;
    }

    @Override
    public void start() {
        // 宿主在 start() 返回后立即轮询 isStarting()：先同步置位，再做可能耗时 5s 的依赖定位
        serverManager.markStarting();
        loadApkParams();

        File nodeBinary = resolveBinary();
        if (nodeBinary == null) {
            serverManager.cancelStart();
            return;
        }
        File assetsDir = new File(Path.getSystemPluginPath() + "/" + ID + "/assets");
        File serverJs = new File(assetsDir, "legado-server.cjs");

        // params 打包为 JSON 注入 node（书源加载/合并逻辑全在 node 侧；
        // 本地书源已在 loadApkParams 转成 /file/ 地址并入 remoteUrls）
        JsonObject env = new JsonObject();
        env.addProperty("remoteUrls", remoteUrls == null ? "" : remoteUrls);

        // 启动含就绪探测（最长约 25s），放后台线程避免阻塞宿主调用线程
        final File fNode = nodeBinary;
        final File fJs = serverJs;
        final String params = env.toString();
        new Thread(() -> serverManager.start(fNode, fJs, params), "legado-start").start();
    }

    @Override
    public void stop() {
        if (serverManager != null) serverManager.stop();
    }

    @Override
    public boolean isRunning() {
        return serverManager != null && serverManager.isRunning();
    }

    @Override
    public boolean isStarting() {
        return serverManager != null && serverManager.isStarting();
    }

    @Override
    public int getPort() {
        return serverManager != null && serverManager.isRunning() ? serverManager.getPort() : 0;
    }

    /** 从自身 plugin.json 的 depends 声明定位运行时插件提供的 node 可执行文件 */
    private File resolveBinary() {
        ApkPluginBean self = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<String> depends = self == null ? null : self.getDepends();
        if (depends == null || depends.isEmpty()) {
            LOG.e("Legado", "plugin.json 未声明 depends，无法定位 node 二进制");
            return null;
        }
        IRuntimePlugin runtime = Plugin.getRuntimePluginById(depends.get(0));
        if (runtime == null) {
            LOG.e("Legado", "运行时插件未安装，请先安装: " + depends.get(0));
            return null;
        }
        File bin = new File(runtime.getExecutable());
        // init 并行加载的极端时序兜底：依赖插件可能仍在解压 assets，等待落盘（最多 5s）
        long deadline = System.currentTimeMillis() + 5_000;
        while (!bin.exists() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(200); } catch (InterruptedException e) { break; }
        }
        if (!bin.exists()) LOG.e("Legado", "运行时插件未安装或缺少 node，请先安装: " + depends);
        return bin.exists() ? bin : null;
    }
}
