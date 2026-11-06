package org.jsoup.select

import com.fleeksoft.ksoup.nodes.Element
import com.fleeksoft.ksoup.nodes.Node
import com.fleeksoft.ksoup.nodes.TextNode
import com.fleeksoft.ksoup.select.Elements as KsElements
import io.legado.app.exception.NoStackTraceException
import io.legado.app.utils.scan.BalanceScan
import kotlin.reflect.KClass

/**
 * Lightweight XPath evaluator for ksoup.
 *
 * 基线逐字同步自 legado 官方 `data/src/commonMain/kotlin/org/jsoup/select/XPathEvaluator.kt`，
 * 在此基础上为「兼容全部阅读书源」做了扩展（官方这份轻量件本身有意只实现了 XPath 1.0 子集，
 * 其测试甚至把 `text()` 谓词、`[*]`、`string-length()` 列为「应抛错」）。扩展内容：
 *
 * - 修正 3 个基线缺陷：`*[...]` 通配标签取不到元素、裸 `[last()]` 被当布尔全命中、
 *   `not(` 被词法器切成普通函数导致 `not(...)` 永远不可用。
 * - 谓词补齐：`text()` / `.` 自身文本、子元素与节点测试 `[a]` / `[a='x']` / `[*]` / `[@*]` /
 *   `[../@id='x']`、`last()-N` 等算术、`and`/`or` 组合下的完整函数集
 *   （normalize-space / string-length / substring* / concat / translate / ends-with / matches /
 *   number / sum / count / floor / ceiling / round / boolean / string / local-name / name / id）。
 * - 路径补齐：`|` 并集、`/text()` 与 `//text()` 真实文本节点步、`/@*` 全属性、
 *   parent/self/child/descendant/ancestor/following(-sibling)/preceding(-sibling) 等轴。
 *
 * 原有语义（同名兄弟 1 基位置、属性缺失用 Missing 参与比较恒 false、and 优先于 or、
 * 多谓词求交、引号内斜杠不切分层、坏语法抛错而非静默多选）一律保持不变。
 */
class XPathEvaluator {

    companion object {
        private val WHITESPACE = Regex("\\s+")

        fun evaluate(xpath: String, element: Element): List<Node> {
            val evaluator = XPathEvaluator()
            return evaluator.eval(xpath, element)
        }

        fun evaluateElements(xpath: String, element: Element): KsElements {
            val result = evaluate(xpath, element)
            return KsElements(result.filterIsInstance<Element>())
        }
    }

    fun eval(xpath: String, element: Element): List<Node> {
        val trimmed = xpath.trim()
        if (trimmed.isEmpty()) return emptyList()

        // 并集 //a | //b：引号内与谓词内的 | 不作分隔符（splitQuoted 已跟踪 [] 与引号）
        val branches = BalanceScan.splitQuoted(trimmed, '|', pair = false).map { it.trim() }
        if (branches.size > 1) {
            val out = ArrayList<Node>()
            val seen = HashSet<Int>()
            for (b in branches) {
                if (b.isEmpty()) continue
                for (n in eval(b, element)) {
                    if (seen.add(System.identityHashCode(n))) out.add(n)
                }
            }
            return out
        }

        // 文本节点步：/text() 取直接子文本，//text() 取全部后代文本。
        // 基线里 AnalyzeByXPath 曾以剥离尾步 + Element.text() 近似，会丢掉分节点语义。
        if (trimmed == "text()" || trimmed.endsWith("/text()")) {
            val recursive = trimmed.endsWith("//text()")
            val base = if (trimmed == "text()") "."
            else trimmed.removeSuffix("/text()").removeSuffix("/").trim()
            val elements = if (base.isEmpty() || base == "." || base == "/") listOf(element)
            else selectByPath(base, element)
            val out = ArrayList<Node>()
            for (el in elements) {
                if (recursive) collectTextNodes(el, out) else collectDirectTextNodes(el, out)
            }
            return out
        }

        // 属性步：/@attr 与 /@*。
        // 只认谓词/引号之外的顶层 /@：基线用 contains("/@") 会把 `//a[../@id='x']`
        // 里父轴的 `../@id` 误判成属性步，拆出残缺路径 → 静默返回空、谓词根本不执行。
        val atStep = topLevelAttrStep(trimmed)
        if (atStep >= 0) {
            val elementPath = trimmed.substring(0, atStep).ifEmpty { "." }
            val attrName = trimmed.substring(atStep + 2).trim()

            val elements = if (elementPath == ".") {
                listOf(element)
            } else {
                selectByPath(elementPath, element)
            }

            val out = ArrayList<Node>()
            for (el in elements) {
                if (attrName == "*") {
                    for (a in el.attributes()) {
                        if (a.value.isNotEmpty()) out.add(TextNode(a.value))
                    }
                } else {
                    val attrValue = el.attr(attrName)
                    if (attrValue.isNotEmpty()) out.add(TextNode(attrValue))
                }
            }
            return out
        }

        return selectByPath(trimmed, element)
    }

    /** 顶层 `/@` 步的起始下标；谓词 `[]` 内、引号内的一律不算。 */
    private fun topLevelAttrStep(path: String): Int {
        var depth = 0
        var quote = 0.toChar()
        var i = 0
        while (i < path.length - 1) {
            val c = path[i]
            if (quote != 0.toChar()) {
                if (c == quote) quote = 0.toChar()
            } else when (c) {
                '\'', '"' -> quote = c
                '[' -> depth++
                ']' -> if (depth > 0) depth--
                '/' -> if (depth == 0 && path[i + 1] == '@') return i
            }
            i++
        }
        return -1
    }

    private fun collectDirectTextNodes(element: Element, out: MutableList<Node>) {
        for (n in element.childNodes()) {
            if (n is TextNode && n.text().isNotBlank()) out.add(n)
        }
    }

    private fun collectTextNodes(element: Element, out: MutableList<Node>) {
        for (n in element.childNodes()) {
            when {
                n is TextNode -> if (n.text().isNotBlank()) out.add(n)
                n is Element -> collectTextNodes(n, out)
            }
        }
    }

    private fun selectByPath(path: String, element: Element): List<Element> {
        val trimmed = path.trim()

        //处理开头的 / 或 //
        val isAbsolute = trimmed.startsWith("/")
        val isRecursiveRoot = trimmed.startsWith("//")
        val relativePath = when {
            isRecursiveRoot -> trimmed.substring(2)
            isAbsolute -> trimmed.substring(1)
            else -> trimmed
        }

        val root = if (isAbsolute) element.ownerDocument() ?: element else element

        //按 // 分割路径, 每段是相对路径, 段间为后代递归关系
        //如 "div//a/b" → ["div", "a/b"]；引号内与 `[]` 内的 `/` 不作分隔符
        val segments = BalanceScan.splitQuoted(relativePath, '/', pair = true).filter { it.isNotEmpty() }
        if (segments.isEmpty()) return listOf(root)

        //第一段: 若路径以 // 开头则递归搜索, 否则相对搜索
        var currentNodes = if (isRecursiveRoot) {
            selectDescendants(segments[0], root)
        } else {
            selectRelative(segments[0], root)
        }

        //后续每段都是后代递归搜索
        for (i in 1 until segments.size) {
            val nextNodes = mutableListOf<Element>()
            for (node in currentNodes) {
                nextNodes.addAll(selectDescendants(segments[i], node))
            }
            currentNodes = nextNodes
        }

        return currentNodes
    }

    /**
     * 后代递归搜索: 在 element 的所有后代中匹配 segment (segment 可含多级相对路径)
     */
    private fun selectDescendants(segment: String, element: Element): List<Element> {
        val parts = parsePathParts(segment)
        if (parts.isEmpty()) return listOf(element)

        //对第一段做递归后代搜索
        var currentNodes = selectStep(parts[0], element, descendants = true)

        //segment 内剩余路径段用相对路径处理 (如 "div/a" 中的 "/a")
        if (parts.size == 1) return currentNodes

        for (part in parts.drop(1)) {
            val nextNodes = mutableListOf<Element>()
            for (node in currentNodes) {
                nextNodes.addAll(selectStep(part, node, descendants = false))
            }
            currentNodes = nextNodes
        }
        return currentNodes
    }

    /**
     * 递归收集所有后代元素 (不含自身)
     */
    private fun collectAllDescendants(element: Element): List<Element> {
        val result = mutableListOf<Element>()
        for (child in element.children()) {
            result.add(child)
            result.addAll(collectAllDescendants(child))
        }
        return result
    }

    private fun selectRelative(path: String, element: Element): List<Element> {
        if (path.isEmpty()) return listOf(element)

        var currentNodes = listOf(element)

        for (part in parsePathParts(path)) {
            val nextNodes = mutableListOf<Element>()
            for (node in currentNodes) {
                nextNodes.addAll(selectStep(part, node, descendants = false))
            }
            currentNodes = nextNodes
        }

        return currentNodes
    }

    private fun parsePathParts(path: String): List<PathPart> {
        val parts = mutableListOf<PathPart>()
        //引号内与 `[]` 内的 `/` 不作层级分隔：`//a[@href='/b/c']` 的值里带斜杠, 按裸 split 会被切成三截
        //→ getElementsByTag("a[@href='") 空 → 整条规则静默返回 0 结果
        val segments = BalanceScan.splitQuoted(path, '/', pair = false).filter { it.isNotEmpty() }

        for (segment in segments) {
            when {
                segment == ".." -> parts.add(PathPart.Parent)
                segment == "." -> parts.add(PathPart.Current)
                segment == "*" -> parts.add(PathPart.AllChildren)
                // 轴步：following-sibling::div[@class='x']。先于谓词分支判定，避免被切成标签名
                segment.contains("::") -> {
                    val idx = segment.indexOf("::")
                    val axis = segment.substring(0, idx).lowercase()
                    val spec = segment.substring(idx + 2)
                    val (tagName, predicates) = parsePredicates(spec)
                    parts.add(PathPart.Axis(axis, normalizeTag(tagName), predicates))
                }
                segment.contains("[") -> {
                    val (tagName, predicates) = parsePredicates(segment)
                    // 修正基线缺陷：`//*[@id='x']` 的 tag 曾是 "*"，被喂给 getElementsByTag("*")
                    // 得到空集。空 tag 在 selectStep 里走 collectAllDescendants / children。
                    parts.add(PathPart.TagWithPredicate(normalizeTag(tagName), predicates))
                }
                else -> parts.add(PathPart.Tag(segment))
            }
        }

        return parts
    }

    /** XPath `*` 节点测试 = 任意元素；内部用空 tag 表示。 */
    private fun normalizeTag(tag: String): String = if (tag == "*") "" else tag

    /**
     * 切出标签名与它的**全部**顶层谓词。
     * 谓词边界用计数式 [BalanceScan.chomp] 逐个拉出，并把连续的多个谓词（`div[a][b]`）全部
     * 收集后求交（基准是 XPath 1.0 的位置步语义）。
     *
     * 残缺（有 `[` 但无配对 `]`）时与原实现同形：整段当标签名、不带谓词，
     * 于是 `getElementsByTag("div[")` 取不到任何东西（宁可漏选，也不静默多选）。
     */
    private fun parsePredicates(segment: String): Pair<String, List<String>> {
        val first = segment.indexOf('[')
        if (first == -1) {
            return segment to emptyList()
        }

        val predicates = ArrayList<String>(2)
        var pos = first
        while (pos < segment.length && segment[pos] == '[') {
            //谓词内允许带引号的字面量（`@id='x'`），引号内符号不计层；引号内反斜杠无效
            val end = BalanceScan.chomp(
                segment, pos, '[', ']',
                quote = true, escape = BalanceScan.Escape.OUTSIDE_QUOTES
            )
            if (end < 0) {
                return segment to emptyList()
            }
            predicates.add(segment.substring(pos + 1, end - 1).trim()) //谓词两侧空白容忍, 不致 `div[ 1 ]` 被判成不支持
            pos = end
            while (pos < segment.length && segment[pos] == ' ') pos++ //谓词间空白容忍
        }

        return segment.substring(0, first) to predicates
    }

    /**
     * 单个路径步的选取。与 [selectDescendants] 共用同一份 `when`（此前两处各写一遍，
     * 同名分支只有一处差异：[PathPart.AllChildren] 与空标签的 [PathPart.TagWithPredicate]
     * 在后代步下取全部后代、在相对步下只取直接子级，故用 [descendants] 显式区分）。
     */
    private fun selectStep(part: PathPart, element: Element, descendants: Boolean): List<Element> {
        return when (part) {
            is PathPart.Parent -> {
                val parent = element.parent()
                if (parent is Element) listOf(parent) else emptyList()
            }
            is PathPart.Current -> listOf(element)
            is PathPart.AllChildren ->
                if (descendants) collectAllDescendants(element) else element.children()
            is PathPart.Tag -> element.getElementsByTag(part.name)
            is PathPart.TagWithPredicate -> {
                val elements = if (part.tag.isEmpty()) {
                    if (descendants) collectAllDescendants(element) else element.children()
                } else {
                    element.getElementsByTag(part.tag)
                }
                filterByPredicate(elements, part.predicates)
            }
            is PathPart.Axis -> {
                val candidates = axisCandidates(part.axis, element)
                val filtered = if (part.tag.isEmpty()) candidates
                else candidates.filter { it.tagName() == part.tag }
                filterByPredicate(filtered, part.predicates)
            }
        }
    }

    /** 轴候选集（namespace 轴按 xpathHelp.md 明确不支持）。 */
    private fun axisCandidates(axis: String, element: Element): List<Element> = when (axis) {
        "self" -> listOf(element)
        "parent" -> listOfNotNull(element.parent() as? Element)
        "child" -> element.children().toList()
        "descendant" -> collectAllDescendants(element)
        "descendant-or-self" -> listOf(element) + collectAllDescendants(element)
        "ancestor" -> ancestorsOf(element)
        "ancestor-or-self" -> listOf(element) + ancestorsOf(element)
        "following-sibling" -> siblingsOf(element, after = true)
        "preceding-sibling" -> siblingsOf(element, after = false)
        "following" -> documentOrderOf(element, after = true)
        "preceding" -> documentOrderOf(element, after = false)
        "attribute" -> emptyList() // 属性节点由 /@ 与 /@* 分支处理
        else -> throw NoStackTraceException("XPath 轴不支持: $axis")
    }

    private fun ancestorsOf(element: Element): List<Element> {
        val out = ArrayList<Element>()
        var p = element.parent()
        while (p is Element) {
            out.add(p)
            p = p.parent()
        }
        return out
    }

    private fun siblingsOf(element: Element, after: Boolean): List<Element> {
        val parent = element.parent() as? Element ?: return emptyList()
        val all = parent.children().toList()
        val idx = all.indexOf(element)
        if (idx < 0) return emptyList()
        return if (after) all.drop(idx + 1) else all.take(idx)
    }

    private fun documentOrderOf(element: Element, after: Boolean): List<Element> {
        val doc = element.ownerDocument() ?: return emptyList()
        val all = listOf(doc as Element) + collectAllDescendants(doc)
        val idx = all.indexOf(element)
        if (idx < 0) return emptyList()
        return if (after) {
            // following 不含自身后代
            all.drop(idx + 1).filterNot { ancestorsOf(it).contains(element) }
        } else {
            // preceding 不含自身祖先
            all.take(idx).filterNot { ancestorsOf(element).contains(it) }
        }
    }

    /** 多个谓词求交：`div[a][b]` 两个谓词都要成立（基准为 XPath 1.0 的位置步语义）。 */
    private fun filterByPredicate(elements: List<Element>, predicates: List<String>): List<Element> {
        if (predicates.isEmpty()) return elements

        //谓词各解析一次成 AST, 再逐个元素复用 (旧实现每个元素重跑一遍全部正则)
        val exprs = predicates.map { parsePredicate(it) }
        return elements.filter { element -> exprs.all { it.eval(element) } }
    }

    /** 谓词切词。引号内不作任何切分, 引号内反斜杠无效 (与 [parsePredicates] 同口径)。 */
    private fun tokenizePredicate(src: String): List<PTok> {
        val toks = ArrayList<PTok>(8)
        var i = 0
        while (i < src.length) {
            val c = src[i]
            when {
                c == ' ' || c == '\t' || c == '\n' || c == '\r' -> i++
                c == '(' -> { toks.add(PTok.Open); i++ }
                c == ')' -> { toks.add(PTok.Close); i++ }
                c == ',' -> { toks.add(PTok.Comma); i++ }
                c == '=' -> { toks.add(PTok.Rel(RelOp.Eq)); i++ }
                c == '!' -> {
                    if (i + 1 >= src.length || src[i + 1] != '=') {
                        throw NoStackTraceException(unsupported(src))
                    }
                    toks.add(PTok.Rel(RelOp.Ne)); i += 2
                }

                c == '<' -> {
                    if (i + 1 < src.length && src[i + 1] == '=') {
                        toks.add(PTok.Rel(RelOp.Le)); i += 2
                    } else {
                        toks.add(PTok.Rel(RelOp.Lt)); i++
                    }
                }

                c == '>' -> {
                    if (i + 1 < src.length && src[i + 1] == '=') {
                        toks.add(PTok.Rel(RelOp.Ge)); i += 2
                    } else {
                        toks.add(PTok.Rel(RelOp.Gt)); i++
                    }
                }

                c == '+' -> { toks.add(PTok.Plus); i++ }
                c == '-' -> { toks.add(PTok.Minus); i++ }
                c == '*' -> { toks.add(PTok.Star); i++ }

                c == '.' -> {
                    when {
                        i + 1 < src.length && src[i + 1] == '.' -> { toks.add(PTok.DotDot); i += 2 }
                        i + 1 < src.length && src[i + 1].isDigit() -> {
                            // `.5` 这类无前导零的数字字面量
                            var j = i + 1
                            while (j < src.length && src[j].isDigit()) j++
                            val value = src.substring(i, j).toDoubleOrNull()
                                ?: throw NoStackTraceException(unsupported(src))
                            toks.add(PTok.Num(value)); i = j
                        }
                        else -> { toks.add(PTok.Dot); i++ }
                    }
                }

                c == '/' -> {
                    if (i + 1 < src.length && src[i + 1] == '/') {
                        toks.add(PTok.DSlash); i += 2
                    } else {
                        toks.add(PTok.Slash); i++
                    }
                }

                c == '@' -> {
                    if (i + 1 < src.length && src[i + 1] == '*') {
                        toks.add(PTok.AttrStar); i += 2
                    } else {
                        var j = i + 1
                        //属性名可含 `:`/`.`/`-` (HTML `data-*`、XML 命名空间前缀都是合法名字)
                        while (j < src.length && (src[j].isLetterOrDigit() || src[j] in "_:.-")) j++
                        if (j == i + 1) throw NoStackTraceException(unsupported(src))
                        toks.add(PTok.Attr(src.substring(i + 1, j))); i = j
                    }
                }

                c == '\'' || c == '"' -> {
                    val close = src.indexOf(c, i + 1)
                    if (close < 0) throw NoStackTraceException("XPath 谓词引号未配对: [$src]")
                    toks.add(PTok.Str(src.substring(i + 1, close))); i = close + 1
                }

                c.isDigit() -> {
                    var j = i
                    var dotted = false
                    while (j < src.length) {
                        val d = src[j]
                        if (d.isDigit()) {
                            j++
                        } else if (d == '.' && !dotted) {
                            dotted = true; j++
                        } else {
                            break
                        }
                    }
                    val value = src.substring(i, j).toDoubleOrNull()
                        ?: throw NoStackTraceException(unsupported(src))
                    toks.add(PTok.Num(value)); i = j
                }

                c.isLetter() -> {
                    var j = i
                    while (j < src.length && (src[j].isLetterOrDigit() || src[j] == '-' || src[j] == '_')) j++
                    val word = src.substring(i, j)
                    var k = j
                    while (k < src.length && src[k] == ' ') k++
                    when {
                        // 修正基线缺陷：`not(` 曾先命中「名字后跟 (」被切成 Func("not")，
                        // 而 parseUnary 只认 Kw("not")，导致 not(...) 永远抛错。关键字优先。
                        word == "and" || word == "or" || word == "not" -> {
                            toks.add(PTok.Kw(word)); i = j
                        }
                        k + 1 < src.length && src[k] == ':' && src[k + 1] == ':' -> {
                            // 轴步 `following-sibling::a`：吞掉 `::`，名字本身不入 token 流
                            toks.add(PTok.Axis(word.lowercase())); i = k + 2
                        }
                        k < src.length && src[k] == '(' -> {
                            // 函数：只消费名字，`(` 留给下一轮单独切词
                            toks.add(PTok.Func(word.lowercase())); i = j
                        }
                        // 裸名字 = 节点测试（[a] / [node()] 里的标签名），不再当坏语法抛错
                        else -> { toks.add(PTok.Name(word)); i = j }
                    }
                }

                else -> throw NoStackTraceException(unsupported(src))
            }
        }
        return toks
    }

    private fun unsupported(predicate: String) = "XPath 谓词不支持: [$predicate]"

    /**
     * 谓词解析：保留基线的递归下降结构（or < and < 一元 < 比较 < 分组），
     * 在其上补齐节点测试操作数、算术后缀与 XPath 1.0 常用函数。
     * 语法不整（残缺括号、多余 token、不认识的函数）仍按不支持抛错, 不静默放行。
     */
    private fun parsePredicate(predicate: String): PredExpr {
        val toks = tokenizePredicate(predicate)
        if (toks.isEmpty()) throw NoStackTraceException("XPath 谓词为空")
        val parser = PredParser(toks, predicate)
        val expr = parser.parseExpression()
        if (!parser.atEnd()) throw NoStackTraceException(unsupported(predicate))
        return expr
    }

    /** 词法单元。 */
    private sealed class PTok {
        object Open : PTok()
        object Close : PTok()
        object Comma : PTok()
        object Dot : PTok()          // .
        object DotDot : PTok()       // ..
        object Star : PTok()         // *
        object AttrStar : PTok()     // @*
        object Plus : PTok()
        object Minus : PTok()
        object Slash : PTok()
        object DSlash : PTok()
        class Rel(val op: RelOp) : PTok()
        class Kw(val word: String) : PTok()
        class Func(val name: String) : PTok()
        class Attr(val name: String) : PTok()
        class Num(val value: Double) : PTok()
        class Str(val value: String) : PTok()
        class Name(val word: String) : PTok()       // 裸名字 / 节点测试
        class Axis(val name: String) : PTok()       // axis::
    }

    private enum class RelOp { Eq, Ne, Lt, Le, Gt, Ge }

    /** 谓词表达式 AST 节点。 */
    private fun interface PredExpr {
        fun eval(element: Element): Boolean
    }

    /** 操作数在某个元素上的取值。 */
    private fun interface Operand {
        fun of(element: Element): PV
    }

    /**
     * 位置类操作数（position()/last() 及其算术组合）。
     * 裸用时必须按位置测试解释，而不是按布尔值——基线里 `[last()]` 因此全命中。
     */
    private interface PositionalOperand : Operand

    /** 数字字面量操作数: 只有它能让"纯数字谓词"按位置测试解释 (`[3]`)。 */
    private class NumberLiteral(val value: Double) : Operand {
        override fun of(element: Element): PV = PV.Num(value)
    }

    /** 属性操作数: 单用它当谓词时是"存在性测试" (`[@a]` 与值是否为空串无关)。 */
    private class AttrOperand(val name: String) : Operand {
        override fun of(element: Element): PV =
            if (element.hasAttr(name)) PV.Text(element.attr(name)) else PV.Missing
    }

    /** `.` / text() / string() 的自身文本。 */
    private class SelfTextOperand : Operand {
        override fun of(element: Element): PV = PV.Text(element.text())
    }

    /** 子元素节点测试 `[a]` / `[a='x']`：无该子元素返回 Missing（参与比较恒 false）。 */
    private class ChildTestOperand(val name: String) : Operand {
        override fun of(element: Element): PV {
            val child = element.children().firstOrNull { it.tagName() == name }
            return if (child != null) PV.Text(child.text()) else PV.Missing
        }
    }

    /** 任意子节点测试 `[*]` / `[node()]`。 */
    private class AnyChildOperand : Operand {
        override fun of(element: Element): PV =
            if (element.childrenSize() > 0) PV.Text(element.children()[0].text()) else PV.Missing
    }

    /** `@*`：返回属性个数，使裸用为存在性、count(@*) 为数量。 */
    private class AttrStarOperand : Operand {
        override fun of(element: Element): PV = PV.Num(element.attributes().size().toDouble())
    }

    private class PosOperand(private val f: (Element) -> Double) : PositionalOperand {
        override fun of(element: Element): PV = PV.Num(f(element))
    }

    private class ArithOperand(
        private val left: Operand, private val right: Operand, private val sign: Double
    ) : Operand {
        override fun of(element: Element): PV =
            PV.Num(left.of(element).num() + sign * right.of(element).num())
    }

    private class PosArithOperand(
        private val left: Operand, private val right: Operand, private val sign: Double
    ) : PositionalOperand {
        override fun of(element: Element): PV =
            PV.Num(left.of(element).num() + sign * right.of(element).num())
    }

    /**
     * 谓词内的相对路径操作数，覆盖 `../@id='x'` / `a/@href` / `following-sibling::a`。
     * 节点集的 string-value 取首个命中节点，节点不存在即 Missing。
     */
    private class PathOperand(private val steps: List<PTok>) : Operand {
        override fun of(element: Element): PV {
            var cur: Element? = element
            var i = 0
            while (i < steps.size && cur != null) {
                when (val t = steps[i]) {
                    is PTok.DotDot -> { cur = cur.parent() as? Element; i++ }
                    PTok.Dot, PTok.Slash, PTok.DSlash -> i++
                    is PTok.Attr -> {
                        return if (cur.hasAttr(t.name)) PV.Text(cur.attr(t.name)) else PV.Missing
                    }
                    PTok.AttrStar -> return PV.Num(cur.attributes().size().toDouble())
                    is PTok.Name -> {
                        cur = cur.getElementsByTag(t.word).firstOrNull()
                        i++
                    }
                    PTok.Star -> { cur = cur.children().firstOrNull(); i++ }
                    is PTok.Axis -> {
                        val next = steps.getOrNull(i + 1) as? PTok.Name
                        if (next == null) return PV.Missing
                        val parent = cur.parent() as? Element
                        cur = when (t.name) {
                            "parent" -> parent
                            "self" -> cur
                            "child" -> cur.children().firstOrNull { it.tagName() == next.word }
                            "descendant" -> cur.getElementsByTag(next.word).firstOrNull()
                            "ancestor" -> {
                                var p = parent
                                var hit: Element? = null
                                while (p is Element) {
                                    if (p.tagName() == next.word) { hit = p; break }
                                    p = p.parent() as? Element
                                }
                                hit
                            }
                            "following-sibling", "preceding-sibling" -> {
                                val all = parent?.children()?.toList().orEmpty()
                                val at = all.indexOf(cur)
                                if (at < 0) null else {
                                    val range = if (t.name == "following-sibling") all.drop(at + 1)
                                    else all.take(at)
                                    range.firstOrNull { it.tagName() == next.word }
                                }
                            }
                            else -> null
                        }
                        i += 2
                    }
                    else -> i++
                }
            }
            return cur?.let { PV.Text(it.text()) } ?: PV.Missing
        }
    }

    /**
     * 操作数取值。属性缺失用 [PV.Missing] 表示 (XPath 1.0 的空节点集): 参与相等/关系比较结果
     * 恒 false, 按布尔取假, 按字符串取空串。旧实现把"没有该属性"与"属性值为空串"混成一件事,
     * 于是 `[@a='']` 会把压根没有 a 属性的元素也算命中。
     */
    private sealed class PV {
        class Text(val v: String) : PV()
        class Num(val v: Double) : PV()
        class Flag(val v: Boolean) : PV()
        object Missing : PV()

        fun bool(): Boolean = when (this) {
            is Text -> v.isNotEmpty()
            is Num -> !v.isNaN() && v != 0.0
            is Flag -> v
            Missing -> false
        }

        /** 字符串取值 (空节点集按规范取空串; 整数值不带 `.0`)。 */
        fun text(): String = when (this) {
            is Text -> v
            is Num -> when {
                v.isNaN() -> "NaN"
                v.isInfinite() -> v.toString()
                v == kotlin.math.floor(v) -> v.toLong().toString()
                else -> v.toString()
            }
            is Flag -> v.toString()
            Missing -> ""
        }

        /** 数值取值; 非数字文本为 NaN (与规范 number() 一致)。 */
        fun num(): Double = when (this) {
            is Num -> v
            is Text -> v.trim().toDoubleOrNull() ?: Double.NaN
            is Flag -> if (v) 1.0 else 0.0
            Missing -> Double.NaN
        }
    }

    /** 递归下降解析器: `or` 优先级最低, 其次 `and`, 再一元/比较/分组。 */
    private inner class PredParser(private val toks: List<PTok>, private val src: String) {
        private var pos = 0

        fun atEnd() = pos >= toks.size

        fun parseExpression(): PredExpr = parseOr()

        private fun parseOr(): PredExpr {
            var left = parseAnd()
            while (true) {
                val t = toks.getOrNull(pos)
                if (t is PTok.Kw && t.word == "or") {
                    pos++
                    val right = parseAnd()
                    val prev = left
                    left = PredExpr { e -> prev.eval(e) || right.eval(e) }
                } else {
                    return left
                }
            }
        }

        private fun parseAnd(): PredExpr {
            var left = parseUnary()
            while (true) {
                val t = toks.getOrNull(pos)
                if (t is PTok.Kw && t.word == "and") {
                    pos++
                    val right = parseUnary()
                    val prev = left
                    left = PredExpr { e -> prev.eval(e) && right.eval(e) }
                } else {
                    return left
                }
            }
        }

        private fun parseUnary(): PredExpr {
            val t = toks.getOrNull(pos) ?: throw NoStackTraceException(unsupported(src))
            if (t is PTok.Kw && t.word == "not") {
                pos++
                expect(PTok.Open)
                val inner = parseExpression()
                expect(PTok.Close)
                return PredExpr { e -> !inner.eval(e) }
            }
            return parsePrimary()
        }

        private fun parsePrimary(): PredExpr {
            val operand = parseTerm()
            val opTok = toks.getOrNull(pos)
            if (opTok is PTok.Rel) {
                pos++
                val rhs = parseTerm()
                val op = opTok.op
                return PredExpr { e -> compare(op, operand.of(e), rhs.of(e)) }
            }
            return when (operand) {
                is NumberLiteral -> PredExpr { e -> positionEquals(e, operand.value) }
                //裸属性 = 存在性测试: 规范里属性节点集非空即为真, 与属性值是不是空串无关
                is AttrOperand -> PredExpr { e -> e.hasAttr(operand.name) }
                // 修正基线缺陷：position()/last()/last()-1 裸用按位置测试，而非按布尔全命中
                is PositionalOperand -> PredExpr { e -> positionEquals(e, operand.of(e).num()) }
                is ChildTestOperand -> PredExpr { e ->
                    e.children().any { it.tagName() == operand.name }
                }
                is AnyChildOperand -> PredExpr { e -> e.childrenSize() > 0 }
                else -> PredExpr { e -> operand.of(e).bool() }
            }
        }

        /** 算术后缀：`last()-1`、`position()+2`、`string-length(@a)-1`。 */
        private fun parseTerm(): Operand {
            var base = parseOperand()
            while (true) {
                val t = toks.getOrNull(pos)
                if (t !== PTok.Plus && t !== PTok.Minus) return base
                pos++
                val rhs = parseOperand()
                val sign = if (t === PTok.Plus) 1.0 else -1.0
                val left = base
                base = if (left is PositionalOperand) {
                    PosArithOperand(left, rhs, sign)
                } else {
                    ArithOperand(left, rhs, sign)
                }
            }
        }

        private fun parseOperand(): Operand {
            val t = toks.getOrNull(pos) ?: throw NoStackTraceException(unsupported(src))
            return when (t) {
                is PTok.Attr -> { pos++; AttrOperand(t.name) }
                PTok.AttrStar -> { pos++; AttrStarOperand() }
                is PTok.Num -> { pos++; NumberLiteral(t.value) }
                is PTok.Str -> {
                    pos++
                    val value = t.value
                    Operand { PV.Text(value) }
                }
                is PTok.Func -> { pos++; parseFunction(t.name) }
                is PTok.Dot -> {
                    pos++
                    val next = toks.getOrNull(pos)
                    if (next === PTok.Slash || next === PTok.DSlash || next is PTok.Attr) {
                        parsePathOperand()
                    } else {
                        SelfTextOperand()
                    }
                }
                PTok.DotDot, is PTok.Axis -> parsePathOperand()
                PTok.Star -> { pos++; AnyChildOperand() }
                is PTok.Name -> {
                    pos++
                    // 裸名字若后接路径分隔符/属性，属于相对路径；否则是子元素节点测试
                    val next = toks.getOrNull(pos)
                    if (next === PTok.Slash || next === PTok.DSlash || next is PTok.Attr) {
                        // 回退一格让 parsePathOperand 收进这个名字
                        pos--
                        parsePathOperand()
                    } else {
                        ChildTestOperand(t.word)
                    }
                }
                PTok.Open -> {
                    pos++
                    val inner = parseExpression()
                    expect(PTok.Close)
                    Operand { e -> PV.Flag(inner.eval(e)) }
                }
                else -> throw NoStackTraceException(unsupported(src))
            }
        }

        /** 收集谓词内的相对路径 token 串（`../@id`、`a/@href`、`following-sibling::a`）。 */
        private fun parsePathOperand(): Operand {
            val steps = ArrayList<PTok>(4)
            while (pos < toks.size) {
                val t = toks[pos]
                if (t === PTok.Dot || t === PTok.DotDot || t === PTok.Slash ||
                    t === PTok.DSlash || t === PTok.Star || t === PTok.AttrStar ||
                    t is PTok.Attr || t is PTok.Name || t is PTok.Axis
                ) {
                    steps.add(t)
                    pos++
                } else break
            }
            if (steps.isEmpty()) throw NoStackTraceException(unsupported(src))
            return PathOperand(steps)
        }

        /** 读取完整参数表（含 0 参数的 `string()` / `local-name()` 等）。 */
        private fun parseArgs(): List<Operand> {
            val args = ArrayList<Operand>(3)
            if (toks.getOrNull(pos) === PTok.Close) {
                pos++
                return args
            }
            while (true) {
                args.add(parseTerm())
                when (toks.getOrNull(pos)) {
                    PTok.Comma -> pos++
                    PTok.Close -> { pos++; return args }
                    else -> throw NoStackTraceException(unsupported(src))
                }
            }
        }

        private fun parseFunction(name: String): Operand {
            expect(PTok.Open)
            return when (name) {
                "position", "last" -> {
                    expect(PTok.Close)
                    val isLast = name == "last"
                    PosOperand { e ->
                        val (at, total) = siblingPositionAndTotal(e)
                        (if (isLast) total else at).toDouble()
                    }
                }

                "true", "false" -> {
                    expect(PTok.Close)
                    Operand { PV.Flag(name == "true") }
                }

                "contains", "starts-with", "ends-with" -> {
                    val a = parseTerm()
                    expect(PTok.Comma)
                    val b = parseTerm()
                    expect(PTok.Close)
                    Operand { e ->
                        val target = a.of(e).text()
                        val arg = b.of(e).text()
                        PV.Flag(
                            when (name) {
                                "contains" -> target.contains(arg)
                                "starts-with" -> target.startsWith(arg)
                                else -> target.endsWith(arg)
                            }
                        )
                    }
                }

                // not 通常走 parseUnary 的 Kw 分支；此处兼容显式函数形态
                "not" -> {
                    val inner = parseExpression()
                    expect(PTok.Close)
                    Operand { e -> PV.Flag(!inner.eval(e)) }
                }

                "text", "node", "string", "normalize-space", "local-name", "name", "number" ->
                    parseUnaryFunction(name)

                "string-length", "boolean", "floor", "ceiling", "round", "substring",
                "substring-before", "substring-after", "concat", "translate", "matches",
                "sum", "count", "id" -> parseMultiFunction(name)

                else -> throw NoStackTraceException(unsupported(src))
            }
        }

        private fun parseUnaryFunction(name: String): Operand {
            val args = parseArgs()
            val base = args.firstOrNull() ?: SelfTextOperand()
            return when (name) {
                "text", "node" -> base
                "string" -> Operand { e -> PV.Text(base.of(e).text()) }
                "normalize-space" -> Operand { e ->
                    PV.Text(base.of(e).text().trim().replace(WHITESPACE, " "))
                }
                "local-name", "name" -> Operand { e -> PV.Text(e.tagName()) }
                "number" -> Operand { e -> PV.Num(base.of(e).num()) }
                else -> throw NoStackTraceException(unsupported(src))
            }
        }

        private fun parseMultiFunction(name: String): Operand {
            val args = parseArgs()
            return when (name) {
                "string-length" -> {
                    val a = args.firstOrNull() ?: SelfTextOperand()
                    Operand { e -> PV.Num(a.of(e).text().length.toDouble()) }
                }
                "boolean" -> {
                    val a = args.firstOrNull() ?: SelfTextOperand()
                    Operand { e -> PV.Flag(a.of(e).bool()) }
                }
                "floor", "ceiling", "round" -> {
                    val a = args.firstOrNull() ?: SelfTextOperand()
                    Operand { e ->
                        val v = a.of(e).num()
                        PV.Num(
                            when (name) {
                                "floor" -> kotlin.math.floor(v)
                                "ceiling" -> kotlin.math.ceil(v)
                                else -> kotlin.math.round(v)
                            }
                        )
                    }
                }
                "sum", "count" -> Operand { e ->
                    PV.Num(args.sumOf { a ->
                        if (a is PathOperand) if (a.of(e) === PV.Missing) 0.0 else 1.0
                        else a.of(e).num()
                    })
                }
                "concat" -> Operand { e -> PV.Text(args.joinToString("") { it.of(e).text() }) }
                "translate" -> {
                    if (args.size < 3) throw NoStackTraceException(unsupported(src))
                    Operand { e ->
                        val text = args[0].of(e).text()
                        val from = args[1].of(e).text()
                        val to = args[2].of(e).text()
                        PV.Text(buildString {
                            for (ch in text) {
                                val at = from.indexOf(ch)
                                when {
                                    at < 0 -> append(ch)
                                    at < to.length -> append(to[at])
                                    else -> Unit // 第三参数短于第二参数时该字符被删除
                                }
                            }
                        })
                    }
                }
                "matches" -> {
                    if (args.size < 2) throw NoStackTraceException(unsupported(src))
                    Operand { e ->
                        val text = args[0].of(e).text()
                        val pattern = args[1].of(e).text()
                        PV.Flag(runCatching { Regex(pattern).containsMatchIn(text) }.getOrDefault(false))
                    }
                }
                "substring-before", "substring-after" -> {
                    if (args.size < 2) throw NoStackTraceException(unsupported(src))
                    Operand { e ->
                        val text = args[0].of(e).text()
                        val needle = args[1].of(e).text()
                        val at = text.indexOf(needle)
                        PV.Text(
                            when {
                                at < 0 -> ""
                                name == "substring-before" -> text.substring(0, at)
                                else -> text.substring(at + needle.length)
                            }
                        )
                    }
                }
                "substring" -> {
                    if (args.size < 2) throw NoStackTraceException(unsupported(src))
                    Operand { e ->
                        val text = args[0].of(e).text()
                        // XPath 1.0 位置从 1 起，参数按 round() 取整
                        val from = (kotlin.math.round(args[1].of(e).num()).toInt() - 1).coerceAtLeast(0)
                        val count = args.getOrNull(2)?.of(e)?.num()
                            ?.let { kotlin.math.round(it).toInt() } ?: (text.length - from)
                        PV.Text(
                            if (from >= text.length) ""
                            else text.substring(from, (from + count).coerceAtMost(text.length))
                        )
                    }
                }
                "id" -> {
                    if (args.isEmpty()) throw NoStackTraceException(unsupported(src))
                    Operand { e ->
                        val key = args[0].of(e).text()
                        val hit = e.ownerDocument()?.getElementById(key)
                        if (hit != null) PV.Text(hit.text()) else PV.Missing
                    }
                }
                else -> throw NoStackTraceException(unsupported(src))
            }
        }

        private fun expect(tok: PTok) {
            if (toks.getOrNull(pos) !== tok) throw NoStackTraceException(unsupported(src))
            pos++
        }
    }

    /** 相等/关系比较。空节点集参与比较恒 false (§3.1: 节点集与另一侧逐个比, 空集无对象)。 */
    private fun compare(op: RelOp, left: PV, right: PV): Boolean {
        if (left is PV.Missing || right is PV.Missing) return false
        return when (op) {
            RelOp.Eq -> valuesEqual(left, right)
            RelOp.Ne -> !valuesEqual(left, right)
            RelOp.Lt -> orderOf(left, right)?.let { it < 0 } == true
            RelOp.Le -> orderOf(left, right)?.let { it <= 0 } == true
            RelOp.Gt -> orderOf(left, right)?.let { it > 0 } == true
            RelOp.Ge -> orderOf(left, right)?.let { it >= 0 } == true
        }
    }

    private fun valuesEqual(left: PV, right: PV): Boolean = when {
        left is PV.Flag || right is PV.Flag -> left.bool() == right.bool()
        left is PV.Num || right is PV.Num -> left.num() == right.num()
        else -> left.text() == right.text()
    }

    /** 关系比较只在两侧都能化成数时有定义; NaN (非数字文本、空串) 一律无结果。 */
    private fun orderOf(left: PV, right: PV): Int? {
        val a = left.num()
        val b = right.num()
        if (a.isNaN() || b.isNaN()) return null
        return a.compareTo(b)
    }

    /** 纯数字谓词 `[n]`: 规范里是位置测试, 序号取同名兄弟的 1 基序号 (§2.1)。 */
    private fun positionEquals(element: Element, n: Double): Boolean =
        n >= 1 && n == kotlin.math.floor(n) && siblingPositionAndTotal(element).first.toDouble() == n

    /**
     * 元素在其父节点**同名**子元素序列中的 1 基序号，与同名子元素总数。
     * 基准为 W3C XPath 1.0 的谓词位置语义（节点先经节点测试过滤、位置从 1 开始）。
     */
    private fun siblingPositionAndTotal(element: Element): Pair<Int, Int> {
        //无父节点（文档根）时它就是候选集里唯一节点: 序号 1、总数 1, `[1]`/`last()` 都应命中
        val parent = element.parent() ?: return 1 to 1
        val tag = element.tagName()
        var position = 0
        var total = 0
        for (child in parent.children()) {
            if (child.tagName() == tag) {
                total++
                if (child === element) position = total
            }
        }
        //找不到自身序号时不做"当成第 1 个"的回退: 那会把错选伪装成命中
        return position to total
    }
}

sealed class PathPart {
    object Parent : PathPart()
    object Current : PathPart()
    object AllChildren : PathPart()
    data class Tag(val name: String) : PathPart()
    data class TagWithPredicate(val tag: String, val predicates: List<String>) : PathPart()
    data class Axis(val axis: String, val tag: String, val predicates: List<String>) : PathPart()
}

// Extension function for Element to support selectXpath
fun Element.selectXpath(xpath: String): KsElements {
    return XPathEvaluator.evaluateElements(xpath, this)
}

// KClass 版（原 java.lang.Class 版泄漏 JVM 类型, commonMain 不可用）。
// type 仅用于筛节点种类；AnalyzeByXPath 已改走 XPathEvaluator.evaluate 直接取 List<Node>，
// 以便 /text()、/@* 产生的 TextNode 不被这里过滤掉。
fun <T : Node> Element.selectXpath(xpath: String, type: KClass<T>): KsElements {
    val result = XPathEvaluator.evaluate(xpath, this)
    val elements = KsElements()
    result.forEach { node ->
        if (node is Element && type.isInstance(node)) {
            elements.add(node)
        }
    }
    return elements
}
