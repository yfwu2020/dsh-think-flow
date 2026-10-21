import { PLUGIN_NAME } from './constants.js'
import type { Context } from '@deepseek-ai/cordis'
import { applySessionEvent, createTrace, reasoningTokensOf, textTokensOf, tokenWeight, stepStatus, type SessionTrace, type TurnFact } from '../trace.js'
import type { Config } from './config.js'
import type { SessionEntry, SessionState, Stats, TurnSummary } from './types.js'

interface SessionHooks {
  titleOfTurn(sessionId: string, turn: TurnFact): string | undefined
  pushSnapshot(sessionId: string): void
}

/** Owns session retention, history reads, hydration and recovery. */
export function createSessionStore(ctx: Context, config: Config, sessions: Map<string, SessionEntry>, stats: Stats, hooks: SessionHooks) {
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
      lastLiveAt: now, resyncAt: 0, resyncBurst: 0,
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
    let reasoningTokens = 0
    let textTokens = 0
    for (const step of turn.steps) {
      tools += step.tools.length
      reasoningTokens += reasoningTokensOf(step)
      textTokens += textTokensOf(step)
    }
    // 轮次标题（模型生成的）：和 turnSnapshot 一样，**指纹对得上**才作数 ——
    // 这一轮的内容变了，旧标题就不该再跟着走
    const title = hooks.titleOfTurn(sessionId, turn)
    return {
      turn: turn.turn,
      startedAt: turn.startedAt,
      // 事件序号（有就带上）：客户端"跳到某一轮"要它
      ...(turn.seq !== undefined ? { seq: turn.seq } : {}),
      endedAt: turn.endedAt,
      endReason: turn.endReason,
      interrupted: turn.interrupted,
      userText: turn.userText,
      title,
      steps: turn.steps.length,
      tools,
      reasoningTokens,
      textTokens,
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
          // 截断了就按**留下**的那段重算 Token —— 面板报的数必须说的是
          // "现在还能读到多少"，和截断前的旧数对不上就是两个真相。
          step.reasoningWeight = tokenWeight(step.reasoning)
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

  /**
   * 在飞的那一趟折历史（按会话）。
   *
   * ⚠️ **必须单飞**：并发的两次 `hydrate` 会各自 `hydrating.set(...)`（后一次把前一次的
   *    排队表**覆盖**掉），然后各自 `e.trace.turns.length = 0` 用**自己那次读到的**日志
   *    重建 —— 只要有一次读得早，它就会把后来的事实（轮结束、工具结果）整段抹掉，
   *    而那次排队表已经没人认领、里面的实时事件**再也不会补放**。
   *    表现：这一轮明明早就中断了，面板还一直挂着"已等 59'46""在跑，而且
   *    **刷新页面也好不了**（内存里那份就是错的）。真机踩到过。
   */
  const hydratingRun = new Map<string, Promise<SessionState>>()

  async function hydrate(sessionId: string, force = false): Promise<SessionState> {
    const inflight = hydratingRun.get(sessionId)
    if (inflight !== undefined) return inflight
    const run = hydrateOnce(sessionId, force)
    hydratingRun.set(sessionId, run)
    const done = (): void => { hydratingRun.delete(sessionId) }
    return run.then((state) => { done(); return state }, (error) => { done(); throw error })
  }

  /**
   * 折一趟（强制时**重折**，把内存里那份换成日志里的事实）。
   * @param force - 为 true 时无视"已经折过"的早退，重新读一遍日志。
   */
  async function hydrateOnce(sessionId: string, force: boolean): Promise<SessionState> {
    const existing = sessions.get(sessionId)
    // 折过就早退（**不是**"有轮次就早退" —— 见 hydrated 的说明）。
    // `force` 是给"本进程不是驱动者"那条路用的：那份内存轨迹没人会来更正，只能自己重读。
    if (!force && hydrated.has(sessionId)) return existing?.state ?? 'live'
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
      ctx.logger?.warn?.(`[${PLUGIN_NAME}] 历史回看失败：${String(error)}`)
      return 'unreadable'
    } finally {
      // 无论成功、失败还是 open 抛错，都要收排队并补放 —— 否则这些实时事件白丢
      try { await handle?.close() } catch { /* 已经关了 */ }
      const queued = hydrating.get(sessionId) ?? []
      hydrating.delete(sessionId)
      for (const run of queued) run()
    }
  }

  // ───────────────────── 内存轨迹的"过期自愈"（重折日志） ─────────────────────

  /** 记一笔"本进程刚看到这个会话的实时动静"。 */
  function markLive(e: SessionEntry): void {
    e.lastLiveAt = Date.now()
    // 一有实时事件就说明本进程确实在驱动它 —— 这一段沉默结束了，重折额度重置
    e.resyncBurst = 0
  }

  /**
   * 这份轨迹"看着还在跑"吗 —— 有没结束的轮，而且它没有正在**流式**的步。
   *
   * ⚠️ 流式中的步要排除掉：那种步的思考文本还在**只存在于内存**（落盘要等这一步的
   *    `assistant/message`），这时候重折会把它抹掉（面板上正在长的字突然没了）。
   *    "等工具"（`waiting`）不一样：那一步的正文早就落盘了，重折是安全的。
   */
  function traceLooksOpen(trace: SessionTrace): boolean {
    const open = trace.turns.filter((t) => t.endedAt === undefined)
    if (open.length === 0) return false
    for (const turn of open) {
      for (const step of turn.steps) {
        const status = stepStatus(step, turn)
        if (status === 'thinking' || status === 'waiting') return true
      }
    }
    return false
  }

  /** 距上一次重折至少要等多久（指数退避：15s → 30s → 60s…，封顶 `resyncMaxGapMs`）。 */
  function resyncGap(e: SessionEntry): number {
    return Math.min(config.resyncSilenceMs * Math.pow(2, e.resyncBurst), config.resyncMaxGapMs)
  }

  /** 该不该强制重折：看着还在跑 + 本进程好久没动静 + 距上次重折够久（退避）。 */
  function needsResync(sessionId: string, now: number): boolean {
    const e = sessions.get(sessionId)
    if (e === undefined) return false
    if (config.resyncMaxGapMs <= 0) return false
    if (!traceLooksOpen(e.trace)) return false
    if (now - e.lastLiveAt < config.resyncSilenceMs) return false
    if (now - e.resyncAt < resyncGap(e)) return false
    e.resyncAt = now
    e.resyncBurst += 1
    return true
  }

  /** 轨迹的"形状指纹"：重折前后比一下，变了才推快照（没变就别惊动面板）。 */
  function tracePrint(trace: SessionTrace): string {
    const parts: string[] = []
    for (const turn of trace.turns) {
      parts.push(`${turn.turn}:${turn.endedAt ?? '-'}:${turn.steps.length}`)
      for (const step of turn.steps) parts.push(`${step.step}/${stepStatus(step, turn)}`)
    }
    return parts.join('|')
  }

  /**
   * **重折一遍日志**，把内存里那份"看着还在跑"的轨迹换成落盘的事实。
   *
   * 为什么需要它：本进程**不是**这个会话的驱动者时，实时事件根本不会到这儿来 ——
   * 打开面板那一刻折出来的"还在跑"就再也没人更正。典型场景：
   *   · 换了个客户端打开同一个会话（`dsh web` → 桌面版，或反过来）；
   *   · 上一轮是在**另一个进程**里被打断的。
   * 实测就是这样：那一轮 19:54 就中断了，21:53 面板还挂着"已等 59'46""，而且
   * **刷新页面也好不了**（`hydrated` 早退了，内存那份永远不更新）。
   *
   * 代价有硬上限：只有"看着还在跑 + 沉默够久"才做，而且**退避**（15s → 30s → … → 5 分钟，
   * 见 `resyncMaxGapMs`）—— 真的在等一个长工具时，几次之后就是 5 分钟才读一遍日志。
   * @returns 这次是不是真的重折了。
   */
  function resyncFromLog(sessionId: string, now: number): boolean {
    const e = sessions.get(sessionId)
    if (e === undefined) return false
    if (!needsResync(sessionId, now)) return false
    const before = tracePrint(e.trace)
    void hydrate(sessionId, true).then(() => {
      const after = sessions.get(sessionId)
      if (after === undefined) return
      if (tracePrint(after.trace) === before) return
      hooks.pushSnapshot(sessionId)
    })
    return true
  }

  /**
   * 过期自愈的节拍器。
   *
   * 只在**有人开着这个会话的面板**时才算数（没人看就不用自愈，省 I/O）：
   * 每次只做条件判断（没有任何 I/O），真重折由 `resyncFromLog` 的节流与额度管着。
   * 间隔取 `resyncSilenceMs`（封顶 10 秒、下限 50ms，测试要能调快）。
   */
  const RESYNC_SWEEP_MS = Math.max(50, Math.min(config.resyncSilenceMs, 10_000))
  if (config.resyncMaxGapMs > 0) {
    const resyncTimer = setInterval(() => {
      const now = Date.now()
      for (const [sessionId, e] of sessions) {
        if (e.subs.size === 0) continue
        resyncFromLog(sessionId, now)
      }
    }, RESYNC_SWEEP_MS)
    ctx.effect(() => () => { clearInterval(resyncTimer) }, `${PLUGIN_NAME}: trace resync timer`)
  }

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
    ctx.effect(() => () => { clearInterval(coldTimer) }, `${PLUGIN_NAME}: cold turn sweep timer`)
  }

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
  }, `${PLUGIN_NAME}: 连接与会话清理`)


  return { entryOf, prune, hydrate, materializeTurn, markLive, whenNotHydrating, needsResync }
}

export type SessionStore = ReturnType<typeof createSessionStore>
