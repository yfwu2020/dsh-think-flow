/**
 * 中文标题：提示词构造与响应解析 —— 纯函数，无 IO，可单测。
 *
 * 为什么要有这个模块：**本地规则做不出可靠的中文标题**。
 * 实测（`scripts/title-probe.mjs`，真实 22 步）本地规则的产出是
 * 7 条可用 / 8 条空洞 / **7 条错**，而且错得很像样（例如把"结论：插件以 profile
 * bundle 装入"标成"查：插件·插槽"）—— 错的标题比没有标题更危险。
 *
 * 所以标题改成按需由模型生成，一次调用覆盖一个 turn 的全部步骤，结果落盘缓存。
 * 这个模块只负责两件容易出错的事：**把输入裁到可控大小**、**把输出解析成可靠结构**。
 */

/** 工具自带的英文说明（要翻成中文）。 */
export interface TitleInputNote {
  /** 工具调用 id —— 客户端按 id 找回来（一步可能有多个工具，各有各的说明）。 */
  readonly id: string
  /** 英文原文。 */
  readonly text: string
}

/** 一步的输入素材。 */
export interface TitleInputStep {
  readonly step: number
  /** 该步的思考原文（英文）。 */
  readonly reasoning: string
  /** 该步调用的工具名。 */
  readonly tools: readonly string[]
  /** 该步各工具自带的英文说明（可选；`bash` 的 `description` 就是这个）。 */
  readonly notes?: readonly TitleInputNote[]
}

/** 构造提示词时的上限。 */
export interface TitleBudget {
  /** 每一步最多喂多少字符的原文。 */
  perStepChars: number
  /** 整份请求的字符上限（超出就按比例压缩每一步）。 */
  totalChars: number
}

/** 默认预算：够模型判断"这一步在干嘛"，又不至于把一次调用撑爆。 */
export const DEFAULT_BUDGET: TitleBudget = { perStepChars: 420, totalChars: 24000 }

/**
 * 把一步的原文压成一段可喂的素材。
 * 取**开头与结尾**：开头通常是这步要干什么，结尾往往是结论。
 * @param text - 完整原文。
 * @param limit - 字符上限。
 * @returns 压缩后的文本。
 */
export function clipReasoning(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const head = Math.ceil(limit * 0.62)
  const tail = Math.max(0, limit - head - 3)
  return `${flat.slice(0, head)} … ${tail > 0 ? flat.slice(flat.length - tail) : ''}`.trim()
}

/**
 * 按预算给每一步分配字符数。步骤多的时候**按比例压缩**，
 * 而不是把后面的步骤整段丢掉 —— 丢掉会让标题和步骤错位。
 * @param steps - 输入步骤。
 * @param budget - 预算。
 * @returns 每一步实际可用的字符数。
 */
export function allocateChars(steps: readonly TitleInputStep[], budget: TitleBudget): number {
  if (steps.length === 0) return budget.perStepChars
  const fair = Math.floor(budget.totalChars / steps.length)
  return Math.max(80, Math.min(budget.perStepChars, fair))
}

/** 提示词的 system 部分：只要 JSON，不要解释。 */
export const TITLE_SYSTEM = [
  '你把编码智能体的英文思维链压缩成中文短标题。',
  '用户会给你若干步骤，每步包含编号、该步思考的原文片段、以及它调用的工具。',
  '为**每一步**写一条中文标题：',
  '- 长度 8~18 个汉字，动词或结论开头（如「确认」「核对」「排除」「读」「盘点」「收束」）。',
  '- 说清这一步**在做什么**或**得出了什么**，不要复述原文，不要写"思考""分析"这种空词。',
  '- 不要编号、不要标点结尾、不要引号、不要换行。',
  '- 如果这一步得出了明确结论，标题里就体现结论（例如「确认插件按包名装入」），而不是写"查看插件"。',
  '另外，如果给了「工具说明」，把每条**翻译成中文短句**（8~16 个汉字，动词开头，',
  '  不要解释、不要加引号、不要保留英文）：这些是命令自带的说明，要贴在对应命令的标题后面。',
  '如果给了「本轮最后的输出」，再为**整轮**写一条标题（字段 turnTitle）：',
  // ⚠️ 长度和步骤标题**同一档**（8~18）：原来写 12~24，生成出来 18~19 字，
  //    比步骤标题（实测中位 13 字）长一截，在 380px 的轮头里显得太长。
  '- 8~18 个汉字，一句话说清这一轮**要什么 / 做了什么 / 结果如何**，让人扫一眼就知道这轮是干嘛的。',
  '- 以用户这一轮的诉求或最终结论为主，不要罗列步骤，不要写"思考""分析"这种空词。',
  '- 不要编号、不要标点结尾、不要引号、不要换行。没给「本轮最后的输出」时 turnTitle 给空字符串。',
  '严格按 JSON 输出，形如 {"titles":["第一条","第二条"],"notes":{"工具id":"中文说明"},"turnTitle":"整轮标题"}。',
  '  titles 的条数必须与步骤数完全一致；notes 只包含给到的那些工具 id；turnTitle 没有就给 ""。',
  '除了这段 JSON 不要输出任何其它内容。',
].join('\n')

/**
 * 构造 user 部分的步骤清单。
 * @param steps - 输入步骤。
 * @param budget - 预算。
 * @returns 提示词文本。
 */
export function buildTitleUser(
  steps: readonly TitleInputStep[],
  budget: TitleBudget = DEFAULT_BUDGET,
  notes: readonly TitleInputNote[] = [],
  turnOutput = '',
): string {
  const per = allocateChars(steps, budget)
  const lines = steps.map((s) => {
    const tools = s.tools.length ? s.tools.join(', ') : '（未调用工具）'
    return `#${s.step}｜工具：${tools}\n${clipReasoning(s.reasoning, per)}`
  })
  const head = `共 ${steps.length} 步，请给出 ${steps.length} 条标题。`
  const noteBlock = notes.length === 0 ? '' :
    `\n\n工具说明（${notes.length} 条，请逐条翻成中文，key 原样保留）：\n` +
    notes.map((n) => `${n.id}｜${n.text}`).join('\n')
  // 整轮标题的素材：**本轮最后的 AI 输出**（用户定的）。裁到 1200 字够写一条 24 字的标题了。
  const turnBlock = turnOutput.trim() === '' ? '' :
    `\n\n本轮最后的输出（请据此写整轮标题 turnTitle，8~18 个汉字）：\n` +
    turnOutput.slice(0, TURN_OUTPUT_CHARS)
  return `${head}\n\n${lines.join('\n\n')}${noteBlock}${turnBlock}`
}

/** 整轮标题的素材（本轮最后的 AI 输出）裁到多长。够写一条 24 字的标题，也不用把整篇塞进去。 */
export const TURN_OUTPUT_CHARS = 1200

/** 解析结果。 */
export interface ParsedTitles {
  readonly titles: readonly string[]
  /** 工具说明的中文翻译，key = 工具 id。没有就给空对象。 */
  readonly notes: Record<string, string>
  /** 整轮标题。模型没给（或给了空串）就是空字符串。 */
  readonly turnTitle: string
}

/**
 * 从模型输出里解析标题数组。
 *
 * 容错是有意的：模型经常包一层 ```json 围栏，或前后多说一句话。
 * 但**条数必须对得上** —— 对不上就宁可报错，也不能让标题和步骤错位：
 * 错位的标题比没有标题更糟（这正是当初否掉本地规则的理由）。
 * @param raw - 模型输出原文。
 * @param expected - 期望的条数。
 * @returns 解析结果，或 undefined 表示不可用。
 */
export function parseTitles(raw: string, expected: number): ParsedTitles | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let text = raw.trim()

  // 去掉 ```json ... ``` 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1] !== undefined) text = fence[1].trim()

  // 取第一个 { 到最后一个 }，容忍前后的客套话
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open < 0 || close <= open) return undefined
  text = text.slice(open, close + 1)

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  const arr = (data as { titles?: unknown } | null)?.titles
  /**
   * ⚠️ `expected === 0` 表示"这次**不要**步骤标题"（只缺说明翻译或整轮标题）。
   *
   * 这种情况下模型**照样会**把步骤标题一起吐回来（提示词里就有那些步骤），
   * 所以不能按"必须 0 条"去卡 —— 否则整条被否掉，连说明和整轮标题一起丢。
   * 真机踩过：只缺整轮标题时，标题生成一直失败。
   */
  if (expected > 0) {
    if (!Array.isArray(arr)) return undefined
    if (arr.length !== expected) return undefined
  }
  const rawTitles = Array.isArray(arr) ? arr : []
  const titles = rawTitles.map((t) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : ''))
  if (expected > 0 && titles.some((t) => t === '')) return undefined
  // notes 宽容处理：不是对象 / 有条目坏了，都只丢那一条 —— 它只是锦上添花，
  // 不该因为它把整轮标题一起否掉（titles 的条数才是硬约束）
  const notes: Record<string, string> = {}
  const rawNotes = (data as { notes?: unknown } | null)?.notes
  if (rawNotes !== null && typeof rawNotes === 'object' && !Array.isArray(rawNotes)) {
    for (const [k, v] of Object.entries(rawNotes as Record<string, unknown>)) {
      if (typeof v !== 'string') continue
      const clean = v.replace(/\s+/g, ' ').trim().replace(/^[「"'']|[」"'']$/g, '').replace(/[。；;]\s*$/, '')
      if (clean !== '') notes[k] = clean
    }
  }
  // 整轮标题：同样是"能洗就洗"，但**不检查长度** —— 它是可选的，模型给什么用什么
  const turnRaw = (data as { turnTitle?: unknown } | null)?.turnTitle
  const turnTitle = typeof turnRaw === 'string'
    ? turnRaw.replace(/^\s*\d+[.、)]\s*/, '').replace(/[。；;]\s*$/, '').replace(/\s+/g, ' ').trim()
    : ''
  return {
    titles: titles.map((t) => t.replace(/^\s*\d+[.、)]\s*/, '').replace(/[。；;]\s*$/, '')),
    notes,
    turnTitle,
  }
}

/**
 * 内容指纹：用来判断缓存是否过期。
 * 步骤数或任一步的原文长度变了，就重新生成。
 * @param steps - 输入步骤。
 * @returns 稳定的字符串。
 */
export function contentFingerprint(steps: readonly TitleInputStep[], notes: readonly TitleInputNote[] = []): string {
  let h = 2166136261
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  feed(String(steps.length))
  for (const s of steps) {
    feed('|')
    feed(String(s.step))
    feed(':')
    feed(String(s.reasoning.length))
    feed(':')
    feed(s.tools.join(','))
  }
  // 说明也要进指纹：它变了（或新增了）就得重新生成，否则拿到的是旧翻译
  feed('#')
  feed(String(notes.length))
  for (const n of notes) {
    feed('|')
    feed(n.id)
    feed(':')
    feed(n.text)
  }
  return (h >>> 0).toString(36)
}
