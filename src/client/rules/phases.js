import { cmdActivity } from './commands.js'

/**
 * 空档超过这么久就当作阶段边界。
 *
 * 定标是量出来的，不是拍的：真实 turn 里相邻步的间隔常态是 3~47 秒
 * （思考 + 工具往返），所以阈值取 20 秒会把 22 步切成 9 个阶段、其中 4 个只有一步，
 * 分组等于失效。取 90 秒后只剩"工具族换向"在切分，22 步收敛成 4 个阶段。
 */
var PHASE_GAP_MS = 90000

/**
 * 工具名 → 中文动词族。
 *
 * 这是阶段标签的**唯一**依据：工具名是确定性的，不需要猜。
 * 认不出来的工具如实显示原名，而不是硬套一个动词。
 */
/**
 * 工具族 → 阶段名。
 *
 * 这是**本地规则**，不花模型调用 —— 阶段名只是"这一段大概在干嘛"的粗分类，
 * 精确的"这一步在干嘛"由模型生成的步骤标题负责（见 README 的中文标题一节）。
 *
 * 匹配顺序：先查 `FAMILY_EXACT`（精确名），再按 `FAMILY_PREFIX` 的顺序试前缀，
 * 都不中就**原样显示工具名**。如实显示比编一个中文名好：`read_image` 一眼就懂，
 * 硬编成"图片处理"反而离事实更远。所以这条兜底是有意的，不是漏了。
 */
var FAMILY_EXACT = {
  // 命令行（**族名只用于分组**，显示名由 phaseLabel 按块内实际内容算，见下）
  bash: '命令行', pwsh: '命令行', terminal: '命令行',
  // 读与改
  read: '读代码', grep: '读代码', glob: '读代码',
  write: '改文件', edit: '改文件',
  read_image: '看图',
  // 交付
  present: '交付产出',
  // 外部
  find_dsh_plugin: '外部检索', web_search: '外部检索',
  advanced_search: '外部检索', platform_search: '外部检索',
  web_fetch: '抓网页',
  // 与用户交互
  ask_user_question: '问用户', todo_write: '列计划', exit_plan_mode: '收尾',
  // 编排与委派
  skill: '加载技能',
  subagent: '派子代理', subagent_fork: '派子代理', send_message: '派子代理',
  interrupt_agent: '派子代理', list_agents: '派子代理',
  workflow: '编排', ralph: '编排',
  // 后台任务
  job_output: '后台任务', job_kill: '后台任务', job_list: '后台任务',
  // 目标
  create_goal: '目标管理', get_goal: '目标管理', update_goal: '目标管理',
}

/**
 * 前缀规则。**按长度降序**排 —— 这样顺序天然安全：更具体的长前缀先匹配，
 * 短前缀抢不走它（比如以后要加 `dev_stage_`，它一定排在 `dev_` 前面）。
 * 这条有断言（test:client 的 ⑨），加规则时不会踩。
 */
var FAMILY_PREFIX = [
  ['cordis_inspect', '宿主 API 查询'],
  ['openpencil_', '画设计稿'],
  ['oh_story_', '短剧制作'],
  ['dev_', '插件工程'],
]

/**
 * 工具名 → 族名。
 * @param tool - 工具事实（只用到 `name`）。
 * @returns 族名；没有名字时给"纯推理"。
 */
function toolFamily(tool) {
  var n = tool && tool.name ? String(tool.name) : ''
  if (!n) return '纯推理'
  if (FAMILY_EXACT[n] !== undefined) return FAMILY_EXACT[n]
  for (var i = 0;i < FAMILY_PREFIX.length;i += 1) {
    if (n.indexOf(FAMILY_PREFIX[i][0]) === 0) return FAMILY_PREFIX[i][1]
  }
  return n
}

/** 该步的工具族（没调工具 = 纯推理）。 */
/**
 * 该步的工具族（没调工具 = 纯推理）。
 *
 * 命令行**再按命令内容细分**：只读 → 读代码、有副作用 → 跑命令、认不出 → 命令行。
 *
 * ① 为什么要细分：一段连续的命令行里常常混着 `sed` 和 `npm test`，只按"命令行"
 *    一族分组的话它们会被并成一块、再按多数派命名 —— 那一步就被**错标**了。
 * ② 为什么只读命令叫"读代码"而不是另起一个名字：它和 `read`/`grep`/`glob`
 *    这些工具是**同一件事**（把代码读出来看），分成两种块名只会让面板上出现
 *    "蓝色、蓝色、绿色、蓝色…"这样同色异名的交替。合成一种之后块更少、也更好读。
 */
function familyOf(step) {
  var tools = step.tools || []
  if (!tools.length) return '纯推理'
  // 多个工具时取最后一个：它代表这一步"最终在干什么"
  var last = tools[tools.length - 1]
  var name = last && last.name ? String(last.name) : ''
  if (name === 'bash' || name === 'pwsh' || name === 'terminal') {
    var act = cmdActivity(last.argsRaw)
    return act === 'inspect' ? '读代码' : act === 'run' ? '跑命令' : '命令行'
  }
  return toolFamily(last)
}

/**
 * 阶段块的**颜色分类**。
 *
 * 为什么是"分类"而不是"每个块名一个颜色"：宿主的设计系统里**只有 4 个色相**
 * （business 蓝 / success 绿 / warn 琥珀 / error 红）+ 中性灰阶，没有紫/青/品红。
 * 二十多个块名各配一色只能自己编颜色 —— 那会同时破坏两件事：脱离设计系统、
 * 深色主题下没有对应的值。所以按**语义**归成 5 类，每类一个宿主色相：
 *
 *   读（蓝）  获取信息          读代码 / 看图 / 外部检索 / 抓网页 / 宿主 API 查询
 *   写（绿）  产出与改动        改文件 / 交付产出 / 画设计稿 / 短剧制作
 *   跑（琥珀）执行与委派        跑命令 / 插件工程 / 派子代理 / 编排 / 后台任务 / 目标管理 / 加载技能
 *   问（红）  需要人            问用户
 *   想（灰）  只在脑子里         纯推理 / 推理中 / 调用中 / 列计划 / 收尾 / 回答 / 命令行（认不出）/ 未知块名
 *
 * 同类共享颜色是**有意的**：颜色回答的是"这一段属于哪种活动"，
 * 具体是什么由块名文字回答。二十多种颜色没人能记住，5 种能。
 */
var CATEGORY_OF = {
  读代码: 'read', 看图: 'read', 外部检索: 'read', 抓网页: 'read', '宿主 API 查询': 'read',
  改文件: 'write', 交付产出: 'write', 画设计稿: 'write', 短剧制作: 'write',
  跑命令: 'run', 插件工程: 'run', 派子代理: 'run', 编排: 'run', 后台任务: 'run', 目标管理: 'run', 加载技能: 'run',
  问用户: 'ask',
  纯推理: 'think', 推理中: 'think', 调用中: 'think', 列计划: 'think', 收尾: 'think', 回答: 'think', 命令行: 'think',
}

/** 认不出的块名一律归"想"（中性灰），不猜。 */
function phaseCategory(label) {
  return CATEGORY_OF[label] || 'think'
}

/**
 * 把**同一种**阶段块合并成一个。
 *
 * 为什么需要：分组是按"相邻 + 同族 + 间隔 < 90s"切的，一个 turn 里
 * 读代码 / 改文件 / 读代码 / 改文件 这样交替，就会切出一串单步小块
 * （实测 turn 31：63 步切出 **32 个块**，图例成了 8 行的一堵墙）。
 * 合并之后只剩"这一轮做了哪几类事"，每类一块 —— 才是小结该有的样子。
 *
 * 块内步骤**保持步骤号升序**（相邻块本来就是升序，按类追加后仍是升序），
 * 所以合并块里的步骤号会有洞（`#1–2, 6, 11–22`），块头如实列出来。
 * @param phases - `groupPhases` 的结果（按时间序）。
 * @returns 按**首次出现顺序**排列的合并块。
 */
function mergeByLabel(phases) {
  var order = []
  var byKey = {}
  for (var i = 0;i < phases.length;i += 1) {
    var ph = phases[i]
    var key = ph.label || ph.family
    if (byKey[key] === undefined) {
      byKey[key] = { family: ph.family, label: key, cat: phaseCategory(key), steps: [] }
      order.push(byKey[key])
    }
    for (var j = 0;j < ph.steps.length;j += 1) byKey[key].steps.push(ph.steps[j])
  }
  return order
}

/**
 * 把步骤号压成可读的区间串：`1–2, 6, 11–22`。
 * @param steps - 升序的步骤数组。
 * @returns 区间串。
 */
function stepRanges(steps) {
  var out = []
  var i = 0
  while (i < steps.length) {
    var a = steps[i].step
    var b = a
    while (i + 1 < steps.length && steps[i + 1].step === b + 1) {
      i += 1
      b = steps[i].step
    }
    out.push(a === b ? String(a) : a + '–' + b)
    i += 1
  }
  return out.join(', ')
}

/**
 * 这一步是否**已经落地** —— 也就是"它的输出吐完了没有"。
 *
 * 只有 `thinking` / `waiting` 是"还在跑"：前者在流式吐字、后者在等工具回来，
 * 两种情况下**都可能再冒出一次工具调用**，所以这一刻还不能断言"没调工具"。
 *
 * ⚠️ `ready`（流已结束、工具都已回收、只差收尾事件）算**已落地**：
 *    工具调用属于 assistant 消息本身，消息的流一结束，"有没有工具"就已经定了。
 *    这也让它和 `derive` 里的 `active`（thinking / waiting）**天然互补** ——
 *    面板上"进行中的块"和"时长格在涨的那一步"永远是同一件事，不会各说各话。
 * @param step - 步骤事实。
 * @returns 是否已落地。
 */
function stepSettled(step) {
  return step.status !== 'thinking' && step.status !== 'waiting'
}

/** 块里是否**还有没落地的步** —— 也就是"这一块还在跑"。 */
function phaseSettled(phase) {
  for (var i = 0;i < phase.steps.length;i += 1) {
    if (!stepSettled(phase.steps[i])) return false
  }
  return true
}

/**
 * 进行中的块叫什么：**等工具 → 调用中，自己在想 → 推理中**。
 *
 * 两个词都是"进程词"，不是分类名词 —— 进行中的块还没定性，不该冒充分类。
 * 它在干什么由**步骤行**回答（工具名 + 等待块里的参数），块头只回答"它还在动"。
 * @param phase - `groupPhases` 产出的阶段。
 * @returns 显示名。
 */
function runningLabel(phase) {
  for (var i = 0;i < phase.steps.length;i += 1) {
    if (phase.steps[i].status === 'waiting') return '调用中'
  }
  return '推理中'
}

/**
 * 阶段显示名。
 *
 * 细分（读代码 / 跑命令 / 命令行）已经在 `familyOf` 里做掉了，
 * 所以块内的步**天然同族**，显示名就是族名 —— 不需要再按多数派猜一次。
 *
 * ⚠️ **没落地的块不许用分类语法**。`familyOf` 判"纯推理/读代码"的依据是
 *    "这一步调了什么工具"，而那是个**事后**才成立的事实：模型正在流式吐字时
 *    工具还没到，块就先挂上「纯推理」，等工具一到又当场改名成「读代码」——
 *    读者看到的是"它刚说自己在纯推理，转头就去读文件了"。
 *    所以：**没落地 → 推理中 / 调用中**（只断言此刻看得见的事实），
 *    **落地之后 → 分类名词**（那时"没调工具/在读代码"才是真的）。
 *    （用词跟步骤行右侧时长格原先那套「推理」「调用」一致 —— 头部状态标签删掉后，
 *      「推理中 / 调用中」就只剩这一处出口了：同一件事只有一种叫法。）
 * @param phase - `groupPhases` 产出的阶段。
 * @returns 显示名。
 */
function phaseLabel(phase) {
  if (!phaseSettled(phase)) return runningLabel(phase)
  return phase.family
}

/**
 * 这一块是不是**给用户的答复**（用户反馈："每个轮次的最后一步不应该叫纯推理"）。
 *
 * 判据三条，缺一不可（真实数据：913 轮里 **819 轮**的最后一步正是这种）：
 *   ① 它是**这一轮的最后一步** —— 中间步骤的正文只是"调用工具前的过渡语"，
 *      那确实是推理的一部分；只有最后一步的正文是**写给用户看的**；
 *   ② 没有工具调用（有工具的话它就是那件事，按工具族叫）；
 *   ③ 真的产出了正文（`textTokens > 0`）—— 只有思考没有正文的 11 轮不算，
 *      完全空的 79 轮（多为命令轮 / 空转轮）也不算。
 * 另外要求它**已落地**：还在流式吐字时块头该说「推理中」——
 * 没落地的块不许用分类语法（见 `phaseLabel` 的说明）。
 *
 * ⚠️ 只改**显示名**，不动分组：819 轮里只有 **1 轮**的最后一步会和前一步并成一块，
 *    为它去改分组不划算，反而会让"块名"和"分组"两个概念重新搅在一起。
 * @param phase - 一个阶段块。
 * @param lastStep - 这一轮的最后一步（没有就 undefined）。
 * @returns 是答复时 true。
 */
function isAnswerPhase(phase, lastStep) {
  if (lastStep === undefined || lastStep === null) return false
  if ((lastStep.tools || []).length > 0) return false
  if (!stepSettled(lastStep)) return false
  if (phase.steps.indexOf(lastStep) < 0) return false
  // 有正文 Token = 真的产出了正文；宿主没下发 Token 数（老快照）时退回"正文非空"，
  // **不在这里再估一遍 Token**（估算口径只有宿主一份，见 TraceChange 的说明）。
  var produced = (lastStep.textTokens || 0) > 0
    || (typeof lastStep.text === 'string' && lastStep.text !== '')
  return produced
}

/**
 * 本地规则分组：相邻步属于同一阶段当且仅当
 *   ① 工具族相同，且 ② 间隔没超过 PHASE_GAP_MS。
 * 间隔用"下一步开始 − 这一步开始"的差，长间隔说明中间在等外部（联网/工具）。
 * @param steps - 一个 turn 的步骤数组（按 step 升序）。
 * @param gapMs - 覆盖默认阈值（仅测试用）。
 * @returns 阶段数组。
 */
function groupPhases(steps, gapMs) {
  var limit = gapMs === undefined ? PHASE_GAP_MS : gapMs
  var phases = []
  var cur = null
  for (var i = 0;i < steps.length;i += 1) {
    var s = steps[i]
    var fam = familyOf(s)
    var prev = steps[i - 1]
    var gap = prev ? s.startedAt - prev.startedAt : 0
    /**
     * **进行中的那一步自己一块**（用户："进行中的块只能有一个步骤"）。
     *
     * 判据是"它是最后一步、而且还没落地"—— 活跃步永远是最新的那一步，
     * 所以这条规则等价于"进行中的块里只有一个步骤"。不这么做的话，
     * 连续几步同族（实测：连着 3 条 bash）会并成一块，于是块头写「第 19 步」、
     * 块内还挂着 #17 #18 #19 三行 —— 用户报的"步骤号太多、重复"就是这么来的。
     *
     * ⚠️ 只在**最后一步且未落地**时断开，所以：
     *   · 它前面那几步照常按同族/间隔并块（信息一点没丢）
     *   · 它落地之后**会并回上面那一块**（那时它已经不是"进行中"了）——
     *     这是有意的：过程说完了，就该归进它所属的那一类里。
     */
    var live = i === steps.length - 1 && !stepSettled(s)
    if (!cur || cur.family !== fam || gap > limit || live) {
      cur = { family: fam, steps: [], label: fam, cat: phaseCategory(fam) }
      phases.push(cur)
    }
    cur.steps.push(s)
  }
  // 分组完成后才定显示名：`label` 要看**整块**的内容，边分边算拿不到全局。
  // 注意它只影响显示，不参与上面的分组判断 —— 这是刻意的（见 phaseLabel 的说明）。
  // `cat` 在上面建块时已经给了（面板用不合并的 phases，也要颜色）。
  var lastStep = steps.length ? steps[steps.length - 1] : null
  for (var k = 0;k < phases.length;k += 1) {
    phases[k].label = phaseLabel(phases[k])
    // 「回答」：这一轮的**最后一步**、没有工具、有正文 —— 它是给用户看的答复，
    // 不是"只在脑子里"的推理。只覆盖显示名与颜色，分组照旧（见 isAnswerPhase）。
    if (isAnswerPhase(phases[k], lastStep)) {
      phases[k].label = '回答'
      phases[k].cat = phaseCategory('回答')
    }
  }
  return phases
}

export { FAMILY_EXACT, FAMILY_PREFIX, toolFamily, familyOf, CATEGORY_OF, phaseCategory, mergeByLabel, stepRanges, stepSettled, phaseSettled, runningLabel, phaseLabel, isAnswerPhase, groupPhases, PHASE_GAP_MS }
