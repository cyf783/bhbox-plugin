# MPV 播放器插件 ProGuard 规则

# 自定义混淆字典（由 proguard-dictionaries-generator 插件生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature

# 保留插件入口无参构造（主 app 通过 DexClassLoader 反射加载）
-keep class bh.box.plugin.mpv.MpvPlugin {
    <init>();
}

# 保留 MPVLib JNI 符号（native 方法名不能混淆）
-keep class is.xyz.mpv.MPVLib { *; }
-keepclassmembers class is.xyz.mpv.MPVLib {
    public static native *;
}

# 保留 MpvPlayer 中的 native 相关代码
-keep class bh.box.plugin.mpv.MpvPlayer { *; }

-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

-keep class **.R$* {*;}
