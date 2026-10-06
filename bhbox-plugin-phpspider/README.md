# PHP Spider 插件

> 插件 ID：`bh.box.plugin.phpspider` · 类型：spider（内容爬虫 / 数据源） · 版本：`1.1.0` · 构建 minSdk：`23`

## 简介

支持 PHP T3 Spider 插件，站点解析脚本以 PHP 编写，运行时依赖 php 插件提供 PHP 解释器。

## 插件标识

| 字段 | 值 |
| --- | --- |
| 插件 ID | `bh.box.plugin.phpspider` |
| 类型 | spider（内容爬虫 / 数据源） |
| 入口类 (mainClass) | `bh.box.plugin.phpspider.PhpSpiderPlugin` |
| 版本号 | `110`（`1.1.0`） |
| 最低 Android 版本（构建） | API 23 |
| 发布下载地址 | https://h-box-release.netlify.app/release/plugins/phpspider.apk |

## 技术栈与关键依赖

- 插件接口基类来自 `com.github.cyf783:bhbox-catvod:1.0.0`（compileOnly，与主工程 catvod 模块二进制一致）
- Android Gradle Plugin 8.5.1，compileSdk 36，targetSdk 28，仅构建 `arm64-v8a` ABI
- 内嵌 PHP 解析脚本 `assets/lib/spider.php`、`assets/lib/HtmlParser.php`
- 依赖 **php 运行时插件** 提供 PHP 执行环境

## 目录结构

```
.
├── app/
│   ├── build.gradle          # :app 模块构建脚本（命名空间、依赖、混淆）
│   ├── libs/                 # 预编译依赖（AAR/JAR/SO，按需）
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── assets/           # plugin.json + 运行所需资源（二进制/脚本/运行时）
│       ├── java/             # 插件入口类（即 plugin.json 中的 mainClass）
│       └── jniLibs/          # 原生库（.so，按需，仅 arm64-v8a）
├── build.gradle              # 根工程：AGP 版本与 ext 配置（compileSdk/minSdk/targetSdk 等）
├── gradle.properties
├── settings.gradle           # rootProject.name = bhbox-plugin-<name>
├── gradle/                   # 共享脚本（如 proguard-dictionary.gradle）
├── gradlew / gradlew.bat
└── local.properties          # 本地 SDK 路径（不入库）
```
> 注：部分子目录（libs / jniLibs / 特定 assets）仅在有对应需求时存在。

## 构建要求

- **JDK 17**：AGP 8.5.1 需要 JDK 17（构建脚本优先选用 `~/.sdkman/candidates/java/17.0.15-zulu`，其次 Android Studio JBR）。
- **Android SDK**：Platform 36（compileSdk 36）+ 对应 Build Tools。
- **Gradle**：项目 wrapper 自带（无需单独安装），直接执行 `./gradlew` 即可。
- **ABI**：仅支持 `arm64-v8a`。

## 构建

```bash
./gradlew :app:copyApk --no-build-cache
```

构建产物（release APK）会被复制到工程内的 `apk/plugins/<name>.apk`。

> 多插件统一打包：回到仓库根目录执行 `./build-all.sh`（`build-all.sh` 会逐个调用各插件的 `:app:copyApk`，并将全部 APK 汇总到 `BHBox/apk/plugins/`）。

## 与 BHBox 集成

本插件是一个**独立 APK**，由 BHBox 主程序的 `PluginManager` 通过 `DexClassLoader` 动态加载，安装目录为 `/files/plugins/{id}/`。
插件自身元数据定义在 `app/src/main/assets/plugin.json`（含名称、类型、入口类、版本、配置参数等）。
开发接口（`Plugin` / `ServicePlugin` / `SpiderPlugin` / `PluginCache` 等）由 `com.github.cyf783:bhbox-catvod` AAR 提供。

## 许可

与主工程 BHBox 一致，采用 **GNU AGPL v3** 许可证。
