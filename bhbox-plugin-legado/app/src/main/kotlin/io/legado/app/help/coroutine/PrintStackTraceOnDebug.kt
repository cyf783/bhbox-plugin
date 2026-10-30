package io.legado.app.help.coroutine

import android.util.Log

/**
 * 对齐 legado PlatformDispatchers.android actual（仅可调试环境打印堆栈）。
 * 插件无 BuildConfig 开关，统一走 Logcat warn 通道（tag 与 RuleAnalyzer 一致）。
 */
fun Throwable.printStackTraceOnDebug() {
    Log.w("legado-engine", Log.getStackTraceString(this))
}
