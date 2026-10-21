import { cmdTitle, baseName } from './commands.js'
import { clip } from './format.js'

/** 从（可能被截断的）参数里抠一个字符串字段。 */
function argString(argsRaw, field) {
  if (typeof argsRaw !== 'string') return ''
  var m = new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(argsRaw)
  if (m === null) return ''
  return m[1].replace(/\\\\n/g, ' ').replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\').replace(/\\s+/g, ' ').trim()
}

/**
 * 数一个数组字段有几项。
 * @param field - 数组字段名（`files` / `todos` / `questions`）。
 * @param itemKey - 每项里**唯一**的那个键（`path` / `content` / `question`）。
 *   不能用"任意键"来数：`present` 的每一项都有 `path` **和** `description`，
 *   按任意键数会把 1 个文件数成 2 个。
 */
function argCount(argsRaw, field, itemKey) {
  if (typeof argsRaw !== 'string') return 0
  var at = argsRaw.indexOf('"' + field + '"')
  if (at < 0) return 0
  var m = argsRaw.slice(at).match(new RegExp('"' + itemKey + '"\\s*:', 'g'))
  return m === null ? 0 : m.length
}

/**
 * **按工具参数**起标题 —— 处理那些没有 `command` 的工具。
 *
 * 为什么需要：实测一个会话里 221 个纯工具步，只认 `command` 的话只有 **52%** 有标题；
 * 剩下 48% 是 `edit`(54) / `read`(19) / `read_image`(17) / `present`(10) / `write`(4) /
 * `find_dsh_plugin`(1) —— 它们的参数里没有命令，但**有文件路径 / 查询词 / 条目数**，
 * 足够起一个准确的短标题。
 *
 * ⚠️ 一律用**正则从原始串里抠**，不走 `JSON.parse`：宿主只留参数前 400 字，
 * `edit`（59 次里 44 次）和 `write`（3 次全截断）经常是不合法 JSON。
 * @param name - 工具名。
 * @param argsRaw - 参数原文。
 * @returns 短标题；认不出时空串。
 */
function toolArgsTitle(name, argsRaw) {
  var n = name === undefined || name === null ? '' : String(name)
  if (n === 'bash' || n === 'pwsh' || n === 'terminal') return cmdTitle(argsRaw)
  var file = argString(argsRaw, 'file_path') || argString(argsRaw, 'path')
  var base = file === '' ? '' : baseName(file)
  if (n === 'read') return base === '' ? '' : '读 ' + base
  if (n === 'edit') return base === '' ? '' : '改 ' + base
  if (n === 'write') return base === '' ? '写文件' : '写 ' + base
  if (n === 'read_image') return base === '' ? '' : '看图 ' + base
  if (n === 'present') {
    var count = argCount(argsRaw, 'files', 'path')
    if (count > 1) return '交付 ' + count + ' 个文件'
    return base === '' ? '交付产出' : '交付 ' + base
  }
  if (n === 'grep' || n === 'rg') {
    var pat = argString(argsRaw, 'pattern')
    return pat === '' ? '' : '搜 ' + clip(pat, 15)
  }
  if (n === 'glob') {
    var g = argString(argsRaw, 'pattern')
    // 模式不是路径：只去掉开头的 `**/`，别走 baseName（`**/*.test.js` 会被切成 `.test.js`）
    return g === '' ? '' : '找 ' + clip(g.replace(/^\*\*\//, ''), 15)
  }
  if (n === 'web_fetch') {
    var url = argString(argsRaw, 'url')
    if (url === '') return ''
    var host = url.replace(/^https?:\/\//, '').split('/')[0]
    return '抓 ' + host
  }
  if (n === 'web_search' || n === 'advanced_search' || n === 'platform_search' || n === 'find_dsh_plugin') {
    var q = argString(argsRaw, 'query') || argString(argsRaw, 'queries')
    if (q === '') {
      // `queries` 是**数组**（`["a","b"]`），argString 只认字符串值，单独捞一次
      var mq = /"queries"\s*:\s*\[\s*"((?:[^"\\]|\\.)*)"/.exec(argsRaw || '')
      if (mq !== null) q = mq[1]
    }
    return q === '' ? '' : '搜 ' + clip(q, 15)
  }
  // 宿主 API 查询（`cordis_inspect_*`）：参数里是服务名或查询词
  if (n === 'cordis_inspect_list') {
    var svc = argString(argsRaw, 'service')
    return svc === '' ? '列服务' : '列 ' + clip(svc, 18)
  }
  if (n === 'cordis_inspect_query') {
    var qq = argString(argsRaw, 'service') || argString(argsRaw, 'query')
    return qq === '' ? '查宿主 API' : '查 ' + clip(qq, 18)
  }
  if (n === 'skill') {
    var sk = argString(argsRaw, 'name') || argString(argsRaw, 'skill')
    return sk === '' ? '加载技能' : '加载 ' + sk
  }
  if (n === 'todo_write') {
    var td = argCount(argsRaw, 'todos', 'content')
    return td === 0 ? '列计划' : '列 ' + td + ' 项计划'
  }
  if (n === 'ask_user_question') {
    var qs = argCount(argsRaw, 'questions', 'question')
    return qs > 1 ? '问 ' + qs + ' 个问题' : '问用户'
  }
  // 这些工具的参数里**本来就有一个短描述**（是给人看的），直接用它
  if (n === 'subagent' || n === 'subagent_fork' || n === 'workflow' || n === 'ralph') {
    var d = argString(argsRaw, 'description')
    if (d !== '') return clip(d, 22)
    return n === 'workflow' || n === 'ralph' ? '编排' : '派子代理'
  }
  if (n === 'create_goal' || n === 'update_goal') {
    var obj = argString(argsRaw, 'objective')
    return obj === '' ? '定目标' : '定目标：' + clip(obj, 16)
  }
  return ''
}

/**
 * 一步的派生标题：**每个工具各起一条**，用 ` · ` 连起来。
 *
 * 早先只取"最后一个起得出标题的工具" —— 多工具步（`bash + edit`）里另一个工具
 * 在行里完全看不出来。现在每个命令都有自己的一条。
 *
 * 命令自带的英文说明（`bash` 的 `description`）由模型翻成中文后，**跟在它自己那条
 * 标题后面**，用 ` · ` 隔开（`读 client.js · 改动后重跑测试`）。
 * @param tools - 该步的工具数组。
 * @param notes - 工具 id → 中文说明（模型生成，可能没有）。
 * @returns 短标题；都起不出时空串。
 */
function toolTitleRuns(tools, notes) {
  var runs = []
  for (var i = 0;i < tools.length;i += 1) {
    var t = toolArgsTitle(tools[i].name, tools[i].argsRaw)
    var note = notes === undefined ? undefined : notes[tools[i].id]
    var text = t === ''
      ? (note === undefined ? '' : note)
      : (note === undefined || note === '' ? t : t + ' · ' + note)
    var last = runs[runs.length - 1]
    // **相邻同名合并**：一步里连着调 6 次 `edit`，标题就是 6 个「改 index.js」——
    // 合并成一条带计数（`改 index.js ×6`），既杀掉重复又保住"调了几次"。
    // 空标题（认不出）不合并：每个工具各占一行，好跟工具行对上。
    if (text !== '' && last !== undefined && last.text === text) {
      last.count += 1
      last.tools.push(tools[i])
      continue
    }
    runs.push({ text: text, count: 1, tools: [tools[i]] })
  }
  return runs
}

/** 一条 run → 显示文字（重复的带 `×N`）。 */
function runText(run) {
  return run.count > 1 ? run.text + ' ×' + run.count : run.text
}

/** 行里要显示的标题行（去掉认不出的那些）。 */
function stepTitleLines(tools, notes) {
  return toolTitleRuns(tools, notes)
    .filter(function (r) { return r.text !== '' })
    .map(runText)
}

// ── 无工具步的名字：从它自己的产出里取（本地规则，零模型调用） ──
//
// 面板上有两条起名路，各有过滤条件：**派生标题**要工具参数、**模型标题**要思考。
// 于是"无工具 + 无思考 + 有正文"的步（就是每一轮最后那一步）**两条都漏** ——
// 扫全部会话 14,030 步，这种有 **487 步**（无工具步 913 里的一半）。
// 用户："为哪些没有标题的步骤起名字" → 走第三条路：**本地摘要**。

/** 自然停顿：摘要在这里断句（不切在句子中间）。 */
var PROSE_CUT = '。！？；，、'

/**
 * 正文 → 一行能读的纯文本（去 Markdown 噪声）。
 *
 * 摘要要的是"第一句说的是什么"，所以代码块、图片、链接地址、强调符都得先清掉 ——
 * 否则标题会变成 ```` ```js ```` 或 `http://…`（真数据里正文常以代码块开头）。
 * @param text - 正文原文。
 * @returns 清干净的文本（可能为空串）。
 */
function cleanProse(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/```[\s\S]*?```/g, ' ')                     // 代码块
    .replace(/^[#>\s*`+\-]+/, '')                        // 开头的标题/引用/列表标记
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')               // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')             // 链接 → 只留文字
    .replace(/[*_`~]/g, '')                              // 强调符
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 正文 → 行标题用的摘要。
 *
 * 规则（拿真数据调出来的，见 README 里那三条真实例子）：
 *   ① 累到第一个**自然停顿**且长度 ≥ 12 字就断（再短就只有半句、再长读起来像正文）
 *   ② 上限 20 字（标题格子就那么大，和模型标题的 8~18 字同一档）
 *   ③ 截断了就收尾：**不闭合的括号不带进去**、**不把英文单词切一半**、
 *      去掉结尾的标点，最后补 `…`
 * @param text - 正文原文。
 * @returns 摘要；正文为空时返回空串。
 */
function excerptOf(text) {
  var c = cleanProse(text)
  if (c === '') return ''
  var out = ''
  for (var i = 0;i < c.length;i += 1) {
    out += c[i]
    if (PROSE_CUT.indexOf(c[i]) >= 0 && out.length >= 12) break
    if (out.length >= 20) break
  }
  out = out.trim()
  if (out.length >= c.length) return out
  var pairs = [['（', '）'], ['(', ')'], ['【', '】'], ['[', ']']]
  for (var p = 0;p < pairs.length;p += 1) {
    var a = out.lastIndexOf(pairs[p][0])
    if (a >= 0 && out.indexOf(pairs[p][1], a) < 0) out = out.slice(0, a)
  }
  var tail = out.match(/[A-Za-z0-9_]+$/)
  if (tail !== null && out.length > 12) out = out.slice(0, out.length - tail[0].length)
  out = out.trim().replace(/[。！？；，、：—-]+$/, '')
  return out === '' ? c.slice(0, 20) + '…' : out + '…'
}

/**
 * 没有标题时行里画的东西 —— **三个点**（`· · ·`）。
 *
 * 为什么不是 `…`：`…` 落在**基线**上，和同一行的字形 / 标题比、看着偏低
 * （真机反馈："位置太低了"）；`·`（U+00B7）在中线上，和块头、和工具名一个高度。
 * 为什么不是「无输出」那种占位词：它**长得就像个标题**（同一档字号、同一档灰），
 * 而这一步什么产出都还没有 —— 拿一个词去冒充名字，和当初否掉"用本地规则猜中文标题"
 * 是同一个错（错的标题比没有标题更危险）。
 * 为什么三个点而不是一个字：**进行中时它们一个接一个亮**（见 CSS）——
 * 那是"在等"，落地之后就静静躺着（只有还在跑的东西才说"在动"）。
 *
 * 三点分三个节点，就是为了这个错开的亮（一个字符串没法只让第二个点亮）。
 */
var DOT = '·'

/**
 * **只有思考、还没正文**时的行标题 —— 「思考」。
 *
 * 用户定的：这一步取不出名字（思考是英文 CoT、本地取不出中文名），
 * 但它**确实产出了东西**（思考在涨），所以不画"空"的三个点，直说它在思考。
 * ⚠️ 和块头次标题的「推理中」不是一回事：那是**状态**（还在跑），这是**这一步的产出**
 *    ——落地之后块头改说分类名（纯推理），这一行仍然是「思考」。
 */
var THINK_TITLE = '思考'

/** 这一步有没有收到过思考（`reasoning` 或活跃步的实时尾巴）。 */
function stepHasThinking(step) {
  if (step === undefined || step === null) return false
  return (step.reasoningTokens || 0) > 0
    || (step.reasoningText !== undefined && step.reasoningText !== '')
}

/**
 * 没有标题时，悬停里说明"为什么没有"。
 *
 * 只说事实（三个计数），不解释、不猜 —— 两种取不出名字的情况在这里是分开的：
 * 0/0/0（这一步什么都没产出）与"只有思考、还没正文"。
 * @param step - 步骤。
 * @returns 悬停文字；步骤读不到时空串。
 */
function noTitleNote(step) {
  if (step === undefined || step === null) return ''
  return stepHasThinking(step)
    ? '只有思考，还没有正文'
    : '这一步没有产出：0 思考、0 正文、0 工具'
}

/**
 * 一个**无工具**的步，行标题写什么。
 *
 *   有正文 → 正文摘要（`excerptOf`）
 *   没有正文 → 空串（取不出名字：0 思考 0 正文 0 工具，或只有思考还没写正文 ——
 *     思考是英文 CoT，本地取不出中文名）
 *
 * ⚠️ 空串**不等于**"这一行没标题"：调用方（`renderStep`）会接着画
 *    {@link THINK_TITLE}（有思考）或 {@link DOT} 那三个点（什么都没有）。
 *    开过「生成标题」时模型标题会顶上。
 * @param step - 步骤。
 * @returns 摘要文字（可能为空串）。
 */
function stepOwnTitle(step) {
  if (step === undefined || step === null) return ''
  if ((step.textTokens || 0) > 0) {
    var head = step.textHead !== undefined ? step.textHead : step.textTail
    return excerptOf(head === undefined ? '' : head)
  }
  return ''
}

export { argString, argCount, toolArgsTitle, toolTitleRuns, runText, stepTitleLines, PROSE_CUT, cleanProse, excerptOf, DOT, THINK_TITLE, stepHasThinking, noTitleNote, stepOwnTitle }
