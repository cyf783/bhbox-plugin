package bh.box.plugin.exo;

import android.text.TextUtils;

import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.DrmInitData;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.exoplayer.analytics.PlayerId;
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager;
import androidx.media3.exoplayer.drm.DrmSession;
import androidx.media3.exoplayer.drm.DrmSessionEventListener;
import androidx.media3.exoplayer.drm.DrmSessionManager;
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider;
import androidx.media3.exoplayer.drm.FrameworkMediaDrm;
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback;
import androidx.media3.exoplayer.drm.LocalMediaDrmCallback;
import androidx.media3.exoplayer.drm.MediaDrmCallback;

import com.github.catvod.utils.LOG;

import java.util.Map;
import java.util.UUID;

/**
 * DRM 会话管理提供者（P1：KODIPROP 驱动，配合 {@link ExoMediaSourceHelper} 使用）。
 * <p>
 * 相比 media3 默认的 {@code DefaultDrmSessionManagerProvider}，做了三件事：
 * <ol>
 *   <li>license 请求走插件统一的 OkHttp 数据源工厂（复用全局连接池与 UA），
 *       不用默认 {@code DefaultHttpDataSource}；</li>
 *   <li>licenseUri 非 http(s)（ClearKey 内联 keys JSON）时直接走
 *       {@link LocalMediaDrmCallback} 静态密钥直供，不发网络请求；</li>
 *   <li>manifest 缺少对应 scheme 的 cenc:pssh、但源通过 KODIPROP 显式提供了 PSSH
 *       数据（license_key=b64:... 或 pssh= 键）时，合成 {@link DrmInitData.SchemeData}
 *       注入会话创建（对应 FongMi forceKey 跳过 manifest PSSH 查找的语义）。</li>
 * </ol>
 * 注：每次 get() 新建 manager（media3 默认实现按 DrmConfiguration 缓存，这里
 *     每个 MediaSource 只会调用一次 get()，缓存无收益，省掉加锁复杂度）。
 */
@OptIn(markerClass = UnstableApi.class)
final class BhDrmSessionManagerProvider implements DrmSessionManagerProvider {

    private static final String TAG = "BhDrmProvider";

    private final DataSource.Factory mDrmDataSourceFactory;
    /** 可空：manifest 缺 PSSH 时注入的 init data（由 KODIPROP 的 pssh 键 / b64 license_key 提供） */
    @Nullable
    private final byte[] mInjectedPssh;
    /** 注入 PSSH 对应的 scheme UUID（与 DrmConfiguration.scheme 一致） */
    private final UUID mInjectedSchemeUuid;

    BhDrmSessionManagerProvider(DataSource.Factory drmDataSourceFactory,
                                @Nullable byte[] injectedPssh, UUID injectedSchemeUuid) {
        mDrmDataSourceFactory = drmDataSourceFactory;
        mInjectedPssh = injectedPssh;
        mInjectedSchemeUuid = injectedSchemeUuid;
    }

    @Override
    public DrmSessionManager get(MediaItem mediaItem) {
        MediaItem.DrmConfiguration drmConfiguration = mediaItem.localConfiguration.drmConfiguration;
        if (drmConfiguration == null) {
            return DrmSessionManager.DRM_UNSUPPORTED;
        }
        String licenseUrl = drmConfiguration.licenseUri == null
                ? null : drmConfiguration.licenseUri.toString();
        boolean staticKey = !TextUtils.isEmpty(licenseUrl) && !licenseUrl.startsWith("http");
        DefaultDrmSessionManager manager = new DefaultDrmSessionManager.Builder()
                .setUuidAndExoMediaDrmProvider(drmConfiguration.scheme, FrameworkMediaDrm.DEFAULT_PROVIDER)
                .setMultiSession(drmConfiguration.multiSession)
                .setPlayClearSamplesWithoutKeys(drmConfiguration.playClearContentWithoutKey)
                .setUseDrmSessionsForClearContent(toTrackTypes(drmConfiguration.forcedSessionTrackTypes))
                .build(createCallback(drmConfiguration, licenseUrl));
        manager.setMode(DefaultDrmSessionManager.MODE_PLAYBACK, drmConfiguration.getKeySetId());
        if (mInjectedPssh != null) {
            return new PsshInjectingManager(manager, mInjectedSchemeUuid, mInjectedPssh, false);
        }
        // ClearKey 静态密钥（forceKey 语义）：manifest 常只带 Widevine 的 cenc:pssh，
        // ClearKey session 会因无匹配 scheme 的 init data 建不起来。此处取 manifest
        // 中任一 schemeData 的数据按 ClearKey UUID 合成注入——Android clearkey CDM
        // 按 PSSH box 结构解析 kid，不校验 systemID。
        if (staticKey && C.CLEARKEY_UUID.equals(drmConfiguration.scheme)) {
            return new PsshInjectingManager(manager, drmConfiguration.scheme, null, true);
        }
        return manager;
    }

    /** 按 licenseUri 形态选择回调：http(s) → HttpMediaDrmCallback；其它 → 静态密钥直供 */
    private MediaDrmCallback createCallback(MediaItem.DrmConfiguration drmConfiguration, String licenseUrl) {
        if (staticKeyLicense(licenseUrl)) {
            // ClearKey 内联 keys JSON 等静态密钥：数据即响应，CDM 直接消费
            LOG.i(TAG + " license 静态密钥直供（非 http licenseUri）");
            return new LocalMediaDrmCallback(licenseUrl.getBytes());
        }
        if (TextUtils.isEmpty(licenseUrl)) {
            LOG.i(TAG + " license URI 缺省（PSSH 数据模式，由 CDM/manifest 提供 license 地址）");
        }
        HttpMediaDrmCallback callback = new HttpMediaDrmCallback(
                licenseUrl, drmConfiguration.forceDefaultLicenseUri, mDrmDataSourceFactory);
        for (Map.Entry<String, String> entry : drmConfiguration.licenseRequestHeaders.entrySet()) {
            callback.setKeyRequestProperty(entry.getKey(), entry.getValue());
        }
        return callback;
    }

    private static boolean staticKeyLicense(String licenseUrl) {
        return !TextUtils.isEmpty(licenseUrl) && !licenseUrl.startsWith("http");
    }

    /** ImmutableList<Integer> → int[]，SDK 23 兼容写法（guava Ints 不保证在插件 classpath） */
    private static int[] toTrackTypes(Iterable<Integer> trackTypes) {
        int size = 0;
        for (Integer ignored : trackTypes) {
            size++;
        }
        int[] types = new int[size];
        int i = 0;
        for (Integer trackType : trackTypes) {
            types[i++] = trackType;
        }
        return types;
    }

    /**
     * 会话管理器包装：为缺少对应 scheme PSSH 的 Format 合成 {@link DrmInitData.SchemeData}。
     * <p>
     * 背景：ClearKey/Widevine 会话创建依赖 manifest 携带匹配 systemID 的 cenc:pssh；
     * 源把 PSSH 数据显式写进 KODIPROP（pssh= 键 / license_key=b64:...）时，manifest
     * 可能不含 PSSH，直接起播会报 DRM session error——这里在 acquire 前补齐 init data。
     */
    private static final class PsshInjectingManager implements DrmSessionManager {

        private final DefaultDrmSessionManager mDelegate;
        private final UUID mSchemeUuid;
        @Nullable
        private final byte[] mPssh;
        /** forceKey 语义：无匹配 scheme 时取 manifest 首个 schemeData 的数据合成注入（仅 ClearKey 静态密钥模式） */
        private final boolean mFallbackToManifest;

        PsshInjectingManager(DefaultDrmSessionManager delegate, UUID schemeUuid,
                             @Nullable byte[] pssh, boolean fallbackToManifest) {
            mDelegate = delegate;
            mSchemeUuid = schemeUuid;
            mPssh = pssh;
            mFallbackToManifest = fallbackToManifest;
        }

        @Override
        public void prepare() {
            mDelegate.prepare();
        }

        @Override
        public void release() {
            mDelegate.release();
        }

        @Override
        public void setPlayer(Looper playbackLooper, PlayerId playerId) {
            mDelegate.setPlayer(playbackLooper, playerId);
        }

        @Override
        public DrmSessionReference preacquireSession(@Nullable DrmSessionEventListener.EventDispatcher eventDispatcher, Format format) {
            return mDelegate.preacquireSession(eventDispatcher, inject(format));
        }

        @Nullable
        @Override
        public DrmSession acquireSession(@Nullable DrmSessionEventListener.EventDispatcher eventDispatcher, Format format) {
            return mDelegate.acquireSession(eventDispatcher, inject(format));
        }

        @Override
        public int getCryptoType(Format format) {
            return mDelegate.getCryptoType(inject(format));
        }

        /** 无匹配 scheme 的 SchemeData 时注入合成的；已有则保持 manifest 原数据 */
        private Format inject(Format format) {
            DrmInitData drmInitData = format.drmInitData;
            if (drmInitData == null) {
                if (mPssh == null) {
                    return format;
                }
                return format.buildUpon()
                        .setDrmInitData(new DrmInitData(new DrmInitData.SchemeData(mSchemeUuid, MimeTypes.VIDEO_MP4, mPssh)))
                        .build();
            }
            for (int i = 0; i < drmInitData.schemeDataCount; i++) {
                if (mSchemeUuid.equals(drmInitData.get(i).uuid)) {
                    return format;
                }
            }
            byte[] injected = mPssh;
            if (injected == null) {
                if (!mFallbackToManifest || drmInitData.schemeDataCount == 0) {
                    return format;
                }
                injected = drmInitData.get(0).data;
                LOG.i(TAG + " forceKey: 用 manifest 的 PSSH 数据合成 ClearKey init data");
            }
            DrmInitData.SchemeData[] schemeDatas = new DrmInitData.SchemeData[drmInitData.schemeDataCount + 1];
            for (int i = 0; i < drmInitData.schemeDataCount; i++) {
                schemeDatas[i] = drmInitData.get(i);
            }
            schemeDatas[drmInitData.schemeDataCount] = new DrmInitData.SchemeData(mSchemeUuid, MimeTypes.VIDEO_MP4, injected);
            return format.buildUpon().setDrmInitData(new DrmInitData(schemeDatas)).build();
        }
    }
}
