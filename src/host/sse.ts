import type { Config } from './config.js'
import type { SessionEntry, Stats, Subscriber } from './types.js'
import type { TraceChange } from '../trace.js'

export function send(sub: Subscriber, payload: unknown): void {
  try {
    sub.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    /* 连接已断，下一轮清理 */
  }
}


export function createBroadcaster(sessions: Map<string, SessionEntry>, config: Config, stats: Stats, prune: (entry: SessionEntry) => void) {
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

  return { broadcast }
}
