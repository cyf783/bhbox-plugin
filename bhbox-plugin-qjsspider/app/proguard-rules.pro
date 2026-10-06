# QuickJS Spider 插件 ProGuard 规则
# 入口类由主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留

# 自定义混淆字典（由 proguard-dictionaries-generator 插件生成）
-obfuscationdictionary build/proguard-dictionaries/obfuscation-dictionary.txt
-classobfuscationdictionary build/proguard-dictionaries/class-dictionary.txt
-packageobfuscationdictionary build/proguard-dictionaries/package-dictionary.txt

-dontskipnonpubliclibraryclassmembers
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes InnerClasses,EnclosingMethod

# QuickJS wrapper（native 回调 + JSMethod 注解反射，AAR consumer-rules 已 keep，此处兜底）
-keep class com.whl.quickjs.** { *; }

# @JSMethod 注解方法由 Global.setProperty 运行时反射扫描，必须保留方法名和注解
-keep class com.github.tvbox.quickjs.method.** { *; }

# Req/Res 等 bean 由宿主 Gson 反射反序列化（gson 为 compileOnly，运行期委托宿主完整 keep 的 gson）；
# R8 会把仅被反射使用的无参构造/字段内联删除，导致 Gson 报
# JsonIOException: Abstract classes can't be instantiated（所有 js 源网络请求返回空的根因）
-keep class com.github.tvbox.quickjs.bean.** { *; }

# jsoup（DOM 解析含反射）/ java9 retrofuture（CompletableFuture 回调）副本必须完整 keep：
# 插件 dex 内为自带副本（宿主已混淆不可委托），allowshrinking 会允许 R8 对副本
# 做合并/内联优化导致引用链断裂（okhttp3 陷阱教训）
-keep class org.jsoup.** { *; }
-keep class java9.util.** { *; }

# jsoup 副本引用了编译期 JSR-305 注解（javax.annotation.*），运行时不参与逻辑
-dontwarn javax.annotation.**

# 入口类（主 app 通过 DexClassLoader 反射加载，类名和无参构造必须保留）
-keep class bh.box.plugin.qjsspider.QjsSpiderPlugin {
    <init>();
}

-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

-keep class **.R$* {*;}

-keepclasseswithmembernames class * {
    native <methods>;
}
