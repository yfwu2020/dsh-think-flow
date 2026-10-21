import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { lastTurn } from '../trace.js'
import type { Config } from './config.js'
import type { SessionEntry, Stats, Subscriber } from './types.js'
import type { SessionStore } from './sessions.js'
import type { TitleService } from './title-service.js'
import type { TranslationService } from './translation-service.js'
import type { Snapshots } from './snapshots.js'
import { json, query, readJsonBody } from './http.js'
import { send } from './sse.js'
import { API, PLUGIN_NAME as name } from './constants.js'

interface RouteServices {
  sessions: Map<string, SessionEntry>
  stats: Stats
  store: SessionStore
  titles: TitleService
  translation: TranslationService
  snapshots: Snapshots
}

/** Register HTTP/SSE endpoints; service objects own the underlying application state. */
export function registerRoutes(ctx: Context, config: Config, { sessions, stats, store, titles, translation, snapshots }: RouteServices): void {
  const { entryOf, hydrate, materializeTurn, needsResync } = store
  const { translatorService, translateLimit, translateOne } = translation
  const { snapshot, turnSnapshot } = snapshots
  const handleStream = (req: IncomingMessage, res: ServerResponse): void => {
    const sessionId = query(req, 'session')
    if (sessionId === undefined) { json(res, 400, { ok: false, error: 'missing session' }); return }
    // 打开面板时先补历史（旧会话内存里是空的），再接实时增量。
    // ⚠️ 如果这份内存轨迹"看着还在跑、可本进程好久没动静"，先**重折一遍**再发快照 ——
    //    不然打开面板看到的就是那份过期的"还在跑"（换个客户端打开同一会话时就是这样）。
    const staleNow = Date.now()
    if (needsResync(sessionId, staleNow)) {
      void hydrate(sessionId, true)
    } else {
      void hydrate(sessionId)
    }

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
    // （`hydrate` 是单飞的：上面那次若已认领，这里等的是**同一趟**，不会多折一遍。）
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
   * 翻译**一段**思考原文（面板按段落发）。
   *
   * 用 POST：正文里就是原文本身 —— 4000 字走 query 会顶穿 URL 长度上限。
   * 只翻传进来的这一段，**不**按 turn/step 在宿主侧翻整份思考：
   * 一次 7 万字的 turn 会变成上百次网络请求，而用户常常只展开其中一步。
   *
   * 没装 translator（官方 experimental bundle）时返回 503，
   * 面板据此把「中文」开关禁用 —— 插件其余功能不受影响。
   */
  const handleTranslate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
    const service = translatorService()
    if (service === undefined) { json(res, 503, { ok: false, error: 'translator-unavailable' }); return }
    let body: unknown
    try {
      body = await readJsonBody(req, 60 * 1024)
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400
      json(res, status, { ok: false, error: status === 413 ? 'body-too-large' : 'invalid-json' })
      return
    }
    const text = body !== null && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string'
      ? (body as { text: string }).text
      : ''
    if (text.trim() === '') { json(res, 200, { ok: true, text: '', cached: true }); return }
    const limit = translateLimit(service)
    if (text.length > limit) {
      json(res, 413, { ok: false, error: 'text-too-long', limit })
      return
    }
    try {
      const out = await translateOne(text)
      json(res, 200, { ok: true, text: out.text, cached: out.cached })
    } catch (error) {
      // 诊断只回错误码：提供方正文 / 提交的原文都不往浏览器漏
      const code = typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'TRANSLATION_FAILED'
      json(res, 502, { ok: false, error: 'translation-failed', code })
    }
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
      const out = await titles.generateTitles(sessionId, turn, query(req, 'force') === '1', true)
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
    titles.setAuto(sessionId, on)
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
      build: 24,
      sessions: sessions.size,
      stats,
      config,
      translate: {
        available: translatorService() !== undefined,
        target: config.translateTarget,
        provider: config.translateProvider,
        maxChars: translateLimit(translatorService()),
        cacheEntries: translation.cacheEntries,
      },
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
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/translate`, handler: handleTranslate }),
    `${name}: translate route`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: `${API}/ping`, handler: handlePing }),
    `${name}: ping route`,
  )

}
