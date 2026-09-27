#!/usr/bin/env node
/**
 * trace.js（轨迹聚合器）单测。
 *
 * 这些断言全部来自**真实踩过或将要踩的坑**，不是凑覆盖率的：
 *   · 序号缺口必须标记文本不完整，而不是拼出一段有洞的思考
 *   · 重试（同一 turn/step 再来一次 start）要计数，而不是覆盖掉前一次
 *   · 工具在跑 = waiting；不做这个推导，"等 47 秒"在界面上就是一片静止
 *   · turn 结束时仍未收尾的步必须标成 cut，不能假装它还完整
 */
import {
  applySessionEvent,
  applyStreamFrame,
  createTrace,
  lastTurn,
  USER_TEXT_CHARS,
  stripEnumPrefix,
  runningTool,
  stepStatus,
  stepElapsed,
} from '../lib/trace.js'

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const T0 = 1_700_000_000_000

/** 造一个 assistant-stream 帧。 */
function frame(type, extra) {
  return Object.assign({ type }, extra)
}
/**
 * 造一个 reasoning 增量帧 —— **严格照宿主真实形状**。
 *
 * ⚠️ chunk 帧**不带 turn/step**（只有 start 帧带，见 dsh-agent-loop 的
 * AssistantStreamAttempt.start/push）。早先这里凭想象给 chunk 加上了 turn/step，
 * 于是测试和实现共享了同一个误解：单测全绿，真机上三万个帧一个字都没抓到。
 * 夹具必须来自源码，不能来自假设。
 */
function delta(index, text, attemptId = 'a1') {
  return frame('chunk', {
    attemptId, revision: index + 2, index, time: T0,
    chunk: { type: 'reasoning-delta', index, text },
  })
}

/** 造一个 text 增量帧（同样不带 turn/step）。 */
function textDelta(index, text, attemptId = 'a1') {
  return frame('chunk', {
    attemptId, revision: index + 2, index, time: T0,
    chunk: { type: 'text-delta', index, text },
  })
}

// ───────────────────── ① 基本聚合 ─────────────────────

console.log('\n① 基本聚合：start → 增量 → end')
{
  const t = createTrace('s1')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applyStreamFrame(t, delta(0, 'Let me '), T0 + 10)
  applyStreamFrame(t, delta(1, 'check.'), T0 + 20)
  const turn = lastTurn(t)
  ok('建出一个 turn', turn && turn.turn === 1)
  ok('建出一个 step', turn.steps.length === 1)
  ok('思考文本按增量累加', turn.steps[0].reasoning === 'Let me check.', turn.steps[0].reasoning)
  ok('流未结束时状态是 thinking', stepStatus(turn.steps[0], turn) === 'thinking')

  applyStreamFrame(t, frame('end', { attemptId: 'a1' }), T0 + 30)
  ok('end 之后进入 ready', stepStatus(turn.steps[0], turn) === 'ready')
}

// ───────────────────── ② 序号缺口 ─────────────────────

console.log('\n② 序号缺口：宁可标不完整，也不拼出有洞的思考')
{
  const t = createTrace('s2')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applyStreamFrame(t, delta(0, 'AAA'), T0 + 10)
  // 缺 index=1，直接来 index=2
  const gapChanges = applyStreamFrame(t, delta(2, 'CCC'), T0 + 20)
  const s = lastTurn(t).steps[0]
  ok('检出缺口', gapChanges.some((c) => c.k === 'gap'), gapChanges)
  ok('标记 streamGap', s.streamGap === true)
  ok('缺口那一帧没有被拼进正文', s.reasoning === 'AAA', s.reasoning)

  // 缺口之后的帧即使序号连续也不该再收（否则又会拼出有洞的内容）
  const after = applyStreamFrame(t, delta(3, 'DDD'), T0 + 30)
  ok('缺口之后停止接收', after.length === 0 && s.reasoning === 'AAA', { after, text: s.reasoning })
}

// ───────────────────── ③ 重试 ─────────────────────

console.log('\n③ 重试：同一 (turn, step) 再来一次 start')
{
  const t = createTrace('s3')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applyStreamFrame(t, delta(0, 'first try'), T0 + 10)
  applyStreamFrame(t, frame('end', { attemptId: 'a1' }), T0 + 20)
  applyStreamFrame(t, frame('start', { attemptId: 'a2', turn: 1, step: 1 }), T0 + 30)
  const s = lastTurn(t).steps[0]
  ok('attempts 计到 2', s.attempts === 2, s.attempts)
  ok('重试后仍只有 1 个 step（不新建）', lastTurn(t).steps.length === 1)
  // 旧尝试的帧必须被丢弃
  const stale = applyStreamFrame(t, delta(1, 'stale', 'a1'), T0 + 40)
  ok('旧 attemptId 的帧被丢弃', stale.length === 0)
  // 新尝试的序号从 0 重新开始
  const fresh = applyStreamFrame(t, delta(0, 'second', 'a2'), T0 + 50)
  ok('新尝试从头接收', fresh.length === 1 && s.reasoning.endsWith('second'), s.reasoning)
}

// ───────────────────── ④ 工具：waiting 状态 ─────────────────────

console.log('\n④ 工具：在跑就是 waiting（本期的关键状态）')
{
  const t = createTrace('s4')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 8 }), T0)
  applyStreamFrame(t, delta(0, 'let me search'), T0 + 10)
  applyStreamFrame(t, frame('end', { attemptId: 'a1' }), T0 + 20)
  const turn = lastTurn(t)
  ok('思考结束、无工具 → ready', stepStatus(turn.steps[0], turn) === 'ready')

  const call = applySessionEvent(t, {
    type: 'tool/call', time: T0 + 20,
    data: { turn: 1, step: 8, callId: 'c1', name: 'find_dsh_plugin', arguments: '{"query":"x"}' },
  }, T0 + 20)
  ok('产生 tool 改动', call.some((c) => c.k === 'tool'), call)
  ok('有工具在跑 → waiting', stepStatus(turn.steps[0], turn) === 'waiting')
  ok('runningTool 能取到', runningTool(turn.steps[0]) && runningTool(turn.steps[0]).name === 'find_dsh_plugin')

  // 真实数据里那 47 秒：结束时 resultChars 要记下来
  applySessionEvent(t, {
    type: 'tool/result', time: T0 + 47000,
    data: { turn: 1, step: 8, message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'abcdef' }] }] } },
  }, T0 + 47000)
  const tool = turn.steps[0].tools[0]
  ok('工具已结束', tool.endedAt === T0 + 47000)
  ok('结果字符数被统计', tool.resultChars === 6, tool.resultChars)
  ok('没有工具在跑 → 回到 ready', stepStatus(turn.steps[0], turn) === 'ready')
}

// ───────────────────── ⑤ 多个工具，部分返回 ─────────────────────

console.log('\n⑤ 多个工具：只要还有一个在跑就仍是 waiting')
{
  const t = createTrace('s5')
  applySessionEvent(t, { type: 'turn/start', time: T0, data: { turn: 1 } }, T0)
  applySessionEvent(t, { type: 'tool/call', time: T0, data: { turn: 1, step: 5, callId: 'c1', name: 'cordis_inspect_list', arguments: '{}' } }, T0)
  applySessionEvent(t, { type: 'tool/call', time: T0, data: { turn: 1, step: 5, callId: 'c2', name: 'find_dsh_plugin', arguments: '{}' } }, T0)
  const turn = lastTurn(t)
  ok('两个工具都记下', turn.steps[0].tools.length === 2)
  applySessionEvent(t, {
    type: 'tool/result', time: T0 + 100,
    data: { turn: 1, step: 5, message: { source: { callId: 'c1' }, content: [] } },
  }, T0 + 100)
  ok('一个回来仍是 waiting', stepStatus(turn.steps[0], turn) === 'waiting', stepStatus(turn.steps[0], turn))
  applySessionEvent(t, {
    type: 'tool/result', time: T0 + 200,
    data: { turn: 1, step: 5, message: { source: { callId: 'c2' }, content: [] } },
  }, T0 + 200)
  ok('两个都回来 → 不再是 waiting', stepStatus(turn.steps[0], turn) !== 'waiting')
}

// ───────────────────── ⑥ step/end ─────────────────────

console.log('\n⑥ step/end：收尾')
{
  const t = createTrace('s6')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applyStreamFrame(t, delta(0, 'x'), T0 + 10)
  applySessionEvent(t, { type: 'step/end', time: T0 + 100, data: { turn: 1, step: 1 } }, T0 + 100)
  const turn = lastTurn(t)
  ok('状态 done', stepStatus(turn.steps[0], turn) === 'done')
  ok('没收到过 end 帧也补上 streamEndedAt', turn.steps[0].streamEndedAt === T0 + 100)
}

// ───────────────────── ⑦ 中断 ─────────────────────

console.log('\n⑦ turn/end：没跑完的步必须标成 cut')
{
  const t = createTrace('s7')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applySessionEvent(t, { type: 'step/end', time: T0 + 100, data: { turn: 1, step: 1 } }, T0 + 100)
  applyStreamFrame(t, frame('start', { attemptId: 'a2', turn: 1, step: 2 }), T0 + 110)
  applyStreamFrame(t, delta(0, 'half a sentence', 'a2'), T0 + 120)
  applySessionEvent(t, { type: 'turn/end', time: T0 + 200, data: { turn: 1, reason: 'aborted' } }, T0 + 200)
  const turn = lastTurn(t)
  ok('turn 标记为中断', turn.interrupted === true)
  ok('收尾原因记下', turn.endReason === 'aborted')
  ok('#1 仍是 done', stepStatus(turn.steps[0], turn) === 'done')
  ok('#2 变成 cut', stepStatus(turn.steps[1], turn) === 'cut', stepStatus(turn.steps[1], turn))
  ok('中断前的思考一个字没丢', turn.steps[1].reasoning === 'half a sentence', turn.steps[1].reasoning)
}

// ───────────────────── ⑧ 正常结束不该被误判为中断 ─────────────────────

console.log('\n⑧ 正常结束：所有步都收尾了就不该标 interrupted')
{
  const t = createTrace('s8')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applySessionEvent(t, { type: 'step/end', time: T0 + 100, data: { turn: 1, step: 1 } }, T0 + 100)
  applySessionEvent(t, { type: 'turn/end', time: T0 + 200, data: { turn: 1, reason: 'stop' } }, T0 + 200)
  const turn = lastTurn(t)
  ok('未被误判为中断', turn.interrupted !== true)
  ok('状态仍是 done', stepStatus(turn.steps[0], turn) === 'done')
}

// ───────────────────── ⑨ 正文与思考分开 ─────────────────────

console.log('\n⑨ reasoning-delta 与 text-delta 不能混在一起')
{
  const t = createTrace('s9')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applyStreamFrame(t, delta(0, 'thinking...'), T0 + 10)
  applyStreamFrame(t, textDelta(1, 'the answer'), T0 + 20)
  const s = lastTurn(t).steps[0]
  ok('思考只有思考', s.reasoning === 'thinking...', s.reasoning)
  ok('正文只有正文', s.text === 'the answer', s.text)
}

// ───────────────────── ⑩ 多 turn ─────────────────────

console.log('\n⑩ 多 turn：各自独立，步骤升序')
{
  const t = createTrace('s10')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 2 }), T0)
  applyStreamFrame(t, frame('start', { attemptId: 'a2', turn: 1, step: 1 }), T0 + 1)
  applySessionEvent(t, { type: 'turn/start', time: T0 + 1000, data: { turn: 2 } }, T0 + 1000)
  applyStreamFrame(t, frame('start', { attemptId: 'a3', turn: 2, step: 1 }), T0 + 1001)
  ok('两个 turn', t.turns.length === 2)
  ok('turn 1 的步骤按序号升序', t.turns[0].steps.map((s) => s.step).join(',') === '1,2')
  ok('lastTurn 是最新的', lastTurn(t).turn === 2)
}

// ───────────────────── ⑪ 脏数据不炸 ─────────────────────

console.log('\n⑪ 脏数据：缺字段 / 类型不对都要安静跳过')
{
  const t = createTrace('s11')
  const a = applyStreamFrame(t, { type: 'chunk' }, T0)
  const b = applyStreamFrame(t, frame('start', { attemptId: 1, turn: 'x', step: null }), T0)
  const c = applySessionEvent(t, { type: 'tool/call', data: {} }, T0)
  const d = applySessionEvent(t, { type: 'turn/end', data: { turn: 99 } }, T0)
  ok('缺字段的流帧返回空', a.length === 0)
  ok('类型不对的 start 返回空', b.length === 0)
  ok('缺字段的工具事件返回空', c.length === 0)
  ok('未知 turn 的 turn/end 不炸', Array.isArray(d))
  ok('没有凭空造出 step', t.turns.reduce((n, x) => n + x.steps.length, 0) === 0)
}


// ───────────────────── ⑫ 中途加载：没收到 start 也要能收到思考 ─────────────────────

console.log('\n⑫ 中途加载：只收到 chunk（start 帧早就过去了）')
{
  const t = createTrace('s12')
  // 先由 tool/call 建出这一步（真实顺序：插件加载后才开始收事件）
  applySessionEvent(t, { type: 'tool/call', time: T0, data: { turn: 1, step: 9, callId: 'c1', name: 'bash', arguments: '{}' } }, T0)
  const before = lastTurn(t).steps[0]
  ok('tool/call 先建出了 step', before !== undefined)
  // 随后才收到这个 attempt 的 chunk（没有 start 帧）
  const changes = applyStreamFrame(t, delta(0, 'late reasoning'), T0 + 10)
  ok('认领 attemptId 后能收到文本', changes.length === 1, changes)
  ok('思考正文被累加', lastTurn(t).steps[0].reasoning === 'late reasoning', lastTurn(t).steps[0].reasoning)
  // 认领之后序号仍然要连续校验
  const gap = applyStreamFrame(t, delta(5, 'hole'), T0 + 20)
  ok('认领之后照样检缺口', gap.some((c) => c.k === 'gap'), gap)
}


// ───────────────────── ⑬ 每个改动都必须带权威状态 ─────────────────────

console.log('\n⑬ 改动载荷带状态（A1 回归：状态只能有一个来源）')
{
  const t = createTrace('s13')
  // stream start
  const start = applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  ok('start 的改动带 status', start[0] && start[0].status === 'thinking', start[0])

  // 增量
  const d = applyStreamFrame(t, delta(0, 'x'), T0 + 1)
  ok('reasoning 的改动带 status', d[0] && d[0].status === 'thinking', d[0])

  // stream end → 应该变成 ready（而不是继续 thinking）
  applyStreamFrame(t, frame('end', { attemptId: 'a1' }), T0 + 2)
  const afterEnd = applyStreamFrame(t, delta(1, 'y'), T0 + 3)
  ok('stream end 之后 status 变 ready', afterEnd[0] && afterEnd[0].status === 'ready', afterEnd[0] && afterEnd[0].status)

  // 工具开始 → waiting
  const callChanges = applySessionEvent(t, {
    type: 'tool/call', time: T0 + 4,
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
  }, T0 + 4)
  ok('tool 改动带 status=waiting', callChanges[0] && callChanges[0].status === 'waiting', callChanges[0] && callChanges[0].status)

  // 工具返回 → 不再是 waiting
  const endChanges = applySessionEvent(t, {
    type: 'tool/result', time: T0 + 5,
    data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [] } },
  }, T0 + 5)
  ok('tool-end 改动带 status（不再是 waiting）', endChanges[0] && endChanges[0].status !== 'waiting', endChanges[0] && endChanges[0].status)

  // step/end → done。这正是之前客户端显示不出"已完成"的地方
  const stepEnd = applySessionEvent(t, { type: 'step/end', time: T0 + 6, data: { turn: 1, step: 1 } }, T0 + 6)
  ok('step/end 的改动带 status=done', stepEnd[0] && stepEnd[0].status === 'done', stepEnd[0])
  ok('host 侧状态确实是 done', stepStatus(lastTurn(t).steps[0], lastTurn(t)) === 'done')

  // turn/end → 必须把收尾事实带走
  const turnEnd = applySessionEvent(t, { type: 'turn/end', time: T0 + 7, data: { turn: 1, reason: 'stop' } }, T0 + 7)
  ok('turn 改动带 endedAt', turnEnd[0] && turnEnd[0].endedAt === T0 + 7, turnEnd[0])
  ok('turn 改动带 interrupted', turnEnd[0] && typeof turnEnd[0].interrupted === 'boolean', turnEnd[0])
  ok('turn 改动带 endReason', turnEnd[0] && turnEnd[0].endReason === 'stop', turnEnd[0])

  /**
   * 时间事实（`timing`）—— 和 `status` 同一个道理，只是管的是**时长**。
   *
   * 真机反馈："运行的时候步骤后面的秒数不显示了"。根因就是客户端手里没有时长：
   * 早先 `elapsedMs` 只在**快照**里给一次，增量里根本没有 —— 面板开着时长出来的步
   * 要么是空的、要么是"连上那一刻"的旧值。现在事实随每条改动走，时长由客户端
   * 按一条公式现算（活跃步才会自己涨，见客户端 stepDurMs）。
   */
  ok('start 改动带 timing.startedAt', start[0] && start[0].timing && start[0].timing.startedAt === T0, start[0] && start[0].timing)
  ok('reasoning 改动带 timing', d[0] && d[0].timing !== undefined, d[0])
  ok('stream end 之后每条改动都带 timing.streamEndedAt',
    afterEnd[0] && afterEnd[0].timing && afterEnd[0].timing.streamEndedAt !== undefined, afterEnd[0] && afterEnd[0].timing)
  ok('tool 改动带 timing', callChanges[0] && callChanges[0].timing !== undefined, callChanges[0])
  ok('tool-end 改动带 timing', endChanges[0] && endChanges[0].timing !== undefined, endChanges[0])
  ok('step/end 改动带 timing.endedAt（结束的步时长就此定格）',
    stepEnd[0] && stepEnd[0].timing && stepEnd[0].timing.endedAt === T0 + 6, stepEnd[0] && stepEnd[0].timing)
  ok('timing 里不塞 undefined 字段（这条通道每秒几十次，白占带宽）',
    stepEnd[0] && Object.keys(stepEnd[0].timing).every((k) => stepEnd[0].timing[k] !== undefined), stepEnd[0] && stepEnd[0].timing)
  ok('turn 改动不带 timing（它是轮级事实，没有"这一步"）', turnEnd[0] && turnEnd[0].timing === undefined, turnEnd[0])
}

// ───────────────────── ⑭ 中断时 turn 改动要报 interrupted ─────────────────────

console.log('\n⑭ 中断：turn 改动必须告诉客户端"被中断了"')
{
  const t = createTrace('s14')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0)
  applyStreamFrame(t, delta(0, 'half'), T0 + 1)
  const changes = applySessionEvent(t, { type: 'turn/end', time: T0 + 9, data: { turn: 1, reason: 'aborted' } }, T0 + 9)
  ok('改动里 interrupted=true', changes[0] && changes[0].interrupted === true, changes[0])
}


// ───────────────────── ⑮ 真实帧形状：chunk 帧没有 turn/step ─────────────────────

console.log('\n⑮ 真实帧形状（本次真机 bug 的回归：chunk 不带 turn/step）')
{
  // 宿主只在 start 帧带 turn/step；chunk 只带 attemptId/index/chunk。
  // 早先实现在 chunk 分支里直接读 frame.turn，读不到就丢 —— 三万个帧、0 字思考。
  const t = createTrace('s15')
  const start = frame('start', { attemptId: 'x1', revision: 1, turn: 3, step: 7 })
  ok('start 帧本身不带 chunk 内容也能建步', applyStreamFrame(t, start, T0).length === 1)

  const c0 = applyStreamFrame(t, delta(0, 'Hello ', 'x1'), T0 + 1)
  const c1 = applyStreamFrame(t, delta(1, 'world', 'x1'), T0 + 2)
  ok('chunk 帧被接受（不再被丢弃）', c0.length === 1 && c1.length === 1, [c0.length, c1.length])
  ok('文本落到正确的 step 上', lastTurn(t).steps[0].reasoning === 'Hello world', lastTurn(t).steps[0].reasoning)
  ok('归属的正是 start 声明的 turn/step', lastTurn(t).steps[0].turn === 3 && lastTurn(t).steps[0].step === 7)
  ok('改动里的 turn/step 也正确', c1[0].turn === 3 && c1[0].step === 7, c1[0])

  // 两个并发尝试（不同 step）不能串台
  applyStreamFrame(t, frame('start', { attemptId: 'x2', revision: 9, turn: 3, step: 8 }), T0 + 10)
  // 注意序号要接上：对同一个 attempt 复用 index 属于真实的乱序，会被缺口守卫拦下
  applyStreamFrame(t, delta(2, 'A', 'x1'), T0 + 11)
  applyStreamFrame(t, delta(0, 'B', 'x2'), T0 + 12)
  const s7 = lastTurn(t).steps.find((x) => x.step === 7)
  const s8 = lastTurn(t).steps.find((x) => x.step === 8)
  ok('并发 attempt 各自归位', s7.reasoning === 'Hello worldA' && s8.reasoning === 'B', [s7.reasoning, s8.reasoning])

  // end 帧清掉映射表（防漏收时无限增长）
  applyStreamFrame(t, frame('end', { attemptId: 'x1' }), T0 + 20)
  ok('end 之后映射表被清理', t.attempts.has('x1') === false)

  // 插件中途加载：chunk 先到、没有 start，靠会话事件记下的 lastStep 回退
  const t2 = createTrace('s15b')
  applySessionEvent(t2, { type: 'tool/call', time: T0, data: { turn: 2, step: 4, callId: 'c', name: 'bash', arguments: '{}' } }, T0)
  applyStreamFrame(t2, delta(0, 'late', 'y1'), T0 + 1)
  const late = lastTurn(t2).steps.find((x) => x.step === 4)
  ok('中途加载的 chunk 能回退到最近一步', late.reasoning === 'late', late.reasoning)
}

// ───────────────────── ⑯ step/start：时长口径 ─────────────────────

console.log('\n⑯ step/start：一步的时长必须含"想"的时间')
{
  /**
   * 真机事故：面板上出现刺眼的「长条 + 0.1s」—— 容量条编码的是**思考字数**（那个是真的），
   * 旁边的秒数却只数了工具。因为聚合器没处理 `step/start`，一步的起点只能落到
   * `assistant/message`（模型**已经想完**、工具调用刚落盘那一刻）。
   *
   * 夹具照抄真实日志顺序（session-*.jsonl）：
   *   step/start → （想了 30 秒）→ assistant/message → tool/call → tool/result → step/end
   */
  const t = createTrace('s16')
  applySessionEvent(t, { type: 'turn/start', time: T0, data: { turn: 1 } }, T0)
  const startChange = applySessionEvent(t, { type: 'step/start', time: T0 + 10, data: { turn: 1, step: 1 } }, T0 + 10)
  ok('step/start 建出这一步', lastTurn(t).steps.length === 1)
  ok('改动带 status=thinking', startChange[0] && startChange[0].status === 'thinking', startChange[0])
  ok('起点就是 step/start 的时刻', lastTurn(t).steps[0].startedAt === T0 + 10, lastTurn(t).steps[0].startedAt)

  // 想完才落盘：assistant/message 晚 30 秒
  applySessionEvent(t, {
    type: 'assistant/message', time: T0 + 30010,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想了很多字'.repeat(200) }] } },
  }, T0 + 30010)
  ok('assistant/message 不许把起点往后推', lastTurn(t).steps[0].startedAt === T0 + 10, lastTurn(t).steps[0].startedAt)

  applySessionEvent(t, { type: 'tool/call', time: T0 + 30020, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } }, T0 + 30020)
  applySessionEvent(t, { type: 'tool/result', time: T0 + 30050, data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [] } } }, T0 + 30050)
  applySessionEvent(t, { type: 'step/end', time: T0 + 30060, data: { turn: 1, step: 1 } }, T0 + 30060)

  const s = lastTurn(t).steps[0]
  ok('时长 = 思考 + 工具（不是那 40ms 的工具）', s.endedAt - s.startedAt === 30050, s.endedAt - s.startedAt)
  ok('工具耗时单独看仍然是 40ms', s.tools[0].endedAt - s.tools[0].startedAt === 30, s.tools[0])
  ok('字数还是真思考的字数（1000）', s.reasoning.length === 1000, s.reasoning.length)
  ok('宿主侧的 stepElapsed 同一个数', stepElapsed(s, T0 + 99999) === 30050, stepElapsed(s, T0 + 99999))
}

console.log('\n⑯b 起点只许往前：流帧先到、step/start 后到')
{
  const t = createTrace('s16b')
  applyStreamFrame(t, frame('start', { attemptId: 'a1', turn: 1, step: 1 }), T0 + 5)
  ok('流帧先给了起点', lastTurn(t).steps[0].startedAt === T0 + 5, lastTurn(t).steps[0].startedAt)
  applySessionEvent(t, { type: 'step/start', time: T0, data: { turn: 1, step: 1 } }, T0)
  ok('step/start 把起点往前挪到真实时刻', lastTurn(t).steps[0].startedAt === T0, lastTurn(t).steps[0].startedAt)
}

console.log('\n⑯c 历史回放：没有流帧，时长口径也必须一致（真机截图那两条的回归）')
{
  /**
   * 面板后开 / 只读日志时，一条流帧都没有，只有耐久事件 —— 这正是截图的来源。
   * 旧口径下：一步的时长 = 纯工具耗时，于是「想得多、工具快」的那一步比
   * 「没怎么想、工具慢」的那一步**更短**，条长（字数）和数字看着互相打架。
   */
  const t = createTrace('s16c')
  const evs = [
    { type: 'turn/start', time: T0, data: { turn: 1 } },
    // #1：想了 3700 字（≈ 条长 80%），工具只跑 100ms
    { type: 'step/start', time: T0 + 100, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: T0 + 9000, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'x'.repeat(3700) }] } } },
    { type: 'tool/call', time: T0 + 9010, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', time: T0 + 9110, data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [] } } },
    { type: 'step/end', time: T0 + 9120, data: { turn: 1, step: 1 } },
    // #2：只想了 365 字（≈ 条长 48%），工具跑了 1.3s
    { type: 'step/start', time: T0 + 9130, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', time: T0 + 9200, data: { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: 'y'.repeat(365) }] } } },
    { type: 'tool/call', time: T0 + 9210, data: { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', time: T0 + 10510, data: { turn: 1, step: 2, message: { source: { callId: 'c2' }, content: [] } } },
    { type: 'step/end', time: T0 + 10520, data: { turn: 1, step: 2 } },
  ]
  for (const ev of evs) applySessionEvent(t, ev, T0)
  const [a, b] = lastTurn(t).steps
  const da = a.endedAt - a.startedAt
  const db = b.endedAt - b.startedAt
  ok('#1 时长 = 想 8.9s + 工具 0.1s', da === 9020, da)
  ok('#2 时长 = 想 0.07s + 工具 1.3s', db === 1390, db)
  ok('两条口径一致（都从 step/start 起算）',
    a.startedAt === T0 + 100 && b.startedAt === T0 + 9130, [a.startedAt, b.startedAt])
  // 这一条就是截图那个矛盾的回归：字数多 10 倍的那一步，时长不该反而更短
  ok('字数多 10 倍的步，时长不再反而更短', da > db, [da, db])
}

console.log('\n⑯d step/start 的脏数据')
{
  const t = createTrace('s16d')
  ok('缺 step 安静跳过',
    applySessionEvent(t, { type: 'step/start', time: T0, data: { turn: 1 } }, T0).length === 0)
  ok('缺 turn 安静跳过',
    applySessionEvent(t, { type: 'step/start', time: T0, data: { step: 1 } }, T0).length === 0)
  ok('没有凭空造出 step', t.turns.reduce((n, x) => n + x.steps.length, 0) === 0)
}

console.log('\n㊾ 晚到的旧轮次事件不能凭空造出一轮')
{
  // 真实事故：第 24 轮的两个 tool/result 在第 51 轮跑到一半时才写进日志，
  // 而第 24 轮早被淘汰（只留最近 N 轮）—— 聚合器凭空造出一个只有 2 步、
  // 永远不结束的"第 24 轮"，还排在最新一轮后面；面板倒序渲染，它跑到了最上面。
  const tr = createTrace('s1')
  // 先堆出第 40–51 轮（第 24 轮不在其中 = 已被淘汰）
  for (let turn = 40; turn <= 51; turn += 1) {
    applySessionEvent(tr, { type: 'turn/start', time: T0 + turn * 1000, data: { turn } }, T0)
    applySessionEvent(tr, { type: 'step/start', time: T0 + turn * 1000 + 1, data: { turn, step: 1 } }, T0)
    applySessionEvent(tr, { type: 'step/end', time: T0 + turn * 1000 + 2, data: { turn, step: 1 } }, T0)
    applySessionEvent(tr, { type: 'turn/end', time: T0 + turn * 1000 + 3, data: { turn } }, T0)
  }
  const before = tr.turns.length
  ok('先有 12 轮', before === 12, before)

  // 晚到的旧轮次结果（第 24 轮）
  const ch = applySessionEvent(tr, {
    type: 'tool/result', time: T0 + 99999,
    data: { turn: 24, step: 4, message: { source: { kind: 'tool', callId: 'x' }, content: [{ type: 'text', text: 'hi' }] } },
  }, T0)
  ok('晚到的旧轮次事件被丢掉（没有改动）', ch.length === 0, ch)
  ok('没有凭空多出一轮', tr.turns.length === before, tr.turns.length)
  ok('没有出现"第 24 轮"', !tr.turns.some((t) => t.turn === 24), tr.turns.map((t) => t.turn))
  ok('轮次仍然有序', tr.turns.every((t, i) => i === 0 || tr.turns[i - 1].turn < t.turn), tr.turns.map((t) => t.turn))

  // 但**认识**的轮次（还在保留窗口里），晚到的调用照旧落进去
  const ch2 = applySessionEvent(tr, {
    type: 'tool/call', time: T0 + 100000,
    data: { turn: 51, step: 1, callId: 'late1', name: 'bash', arguments: '{"command":"npm test"}' },
  }, T0)
  ok('保留窗口内的轮次照旧收下晚到的调用', ch2.length === 1, ch2)
  const t51 = tr.turns.find((t) => t.turn === 51)
  ok('落到了它自己那一轮上', t51.steps[0].tools.length === 1, t51.steps[0].tools.length)

  // 新轮次（编号更大）当然要收
  const ch3 = applySessionEvent(tr, { type: 'turn/start', time: T0 + 200000, data: { turn: 52 } }, T0)
  ok('编号更大的新轮次正常收下', ch3.length === 1 && tr.turns.length === before + 1, tr.turns.length)
}

console.log('\n㊿ note 只给命令类工具采集')
{
  // 只有命令类工具（bash/pwsh/terminal）的 description 是"这条命令在干什么"。
  // present 的 description 是**每个文件的说明**、ask_user_question 的是**问题描述** ——
  // 早先不分工具一律抓第一个 description，把文件说明也当成了命令说明。
  const t = createTrace('s-note')
  const call = (callId, name, args) => applySessionEvent(t, {
    type: 'tool/call', time: T0, data: { turn: 1, step: 1, callId, name, arguments: args },
  }, T0)
  call('b1', 'bash', '{"command":"npm test","description":"Run tests after the change"}')
  call('p1', 'present', '{"files":[{"description":"预览页：行里只留派生标题","path":"/a/x.html"}]}')
  call('a1', 'ask_user_question', '{"questions":[{"description":"我一直在打转","question":"选哪个"}]}')
  call('w1', 'pwsh', '{"command":"Get-ChildItem","description":"List the directory"}')
  const tools = t.turns[0].steps[0].tools
  const by = (id) => tools.find((x) => x.id === id)
  ok('bash 的说明被采集', by('b1').note === 'Run tests after the change', by('b1').note)
  ok('pwsh 的说明也被采集（命令类）', by('w1').note === 'List the directory', by('w1').note)
  ok('present 的**文件说明**不当成命令说明', by('p1').note === undefined, by('p1').note)
  ok('ask_user_question 的**问题描述**也不采集', by('a1').note === undefined, by('a1').note)
}

console.log('\n㊿b 工具失败：宿主说失败，面板就必须看得见')
{
  /**
   * 夹具**逐字来自真实日志**（`~/.dsh/sessions/.../session.v4.jsonl.zstd` 第 127 条，
   * 就是下面这个 `ask_user_question` 参数少字段那次）。
   *
   * 为什么非要真形状：失败结果的字段**长什么样全靠宿主**（`message.isError` 在哪一层、
   * `error` 挂 `data` 还是 `message` 上）。凭印象写夹具的话，实现和测试会共享同一个误解 ——
   * 这个仓库已经因为"凭想象造帧"吃过一次亏（见 ⑮ chunk 帧不带 turn/step）。
   */
  const realCall = { type: 'tool/call', seq: 126, time: T0, data: { turn: 1, step: 18, callId: 'call_00_glNyRzBo7gtFOh7Jtmkx8193', name: 'ask_user_question', arguments: '{"questions":[{"id":"mount"}]}' } }
  const realResult = {
    type: 'tool/result', seq: 127, time: T0 + 9, sourceEventSeqs: [126], surfaceOp: 'append',
    data: {
      turn: 1, step: 18,
      message: {
        role: 'tool', source: { kind: 'tool', callId: 'call_00_glNyRzBo7gtFOh7Jtmkx8193' },
        toolCallId: 'call_00_glNyRzBo7gtFOh7Jtmkx8193',
        content: [{ type: 'text', text: 'Error: invalid arguments: missing required property "questions[2].id"; missing required property "questions[2].question"' }],
        isError: true, id: 'cbe4c1db-3ded-43ef-8fe3-a8361dc8fc9a',
      },
      error: { name: 'ToolArgsError', code: 'INVALID_ARGS' },
    },
  }
  const t = createTrace('s-fail')
  applySessionEvent(t, realCall, T0)
  const ch = applySessionEvent(t, realResult, T0 + 9)
  const tool = t.turns[0].steps[0].tools[0]
  ok('失败落到工具事实上', tool.failed !== undefined, tool.failed)
  ok('错误码照抄（机读的那个，不改写）', tool.failed.code === 'INVALID_ARGS', tool.failed.code)
  ok('错误类名也留着', tool.failed.name === 'ToolArgsError', tool.failed.name)
  ok('摘要是给人读的那句，且**去掉了 `Error: ` 前缀**',
    tool.failed.text.startsWith('invalid arguments:'), tool.failed.text)
  ok('失败也要记结束时间与返回字数（结果确实回来了）',
    tool.endedAt === T0 + 9 && tool.resultChars > 0, { endedAt: tool.endedAt, resultChars: tool.resultChars })

  const end = ch.find((c) => c.k === 'tool-end')
  ok('增量里带上失败（面板不用等下次快照）', end && end.failed && end.failed.code === 'INVALID_ARGS', end)

  // 成功的结果**不带** failed 字段 —— "没标失败"是有依据的成功（宿主每次都写 isError）
  const t2 = createTrace('s-ok')
  applySessionEvent(t2, realCall, T0)
  const ch2 = applySessionEvent(t2, {
    type: 'tool/result', time: T0 + 5,
    data: {
      turn: 1, step: 18,
      message: { role: 'tool', source: { kind: 'tool', callId: realCall.data.callId }, content: [{ type: 'text', text: '好的' }], isError: false },
    },
  }, T0 + 5)
  const okTool = t2.turns[0].steps[0].tools[0]
  ok('成功的结果不带 failed', okTool.failed === undefined)
  ok('成功的增量里**连这个键都没有**（不给成功路径增体积）',
    !Object.prototype.hasOwnProperty.call(ch2[0], 'failed'), Object.keys(ch2[0]))

  // 没有 error 字段的失败：实测 104 条失败里 7 条这样（审批被拒 / 派发前被取消）
  const t3 = createTrace('s-nocode')
  applySessionEvent(t3, realCall, T0)
  applySessionEvent(t3, {
    type: 'tool/result', time: T0 + 3,
    data: {
      turn: 1, step: 18,
      message: { role: 'tool', source: { kind: 'tool', callId: realCall.data.callId }, content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }], isError: true },
    },
  }, T0 + 3)
  const noCode = t3.turns[0].steps[0].tools[0]
  ok('没有 error 字段也照样是失败（这是最需要显示的那种）', noCode.failed !== undefined, noCode.failed)
  ok('没有码时不编一个', noCode.failed.code === undefined && noCode.failed.name === undefined, noCode.failed)
  ok('摘要仍取到那句话', noCode.failed.text === 'tool call aborted before dispatch', noCode.failed.text)

  // 判据必须严格：`isError` 只要不是布尔 true 都不算
  for (const [what, val] of [['字符串 "true"', 'true'], ['0 / false', false], ['缺失', undefined]]) {
    const tx = createTrace('s-strict')
    applySessionEvent(tx, realCall, T0)
    applySessionEvent(tx, {
      type: 'tool/result', time: T0 + 2,
      data: { turn: 1, step: 18, message: { source: { callId: realCall.data.callId }, content: [{ type: 'text', text: 'Error: x' }], isError: val } },
    }, T0 + 2)
    ok(`isError 是${what}时不算失败`, tx.turns[0].steps[0].tools[0].failed === undefined)
  }

  // 长文本 / 多行：截到上限，且压成一行（拒绝理由里带换行，一行装不下）
  const long = 'Error: ' + 'x'.repeat(400) + '\n\n再看这段：' + 'y'.repeat(50)
  const t4 = createTrace('s-long')
  applySessionEvent(t4, realCall, T0)
  applySessionEvent(t4, {
    type: 'tool/result', time: T0 + 2,
    data: { turn: 1, step: 18, message: { source: { callId: realCall.data.callId }, content: [{ type: 'text', text: long }], isError: true } },
  }, T0 + 2)
  const lt = t4.turns[0].steps[0].tools[0].failed
  ok('超长摘要截到上限', lt.text.length === 200, lt.text.length)
  ok('换行被压平（一行放得下）', !/\s{2,}/.test(lt.text) && lt.text.indexOf('\n') < 0, lt.text.slice(0, 60))

  // 失败**不改变**这一步在干什么：状态说的是"进度"，失败是"结果" —— 两者不能混
  const t5 = createTrace('s-status')
  applySessionEvent(t5, realCall, T0)
  applySessionEvent(t5, { type: 'tool/call', time: T0, data: { turn: 1, step: 18, callId: 'c2', name: 'read', arguments: '{}' } }, T0)
  applySessionEvent(t5, realResult, T0 + 9)
  const turn5 = t5.turns[0]
  ok('一个失败 + 一个还在跑 → 仍是 waiting', stepStatus(turn5.steps[0], turn5) === 'waiting',
    stepStatus(turn5.steps[0], turn5))
  applySessionEvent(t5, {
    type: 'tool/result', time: T0 + 12,
    data: { turn: 1, step: 18, message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'ok' }], isError: false } },
  }, T0 + 12)
  ok('两个结果都收了 → 不再是 waiting（失败不把这一步钉在"等"上）',
    stepStatus(turn5.steps[0], turn5) !== 'waiting', stepStatus(turn5.steps[0], turn5))
  // 流结束 → ready。这一步在真实会话里**恰恰是失败最常被看到的时刻**：
  // 模型写完"我去跑个命令"就结束流，工具随后失败，而 step/end 还没到。
  applyStreamFrame(t5, frame('start', { attemptId: 'a9', turn: 1, step: 18 }), T0 - 100)
  applyStreamFrame(t5, frame('end', { attemptId: 'a9' }), T0 + 20)
  ok('流也结束了 → ready（失败不把这一步钉在异常上）', stepStatus(turn5.steps[0], turn5) === 'ready',
    stepStatus(turn5.steps[0], turn5))
}

// ───────────────────── 轮标题的默认素材：本轮用户消息 ─────────────────────

{
  const t = createTrace('s')
  const ev = (type, data) => ({ type, time: 1000, data })
  // ⚠️ user/message **没有 turn 字段**（靠事件顺序归属）。这条曾经被函数开头的
  // `if (turn === undefined) return []` 整条丢掉 —— 真机表现：轮标题的默认层一条都不出现。
  applySessionEvent(t, ev('turn/start', { turn: 1 }), 1000)
  const changes = applySessionEvent(t, ev('user/message', {
    source: { kind: 'user' }, content: [{ type: 'text', text: '我想看 20 轮之前的思维链' }],
  }), 1001)
  ok('user/message（无 turn 字段）没被丢掉', changes.length === 1 && changes[0].k === 'turn', changes)
  ok('记到了那一轮上', t.turns[0].userText === '我想看 20 轮之前的思维链', t.turns[0].userText)
  ok('变更里带 userText（面板不用等下次快照）', changes[0].userText === '我想看 20 轮之前的思维链')

  // 注入的三类不算"用户说了什么"
  const t2 = createTrace('s')
  applySessionEvent(t2, ev('turn/start', { turn: 1 }), 1000)
  for (const kind of ['skill-catalog', 'runtime-context', 'compact-checkpoint']) {
    applySessionEvent(t2, ev('user/message', { source: { kind }, content: [{ type: 'text', text: '注入的内容' }] }), 1001)
  }
  ok('注入的三类不记（不是"这一轮要什么"）', t2.turns[0].userText === undefined, t2.turns[0].userText)

  // 每轮只记第一条
  const t3 = createTrace('s')
  applySessionEvent(t3, ev('turn/start', { turn: 1 }), 1000)
  applySessionEvent(t3, ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] }), 1001)
  applySessionEvent(t3, ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第二句' }] }), 1002)
  ok('每轮只记第一条（第一条才是诉求）', t3.turns[0].userText === '第一句', t3.turns[0].userText)

  // 太长要裁
  const t4 = createTrace('s')
  applySessionEvent(t4, ev('turn/start', { turn: 1 }), 1000)
  // ⚠️ 长度要**跟着常量走**，不能写死：常量从 160 抬到 1000 时，
  //    写死的 900 字就不再是"超长"了，于是这条断言假红（真的踩到过）。
  const LONG = USER_TEXT_CHARS + 500
  applySessionEvent(t4, ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(LONG) }] }), 1001)
  ok('超长裁到 USER_TEXT_CHARS', t4.turns[0].userText.length === USER_TEXT_CHARS, t4.turns[0].userText.length)
  ok('（前提）素材确实比上限长', LONG > USER_TEXT_CHARS, [LONG, USER_TEXT_CHARS])

  // 归到**当前**那一轮，不是第一轮
  const t5 = createTrace('s')
  applySessionEvent(t5, ev('turn/start', { turn: 1 }), 1000)
  applySessionEvent(t5, ev('turn/start', { turn: 2 }), 2000)
  applySessionEvent(t5, ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮的话' }] }), 2001)
  ok('归到当前轮（不是第一轮）',
    t5.turns[0].userText === undefined && t5.turns[1].userText === '第二轮的话',
    t5.turns.map((x) => x.userText))

  // 还没有任何轮次时先不记（等 turn/start）
  const t6 = createTrace('s')
  applySessionEvent(t6, ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '抢跑' }] }), 500)
  ok('还没有轮次时不记（等 turn/start）', t6.turns.length === 0, t6.turns.length)
}

// ───────────────────── 轮标题：去掉开头的序号 ─────────────────────

{
  // 真实数据：109 条真人消息里 10 条是 `1、…` 开头，0 条是"数字+空格"或圈码
  const strip = [
    ['1、默认层没有出现', '默认层没有出现'],
    ['2、第 8 条（异常）加', '第 8 条（异常）加'],
    ['（3）切看原文', '切看原文'],
    ['(4) 只改徽章', '只改徽章'],
    ['一、整个面板统一', '整个面板统一'],
    ['① 反转', '反转'],
    ['3. 改成两字', '改成两字'],
    ['1：先看结构', '先看结构'],
  ]
  for (const [input, want] of strip) {
    ok('去掉序号：' + input + ' → ' + want, stripEnumPrefix(input) === want, stripEnumPrefix(input))
  }
  // ⚠️ 误伤防线：开头的数字如果不是序号，一个字都不能动
  const keep = [
    '20轮之前的思维链怎么看',
    '20 轮之前的思维链怎么看',
    '一个会话，如果我想看20轮之前的思维链',
    '2026 年的计划',
    '3D 视图怎么开',
  ]
  for (const input of keep) {
    ok('不误伤：' + input, stripEnumPrefix(input) === input, stripEnumPrefix(input))
  }
  // 只去一个：后面那些是内容的一部分
  ok('只去开头那一个序号',
    stripEnumPrefix('1、去重 2、多个工具多行显示') === '去重 2、多个工具多行显示',
    stripEnumPrefix('1、去重 2、多个工具多行显示'))
  // 整条就是个序号 → 别删成空串
  ok('只有序号时不删空', stripEnumPrefix('1、') === '1、', stripEnumPrefix('1、'))

  // 接到轨迹上：存下来的 userText 已经是干净的
  const t = createTrace('s')
  applySessionEvent(t, { type: 'turn/start', time: 1000, data: { turn: 1 } }, 1000)
  applySessionEvent(t, {
    type: 'user/message', time: 1001,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '1、默认层没有出现 2、历史轮次没有默认层' }] },
  }, 1001)
  ok('轨迹里的 userText 已去掉序号', t.turns[0].userText === '默认层没有出现 2、历史轮次没有默认层', t.turns[0].userText)
}

// ───────────────────── 汇总 ─────────────────────

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
