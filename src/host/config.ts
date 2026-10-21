import z from '@deepseek-ai/schemastery'

export interface Config {
  /**
   * 每个会话最多保留多少个 turn 的**正文**（0 = 不限）。
   *
   * ⚠️ 这是**正文窗口**，不是"能看到多少轮"。
   * 目录（`/trace` 快照里的 `index`）按 `maxIndexTurns` 单独限，
   * 所以面板里能翻到的轮次远多于这个数 —— 早先两者是同一个数，
   * 于是 `prune()` 把 20 轮之前的**连骨架一起扔了**（133 轮的会话只剩 15%）。
   */
  maxTurnsPerSession: number
  /**
   * 目录索引里最多记多少轮（0 = 不限）。
   *
   * 骨架很便宜（一轮几百字节：轮号/时间/用户消息/步数/Token），
   * 所以这个上限只是防病态会话，默认给得很宽。
   */
  maxIndexTurns: number
  /**
   * 按需折进来的**更早轮次**（"冷轮正文"）保留多久，毫秒。
   *
   * **空闲计时**：每读一次就重新计时，所以"你正在读的那一轮"不会被抽走；
   * 超过这个时间没再被读过的，正文收回（骨架仍留在目录里）。0 = 不按时间收。
   *
   * 默认 2 小时。
   */
  coldTtlMs: number
  /**
   * 冷轮正文的**硬上限**（字符，思考原文 + 正文 + 工具参数）。0 = 不限。
   *
   * 和 `coldTtlMs` 是**两条独立的策略，谁先到算谁**：
   *   · 时间到了（空闲太久）→ 收；
   *   · 字符数超了 → 从最旧的开始丢。
   *
   * 为什么两条都要：时间策略管"不用了就还回来"，但它**没有内存上界** ——
   * 两小时里连开几百个老轮次，内存就一直涨到时间到为止。
   * 字符上限补的正是这个洞。默认 4,000,000 字符 ≈ 7.6MB（UTF-16）。
   */
  maxColdChars: number
  /** 单个 step 的思考原文上限（字符），超了截断并从尾部保留。 */
  maxReasoningCharsPerStep: number
  /** 同时在内存里跟踪多少个会话（LRU）。 */
  maxSessions: number
  /** SSE 合并推送的最小间隔（毫秒）：流式每秒几百个事件，必须合并。 */
  sseThrottleMs: number
  /** SSE 心跳间隔（毫秒），防代理掐连接。 */
  heartbeatMs: number
  /** 快照里为"当前步"附带多少字符的原文（其余步骤按需取）。 */
  snapshotTailChars: number
  /** 生成中文标题时,每一步最多喂多少字符的思考原文。 */
  titleStepChars: number
  /** 生成中文标题时整份请求的字符上限。 */
  titleTotalChars: number
  /** 生成中文标题的推理档位（标题是压缩任务，低档就够）。 */
  titleReasoningEffort: string
  /** 标题缓存文件路径。'' = 默认的 ~/.dsh/think-flow/titles.json（测试用临时目录覆盖）。 */
  titleCachePath: string
  /** 自动标题节拍器间隔（毫秒）。调小只为测试。 */
  autoTickMs: number
  /**
   * 内存轨迹多久没收到实时动静就算"可疑"（毫秒）：到点且轨迹看着还在跑，就重折一遍日志。
   * 也是重折**退避的基数**（15s → 30s → 60s…，封顶见 `resyncMaxGapMs`）。
   */
  resyncSilenceMs: number
  /**
   * 重折的退避上限（毫秒），也是这条自愈的总开关（`0` = 关掉）。
   *
   * ⚠️ 为什么是**退避**而不是"一段沉默期里最多折几次就彻底停手"：
   *    本进程**不是**驱动者时（换个客户端接着看），实时事件永远不会来 ——
   *    "沉默期"永远不会结束，一个硬上限就等于过一阵子**永久停止自愈**，
   *    面板又会挂着一轮几小时前的"还在跑"（真机踩到过：硬上限那版 5 次之后就不再更正）。
   */
  resyncMaxGapMs: number
  /**
   * 历史回看时最多折入多少条落盘事件（从最新往回取）。
   * 0 = 不限。大会话全量折入很慢，默认留一个上限。
   */
  maxHydrateEvents: number
  /**
   * 标题缓存最多保留多少条（按生成时间 LRU）。
   * 缓存文件只增不减的话会一直长 —— 每个会话每一轮一条。
   * 0 = 不限。
   */
  /**
   * 标题缓存最多记**多少轮**（不是多少条标题 —— 一条 = 一轮，里面装该轮每一步的标题
   * 和该轮所有工具说明的翻译）。
   */
  maxTitledTurns: number
  /**
   * 思考原文机翻的**目标语言**（默认简体中文）。
   *
   * 翻译走官方 `@deepseek-ai/dsh-experimental-translator`（`ctx.translator`）。
   * 没装那个 bundle 的 profile 里本项无效，面板上的「中文」开关自动禁用。
   */
  translateTarget: string
  /**
   * 机翻**提供方**：`bing` / `google` / `deepseek-account` / `deepseek-official`。
   *
   * `''` = 跟随 translator 服务自身的配置（默认 `bing`，匿名端点、不需要 key）。
   * 付费路由要求会话持久化，而本插件对会话只读、不传 sessionId ——
   * 所以这里**只建议用 bing / google**（付费路由会因为缺 session 直接报错）。
   */
  translateProvider: string
  /**
   * 单个翻译请求的**字符上限**。
   *
   * 客户端按段落切、每段不超过它；宿主还会再和 translator 的 `maxTextChars`
   * 取一次较小值（Bing/Google 默认 4000）。超出直接 413，不截断 ——
   * 截断会把一句话翻成半句，比不翻更糟。
   */
  translateMaxChars: number
  /** 单次翻译请求的超时（毫秒）。超时/失败都只在面板上标一下，不重试 —— 重试由用户切开关触发。 */
  translateTimeoutMs: number
  /** 翻译缓存文件路径。`''` = 默认的 `~/.dsh/think-flow/translations.json`。 */
  translateCachePath: string
  /**
   * 翻译缓存最多保留多少条（按原文 LRU）。0 = 不限。
   *
   * 一条 = 一个段落（通常 200~1500 字），4000 条约 3~6MB ——
   * 面板翻历史时大多数段落直接命中，不再走网络。
   */
  maxTranslationEntries: number
}

/** 配置（缺省值即推荐值）。 */
export const Config = z.object({
  maxTurnsPerSession: z.number().min(0).max(500).default(20),
  maxIndexTurns: z.number().min(0).max(20000).default(2000),
  coldTtlMs: z.number().min(0).max(86_400_000).default(7_200_000),
  maxColdChars: z.number().min(0).max(200_000_000).default(4_000_000),
  maxReasoningCharsPerStep: z.number().min(1000).max(400000).default(120000),
  maxSessions: z.number().min(1).max(256).default(32),
  sseThrottleMs: z.number().min(0).max(2000).default(120),
  heartbeatMs: z.number().min(2000).max(120000).default(15000),
  snapshotTailChars: z.number().min(200).max(20000).default(4000),
  titleStepChars: z.number().min(80).max(4000).default(420),
  titleTotalChars: z.number().min(2000).max(200000).default(24000),
  titleReasoningEffort: z.string().default('low'),
  titleCachePath: z.string().default(''),
  autoTickMs: z.number().min(20).max(60_000).default(5000),
  /**
   * 内存轨迹多久没收到实时动静就算"可疑"（毫秒）—— 到了这个时间且轨迹看着还在跑，
   * 就把日志重折一遍（见 `resyncFromLog`）。也是重折退避的基数。
   */
  resyncSilenceMs: z.number().min(20).max(600_000).default(15_000),
  /** 重折退避的上限（毫秒；0 = 关掉这条自愈）。 */
  resyncMaxGapMs: z.number().min(0).max(3_600_000).default(300_000),
  maxHydrateEvents: z.number().min(0).max(200000).default(20000),
  // 640 = 会话 LRU 上限 32 × 每会话轮数上限 20 —— 两个上限对齐，
  // 这样"还能在面板里翻到的轮"标题都不会被淘汰（实测 57 轮才 69KB，不差这点）
  maxTitledTurns: z.number().min(0).max(10000).default(640),
  translateTarget: z.string().default('zh-CN'),
  translateProvider: z.string().default(''),
  translateMaxChars: z.number().min(200).max(4000).default(3600),
  translateTimeoutMs: z.number().min(1000).max(120000).default(20000),
  translateCachePath: z.string().default(''),
  maxTranslationEntries: z.number().min(0).max(100000).default(4000),
})

/** Normalize programmatic apply() calls using the same documented defaults. */
export function resolveConfig(rawConfig: Config): Config {
  return {
    maxTurnsPerSession: rawConfig?.maxTurnsPerSession ?? 20,
    maxIndexTurns: rawConfig?.maxIndexTurns ?? 2000,
    coldTtlMs: rawConfig?.coldTtlMs ?? 7_200_000,
    maxColdChars: rawConfig?.maxColdChars ?? 4_000_000,
    maxReasoningCharsPerStep: rawConfig?.maxReasoningCharsPerStep ?? 120000,
    maxSessions: rawConfig?.maxSessions ?? 32,
    sseThrottleMs: rawConfig?.sseThrottleMs ?? 120,
    heartbeatMs: rawConfig?.heartbeatMs ?? 15000,
    snapshotTailChars: rawConfig?.snapshotTailChars ?? 4000,
    titleStepChars: rawConfig?.titleStepChars ?? 420,
    titleTotalChars: rawConfig?.titleTotalChars ?? 24000,
    titleReasoningEffort: rawConfig?.titleReasoningEffort ?? 'low',
    titleCachePath: rawConfig?.titleCachePath ?? '',
    autoTickMs: rawConfig?.autoTickMs ?? 5000,
    resyncSilenceMs: rawConfig?.resyncSilenceMs ?? 15_000,
    resyncMaxGapMs: rawConfig?.resyncMaxGapMs ?? 300_000,
    maxHydrateEvents: rawConfig?.maxHydrateEvents ?? 20000,
    maxTitledTurns: rawConfig?.maxTitledTurns ?? 640,
    translateTarget: rawConfig?.translateTarget ?? 'zh-CN',
    translateProvider: rawConfig?.translateProvider ?? '',
    translateMaxChars: rawConfig?.translateMaxChars ?? 3600,
    translateTimeoutMs: rawConfig?.translateTimeoutMs ?? 20000,
    translateCachePath: rawConfig?.translateCachePath ?? '',
    maxTranslationEntries: rawConfig?.maxTranslationEntries ?? 4000,
  }
}
