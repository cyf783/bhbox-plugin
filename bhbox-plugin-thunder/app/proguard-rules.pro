# 迅雷播放类型插件 ProGuard 规则
# 入口类由主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留

# 自定义混淆字典（由 proguard-dictionaries-generator 插件生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes InnerClasses,EnclosingMethod

# 迅雷 SDK：JNI 回调 + 静态单例（XLDownloadManager.getInstance）/静态设备字段（XLUtil），
# 体积小（79KB），全量 keep 最稳
-keep class com.xunlei.** { *; }

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.extractor.thunder.ThunderExtractorPlugin {
    <init>();
}

-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

-keep class **.R$* {*;}
