package io.legado.app.exception

/**
 * 不记录错误堆栈的报错（对齐 legado jvmAndAndroidMain actual：抑制堆栈采集）。
 * legado commonMain 为 expect class，插件单平台直接提供 JVM 实现。
 */
open class NoStackTraceException(msg: String) : Exception(msg) {
    override fun fillInStackTrace(): Throwable {
        stackTrace = emptyArray()
        return this
    }
}
