package bh.box.plugin.legado;

import android.text.TextUtils;

import com.github.catvod.plugin.IServicePlugin;
import com.github.catvod.plugin.bean.ApkParam;
import com.github.catvod.plugin.bean.ApkPluginBean;
import com.github.catvod.utils.LOG;
import com.github.catvod.utils.Plugin;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

import bh.box.plugin.legado.t4.T4Server;

/**
 * Legado 书源插件入口类（阅读APP书源 → T4 小说服务）。
 *
 * 纯 Service 插件（无 Spider 桥）：解析引擎与服务层均为进程内 Java 实现（engine/ + t4/），
 * 不再依赖 node 运行时插件——start() 直接启动进程内 T4Server（NanoHTTPD，端口 9930-9939）。
 * - 宿主把 http://127.0.0.1:<port>/config 当订阅配置拉取，得到每个启用书源对应的 type=4 站点
 * - 之后 home/list/detail/search/play 全部走宿主原生 T4 HTTP 通道直连本插件服务
 *
 * params 在 start 时注入；运行中可经 T4Server /params 端点读写并热更新
 * （持久化经 SDK Plugin.savePluginParams 交宿主统一处理，需宿主含该 API）。
 */
public class LegadoPlugin implements IServicePlugin {

    public static final String ID = "bh.box.plugin.legado";

    /**
     * 当前生效参数原始值（remoteUrls 多行值：每行 http(s):// 订阅地址或 file:// 本地书源
     * 文件，旧独立参数 localFile 读取时归并入此值）。宿主 bean 每次经 Cache 反序列化出
     * 新副本（CacheManager.get 直读 Room），不可作内存态载体——此处为插件侧生效态：
     * start 时从 bean 初始化，/params 保存后即时更新，打开 web 时经 syncIfChanged
     * 跟进外部修改（持久化统一回写宿主）。
     */
    private static volatile String liveRemoteUrls;

    /** 启动中标记（对齐原 LegadoServerManager.markStarting 的宿主轮询语义） */
    private final AtomicBoolean starting = new AtomicBoolean(false);

    @Override
    public void init() {
        // 服务为进程内 T4Server 静态单例，无需实例化资源
    }

    @Override
    public void install() {
        // 无额外部署：解析引擎与服务层随 APK 编译期内置
    }

    @Override
    public void uninstall() {}

    /** start 时从宿主 bean 快照当前参数到 live 态（此后 /params 读写均面向 live） */
    private static void initLiveParams() {
        liveRemoteUrls = null;
        List<ApkParam> params = Plugin.getPluginParams(ID);
        if (params == null) return;
        String legacyLocal = null;
        for (ApkParam param : params) {
            if (param == null) continue;
            if ("remoteUrls".equals(param.getId())) {
                liveRemoteUrls = param.getValue();
            } else if ("localFile".equals(param.getId())) {
                legacyLocal = param.getValue();
            }
        }
        liveRemoteUrls = mergeLegacyLocal(liveRemoteUrls, legacyLocal);
    }

    /**
     * live 多行值逐行转换为 remoteUrls：http(s):// 直取；file://（或裸路径）行经
     * /file/ 端点转换并入（本机回环，无路径/权限问题）。start 与 T4Server /params
     * 热更新共用。
     */
    private static String buildRemoteUrls() {
        if (TextUtils.isEmpty(liveRemoteUrls)) return null;
        List<String> out = new ArrayList<>();
        for (String s : liveRemoteUrls.split("\n")) {
            String u = toFileServerUrl(s);
            if (u != null) out.add(u);
        }
        return out.isEmpty() ? null : TextUtils.join("\n", out);
    }

    /**
     * 本地书源参数 → 本机文件服务地址。宿主 9978 /file/ 端点以 sdcard 根为基准提供本地文件
     * （宝盒/bookSource.json → http://127.0.0.1:9978/file/宝盒/bookSource.json），与
     * ApiLoadHelper/UrlHelper 消费 /file/ 地址的生态一致；参数值兼容 file:// 前缀与
     * 绝对路径（剥挂载根成相对段），已是 http(s) URL 则原样返回。
     */
    private static String toFileServerUrl(String raw) {
        if (TextUtils.isEmpty(raw)) return null;
        String s = raw.trim();
        if (s.startsWith("http://") || s.startsWith("https://")) return s;
        if (s.startsWith("file://")) s = s.substring("file://".length());
        while (s.startsWith("/")) s = s.substring(1);
        return "http://127.0.0.1:9978/file/" + s;
    }

    /** 宿主 bean 最新参数 → T4Server 启动参数 JSON（{"remoteUrls": 合并值}），start 与 /params 热更新共用 */
    public static String buildParamsJson() {
        JsonObject env = new JsonObject();
        String merged = buildRemoteUrls();
        env.addProperty("remoteUrls", merged == null ? "" : merged);
        return env.toString();
    }

    /** 实时读取宿主 bean 参数原始值（T4Server /params 回显用，直读持久层最新值；未配置返回 null） */
    public static String getParamRaw(String id) {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<ApkParam> params = bean == null ? null : bean.getParams();
        if (params == null) return null;
        for (ApkParam param : params) {
            if (param != null && id.equals(param.getId())) return param.getValue();
        }
        return null;
    }

    /**
     * 宿主 bean 参数与 live 不同时（TV 端表单等外部修改）同步 live 到 bean 值并返回
     * true，供 T4Server 打开 web 时自动跟进最新配置（无需手动重载）；一致返回 false。
     * bean 为唯一事实源：网页保存未持久化时，打开 web 会回滚到持久值。
     */
    public static boolean syncIfChanged() {
        ApkPluginBean bean = (ApkPluginBean) Plugin.getPluginBeanById(ID);
        List<ApkParam> params = bean == null ? null : bean.getParams();
        if (params == null) return false;
        String remote = null;
        String legacyLocal = null;
        for (ApkParam param : params) {
            if (param == null) continue;
            if ("remoteUrls".equals(param.getId())) {
                remote = param.getValue();
            } else if ("localFile".equals(param.getId())) {
                legacyLocal = param.getValue();
            }
        }
        String merged = mergeLegacyLocal(remote, legacyLocal);
        if (TextUtils.equals(merged, liveRemoteUrls)) return false;
        liveRemoteUrls = merged;
        return true;
    }

    /**
     * 保存参数：先更新 live 态（即时生效，供热更新重载消费），再经 SDK 交宿主统一
     * 持久化。参数不在 plugin.json 声明，运行期按 id upsert（已有条目只改 value
     * 保留元数据，缺失条目现场创建并补 name/type 供宿主表单渲染）；旧双参数中的
     * localFile 条目一并移除（合并值已含本地文件行）。经 Plugin.savePluginParams
     * 交宿主落 PluginCache（重启后可读回）。保存后校验持久层已生效（宿主可能静默
     * 跳过，如插件未注册），未生效抛错由请求层返回明确失败。
     */
    public static void saveParams(String remoteUrls) {
        if (remoteUrls != null) liveRemoteUrls = remoteUrls;
        List<ApkParam> saved = Plugin.getPluginParams(ID);
        // 宿主无参数时返回不可变空表、有参数时返回 bean 内部列表，均先拷贝再改
        List<ApkParam> params = new ArrayList<>();
        if (saved != null) params.addAll(saved);
        if (remoteUrls != null) upsertParam(params, "remoteUrls", "书源地址", remoteUrls);
        removeParam(params, "localFile");
        Plugin.savePluginParams(ID, params);
        if (!TextUtils.equals(getParamRaw("remoteUrls"), liveRemoteUrls)) {
            throw new IllegalStateException("persist not visible after savePluginParams");
        }
    }

    /** 按 id upsert 参数：存在只改 value（保留声明元数据），缺失则创建 */
    private static void upsertParam(List<ApkParam> params, String id, String name, String value) {
        for (ApkParam param : params) {
            if (param != null && id.equals(param.getId())) {
                param.setValue(value);
                return;
            }
        }
        params.add(new ApkParam().setId(id).setName(name).setType("text").setValue(value));
    }

    /** 按 id 移除参数条目（旧双参数 localFile 迁移清理用） */
    private static void removeParam(List<ApkParam> params, String id) {
        for (int i = params.size() - 1; i >= 0; i--) {
            ApkParam param = params.get(i);
            if (param != null && id.equals(param.getId())) params.remove(i);
        }
    }

    /**
     * 旧双参数迁移：localFile（旧独立参数，绝对路径或 file:// 前缀）归一为 file:// 行
     * 追加到 remoteUrls 多行值尾部；localFile 为空时原样返回。旧条目在首次 saveParams
     * 时移除，之后 localFile 读值为空，合并退化为直取 remoteUrls。
     */
    private static String mergeLegacyLocal(String remoteUrls, String localFile) {
        String l = localFile == null ? "" : localFile.trim();
        if (l.isEmpty()) return remoteUrls;
        String lower = l.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            if (lower.startsWith("file://")) l = l.substring("file://".length());
            while (l.startsWith("/")) l = l.substring(1);
            l = "file://" + l;
        }
        return TextUtils.isEmpty(remoteUrls) ? l : remoteUrls + "\n" + l;
    }

    @Override
    public void start() {
        // 宿主在 start() 返回后立即轮询 isStarting()：先同步置位（原 markStarting 语义）
        if (T4Server.isRunning()) return;
        starting.set(true);
        initLiveParams();

        // 参数为空也启动空服务（/config 返回空站点列表，语义对齐 node 版空参数加载）：
        // 仅在完全无法解析参数时快速失败（原 cancelStart 语义）
        final String params = buildParamsJson();

        // 端口 try-start 毫秒级，源数据由服务内部后台加载（先监听后加载），
        // 放后台线程避免占用宿主调用线程
        new Thread(() -> {
            try {
                T4Server.start(params);
            } finally {
                starting.set(false);
            }
        }, "legado-start").start();
    }

    @Override
    public void stop() {
        T4Server.shutdown();
        starting.set(false);
    }

    @Override
    public boolean isRunning() {
        return T4Server.isRunning();
    }

    @Override
    public boolean isStarting() {
        return starting.get();
    }

    @Override
    public int getPort() {
        return T4Server.getPort();
    }
}
