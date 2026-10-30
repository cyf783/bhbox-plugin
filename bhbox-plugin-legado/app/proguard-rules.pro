# 插件专用 ProGuard 规则
# 启用混淆：仅保留入口类与 JS 反射触达面（Rhino LiveConnect 按类名/方法名字符串反射调用，
# 改名即 NoSuchMethodError），其余代码（含 vendored Kotlin 解析层，插件内部直接调用、无反射）全部混淆收缩

# 自定义混淆字典（由 generateProguardDictionary 任务生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.legado.LegadoPlugin {
    <init>();
}

# ===== JS 反射触达面 =====
# java.* 桥：书源 JS 的 java.ajax/toast/get/put/... 字符串级调用全部 public 方法
-keep class bh.box.plugin.legado.engine.JsExtensions { public *; }
# Rhino：自身大量反射 + LiveConnect 动态生成类
-dontwarn org.mozilla.javascript.**
-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.classfile.** { *; }
# 书源 JS 直接调用：org.jsoup.Jsoup.parse(...)、element.select/attr/... （abea14 等源实锤使用）
-dontwarn org.jsoup.**
-keep class org.jsoup.** { *; }

# ===== 第三方库（仅告警抑制，无反射触达面，可正常混淆收缩）=====
-dontwarn com.fleeksoft.ksoup.**
-dontwarn kotlinx.serialization.**
-dontwarn kotlinx.atomicfu.**
-dontwarn org.nanohttpd.**
