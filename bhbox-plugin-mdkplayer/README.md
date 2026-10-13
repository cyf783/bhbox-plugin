# bhbox-plugin-mdkplayer

MDK 播放器内核插件（`bh.box.plugin.mdk`，工厂 ID=7）。方案见 `docs/BHBox播放器插件-mdkplayer方案.md`。

- mdk-sdk 版本：**v0.39.0**，预编 so 预提交于 `app/src/main/jniLibs/arm64-v8a/`（libmdk / libffmpeg / libass / libdav1d；`libmdk-avglue.so` 该版本已并入主库，`libc++_shared.so` 由 NDK 27.2 构建自动打包），升级走独立 PR 并同步替换 `app/src/main/cpp/include/mdk/` 头文件
- ABI：arm64-v8a
- 构建：`./gradlew assembleRelease`
- license key：见 `MdkPlugin.init()` TODO（无 key 时 mdk 在末帧显示二维码水印，发版前必须解决）
