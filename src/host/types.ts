/** Internal host state. Public status/summary types are re-exported by src/index.ts. */
import type { SessionTrace, TraceChange, TurnFact } from '../trace.js'

export interface Subscriber {
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
export interface TitleCacheEntry {
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
export type TitleCache = Record<string, TitleCacheEntry>

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
  /**
   * 这一轮 `turn/start` 的**事件序号**：主会话"跳到某一轮"用的锚点
   * （面板里点轮次号 → 客户端调 `session.loadThrough(seq)`）。
   *
   * ⚠️ 必须随**骨架**下发，不能只放在正文快照里：能跳的轮次恰恰常常是正文还没取回来的
   * 那些（目录里点"更早的轮次"就是这种情况），只给正文那一份等于跳不了。
   * 缺失（老日志 / hydrate 上限截断）时客户端退回"一页一页翻"的慢路。
   */
  seq?: number
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
  /** 思考原文总 **Token** 数（正文丢了也保留这个数）。 */
  reasoningTokens: number
  /** 正文总 **Token** 数。 */
  textTokens: number
  /** 正文现在在内存里吗（false = 打开它时要现折）。 */
  inMemory: boolean
}

/** 一棵会话轨迹树 + 它的订阅者。 */
export interface SessionEntry {
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
  /**
   * 本进程**最后一次亲眼看到**这个会话的实时动静是什么时候（流帧或会话事件都算）。
   *
   * 它是"这份内存轨迹还新不新"的唯一判据：本进程**不是**这个会话的驱动者时
   *（换个客户端接着看 / 另一台进程在跑那一轮），实时事件根本不会到这儿来 ——
   * 靠它才能认出"看着还在跑、其实早就结束了"。见 {@link maybeResync}。
   */
  lastLiveAt: number
  /** 上一次强制重折的时间（节流用）。 */
  resyncAt: number
  /**
   * 这一段"沉默期"里已经强制重折过几次。
   *
   * 为什么要退避：**真的**在等一个长工具时同样没有事件（实测有一次 `bash` 等了 59 分钟），
   * 而那种沉默是正常的 —— 不能每 15 秒去重折一遍日志。所以按 2 的幂放大间隔，
   * 一有实时事件就清零（说明本进程确实在驱动它，这段沉默结束了）。
   */
  resyncBurst: number
}

/** 内部诊断计数，`/ping` 用。 */
export interface Stats {
  frames: number
  events: number
  gaps: number
  dropped: number
}
