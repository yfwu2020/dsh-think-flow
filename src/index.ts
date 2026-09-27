/**
 * @yfwu2020/dsh-think-flow —— 宿主半。
 *
 * 职责只有三件事：
 *   ① 订阅 `agent/assistant-stream`（流式思考增量）与 `session/event`（工具调用 / 步边界）
 *   ② 折成「turn → step →（思考原文 + 工具调用）」，每个会话一份，LRU 上限
 *   ③ 通过 HTTP 把变化推给前端：`/stream`（SSE 增量）+ `/trace`（一次性快照）+ `/step`（按需取原文）
 *
 * 另外两条路径：
 *   · 历史回看 —— 内存里没有的会话，从落盘日志折出来（`hydrate`），使旧会话也能读
 *   · 中文标题 —— 按需调用模型把整轮思考压成中文短标题，结果落盘缓存（`/titles`）
 *
 * 唯一落盘的东西是**标题缓存**（派生数据，丢了随时能重算）；会话本身只读、不改。
 * 除了"生成标题"这一次显式动作，插件不主动调用模型。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
// 只为把事件声明合并进来：`agent/assistant-stream` 来自 dsh-agent，
// `session/event` 来自 dsh-session；不 import 的话 ctx.on 不认识这两个事件名。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  buildTitleUser,
  contentFingerprint,
  DEFAULT_BUDGET,
  parseTitles,
  TITLE_SYSTEM,
  type TitleBudget,
  type TitleInputNote,
  type TitleInputStep,
} from './titles.js'
import {
  applySessionEvent,
  applyStreamFrame,
  COMMAND_TOOLS,
  createTrace,
  type StepFact,
  lastTurn,
  runningTool,
  stepElapsed,
  stepStatus,
  type SessionTrace,
  type TraceChange,
  type TurnFact,
} from './trace.js'

export const name = '@yfwu2020/dsh-think-flow'

/** web 服务器；会话与 agent 事件走全局事件总线；`llm` 用于按需生成中文标题。 */
export const inject = ['webServer', 'llm']

/** 路由前缀。 */
const API = '/think-flow/api'

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
   * 骨架很便宜（一轮几百字节：轮号/时间/用户消息/步数/字数），
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
  maxHydrateEvents: z.number().min(0).max(200000).default(20000),
  // 640 = 会话 LRU 上限 32 × 每会话轮数上限 20 —— 两个上限对齐，
  // 这样"还能在面板里翻到的轮"标题都不会被淘汰（实测 57 轮才 69KB，不差这点）
  maxTitledTurns: z.number().min(0).max(10000).default(640),
})

/** 一个 SSE 订阅者。 */
interface Subscriber {
  readonly sessionId: string
  write(chunk: string): void
  end(): void
  /** 合并窗口内累积的改动。 */
  pending: TraceChange[]
  timer: ReturnType<typeof setTimeout> | undefined
}

/** 标题缓存里的一条记录。 */
/**
 * 标题缓存条目。
 *
 * ⚠️ v2 起改成**按步存**（`steps` / `notes` 都是 map）—— 为了支持"边跑边出标题"：
 * 一轮跑到一半就该把已经结束的那几步先起好，不能等整轮跑完再一次性生成。
 * v1 是"一轮一个数组 + 整轮指纹"，v2 代码读到就当没有（下次生成会重写成 v2）。
 */
interface TitleCacheEntry {
  at: number
  /** 步号 → { 标题, 该步思考的指纹 }。 */
  steps?: Record<string, { title: string; print: string }>
  /** 工具 id → { 中文说明, 英文原文指纹 }。 */
  notes?: Record<string, { note: string; print: string }>
  /**
   * **整轮标题**（一句话说清这一轮干了什么）。
   *
   * 与按步标题的区别：它总结的是**整轮**，素材是"本轮最后的 AI 输出"，
   * 而且只在**轮结束之后**才生成（跑的过程中输出还在变，生成出来就要重算）。
   * `print` 是那份输出的指纹，输出变了标题就该重算。
   */
  title?: { text: string; print: string }
  /** v1 遗留字段（读到忽略）。 */
  fingerprint?: string
  titles?: string[]
  model?: string
}
/** 标题缓存：`sessionId:turn` → 记录。 */
type TitleCache = Record<string, TitleCacheEntry>

/**
 * 会话的可用状态。
 *
 * 早先只有一个 `known:boolean`，把"读不到会话"和"会话是新的、还没有步骤"
 * 混成了一件事 —— 面板会对一个刚开的会话说"读不到"，也会对一个被删掉的会话
 * 说"等待推理开始"。两种都说反了，所以拆开。
 */
export type SessionState =
  /** 收到了实时事件。 */
  | 'live'
  /** 内存里没有，从落盘日志折出来的。 */
  | 'hydrated'
  /** 能读，但还没有任何步骤（新建的会话）。 */
  | 'empty'
  /** 读不到（已删除 / 被别的进程占用 / 没有持久化服务）。 */
  | 'unreadable'

/**
 * 一轮的**骨架**：几百字节，不含正文。
 *
 * 目录（"看更早的轮次"）靠的就是它 —— 正文可以丢，骨架不能丢。
 * 早先 `prune()` 直接把 `turns` 从头 splice 掉，于是 133 轮的会话在面板里
 * 只剩 15%，而且**连"有过这一轮"都不知道**。
 */
export interface TurnSummary {
  readonly turn: number
  startedAt: number
  endedAt?: number
  endReason?: string
  interrupted?: boolean
  /** 本轮第一条**真人**消息（轮标题的默认素材）。 */
  userText?: string
  /**
   * **模型生成的轮次标题**（没有就是 undefined —— 那这一轮显示的是上面的 userText）。
   *
   * 放在骨架里是因为：面板上的搜索只搜"轮次"，搜的就是 **userText + title** 这两样，
   * 而标题**不是会话事件**（它是这个插件自己生成的），任何会话检索服务都搜不到它 ——
   * 只能随骨架一起下发，在客户端本地搜。
   */
  title?: string
  /** 步数。 */
  steps: number
  /** 工具调用次数。 */
  tools: number
  /** 思考原文总字数（正文丢了也保留这个数）。 */
  reasoningChars: number
  /** 正文总字数。 */
  textChars: number
  /** 正文现在在内存里吗（false = 打开它时要现折）。 */
  inMemory: boolean
}

/** 一棵会话轨迹树 + 它的订阅者。 */
interface SessionEntry {
  /** 这份数据是怎么来的。 */
  state: SessionState
  readonly trace: SessionTrace
  readonly subs: Set<Subscriber>
  /**
   * **全轮骨架**：轮号 → 摘要。所有活过的轮都在里面，包括正文已经被丢掉的。
   * 目录直接读它。
   */
  readonly index: Map<number, TurnSummary>
  /**
   * 按需折进来的**更早轮次**的正文（不在 `trace.turns` 窗口里的那些）。
   *
   * `at` = **最后一次被读**的时间：超过 `coldTtlMs` 没再读过就收回（空闲计时，
   * 读一次就重新计时）。见 `sweepCold`。
   */
  readonly cold: Map<number, { turn: TurnFact; at: number }>
  /**
   * `cold` 里正文的总字符数。
   *
   * 存成计数器而不是每次现算：`prune()` 在**每个事件批次**上都会跑，
   * 现算要把所有冷轮的每一步都过一遍 —— 那是每个事件一次的全量扫描。
   */
  coldChars: number
}

/** 内部诊断计数，`/ping` 用。 */
interface Stats {
  frames: number
  events: number
  gaps: number
  dropped: number
}

export function apply(ctx: Context, rawConfig: Config): void {
  const config: Config = {
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
    maxHydrateEvents: rawConfig?.maxHydrateEvents ?? 20000,
    maxTitledTurns: rawConfig?.maxTitledTurns ?? 640,
  }

  const sessions = new Map<string, SessionEntry>()
  const stats: Stats = { frames: 0, events: 0, gaps: 0, dropped: 0 }

  // ───────────────────────── 会话条目（LRU） ─────────────────────────

  function entryOf(sessionId: string, now: number): SessionEntry {
    let e = sessions.get(sessionId)
    if (e !== undefined) {
      // 重插一次即最近使用
      sessions.delete(sessionId)
      sessions.set(sessionId, e)
      return e
    }
    e = {
      trace: createTrace(sessionId), subs: new Set(), state: 'live',
      index: new Map(), cold: new Map(), coldChars: 0,
    }
    sessions.set(sessionId, e)
    while (sessions.size > config.maxSessions) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined || oldest === sessionId) break
      const victim = sessions.get(oldest)
      if (victim !== undefined) {
        for (const s of victim.subs) s.end()
        stats.dropped += 1
      }
      sessions.delete(oldest)
    }
    return e
  }

  /** 一轮正文占多少字符（冷缓存预算用）。 */
  function turnChars(turn: TurnFact): number {
    let n = 0
    for (const step of turn.steps) {
      n += step.reasoning.length + step.text.length
      for (const tool of step.tools) n += tool.argsRaw.length
    }
    return n
  }

  /** 把一轮压成**骨架**：几百字节，不含正文。 */
  function summaryOf(sessionId: string, turn: TurnFact, inMemory: boolean): TurnSummary {
    let tools = 0
    let reasoningChars = 0
    let textChars = 0
    for (const step of turn.steps) {
      tools += step.tools.length
      reasoningChars += step.reasoning.length
      textChars += step.text.length
    }
    // 轮次标题（模型生成的）：和 turnSnapshot 一样，**指纹对得上**才作数 ——
    // 这一轮的内容变了，旧标题就不该再跟着走
    const cached = titleCache?.[`${sessionId}:${turn.turn}`]
    const title = cached?.title !== undefined && cached.title.print === turnPrint(turn)
      ? cached.title.text
      : undefined
    return {
      turn: turn.turn,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      endReason: turn.endReason,
      interrupted: turn.interrupted,
      userText: turn.userText,
      title,
      steps: turn.steps.length,
      tools,
      reasoningChars,
      textChars,
      inMemory,
    }
  }

  /** 记骨架（正文在内存里的轮）。 */
  function rememberTurn(e: SessionEntry, turn: TurnFact): void {
    e.index.set(turn.turn, summaryOf(e.trace.sessionId, turn, true))
  }

  /** 正文被丢掉时改骨架：轮还在，只是"不在内存里"了。 */
  function markDropped(e: SessionEntry, turn: number): void {
    const prev = e.index.get(turn)
    if (prev !== undefined) e.index.set(turn, { ...prev, inMemory: false })
  }

  /** 会话持久化服务；拿不到就是 undefined（没有它就没有历史回看）。 */
  function persistenceOf() {
    return ctx.get('sessionPersistence') as
      | { open?: (id: string, mode: 'read') => Promise<{ read: () => Promise<{ events?: readonly unknown[] }>; close: () => Promise<void> }> }
      | undefined
  }

  /** 折历史时最多取多少条事件（从最新往回取）。 */
  function capHydrateEvents(events: readonly unknown[]): readonly unknown[] {
    return config.maxHydrateEvents > 0 && events.length > config.maxHydrateEvents
      ? events.slice(events.length - config.maxHydrateEvents)
      : events
  }

  /**
   * 从落盘日志里**只折出某一轮**。
   *
   * 为什么不整份折：整份是 31MB / 11493 个事件，而你要的往往只是一轮。
   * 先轻量挑出这一轮的事件（只读 `data.turn`，不做任何组装），再只折它们。
   * @param sessionId - 会话。
   * @param turnNo - 轮号。
   * @returns 折出来的那一轮；读不到 / 没有这一轮时 undefined。
   */
  async function foldTurnFromLog(sessionId: string, turnNo: number): Promise<TurnFact | undefined> {
    const persistence = persistenceOf()
    if (persistence?.open === undefined) return undefined
    let handle: Awaited<ReturnType<NonNullable<typeof persistence.open>>> | undefined
    try { handle = await persistence.open(sessionId, 'read') } catch { return undefined }
    try {
      const { events } = await handle.read()
      if (!Array.isArray(events) || events.length === 0) return undefined
      const slice = capHydrateEvents(events)
      const picked: unknown[] = []
      let cur = 0
      for (const raw of slice) {
        const ev = raw as { data?: { turn?: unknown } }
        if (typeof ev.data?.turn === 'number') cur = ev.data.turn
        // user/message 不带 turn，靠"当前轮"归属 —— 和 buildTurnRanges 同一套判断
        if (cur === turnNo) picked.push(raw)
      }
      if (picked.length === 0) return undefined
      const scratch = createTrace(sessionId)
      for (const ev of picked) applySessionEvent(scratch, ev as never, Date.now())
      return scratch.turns.find((t) => t.turn === turnNo)
    } finally {
      try { await handle?.close() } catch { /* 已经关了 */ }
    }
  }

  /**
   * 拿一轮的正文：窗口里有就用，冷缓存里有就用，都没有才现折。
   * @returns 那一轮；日志里也没有时 undefined。
   */
  async function materializeTurn(e: SessionEntry, sessionId: string, turnNo: number): Promise<TurnFact | undefined> {
    // 先按时间收一遍：这次要用的轮次如果已经过期，下面自然会重新折
    sweepCold(e, Date.now())
    const inWindow = e.trace.turns.find((t) => t.turn === turnNo)
    if (inWindow !== undefined) return inWindow
    const cached = e.cold.get(turnNo)
    if (cached !== undefined) {
      cached.at = Date.now()           // **续期**：正在读的轮次不该被时间收走
      return cached.turn
    }
    const folded = await foldTurnFromLog(sessionId, turnNo)
    if (folded === undefined) return undefined
    e.cold.set(turnNo, { turn: folded, at: Date.now() })
    e.coldChars += turnChars(folded)
    rememberTurn(e, folded)          // 骨架改成"在内存里"了
    prune(e)                         // 顺手按可选硬上限修剪
    return folded
  }

  /**
   * 修剪：正文窗口、目录上限、冷缓存预算、单个 step 的原文长度。
   *
   * ⚠️ 顺序很重要：**先记骨架，再丢正文**。反过来的话目录跟着正文一起没了 ——
   * 老版本就是直接 `splice` 掉，133 轮的会话在面板里只剩 15%，而且
   * 连"更早还有 113 轮"都不知道。正文可以丢，骨架不能丢。
   */
  function prune(e: SessionEntry): void {
    const t = e.trace
    // ① 记骨架（正文窗口里的轮都算"在内存里"）
    for (const turn of t.turns) rememberTurn(e, turn)
    // ② 丢正文窗口之外的（骨架留着）
    if (config.maxTurnsPerSession > 0 && t.turns.length > config.maxTurnsPerSession) {
      const dropped = t.turns.splice(0, t.turns.length - config.maxTurnsPerSession)
      for (const turn of dropped) markDropped(e, turn.turn)
    }
    // ③ 单个 step 的原文上限
    for (const turn of t.turns) {
      for (const step of turn.steps) {
        const cap = config.maxReasoningCharsPerStep
        if (step.reasoning.length > cap) {
          step.reasoning = step.reasoning.slice(step.reasoning.length - cap)
          step.streamGap = true          // 截断过，如实标记
        }
      }
    }
    // ④ 目录上限（骨架很便宜，这个只是防病态会话）
    if (config.maxIndexTurns > 0 && e.index.size > config.maxIndexTurns) {
      const keys = [...e.index.keys()].sort((a, b) => a - b)
      for (const k of keys.slice(0, e.index.size - config.maxIndexTurns)) e.index.delete(k)
    }
    // ⑤ 冷轮正文：两条策略谁先到算谁 —— 先按时间收（空闲太久），再按字符上限收
    sweepCold(e, Date.now())
    if (config.maxColdChars > 0 && e.coldChars > config.maxColdChars) {
      for (const k of [...e.cold.keys()].sort((a, b) => a - b)) {
        if (e.coldChars <= config.maxColdChars) break
        const hit = e.cold.get(k)
        if (hit === undefined) continue
        e.coldChars -= turnChars(hit.turn)
        e.cold.delete(k)
        markDropped(e, k)
      }
    }
  }

  /**
   * 按**时间**收回冷轮正文：超过 `coldTtlMs` 没被读过的，正文丢掉（骨架留着）。
   *
   * ⚠️ 计时是**空闲**计时，不是"从折进来算起"：`materializeTurn` 每次命中都会
   *    把 `at` 推到当下 —— 你正在读的那一轮不该在两小时后突然空掉。
   *
   * ⚠️ 光有这一条**没有内存上界**：两小时里连开几百个老轮次就一直涨。
   *    所以 `prune()` 里紧跟着还有一道 `maxColdChars` 字符上限 —— 两条一起才完整。
   */
  function sweepCold(e: SessionEntry, now: number): void {
    if (config.coldTtlMs <= 0 || e.cold.size === 0) return
    for (const [k, hit] of [...e.cold]) {
      if (now - hit.at <= config.coldTtlMs) continue
      e.coldChars -= turnChars(hit.turn)
      e.cold.delete(k)
      markDropped(e, k)
    }
  }

  /** 对**所有**会话收一遍（定时器用：没人碰面板时也要能到点收回）。 */
  function sweepAllCold(now: number): void {
    for (const e of sessions.values()) sweepCold(e, now)
  }

  // ───────────────────────── 推送 ─────────────────────────

  function send(sub: Subscriber, payload: unknown): void {
    try {
      sub.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      /* 连接已断，下一轮清理 */
    }
  }

  function flush(sub: Subscriber): void {
    sub.timer = undefined
    const pending = sub.pending
    sub.pending = []
    if (!pending.length) return
    // 同一 step 的连续文本增量合成一条，避免逐字推
    const merged: TraceChange[] = []
    for (const c of pending) {
      const last = merged[merged.length - 1]
      if (
        last !== undefined &&
        (c.k === 'reasoning' || c.k === 'text') &&
        last.k === c.k &&
        last.turn === c.turn &&
        last.step === c.step
      ) {
        merged[merged.length - 1] = { ...last, text: last.text + c.text }
        continue
      }
      merged.push(c)
    }
    for (const c of merged) {
      send(sub, { t: 'change', change: c })
    }
  }

  function broadcast(sessionId: string, changes: TraceChange[]): void {
    const e = sessions.get(sessionId)
    if (e === undefined) return
    // 修剪必须在**有无订阅者**两条路径上都跑。
    // 早先它写在"有订阅者"的分支后面，于是没人打开面板时原文永不截断 ——
    // 内存只涨不落（路由测试 ⑨ 抓到的）。
    prune(e)
    if (e.subs.size === 0) return
    for (const c of changes) {
      if (c.k === 'gap') stats.gaps += 1
    }
    for (const sub of e.subs) {
      sub.pending.push(...changes)
      if (config.sseThrottleMs === 0) {
        flush(sub)
      } else if (sub.timer === undefined) {
        sub.timer = setTimeout(() => flush(sub), config.sseThrottleMs)
      }
    }
  }

  // ───────────────────────── 事件订阅 ─────────────────────────

  const offStream = ctx.on('agent/assistant-stream', (payload: unknown) => {
    const p = payload as { agent?: { session?: { id?: unknown } }; frame?: unknown } | undefined
    const sessionId = p?.agent?.session?.id
    if (typeof sessionId !== 'string' || p?.frame === undefined) return
    stats.frames += 1
    const e = entryOf(sessionId, Date.now())
    e.state = 'live'
    whenNotHydrating(sessionId, () => {
      const changes = applyStreamFrame(e.trace, p.frame as never, Date.now())
      if (changes.length) broadcast(sessionId, changes)
    })
  })

  const offEvent = ctx.on('session/event', (session: unknown, event: unknown) => {
    const sessionId = (session as { id?: unknown } | undefined)?.id
    if (typeof sessionId !== 'string') return
    stats.events += 1
    const e = entryOf(sessionId, Date.now())
    e.state = 'live'
    whenNotHydrating(sessionId, () => {
      // 实时会话也要记区间：没 hydrate 过的会话（正在跑的那个）搜索时同样要反查轮号
      const changes = applySessionEvent(e.trace, event as never, Date.now())
      if (changes.length) broadcast(sessionId, changes)
      // 自动标题：有步开始/结束就记一笔，等节拍器来刷（**不是**每步一次调用）
      if (autoTitles.has(sessionId) && changes.length > 0) autoDirty.add(sessionId)
    })
  })

  ctx.effect(() => () => { offStream(); offEvent() }, `${name}: event subscriptions`)

  /**
   * 卸载时把已建立的 SSE 连接收干净。
   *
   * 为什么必须有：`webServer.register()` 返回的 disposer 只把路由从表里摘掉
   * （见 dsh-host-webserver 的 `register()`），**不碰已经建立的连接**。
   * 于是热重载后旧 fiber 的订阅虽然解了（旧 trace 不再收事件），旧连接和它的
   * 心跳却还活着 —— 面板从此只收 ping，看起来像卡死，只能手动刷新（真机踩到）。
   *
   * 收干净还有个副作用是好的：连接被正常关闭后 `EventSource` 会**自动重连**，
   * 于是热重载从"面板冻住"变成"自己恢复"。
   */
  ctx.effect(() => () => {
    for (const e of sessions.values()) {
      for (const s of e.subs) s.end()
      e.subs.clear()
    }
    sessions.clear()
  }, `${name}: 连接与会话清理`)

  // ───────────────────────── 历史回看（从落盘会话重建轨迹） ─────────────────────────

  /**
   * 从落盘会话把轨迹折出来。
   *
   * 为什么需要它：事件是**实时**的，不回放 —— 插件加载之前、以及更早的会话，
   * 内存里什么都没有。切到旧会话时面板必须是空的还是能看到当时怎么想的，
   * 差别就在这里。
   *
   * 只在该会话内存里**还没有任何 turn** 时才做，避免把实时状态覆盖掉。
   * @param sessionId - 要回看的会话。
   * @returns 是否真的折入了内容。
   */
  /**
   * 本进程里**已经折过历史**的会话。
   *
   * ⚠️ 判断"要不要折"不能用"轨迹里有轮次" —— 会话**正在跑**的时候，流式帧会先到、
   * 内存里先长出 1 轮，于是 hydrate 一看到"有轮次"就早退，历史**永远折不进来**。
   * 触发条件恰好是最正常的场景（面板打开一个正在跑的会话），真机踩过：
   * 日志里 103 轮 / 1747 步的会话，面板里只剩 1 轮 4 步。
   */
  const hydrated = new Set<string>()

  /**
   * 正在折历史的会话 → 这期间到达的实时事件**先排队**，折完再补放。
   *
   * 折叠的最后一步是 `trace.turns.length = 0` 再逐条重放 —— 排队期间直接应用的事件
   * 会被这一下抹掉（表现为"最新那一步要等下一个事件才回来"）。
   * 补放是安全的：`assistant/message` 是**覆盖**、`tool/call` 按 id 去重、
   * 流式 chunk 有稠密序号守卫 —— 即使日志里已经出现过一遍也不会重复。
   */
  const hydrating = new Map<string, Array<() => void>>()

  /** 折历史期间先排队，折完补放；平时直接跑。 */
  function whenNotHydrating(sessionId: string, run: () => void): void {
    const queued = hydrating.get(sessionId)
    if (queued !== undefined) queued.push(run)
    else run()
  }

  async function hydrate(sessionId: string): Promise<SessionState> {
    const existing = sessions.get(sessionId)
    // 折过就早退（**不是**"有轮次就早退" —— 见 hydrated 的说明）
    if (hydrated.has(sessionId)) return existing?.state ?? 'live'
    const persistence = persistenceOf()
    if (persistence?.open === undefined) return existing?.state ?? 'live'

    // 从这里开始，这个会话的实时事件先排队（见 hydrating 的说明）。
    // ⚠️ 开排队 / 收排队必须在**同一个 try/finally** 里 —— 早先我把收排队挂在第二个 try 上，
    // 结果 `open` 抛错走第一个 catch 时排队表永远不清，那个会话的实时事件就**再也不补放**了
    // （表现：日志锁着时收到实时事件，面板却一直空着）。测试当场抓到。
    hydrating.set(sessionId, [])
    let handle: Awaited<ReturnType<NonNullable<typeof persistence.open>>> | undefined
    try {
      try {
        handle = await persistence.open(sessionId, 'read')
      } catch {
        // 会话不存在 / 正被别的进程独占：如实记成"读不到"，而不是假装它还没开始
        const e = entryOf(sessionId, Date.now())
        if (e.trace.turns.length === 0) e.state = 'unreadable'
        return 'unreadable'
      }
      const { events } = await handle.read()
      if (!Array.isArray(events) || events.length === 0) {
        const e0 = entryOf(sessionId, Date.now())
        if (e0.trace.turns.length === 0) e0.state = 'empty'
        hydrated.add(sessionId)          // 确认没历史，也别再读一遍
        return 'empty'
      }
      const slice = capHydrateEvents(events)
      const e = entryOf(sessionId, Date.now())
      e.trace.turns.length = 0
      for (const ev of slice) applySessionEvent(e.trace, ev as never, Date.now())
      e.trace.updatedAt = Date.now()
      e.state = e.trace.turns.length > 0 ? 'hydrated' : 'empty'
      hydrated.add(sessionId)
      prune(e)
      return e.state
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] 历史回看失败：${String(error)}`)
      return 'unreadable'
    } finally {
      // 无论成功、失败还是 open 抛错，都要收排队并补放 —— 否则这些实时事件白丢
      try { await handle?.close() } catch { /* 已经关了 */ }
      const queued = hydrating.get(sessionId) ?? []
      hydrating.delete(sessionId)
      for (const run of queued) run()
    }
  }

  // ───────────────────────── 中文标题（按需生成 + 落盘缓存） ─────────────────────────

  /**
   * 标题缓存文件。
   *
   * 放插件自己的目录，不碰会话：标题是**派生物**，丢了随时能重算，
   * 而会话是重型对象。key = `sessionId:turn`，value 带内容指纹用于失效。
   */
  // 可覆盖：测试要指到临时目录，不能污染用户的 ~/.dsh
  const titleCachePath = config.titleCachePath !== ''
    ? config.titleCachePath
    : join(homedir(), '.dsh', 'think-flow', 'titles.json')
  /** 内存镜像：避免每次请求都读盘。 */
  let titleCache: TitleCache | undefined
  let titleCacheDirty = false

  async function loadTitleCache(): Promise<TitleCache> {
    if (titleCache !== undefined) return titleCache
    let parsed: TitleCache = {}
    try {
      const raw = await readFile(titleCachePath, 'utf8')
      const data: unknown = JSON.parse(raw)
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) parsed = data as TitleCache
    } catch {
      parsed = {}                    // 文件不存在或坏了：从空缓存开始，不影响插件
    }
    titleCache = parsed
    return parsed
  }

  /**
   * 修剪标题缓存：按生成时间保留最近的 N 条。
   *
   * 不做这件事的话 titles.json 只增不减（每个会话每一轮一条），长期使用会一直涨。
   * @param cache - 缓存对象（原地修改）。
   */
  function pruneTitleCache(cache: TitleCache): void {
    const cap = config.maxTitledTurns
    if (cap <= 0) return
    const keys = Object.keys(cache)
    if (keys.length <= cap) return
    // 旧的先走
    keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0))
    for (const k of keys.slice(0, keys.length - cap)) delete cache[k]
  }

  async function saveTitleCache(): Promise<void> {
    if (!titleCacheDirty || titleCache === undefined) return
    pruneTitleCache(titleCache)
    titleCacheDirty = false
    try {
      await mkdir(dirname(titleCachePath), { recursive: true })
      await writeFile(titleCachePath, JSON.stringify(titleCache, null, 1), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] 标题缓存写入失败：${String(error)}`)
    }
  }

  /** 解析模型路由：优先用设置里的默认模型，退回任意可用 provider。 */
  function resolveRoute(): { provider: string; model: string } | undefined {
    const service = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined
    const selection = service?.currentSelection?.()
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
    const llm = ctx.get('llm') as { listProviders?: () => Array<{ id?: string; models?: Array<{ id?: string }> }> } | undefined
    const first = llm?.listProviders?.()?.find((item) => (item.models?.length ?? 0) > 0)
    if (first?.id && first.models?.[0]?.id) return { provider: first.id, model: first.models[0].id }
    return undefined
  }

  /** 把一个 turn 的步骤整理成标题输入。 */
  function titleInputsOf(turn: TurnFact): TitleInputStep[] {
    return turn.steps
      .filter((s) => s.reasoning.length > 0)
      .map((s) => ({ step: s.step, reasoning: s.reasoning, tools: s.tools.map((t) => t.name) }))
  }

  /**
   * 一个 turn 里所有**带英文说明的命令**。
   *
   * 注意它和 `titleInputsOf` 的口径不同：说明要翻成中文贴到**派生标题**后面，
   * 而派生标题是给**没有思考的步**用的 —— 所以这里不能按"有思考"过滤，
   * 否则恰恰漏掉了最需要它的那些步（0 字的纯工具步）。
   */
  function toolNotesOf(turn: TurnFact): TitleInputNote[] {
    const out: TitleInputNote[] = []
    for (const s of turn.steps) {
      for (const t of s.tools) {
        if (!COMMAND_TOOLS.has(t.name)) continue
        if (t.note !== undefined && t.note !== '') out.push({ id: t.id, text: t.note })
      }
    }
    return out
  }

  /**
   * 一步的"内容指纹"：够便宜，又能判出内容变没变。
   *
   * 用长度 + 开头一小段就够：思考只会**追加**，长度变了基本就是变了；
   * 开头一段兜住"同长度但内容不同"的极端情况。整段做哈希太贵
   * （一步上万字，而这个检查每 5 秒会跑一次）。
   * @param s - 该步。
   * @returns 指纹串。
   */
  function stepPrint(s: StepFact): string {
    return s.reasoning.length + ':' + s.reasoning.slice(0, 24)
  }

  /**
   * **本轮最后的 AI 输出** —— 整轮标题的素材（用户定的）。
   *
   * 从最后一步往前找第一条非空的正文：末尾的步常常只有工具调用、没有正文，
   * 直接取最后一步会拿到空串。
   */
  function turnOutputOf(turn: TurnFact): string {
    for (let i = turn.steps.length - 1; i >= 0; i -= 1) {
      const text = turn.steps[i]?.text ?? ''
      if (text.trim() !== '') return text
    }
    return ''
  }

  /** 整轮标题的指纹（素材 = 本轮最后的输出）。没输出就是空串 —— 那就没什么可总结的。 */
  function turnPrint(turn: TurnFact): string {
    const out = turnOutputOf(turn)
    return out === '' ? '' : out.length + ':' + out.slice(0, 24)
  }

  /**
   * 该轮里"还没标题 / 还没翻译"的部分。
   *
   * @param turn - 该轮。
   * @param entry - 该轮的缓存条目（可能没有）。
   * @returns 待生成的步骤与说明。
   */
  function pendingOf(turn: TurnFact, entry: TitleCacheEntry | undefined, opts?: { turnTitleAnyway?: boolean }): {
    steps: TitleInputStep[]
    notes: TitleInputNote[]
    /** 要写整轮标题时给素材；不写就给空串（提示词据此决定要不要那个字段）。 */
    turnOutput: string
  } {
    const steps: TitleInputStep[] = []
    const notes: TitleInputNote[] = []
    for (const s of turn.steps) {
      if (s.reasoning.length === 0) continue
      const hit = entry?.steps?.[String(s.step)]
      if (hit !== undefined && hit.print === stepPrint(s)) continue
      steps.push({ step: s.step, reasoning: s.reasoning, tools: s.tools.map((t) => t.name) })
    }
    // 说明要翻成中文贴在**派生标题**后面，而派生标题是给"没有思考的步"用的 ——
    // 所以这里不能按"有思考"过滤，否则恰恰漏掉最需要它的那些步（0 字的纯工具步）。
    for (const s of turn.steps) {
      for (const t of s.tools) {
        if (!COMMAND_TOOLS.has(t.name)) continue
        if (t.note === undefined || t.note === '') continue
        const hit = entry?.notes?.[t.id]
        if (hit !== undefined && hit.print === t.note) continue
        notes.push({ id: t.id, text: t.note })
      }
    }
    // 整轮标题：**轮结束之后**才要（跑的过程中输出还在变），且缓存里的指纹要对得上。
    // 素材非空才算"要" —— 纯工具轮没有正文，没什么可总结的。
    const output = turnOutputOf(turn)
    // 自动那条路要求**轮已结束**（跑的过程中输出还在变，生成出来就要重算）；
    // 手动点「生成标题」时用户就是要现在拿到（`turnTitleAnyway`），那就按当前输出先写一版。
    const endedOk = turn.endedAt !== undefined || opts?.turnTitleAnyway === true
    const wantTurnTitle = endedOk && output !== ''
      && (entry?.title === undefined || entry.title.print !== turnPrint(turn))
    return { steps, notes, turnOutput: wantTurnTitle ? output : '' }
  }

  /**
   * 给**一批**步骤 / 说明起标题（一次模型调用）。
   *
   * @param sessionId - 会话 id（模型调用要带）。
   * @param pending - 待生成的步骤与说明。
   * @returns 这一次生成的 titles（步号 → 标题）、notes（工具 id → 中文）与所用模型。
   */
  async function generateBatch(
    sessionId: string,
    pending: { steps: TitleInputStep[]; notes: TitleInputNote[]; turnOutput?: string },
  ): Promise<{ titles: Record<string, string>; notes: Record<string, string>; turnTitle?: string; model: string; error?: string }> {
    const { steps: inputs, notes: notesIn } = pending
    const turnOutput = pending.turnOutput ?? ''
    const empty: { titles: Record<string, string>; notes: Record<string, string>; turnTitle?: string; model: string } =
      { titles: {}, notes: {}, model: '' }
    // 注意：只要还有"整轮标题"要写，就不算没事干
    if (inputs.length === 0 && notesIn.length === 0 && turnOutput === '') return empty
    const route = resolveRoute()
    if (route === undefined) return { ...empty, error: '找不到可用的模型路由' }
    const model = `${route.provider}/${route.model}`

    const budget: TitleBudget = { perStepChars: config.titleStepChars, totalChars: config.titleTotalChars }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    let raw = ''
    try {
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        sessionId: sessionId as never,
        system: undefined,
        messages: [
          // ⚠️ 只接一个参数（`createSystemMessage(text)`）。这里原先多传了一个 `name`，
          // 类型检查一直在报 TS2554，但 build.sh 没检查退出码 —— 于是"构建完成"照打。
          createSystemMessage(TITLE_SYSTEM),
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: buildTitleUser(inputs, budget, notesIn, turnOutput) }] }),
        ],
        ...(config.titleReasoningEffort ? { reasoningEffort: ReasoningEffortId(config.titleReasoningEffort) } : {}),
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') raw += chunk.text
      }
    } catch (error) {
      return { ...empty, model, error: `生成失败：${String((error as Error)?.message ?? error)}` }
    } finally {
      clearTimeout(timer)
    }

    // 没有思考的轮次（只有说明要翻）不检查 titles 条数
    const parsed = inputs.length === 0
      ? { titles: [] as string[], notes: parseTitles(raw, 0)?.notes ?? {}, turnTitle: parseTitles(raw, 0)?.turnTitle ?? '' }
      : parseTitles(raw, inputs.length)
    if (parsed === undefined) {
      // 条数对不上就宁可报错：错位的标题比没有标题更糟（这正是当初否掉本地规则的理由）
      return { ...empty, model, error: '模型返回的标题条数与步骤数不一致，未采用' }
    }

    const titles: Record<string, string> = {}
    inputs.forEach((s, i) => { titles[String(s.step)] = parsed.titles[i] })
    // 只保留**确实要过**的 id：模型偶尔会自己编几个 key 出来
    const wanted = new Set(notesIn.map((n) => n.id))
    const notes: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed.notes)) if (wanted.has(k)) notes[k] = v
    /**
     * 整轮标题：`undefined` = 这次**没要**（别动缓存里已有的）；空串 = **要了但模型没给**。
     *
     * ⚠️ 这个区分是必须的：如果"要了但没给"也当成"没要"，缓存里就永远没有这一版的记录，
     * `pendingOf` 每次都判"还缺整轮标题" → 节拍器**无限重复调模型**（测试抓到过）。
     */
    const turnTitle = turnOutput === '' ? undefined : parsed.turnTitle
    return { titles, notes, ...(turnTitle !== undefined ? { turnTitle } : {}), model }
  }

  /** 把一次生成的结果合并进缓存并落盘。 */
  async function mergeIntoCache(
    sessionId: string,
    turn: TurnFact,
    got: { titles: Record<string, string>; notes: Record<string, string>; turnTitle?: string },
    model: string,
  ): Promise<void> {
    const key = `${sessionId}:${turn.turn}`
    const cache = await loadTitleCache()
    const old = cache[key]
    // v1 的旧条目（数组式）直接丢掉重写
    const entry: TitleCacheEntry = old !== undefined && old.steps !== undefined
      ? old
      : { at: Date.now() }
    const steps = { ...(entry.steps ?? {}) }
    for (const s of turn.steps) {
      const t = got.titles[String(s.step)]
      if (t !== undefined) steps[String(s.step)] = { title: t, print: stepPrint(s) }
    }
    const notes = { ...(entry.notes ?? {}) }
    for (const s of turn.steps) {
      for (const t of s.tools) {
        const n = got.notes[t.id]
        if (n !== undefined && t.note !== undefined) notes[t.id] = { note: n, print: t.note }
      }
    }
    // 整轮标题：拿到了就更新（指纹用**当前**素材算，别用生成时刻的，否则下次一定判过期）
    // 要过就记一笔（**空串也记**）：表示"这一版素材已经试过了"，
    // 否则 pendingOf 会一直判"还缺整轮标题"，节拍器无限重复调模型。
    const title = got.turnTitle !== undefined
      ? { text: got.turnTitle, print: turnPrint(turn) }
      : entry.title
    cache[key] = {
      at: Date.now(), steps, notes,
      ...(title !== undefined ? { title } : {}),
      ...(model !== '' ? { model } : {}),
    }
    titleCacheDirty = true
    await saveTitleCache()
  }

  /**
   * 生成一个 turn 的标题与说明翻译（**按需**，用户点按钮时走这里）。
   *
   * 只补"还没有 / 已经变了"的部分（`force` 才全部重来）—— 自动标题那条路
   * 已经把大部分步起好了，手动点一下不该把已有的重算一遍。
   *
   * @param sessionId - 会话 id。
   * @param turn - 该轮。
   * @param force - 忽略缓存、整轮重生成。
   * @returns 该轮**全部**可用的 titles（步号 → 标题）与 notes（工具 id → 中文）。
   */
  async function generateTitles(
    sessionId: string,
    turn: TurnFact,
    force = false,
    /** 手动点按钮时为 true：整轮标题不等轮结束，按当前输出先写一版。 */
    turnTitleAnyway = false,
  ): Promise<{ titles: Record<string, string>; notes: Record<string, string>; turnTitle?: string; cached: boolean; error?: string }> {
    const cache = await loadTitleCache()
    const entry = cache[`${sessionId}:${turn.turn}`]

    // 先把缓存里**还有效**的收起来（force 时不要）
    const titles: Record<string, string> = {}
    const notes: Record<string, string> = {}
    let cachedTurnTitle: string | undefined
    if (!force && entry !== undefined) {
      for (const s of turn.steps) {
        const hit = entry.steps?.[String(s.step)]
        if (hit !== undefined && hit.print === stepPrint(s)) titles[String(s.step)] = hit.title
      }
      for (const s of turn.steps) {
        for (const t of s.tools) {
          const hit = entry.notes?.[t.id]
          if (hit !== undefined && t.note !== undefined && hit.print === t.note) notes[t.id] = hit.note
        }
      }
      // 整轮标题：指纹对得上（= 本轮最后的输出没变过）才算还有效
      if (entry.title !== undefined && entry.title.print === turnPrint(turn)) cachedTurnTitle = entry.title.text
    }

    const pending = force
      ? { steps: titleInputsOf(turn), notes: toolNotesOf(turn), turnOutput: turnOutputOf(turn) }
      : pendingOf(turn, entry, { turnTitleAnyway })
    const nothingToDo = pending.steps.length === 0 && pending.notes.length === 0 && pending.turnOutput === ''
    if (nothingToDo) {
      if (Object.keys(titles).length === 0 && Object.keys(notes).length === 0 && cachedTurnTitle === undefined) {
        return { titles: {}, notes: {}, cached: false, error: '这个 turn 还没有思考内容' }
      }
      return { titles, notes, ...(cachedTurnTitle !== undefined ? { turnTitle: cachedTurnTitle } : {}), cached: true }
    }

    const got = await generateBatch(sessionId, pending)
    if (got.error !== undefined) return { titles, notes, cached: false, error: got.error }
    await mergeIntoCache(sessionId, turn, got, got.model)
    const turnTitle = got.turnTitle !== undefined && got.turnTitle !== '' ? got.turnTitle : cachedTurnTitle
    return {
      titles: { ...titles, ...got.titles },
      notes: { ...notes, ...got.notes },
      ...(turnTitle !== undefined ? { turnTitle } : {}),
      cached: false,
    }
  }

  // ───────────────────────── 自动标题（默认关） ─────────────────────────

  /**
   * 开了自动标题的会话。**默认关** —— 标题要花模型调用，不该默认替用户花。
   * 由面板上的开关按钮控制（`POST /auto?session&on=`），状态随快照回给面板。
   */
  const autoTitles = new Set<string>()
  /** 有新的步结束、等着刷标题的会话。 */
  const autoDirty = new Set<string>()
  /** 上次刷的时间（限速用）。 */
  const autoLastFlush = new Map<string, number>()
  /** 此刻正在生成的那几个会话 —— 面板上「实时」那枚要脉冲，用户才知道它在干活。 */
  const autoBusy = new Set<string>()

  /** 攒够几步就刷 —— 一步一次调用的话**系统提示词每步都要重发**（实测输入约 2×）。 */
  const AUTO_MIN_STEPS = 3
  /** 或者距上次刷够久也刷 —— 观感上仍然是"边看边出标题"，不会干等。 */
  const AUTO_MIN_GAP_MS = 15_000
  /** 节拍器间隔（自动路径的延迟上限 ≈ AUTO_MIN_GAP_MS + 这个值）。 */
  const AUTO_TICK_MS = config.autoTickMs

  /** 告诉面板"这一批开始/结束生成"（只影响那枚胶囊的脉冲）。 */
  function pushAutoBusy(sessionId: string, busy: boolean): void {
    const e = sessions.get(sessionId)
    if (e === undefined) return
    for (const sub of e.subs) send(sub, { t: 'autoBusy', busy })
  }

  /** 把新生成的标题/说明推给正在看这个会话的面板。 */
  function pushTitles(
    sessionId: string,
    turn: number,
    titles: Record<string, string>,
    notes: Record<string, string>,
    turnTitle?: string,
  ): void {
    const e = sessions.get(sessionId)
    if (e === undefined) return
    // 什么都没变就别推：模型"要了但没给出整轮标题"时会产生一次空结果，
    // 白推一条 SSE 只会让面板空转一次重渲染。
    const nothing = Object.keys(titles).length === 0 && Object.keys(notes).length === 0
      && (turnTitle === undefined || turnTitle === '')
    if (nothing) return
    for (const sub of e.subs) send(sub, { t: 'titles', turn, titles, notes, ...(turnTitle !== undefined ? { turnTitle } : {}) })
  }

  /**
   * 自动标题的节拍器：把"已结束但还没标题的步 / 还没翻译的说明 / 整轮标题"攒一批生成。
   * 整轮标题只在**轮结束之后**才会出现在 pending 里（见 pendingOf）。
   *
   * 三条闸门，缺一不可：
   *   ① 用户在这个会话上开了开关（默认关）
   *   ② **有人正开着这个会话的面板**（`e.subs.size > 0`）—— 插件同时跟踪最多 32 个
   *      会话，每个都自动生成会失控；没人看就不该花 token
   *   ③ 攒够 AUTO_MIN_STEPS 步，或距上次刷够 AUTO_MIN_GAP_MS
   *
   * 失败**不打扰用户**（自动路径静默等下一拍）—— 手动点按钮那条路才报错。
   */
  async function flushAuto(): Promise<void> {
    if (autoDirty.size === 0) return
    for (const sessionId of [...autoDirty]) {
      const e = sessions.get(sessionId)
      if (e === undefined) { autoDirty.delete(sessionId); continue }
      if (e.subs.size === 0) continue
      const turn = lastTurn(e.trace)
      if (turn === undefined) { autoDirty.delete(sessionId); continue }
      const cache = await loadTitleCache()
      const pending = pendingOf(turn, cache[`${sessionId}:${turn.turn}`])
      // ⚠️ 整轮标题也算一件活：轮结束时步标题往往早就生成完了（total = 0），
      // 不把它算进来的话这里会直接"没事干"退出，整轮标题永远不生成。
      const total = pending.steps.length + pending.notes.length + (pending.turnOutput === '' ? 0 : 1)
      if (total === 0) { autoDirty.delete(sessionId); continue }
      /**
       * 整轮标题按"一整批"的分量算：它是**一轮一次**的东西，而且轮结束时用户就在等它，
       * 不该被"攒够 3 步 / 距上次刷 15 秒"的批量限速拖住（那样要等最多 15 秒才出标题）。
       * 步标题照旧受限速管 —— 那个是持续产生、攒批更划算的。
       */
      const weight = total + (pending.turnOutput === '' ? 0 : AUTO_MIN_STEPS - 1)
      const since = Date.now() - (autoLastFlush.get(sessionId) ?? 0)
      if (weight < AUTO_MIN_STEPS && since < AUTO_MIN_GAP_MS) continue
      autoLastFlush.set(sessionId, Date.now())
      autoBusy.add(sessionId)
      pushAutoBusy(sessionId, true)
      let got: Awaited<ReturnType<typeof generateBatch>>
      try {
        got = await generateBatch(sessionId, pending)
      } finally {
        // 无论成功失败都要把脉冲收掉，否则胶囊会一直闪（看起来像卡住了）
        autoBusy.delete(sessionId)
        pushAutoBusy(sessionId, false)
      }
      if (got.error !== undefined) continue
      await mergeIntoCache(sessionId, turn, got, got.model)
      pushTitles(sessionId, turn.turn, got.titles, got.notes, got.turnTitle)
    }
  }

  const autoTimer = setInterval(() => { void flushAuto() }, AUTO_TICK_MS)
  ctx.effect(() => () => { clearInterval(autoTimer) }, `${name}: auto title timer`)

  /**
   * 冷轮正文的**到点收回**节拍器。
   *
   * 为什么需要它（而不是只靠 `prune`）：`prune` 挂在事件广播上，**没人开面板、
   * 会话也没在跑**的时候它根本不跑 —— 那样"两小时后自动收回"就成了空话，
   * 正文会一直躺着直到你下次碰它。所以这里按时间自己扫。
   *
   * 间隔取 `coldTtlMs / 10`（封顶 5 分钟）：2 小时 → 每 5 分钟扫一次，
   * 收回最多晚 5 分钟，够准；扫的是每个会话一张小表，代价可以忽略。
   * `coldTtlMs = 0`（不按时间收）时**不挂定时器** —— 别为关掉的功能留个常驻计时器。
   *
   * ── 休眠 / 挂起时会怎样（实测过，别凭直觉猜）──
   * ① **休眠的时间算数**：TTL 比较用的是 `Date.now()`（墙钟），休眠期间照样走。
   * ② **醒来后立刻跳，而且不会爆发**：libuv 的定时器时钟在 macOS 上用的是
   *    `mach_continuous_time`（**包含休眠**），所以挂起的进程一恢复，
   *    已经过期的定时器**当场**触发。实测：冻 9 秒（本该错过 4 跳）→
   *    恢复那一瞬间只跳 **1** 次，错过的跳数合并掉了，之后按正常节奏继续。
   * ③ 所以"睡了一夜"的结果是：醒来后第一次扫描就把超过 2 小时的空闲全部收掉 ——
   *    最多晚一个间隔（5 分钟）。
   *
   * 进程**根本不在**时（DSH 停了 / 插件热重载）：冷缓存是内存里的 Map，
   * 随进程或 fiber 一起没了 —— 没有东西需要"收回"，这条策略无事可做。
   */
  const COLD_SWEEP_MS = config.coldTtlMs > 0
    ? Math.max(1000, Math.min(Math.floor(config.coldTtlMs / 10), 5 * 60_000))
    : 0
  if (COLD_SWEEP_MS > 0) {
    const coldTimer = setInterval(() => { sweepAllCold(Date.now()) }, COLD_SWEEP_MS)
    ctx.effect(() => () => { clearInterval(coldTimer) }, `${name}: cold turn sweep timer`)
  }

  // ───────────────────────── 快照 ─────────────────────────

  /**
   * 生成快照。
   *
   * 刻意**只给"当前步"附原文**：一个 turn 实测能有 7 万字思考，53 步全带原文的
   * 快照每次连接要传几 MB，而前端真正需要实时滚动观看的只有最后一步。
   * 其余步骤只给字数与状态，用户展开时再走 `/step` 按需取。
   */
  /**
   * 一轮的**快照形状**。
   *
   * 抽出来是因为现在有两条路要用它：整份快照（`snapshot`，最近 N 轮）和
   * 按需取一轮（`/turn`，更早的轮次）。各写一遍的话"客户端字段"就有两个真相。
   */
  function turnSnapshot(sessionId: string, turn: TurnFact, latest: TurnFact | undefined, now: number) {
    const cache = titleCache
      const interrupted = turn.interrupted === true
      // 已缓存的标题随快照下发：刷新页面不必重新生成（缓存里没有就是 undefined）。
      //
      // ⚠️ 下发的是**按步骤号索引的对象**，不是数组。早先下发数组、客户端按下标读，
      // 而数组是按"有思考的步骤"过滤后的顺序 —— 只要中间有步骤没思考就整体错位
      // （真机表现：#11 显示成了本该属于 #20 的标题）。用对象键从根上消除这种对齐问题。
      const cachedTitles = cache === undefined ? undefined : cache[`${sessionId}:${turn.turn}`]
      // 缓存是**按步存**的，所以逐条判"这一步的内容还是不是当初那份"（指纹对得上才下发）——
      // 增量生成意味着同一轮里有的步有标题、有的还没轮到。
      const titlesByStep: Record<string, string> = {}
      const notesByTool: Record<string, string> = {}
      // 整轮标题同样要指纹对得上才下发（本轮最后的输出变了，旧标题就不作数了）
      const cachedTurnTitle = cachedTitles?.title !== undefined && cachedTitles.title.print === turnPrint(turn)
        ? cachedTitles.title.text
        : undefined
      if (cachedTitles !== undefined) {
        for (const step of turn.steps) {
          const hit = cachedTitles.steps?.[String(step.step)]
          if (hit !== undefined && hit.print === stepPrint(step)) titlesByStep[String(step.step)] = hit.title
        }
        for (const step of turn.steps) {
          for (const tool of step.tools) {
            const hit = cachedTitles.notes?.[tool.id]
            if (hit !== undefined && tool.note !== undefined && hit.print === tool.note) notesByTool[tool.id] = hit.note
          }
        }
      }
      return {
        turn: turn.turn,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        endReason: turn.endReason,
        interrupted,
        titles: Object.keys(titlesByStep).length > 0 ? titlesByStep : undefined,
        // **整轮标题**（一句话说清这一轮）—— 轮头第一行用它
        turnTitle: cachedTurnTitle,
        // 默认素材：本轮用户说了什么。还没总结（或这一轮还在跑）时，轮头第一行直接显示它。
        userText: turn.userText,
        // 工具说明的中文翻译：**按工具 id** 下发（一步可能有多个命令，各有各的说明）
        notes: Object.keys(notesByTool).length > 0 ? notesByTool : undefined,
        titlesFrom: cachedTitles?.model,
        titlesAt: cachedTitles?.at,
        steps: turn.steps.map((step) => {
          const isLatest = latest !== undefined && turn.turn === latest.turn && step.step === lastStepNo(latest)
          const full = isLatest ? tail(step.reasoning, config.snapshotTailChars) : undefined
          return {
            step: step.step,
            status: stepStatus(step, turn),
            attempts: step.attempts,
            reasoningChars: step.reasoning.length,
            textChars: step.text.length,
            startedAt: step.startedAt,
            elapsedMs: stepElapsed(step, now),
            streamEndedAt: step.streamEndedAt,
            endedAt: step.endedAt,
            streamGap: step.streamGap === true,
            chunkCount: step.chunkCount,
            // 当前步给尾部原文（前端在此基础上继续追加增量）
            reasoningTail: full,
            textTail: isLatest ? tail(step.text, 2000) : undefined,
            /**
             * 这一步**正文的开头**（~160 字）。
             *
             * 用途：**无工具步的行标题**（`stepOwnTitle` → `excerptOf`）取的是正文**首句**，
             * 而 `textTail` 是**尾部** —— 正文一超过 2000 字，开头就没了。
             * 客户端拿这段自己算摘要（宿主只给事实，标题是客户端的本地规则，和派生标题同一路）。
             */
            textHead: step.text === '' ? undefined : step.text.slice(0, 160),
            tools: step.tools.map((tool) => ({
              id: tool.id,
              name: tool.name,
              argsRaw: tool.argsRaw,
              // ⚠️ 这里**刻意不下发** `note`（命令自带的英文说明）：
              // 客户端一个地方都不读它，纯占体积（实测 20 轮快照里 11.7KB / 5.2%）。
              // 翻译用的说明走 `turn.notes`（工具 id → 中文），那条才是客户端要的。
              startedAt: tool.startedAt,
              endedAt: tool.endedAt,
              resultChars: tool.resultChars,
              // 失败态：只在真失败时下发（成功不带这个字段 —— 见 ToolFact.failed）。
              // 摘要已截到 200 字，一个失败的工具最多多占几百字节。
              ...(tool.failed !== undefined ? { failed: tool.failed } : {}),
            })),
            waitingMs: (() => {
              const rt = runningTool(step)
              return rt === undefined ? undefined : Math.max(0, now - rt.startedAt)
            })(),
          }
        }),
      }
  }

  function snapshot(sessionId: string) {
    const e = sessions.get(sessionId)
    const now = Date.now()
    if (e === undefined) return { sessionId, turns: [], serverTime: now, known: false, state: 'unreadable' as SessionState, auto: autoTitles.has(sessionId), autoBusy: false }
    const t = e.trace
    const cache = titleCache
    const latest = lastTurn(t)
    const turns = t.turns.map((turn) => turnSnapshot(sessionId, turn, latest, now))
    return {
      sessionId, turns, serverTime: now,
      /**
       * **全轮骨架**（最新在前）：目录"看更早的轮次"直接读它。
       *
       * 它比 `turns` 长得多 —— `turns` 是**正文窗口**（默认 20 轮，客户端渲染得动），
       * `index` 是所有活过的轮（默认上限 2000）。两者分开是这次改动的核心：
       * 早先它们共用一个上限，于是 133 轮的会话只能看到 20 轮。
       */
      index: [...e.index.values()].sort((a, b) => b.turn - a.turn),
      // 自动标题的开关状态（默认 false）—— 面板据此恢复按钮状态
      auto: autoTitles.has(sessionId),
      /** 此刻正在生成（面板上那枚胶囊脉冲用）。 */
      autoBusy: autoBusy.has(sessionId),
      known: turns.length > 0,
      state: e.state,
    }
  }

  function lastStepNo(turn: { steps: { step: number }[] }): number {
    return turn.steps.length ? turn.steps[turn.steps.length - 1].step : -1
  }

  function tail(s: string, n: number): string {
    return s.length <= n ? s : s.slice(s.length - n)
  }

  // ───────────────────────── 路由 ─────────────────────────

  function query(req: IncomingMessage, key: string): string | undefined {
    const url = req.url ?? ''
    const q = url.indexOf('?')
    if (q < 0) return undefined
    const params = new URLSearchParams(url.slice(q + 1))
    return params.get(key) ?? undefined
  }

  function json(res: ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  const handleStream = (req: IncomingMessage, res: ServerResponse): void => {
    const sessionId = query(req, 'session')
    if (sessionId === undefined) { json(res, 400, { ok: false, error: 'missing session' }); return }
    // 打开面板时先补历史（旧会话内存里是空的），再接实时增量
    void hydrate(sessionId)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // 关掉 Nginx 之类的缓冲，否则流式会被攒成一批
      'x-accel-buffering': 'no',
    })

    const e = entryOf(sessionId, Date.now())
    let closed = false
    /** 心跳定时器。`sub.end()` 里要能清掉它，所以放在外面。 */
    let beat: ReturnType<typeof setInterval> | undefined
    const sub: Subscriber = {
      sessionId,
      pending: [],
      timer: undefined,
      write(chunk) { if (!closed) res.write(chunk) },
      end() {
        if (closed) return
        closed = true
        if (sub.timer !== undefined) clearTimeout(sub.timer)
        // 心跳必须在这里收，不能指望 `res.end()` 之后一定收到 req 的 'close'
        // —— 淘汰（LRU）和插件卸载两条路径都是直接调 `end()` 的。
        if (beat !== undefined) clearInterval(beat)
        try { res.end() } catch { /* 已断 */ }
      },
    }
    e.subs.add(sub)

    // 先给一份快照，前端据此建结构；之后只收增量。
    // 放在 hydrate 之后发：旧会话要先把历史折进来，否则前端收到的是空快照。
    void hydrate(sessionId).then(() => {
      send(sub, { t: 'snapshot', snapshot: snapshot(sessionId) })
    })

    beat = setInterval(() => {
      if (closed) return
      send(sub, { t: 'ping', serverTime: Date.now() })
    }, config.heartbeatMs)

    const cleanup = (): void => {
      e.subs.delete(sub)
      sub.end()
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('error', cleanup)
  }

  const handleTrace = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = query(req, 'session')
    if (sessionId === undefined) { json(res, 400, { ok: false, error: 'missing session' }); return }
    // 历史会话：内存里没有就直接从落盘折一遍
    await hydrate(sessionId)
    json(res, 200, snapshot(sessionId))
  }

  /** 按需取某一步的完整思考原文（快照里只带了当前步）。 */
  const handleStep = (req: IncomingMessage, res: ServerResponse): void => {
    const sessionId = query(req, 'session')
    const turnNo = Number(query(req, 'turn'))
    const stepNo = Number(query(req, 'step'))
    if (sessionId === undefined || !Number.isFinite(turnNo) || !Number.isFinite(stepNo)) {
      json(res, 400, { ok: false, error: 'need session, turn, step' }); return
    }
    const e = sessions.get(sessionId)
    const turn = e?.trace.turns.find((t) => t.turn === turnNo)
    const step = turn?.steps.find((s) => s.step === stepNo)
    if (step === undefined) { json(res, 404, { ok: false, error: 'not found' }); return }
    json(res, 200, {
      sessionId, turn: turnNo, step: stepNo,
      reasoning: step.reasoning,
      text: step.text,
      streamGap: step.streamGap === true,
    })
  }

  /**
   * 按需取**某一轮的正文**（目录里点"更早的轮次"走这里）。
   *
   * 用 GET：纯读，不改状态，可以缓存。
   * 返回的形状和快照里的 `turns[]` **同一个**（共用 `turnSnapshot`），
   * 客户端把它塞进本地 turns 里就能直接渲染。
   */
  const handleTurn = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = query(req, 'session')
    const turnNo = Number(query(req, 'turn'))
    if (sessionId === undefined || !Number.isFinite(turnNo)) {
      json(res, 400, { ok: false, error: 'need session and turn' }); return
    }
    await hydrate(sessionId)
    const e = sessions.get(sessionId)
    if (e === undefined) { json(res, 404, { ok: false, error: 'session not found' }); return }
    const turn = await materializeTurn(e, sessionId, turnNo)
    if (turn === undefined) { json(res, 404, { ok: false, error: 'turn not found' }); return }
    json(res, 200, {
      ok: true, sessionId, turn: turnSnapshot(sessionId, turn, lastTurn(e.trace), Date.now()),
    })
  }

  const handleSessions = (_req: IncomingMessage, res: ServerResponse): void => {
    json(res, 200, {
      ok: true,
      sessions: [...sessions.values()].map((e) => ({
        sessionId: e.trace.sessionId,
        turns: e.trace.turns.length,
        steps: e.trace.turns.reduce((a, t) => a + t.steps.length, 0),
        subscribers: e.subs.size,
        updatedAt: e.trace.updatedAt,
      })),
    })
  }

  /**
   * 生成（或命中缓存）某一轮的中文标题。
   *
   * 用 POST：这是一次**会产生模型调用**的动作，不该被浏览器/代理当成可缓存的 GET。
   */
  const handleTitles = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = query(req, 'session')
    const turnNo = Number(query(req, 'turn'))
    if (sessionId === undefined || !Number.isFinite(turnNo)) {
      json(res, 400, { ok: false, error: 'need session and turn' }); return
    }
    await hydrate(sessionId)
    const e = sessions.get(sessionId)
    const turn = e?.trace.turns.find((t) => t.turn === turnNo)
    if (turn === undefined) { json(res, 404, { ok: false, error: 'turn not found' }); return }
    try {
      // force=1 → 整轮重生成（面板上按钮显示"重新生成"时带这个）
      // 手动点的这条路：**整轮标题也一起生成**（用户明确要求），不等轮结束
      const out = await generateTitles(sessionId, turn, query(req, 'force') === '1', true)
      json(res, 200, { ok: out.error === undefined, ...out, turn: turnNo })
    } catch (error) {
      json(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    }
  }

  /** 开关自动标题（默认关）。状态记在宿主侧，随快照回给面板。 */
  const handleAuto = (req: IncomingMessage, res: ServerResponse): void => {
    const sessionId = query(req, 'session')
    if (sessionId === undefined) { json(res, 400, { ok: false, error: 'need session' }); return }
    const on = query(req, 'on') === '1'
    if (on) {
      autoTitles.add(sessionId)
      autoDirty.add(sessionId)     // 立刻开始补已经结束的那些步
    } else {
      autoTitles.delete(sessionId)
      autoDirty.delete(sessionId)
    }
    json(res, 200, { ok: true, auto: on })
  }

  const handlePing = (_req: IncomingMessage, res: ServerResponse): void => {
    json(res, 200, {
      ok: true,
      name,
      /**
       * 热重载时用来确认跑的是哪一版代码（改代码记得一起 +1）。
       *
       * 6：标题缓存改成按步存（v2）、新增 `POST /auto` 开关路由、新增 `autoBusy` 推送。
       * 7：标题缓存上限 200 → **640**（对齐 32 会话 × 20 轮），字段改名
       *    `maxTitleEntries` → `maxTitledTurns`（它数的是**轮**，不是标题）。
       * 8：修 hydrate 的早退条件（原"内存里有轮次就不折"会让**正在跑**的会话永远折不进历史）
       *    + 折叠读盘期间的实时事件改为排队补放（原来会被"清空 + 重放"抹掉）。
       * 9：**整轮标题** —— 轮头第一行（① 反转布局：标题当主行、编号与元信息降为注脚）。
       *    素材 = 本轮最后的 AI 输出；只在轮结束后生成（实时开着才自动生成）；
       *    并入现有那次标题调用（不多一次请求）。
       * 10：轮标题改成**两层** —— 默认/运行中用**本轮用户消息**（免费、立刻有）；
       *    实时模式轮结束时用模型总结 AI 最后的输出覆盖它；手动点「生成标题」也生成
       *    （不等轮结束）。轨迹开始记 userText（只认 source.kind === 'user'）。
       * 11：修 `user/message` 被整条丢掉 —— 它身上**没有** `turn` 字段，被 applySessionEvent
       *    开头的 `if (turn === undefined) return []` 挡在门外（默认层一条都不出现）。
       *    分支挪到取 turn 之前。
       * 12：轮标题改成**平铺第二行**（设计稿 turn-title.html），标题一行到底 + 省略号
       *    （原来是 turn-title-2.html 的 ① 反转：标题在第一行当主行，不截断）。
       * 13：轮标题长度对齐步骤标题那一档（提示词 12~24 → **8~18**）；回落层（用户消息）
       *    显示时按字数截到 18 字 + `…`（只靠 CSS 截的话读起来是"半句话被切断"）。
       * 14：轮标题默认层去掉开头的**序号**（`1、` `2.` `（3）` `一、` `①`）—— 要求分隔符，
       *    避免误删"20轮之前的思维链"这种开头数字是内容的消息。
       * 15：（已撤回）试过"用户消息那层降一档 + 悬停说明来源"，都不合适。
       * 16：两种来源**只差颜色一档** —— AI 总结的加黑到 label-primary（is-model），
       *    用户消息那条保持 label-secondary。字号字重行数都不动。
       * 17：把对比拉开 —— AI 总结：label-primary + **字重 600**；用户消息：label-tertiary + 400。
       *    （`--dsw-font-xxs-strong-12` 只有 500，实测拉不开差别，所以字重直接写 600。）
       * 18：AI 总结的字重回落到设计系统 token（`--dsw-font-xxs-strong-12` = 500）。
       *    实测 500 与 600 的墨量只差 8%（5.87% vs 6.34%），肉眼几乎一样 ——
       *    主要区别在颜色那一档（primary vs tertiary），没必要脱离字级表。
       * 改宿主代码后 `dsh web` 必须重启（ESM 缓存），重启完用
       * `curl -s localhost:3080/think-flow/api/ping` 看这个号对不对。
       */
      build: 22,
      sessions: sessions.size,
      stats,
      config,
    })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/stream`, handler: handleStream }),
    `${name}: stream route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/trace`, handler: handleTrace }),
    `${name}: trace route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/step`, handler: handleStep }),
    `${name}: step route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/turn`, handler: handleTurn }),
    `${name}: turn route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/sessions`, handler: handleSessions }),
    `${name}: sessions route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/titles`, handler: handleTitles }),
    `${name}: titles route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/auto`, handler: handleAuto }),
    `${name}: auto route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/ping`, handler: handlePing }),
    `${name}: ping route`,
  )

  // 预热标题缓存：让首次 /trace 就能带上已生成的标题（读失败不影响启动）
  void loadTitleCache().catch(() => {})

  ctx.logger?.info?.(`[${name}] 思维链路由就绪：${API}/stream`)
}

/** 供单测与类型使用。 */
export type { SessionTrace, TraceChange } from './trace.js'
export type WebServerLike = WebServer
