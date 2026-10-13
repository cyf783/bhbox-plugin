# MDK 播放器插件 ProGuard 规则
# 入口类由主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留

# 自定义混淆字典（由 proguard-dictionary.gradle 生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.mdk.MdkPlugin {
    <init>();
}

# native 方法依赖 JNI 符号名（Java_bh_box_plugin_mdk_MdkPlayer_*），类名与方法名不能混淆
-keepclasseswithmembernames class * {
    native <methods>;
}

# postEventFromNative 仅被 libmdk-jni.so 回调（Java 侧无调用者，R8 会误判为不可达而删除）
-keepclassmembers class bh.box.plugin.mdk.MdkPlayer {
    private static void postEventFromNative(java.lang.Object, int, int, int, java.lang.Object);
}

-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

-keep class **.R$* {*;}
