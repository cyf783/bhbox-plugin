package bh.box.plugin.legado.engine

import io.legado.app.model.analyzeRule.AnalyzeByJSonPath

/** Java 侧（TemplateRenderer {{$.x}} 模板等）调用 Kotlin 解析层的桥接 */
object KotlinBridge {

    /**
     * {{$.x}} 模板子规则求值：直接以 legado AnalyzeByJSonPath 语义执行
     * （RJPath 查询 + 内嵌 {$.} 替换 + &&/|| 组合），data 接受 gson JsonElement/Map/List/String。
     */
    @JvmStatic
    fun jsonLookup(data: Any, expr: String): String? {
        return try {
            AnalyzeByJSonPath(data).getString(expr)
        } catch (e: Exception) {
            null
        }
    }
}
