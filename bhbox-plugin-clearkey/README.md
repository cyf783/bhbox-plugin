# ClearKey 解密代理插件（bh.box.plugin.extractor.clearkey）

让所有播放器内核（IJK / MPV / EXO / 系统播放器）都能播 **ClearKey 加密的 unfragmented CENC MP4**（如红果短剧源）。True DRM（Widevine/PlayReady）密钥不出 CDM，任何代理方式都拿不到明文，不在本插件能力范围。

## 工作原理

```
播放 URL（#KODIPROP:...license_type=clearkey&license_key={keys json}[&stream_headers={UA...}]）
    │  ExtractorManager.getUrl() 命中本插件
    ▼
Range 探测容器（只读头部 ≤2MB）
    ├─ fragmented MP4 / DASH ──→ 原样返回（EXO 原生 DRM session 路径继续工作，零影响）
    ├─ unfragmented CENC MP4 ─→ 流式流水线任务，立即返回 http://127.0.0.1:PORT/ck/<id>
    └─ 探测失败 ───────────────→ 原样返回（安全降级）
    ▼
任意播放器请求代理地址 → 响应头立即发出 → 数据逐块流出：
    头部连接从 0 开始【单流贯到底、永不中途换连接】（起播零额外握手，最快路径）：
    moov 一完整就解析出解密任务表并修剪 DRM 盒（头部即刻可读），随后数据沿同一连接
    流式喂入明文写入器：间隙直写、sample 内存解密后直写明文（密文不落盘），
    明文水位 readyPos 随每块写入实时推进，播放器请求越过时才短暂等待。
    仅当剩余量 > 12MB（大文件/长视频）时，顺序预跑 8MB 后才切换条带并行
    （4 连接轮转 + 乱序重装）提升中段吞吐；短剧单集约 9MB，全程单流。
```

- 解密语义与 EXO 插件的 `UnfragmentedCencDecryptor`（Box/media 方案 A）完全一致：仅 `cenc`（AES-CTR）、IV 0/8/16 字节补零、senc flags&0x02 subsample、kid hex 匹配（全零 kid / 单密钥放宽）。
- 零尺寸漂移修剪：`senc`/`frma`/`sinf` → `free`，stsd entry 4CC 恢复为 `frma` 原始格式（如 hvc1/mp4a），产出任何播放器可直接播放的明文 MP4。
- 性能设计（起播优先）：单流起播路径与最快起播版行为完全一致——不中途换连接（无握手空窗）、水位逐块实时推进（播放器不等全文件）；大文件才切条带并行（2MB 条带、乱序重装、连接回池复用）；内存解密直写明文（密文不落盘，磁盘写量减半）；内存上界 ≈ 2.5MB。
- 关键实现细节：完成 moov 的那一块往往多读了 moovEnd 之后的 mdat 字节，必须把该尾部补喂给写入器，否则流游标与文件游标错位、末尾 sample 永远攒不齐。
- 状态流转：DOWNLOADING（moov 未完整）→ STREAMING（边下边解，状态文本带进度）→ READY / FAILED；FAILED 条目在下次 `getUrl` 时自动重建。

## 依赖

- 宿主 ≥ `minAppVersion: 385`（含 `PlayContent.applyDrmKodiprop()`：drm 字段 → KODIPROP，并把 `header` 拼为 `stream_headers`，代理靠它拿 UA 下载 CDN）。
- 写源也可自行拼 KODIPROP（与 FongMi 格式兼容），headers 键：`common_headers` / `stream_headers` / `license_headers`（JSON，单引号宽容），按序覆盖。

## 生命周期

| 事件 | 行为 |
|---|---|
| `getUrl` 重复请求 | READY 复用缓存；进行中复用任务；FAILED 自动重建 |
| `stop(false)`（切集/退出播放） | 取消进行中任务，保留已就绪缓存 |
| `stop(true)` / 卸载 | 关闭代理服务器、删除全部缓存 |
| 缓存上限 | LRU 最多 3 个条目，目录 `cache/clearkey/` |

## 限制

- 仅支持 unfragmented CENC MP4；fMP4/DASH 的 ClearKey 由 EXO 原生路径处理。
- CDN 无 Content-Length 的源退化为单流顺序流水线（不并行）；超过 512MB 拒绝解密。
- 代理只绑定 127.0.0.1，不对外暴露。
