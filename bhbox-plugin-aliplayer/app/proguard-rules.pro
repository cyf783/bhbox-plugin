# AliYunPlayer 播放器插件 ProGuard 规则

# 自定义混淆字典（由 proguard-dictionaries-generator 插件生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature

# AliYunPlayer SDK 类保护（native JNI 回调不能混淆）
-keep class com.alivc.** {*;}
-keep class com.aliyun.** {*;}
-keep class com.cicada.** {*;}
-dontwarn com.alivc.**
-dontwarn com.aliyun.**
-dontwarn com.cicada.**

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.ali.AliPlugin {
    <init>();
}

-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

-keep class **.R$* {*;}

# native 方法注册依赖 JNI 符号名，不能改名
-keepclasseswithmembernames class * {
    native <methods>;
}
