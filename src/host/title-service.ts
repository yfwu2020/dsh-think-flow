import { PLUGIN_NAME } from './constants.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { buildTitleUser, parseTitles, TITLE_SYSTEM, type TitleBudget, type TitleInputNote, type TitleInputStep } from '../titles.js'
import { COMMAND_TOOLS, lastTurn, type TurnFact } from '../trace.js'
import type { Config } from './config.js'
import type { SessionEntry, Subscriber, TitleCache, TitleCacheEntry } from './types.js'
import { stepPrint, turnPrint, turnOutputOf } from './title-fingerprints.js'

/**
 * 让"等外部事件"的定时器**不参与进程存活判定**。
 *
 * 为什么必须要：宿主退出/热重载时先 dispose 插件，再等事件循环排空。一个没 `unref`
 * 的长定时器（这里是 120s 的生成超时）会让进程空转到它到点为止 —— 外壳的优雅退出
 * 期限（10s）早过了，于是记一条 `shutdown-lingering` 并把这次更新判失败。
 * 同类毛病在 `dsh-selection-explain` 的 25s 截图轮询上真机踩过（2026-10）。
 *
 * 注意 `unref` 只解决"钉住进程"，不解决"生成还在跑"：后者由 `inflight` 的 dispose abort 兜。
 * @param timer - 定时器。
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.()
}

/** Owns title generation, cache and the opt-in batch scheduler. */
export function createTitleService(ctx: Context, config: Config, sessions: Map<string, SessionEntry>, send: (sub: Subscriber, payload: unknown) => void) {
  /**
   * 此刻正在跑的标题生成。
   *
   * 卸载时一律 abort，这不是洁癖：`unref` 只让**定时器**不再钉住进程，而生成中的
   * LLM 流本身还挂着 socket，同样会拖住退出（顺带继续烧 token）。abort 之后
   * 流立即收尾、`generateBatch` 走 catch/finally，句柄全释放。
   */
  const inflight = new Set<AbortController>()
  ctx.effect(() => () => {
    for (const controller of inflight) {
      try { controller.abort() } catch { /* 已经结束了 */ }
    }
    inflight.clear()
  }, `${PLUGIN_NAME}: abort in-flight title generations`)

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
      ctx.logger?.warn?.(`[${PLUGIN_NAME}] 标题缓存写入失败：${String(error)}`)
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
   * 否则恰恰漏掉了最需要它的那些步（没有思考的纯工具步）。
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
    // 所以这里不能按"有思考"过滤，否则恰恰漏掉最需要它的那些步（没有思考的纯工具步）。
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
    inflight.add(controller)
    // 超时兜底交给 abort；`unref` 保证"生成还没回来就要退出"时不把宿主钉到 120s。
    const timer = setTimeout(() => controller.abort(), 120_000)
    unrefTimer(timer)
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
      inflight.delete(controller)
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
  ctx.effect(() => () => { clearInterval(autoTimer) }, `${PLUGIN_NAME}: auto title timer`)


  function titleOfTurn(sessionId: string, turn: TurnFact): string | undefined {
    const cached = titleCache?.[`${sessionId}:${turn.turn}`]
    return cached?.title !== undefined && cached.title.print === turnPrint(turn) ? cached.title.text : undefined
  }
  function markDirty(sessionId: string): void {
    if (autoTitles.has(sessionId)) autoDirty.add(sessionId)
  }
  function setAuto(sessionId: string, on: boolean): void {
    if (on) { autoTitles.add(sessionId); autoDirty.add(sessionId) }
    else { autoTitles.delete(sessionId); autoDirty.delete(sessionId) }
  }
  return {
    get cache() { return titleCache },
    loadTitleCache, generateTitles, titleOfTurn, markDirty, setAuto,
    isAuto: (sessionId: string) => autoTitles.has(sessionId),
    isBusy: (sessionId: string) => autoBusy.has(sessionId),
  }
}

export type TitleService = ReturnType<typeof createTitleService>
