# 插件专用 ProGuard 规则
# 启用混淆：仅保留入口类名和接口方法，其余代码全部混淆

# 自定义混淆字典（由 generateProguardDictionary 任务生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.pyspider.PySpiderPlugin {
    <init>();
}

-keep class bh.box.plugin.pyspider.Proxy { *; }

# @Keep 注解标记的类和方法（Chaquopy Python 互操作需要）
-keep @androidx.annotation.Keep class * { *; }
-keepclassmembers class * {
    @androidx.annotation.Keep *;
}

-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

-keep class **.R$* {*;}

-keepclasseswithmembernames class * {
    native <methods>;
}

# Chaquopy Python 运行时
-dontwarn com.chaquo.python.**
-keep class com.chaquo.python.** { *; }
