# EXO 播放器插件 ProGuard 规则
# 入口类由主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留

# 自定义混淆字典（由 proguard-dictionaries-generator 插件生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes InnerClasses,EnclosingMethod

# media3 为 cyf783 fm 定制构建，保留类名/成员名不混淆（仍参与裁剪优化），
# 避免 R8 混淆破坏其内部行为，且崩溃堆栈可直接阅读
-keep,allowshrinking class androidx.media3.** { *; }

# ffmpeg 软解扩展(libs/lib-decoder-ffmpeg-release.aar)只被 DefaultRenderersFactory 通过
# Class.forName("androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer" / ".FfmpegVideoRenderer")
# 反射加载,静态引用分析不到 → 上面的 allowshrinking 规则会把整个扩展包裁掉(反射时
# ClassNotFoundException, 表现为「切了软解没变化 / AC3 依然无声」)。这里必须无条件 keep,
# 连同 native 方法一起保住。注意 fork 反射的是 FfmpegVideoRenderer(非上游的
# ExperimentalFfmpegVideoRenderer), 构造签名 (Context,long,Handler,listener,int)。
-keep class androidx.media3.decoder.ffmpeg.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}

# okhttp3/okio 运行时实际使用宿主提供的类（parent-first 委托），必须完整 keep：
# allowshrinking 会允许 R8 对插件 dex 内的 okhttp3 副本做合并/内联优化，
# 导致依赖它的 OkHttpDataSource 引用链断裂被桩化（open() 变 throw null、
# callFactory 被常量传播成 null 而在构造时 NPE）。宿主 app 对 okhttp3/okio 也是完整 keep。
-keep class okhttp3.** { *; }
-keep class okio.** { *; }

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.exo.ExoPlugin {
    <init>();
}

-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

-keep class **.R$* {*;}
