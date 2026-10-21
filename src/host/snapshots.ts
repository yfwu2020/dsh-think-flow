import { lastTurn, reasoningTokensOf, textTokensOf, stepStatus, stepElapsed, runningTool, type TurnFact } from '../trace.js'
import type { Config } from './config.js'
import type { SessionEntry, SessionState } from './types.js'
import type { TitleService } from './title-service.js'
import { stepPrint, turnPrint } from './title-fingerprints.js'

/** Shared wire serialization for recent-turn snapshots and cold-turn responses. */
export function createSnapshots(config: Config, sessions: Map<string, SessionEntry>, titles: TitleService) {
  /**
   * 生成快照。
   *
   * 刻意**只给"当前步"附原文**：一个 turn 实测能有 7 万字思考，53 步全带原文的
   * 快照每次连接要传几 MB，而前端真正需要实时滚动观看的只有最后一步。
   * 其余步骤只给 Token 数与状态，用户展开时再走 `/step` 按需取。
   */
  /**
   * 一轮的**快照形状**。
   *
   * 抽出来是因为现在有两条路要用它：整份快照（`snapshot`，最近 N 轮）和
   * 按需取一轮（`/turn`，更早的轮次）。各写一遍的话"客户端字段"就有两个真相。
   */
  function turnSnapshot(sessionId: string, turn: TurnFact, latest: TurnFact | undefined, now: number) {
    const cache = titles.cache
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
          reasoningTokens: reasoningTokensOf(step),
          textTokens: textTokensOf(step),
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
            resultTokens: tool.resultTokens,
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
    if (e === undefined) return { sessionId, turns: [], serverTime: now, known: false, state: 'unreadable' as SessionState, auto: titles.isAuto(sessionId), autoBusy: false }
    const t = e.trace
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
      auto: titles.isAuto(sessionId),
      /** 此刻正在生成（面板上那枚胶囊脉冲用）。 */
      autoBusy: titles.isBusy(sessionId),
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


  return { snapshot, turnSnapshot }
}

export type Snapshots = ReturnType<typeof createSnapshots>
