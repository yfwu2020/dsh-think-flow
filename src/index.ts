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
 * 还有一条**可选**能力：
 *   · 思考原文机翻（`/translate`）—— 面板按段落送翻，宿主转给官方的
 *     `@deepseek-ai/dsh-experimental-translator`（Bing/Google 匿名端点）。
 *     没装那个 bundle 时接口返回 503，面板把「中文」开关禁用，其余功能照常。
 *
 * 唯一落盘的东西是**标题缓存**与**译文缓存**（都是派生数据，丢了随时能重算）；
 * 会话本身只读、不改。除了"生成标题"这一次显式动作，插件不主动调用模型。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { } from '@deepseek-ai/dsh-agent'
import type { } from '@deepseek-ai/dsh-session'
import { applySessionEvent, applyStreamFrame } from './trace.js'
import { Config, resolveConfig } from './host/config.js'
import type { SessionEntry, Stats } from './host/types.js'
import { createSessionStore } from './host/sessions.js'
import { createTitleService } from './host/title-service.js'
import { createTranslationService } from './host/translation-service.js'
import { createSnapshots } from './host/snapshots.js'
import { registerRoutes } from './host/routes.js'
import { createBroadcaster, send } from './host/sse.js'
import { API, PLUGIN_NAME } from './host/constants.js'
export { Config } from './host/config.js'
export type { SessionState, TurnSummary } from './host/types.js'

export const name = PLUGIN_NAME

/** web 服务器；会话与 agent 事件走全局事件总线；`llm` 用于按需生成中文标题。 */
export const inject = ['webServer', 'llm']

export function apply(ctx: Context, rawConfig: Config): void {
  const config = resolveConfig(rawConfig)

  const sessions = new Map<string, SessionEntry>()
  const stats: Stats = { frames: 0, events: 0, gaps: 0, dropped: 0 }

  const titles = createTitleService(ctx, config, sessions, send)
  const { snapshot, turnSnapshot } = createSnapshots(config, sessions, titles)
  const store = createSessionStore(ctx, config, sessions, stats, { titleOfTurn: titles.titleOfTurn, pushSnapshot })
  const { entryOf, markLive, whenNotHydrating } = store
  const { broadcast } = createBroadcaster(sessions, config, stats, store.prune)
  const translation = createTranslationService(ctx, config)

  function pushSnapshot(sessionId: string): void {
    const e = sessions.get(sessionId)
    if (e === undefined || e.subs.size === 0) return
    const snap = snapshot(sessionId)
    for (const sub of e.subs) send(sub, { t: 'snapshot', snapshot: snap })
  }

  // ───────────────────────── 事件订阅 ─────────────────────────

  const offStream = ctx.on('agent/assistant-stream', (payload: unknown) => {
    const p = payload as { agent?: { session?: { id?: unknown } }; frame?: unknown } | undefined
    const sessionId = p?.agent?.session?.id
    if (typeof sessionId !== 'string' || p?.frame === undefined) return
    stats.frames += 1
    const e = entryOf(sessionId, Date.now())
    e.state = 'live'
    markLive(e)
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
    markLive(e)
    whenNotHydrating(sessionId, () => {
      // 实时会话也要记区间：没 hydrate 过的会话（正在跑的那个）搜索时同样要反查轮号
      const changes = applySessionEvent(e.trace, event as never, Date.now())
      if (changes.length) broadcast(sessionId, changes)
      // 自动标题：有步开始/结束就记一笔，等节拍器来刷（**不是**每步一次调用）
      if (changes.length > 0) titles.markDirty(sessionId)
    })
  })

  ctx.effect(() => () => { offStream(); offEvent() }, `${name}: event subscriptions`)

  registerRoutes(ctx, config, { sessions, stats, store, titles, translation, snapshots: { snapshot, turnSnapshot } })

  // 预热标题缓存：让首次 /trace 就能带上已生成的标题（读失败不影响启动）
  void titles.loadTitleCache().catch(() => { })

  ctx.logger?.info?.(`[${name}] 思维链路由就绪：${API}/stream`)
}

/** 供单测与类型使用。 */
export type { SessionTrace, TraceChange } from './trace.js'
export type WebServerLike = WebServer
