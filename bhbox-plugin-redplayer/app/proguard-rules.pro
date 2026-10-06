# RedPlayer 播放器插件 ProGuard 规则
# 入口类由主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留

# 自定义混淆字典（由 proguard-dictionaries-generator 插件生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature

# RedPlayer（native 层通过 JNI 回调 Java 类，类名/方法名不能混淆）
-keep class com.xingin.openredplayercore.** { *; }
-dontwarn com.xingin.openredplayercore.**

# AAR 中未使用的 renderview 引用了 androidx，仅编译期可见，忽略告警
-dontwarn androidx.**
-dontwarn com.google.android.material.**

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.red.RedPlugin {
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
