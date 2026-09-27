#!/usr/bin/env node
/**
 * 宿主路由测试。
 *
 * 为什么需要它：`test-trace.mjs` 只覆盖纯函数 `trace.ts`，
 * 而**真正容易出错的一层**（SSE 分帧、快照形状、按需取原文、LRU、
 * 节流合并）全在 `index.ts` 的路由里，之前零覆盖。
 *
 * 做法：用桩 ctx 跑真实的 `apply()`，把注册的路由抓出来，
 * 再用假的 req/res 直接调用——测的是构建产物本身，不是它的复制品。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

/** 标题缓存写到临时目录，绝不碰用户的 ~/.dsh。 */
const TMP_DIR = mkdtempSync(join(tmpdir(), 'think-flow-test-'))
const TMP_TITLES = join(TMP_DIR, 'titles.json')
/** notes 那两节专用（前后两次调用要共用，但不能跟别的用例共用）。 */
const NOTES_TITLES = join(TMP_DIR, 'notes-titles.json')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const T0 = Date.now()

// ───────────────────── 桩：ctx / req / res ─────────────────────

/** 跑一次 apply，返回抓到的路由与事件订阅入口。 */
/** 每个 boot() 一个序号，用来给缓存文件起唯一名字（见下面那段说明）。 */
let bootSeq = 0

function boot(config, opts = {}) {
  const routes = new Map()
  const listeners = new Map()
  /** 收集 ctx.effect 的清理函数，供"卸载"用例复现真实 dispose。 */
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    // cordis 会把服务同时挂在 ctx 上（ctx.llm）和 ctx.get('llm')；两者都要有
    llm: opts.llm,
    agentDefaultModel: opts.model,
    on(event, fn) {
      const arr = listeners.get(event) ?? []
      arr.push(fn)
      listeners.set(event, arr)
      return () => {}
    },
    effect(fn) {
      const d = fn()
      disposers.push(typeof d === 'function' ? d : () => {})
      return typeof d === 'function' ? d : () => {}
    },
    get(name) {
      if (name === 'llm') return opts.llm
      if (name === 'agentDefaultModel') return opts.model
      if (name === 'sessionPersistence') return opts.persistence
      if (name === 'sessionQuery') return opts.sessionQuery
      return undefined
    },
    webServer: {
      register(spec) { routes.set(spec.path, spec.handler); return () => {} },
    },
  }
  /**
   * ⚠️ 默认给**每个实例一个独立**的缓存文件。
   *
   * 所有用例都用 `session=s1&turn=1` 这同一个键 —— 共用一个文件的话，前一个用例写的条目
   * 会被后一个用例读到（`saveTitleCache` 又是**异步落盘**的，所以还取决于时序）。
   * 这套测试因此偶发失败过：同一份代码跑两次，一次 108 通过、一次 106 通过。
   * 要测"跨实例持久化"的用例，显式传 `titleCachePath` 即可。
   */
  const cachePath = (config && config.titleCachePath) || join(TMP_DIR, 'titles-' + (bootSeq += 1) + '.json')
  apply(ctx, { ...Config({}), titleCachePath: cachePath, ...(config || {}) })
  return {
    routes,
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    /** 模拟插件被卸载 / 热重载：跑一遍所有 effect 的清理函数。 */
    dispose() { for (const d of [...disposers].reverse()) d() },
    handler(path) {
      const h = routes.get(path)
      if (!h) throw new Error('no route: ' + path)
      return h
    },
  }
}

/** 假 res：收集写出的内容。 */
function fakeRes() {
  const chunks = []
  const handlers = {}
  return {
    status: 0,
    headers: null,
    ended: false,
    chunks,
    on(ev, fn) { handlers[ev] = fn },        // ServerResponse 也有 .on（error 等）
    emitRes(ev) { handlers[ev] && handlers[ev]() },
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(s) { chunks.push(s); return true },
    end(s) { if (s) chunks.push(s); this.ended = true },
    /** 已写出的 JSON 体（非 SSE 路由用）。 */
    json() { return JSON.parse(chunks.join('').replace(/^data: /, '')) },
    /** SSE 事件列表。 */
    events() {
      return chunks.join('').split('\n\n').filter((s) => s.startsWith('data: '))
        .map((s) => JSON.parse(s.slice(6)))
    },
  }
}

/** 假 req。 */
function fakeReq(url) {
  const handlers = {}
  return {
    url,
    on(ev, fn) { handlers[ev] = fn },
    close() { handlers['close'] && handlers['close']() },
  }
}

const API = '/think-flow/api'

/** 造一个真实的流式帧（chunk 帧不带 turn/step，与宿主一致）。 */
function startFrame(attemptId, turn, step, sessionId = 's1') {
  return { agent: { session: { id: sessionId } }, frame: { type: 'start', attemptId, revision: 1, turn, step } }
}
function chunkFrame(attemptId, index, text, sessionId = 's1') {
  return {
    agent: { session: { id: sessionId } },
    frame: { type: 'chunk', attemptId, revision: index + 2, index, time: T0, chunk: { type: 'reasoning-delta', index, text } },
  }
}
function toolCall(turn, step, callId, name) {
  return [{ id: 's1' }, { type: 'tool/call', time: T0, data: { turn, step, callId, name, arguments: '{}' } }]
}

/**
 * 造一条**失败**的 tool/result —— 形状逐字抄自真实日志（11525 条事件里第 127 条）。
 *
 * 抄真形状的理由：`isError` 在 `data.message` 里、`error` 在 `data.error` 里，
 * 凭印象很容易写反（挂到 message 上），那样测试会跟着实现一起错。
 * @param time - 事件时间。
 * @param callId - 它回应哪次调用。
 * @param text - 结果正文（宿主固定是 `Error: <一句话>`）。
 * @param info - 宿主的 `{ name, code }`；没有就传 undefined（实测 104 条失败里 7 条没有）。
 * @returns 一条 `session/event` 事件。
 */
function failedResult(time, callId, text, info) {
  return {
    type: 'tool/result', time, sourceEventSeqs: [], surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
        content: [{ type: 'text', text }], isError: true, id: 'msg-' + callId,
      },
      ...(info === undefined ? {} : { error: info }),
    },
  }
}

/** 造一条**成功**的 tool/result（同样的形状，`isError: false`）。 */
function okResult(time, callId, text, turn = 1, step = 1) {
  return {
    type: 'tool/result', time,
    data: {
      turn, step,
      message: {
        role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
        content: [{ type: 'text', text }], isError: false, id: 'msg-' + callId,
      },
    },
  }
}

// ───────────────────── ① 路由都注册上了 ─────────────────────

console.log('\n① 路由注册')
{
  const app = boot()
  for (const p of ['stream', 'trace', 'step', 'turn', 'sessions', 'titles', 'ping']) {
    ok(`注册了 ${API}/${p}`, app.routes.has(`${API}/${p}`))
  }
  ok('共 8 条路由', app.routes.size === 8, app.routes.size)
}

// ───────────────────── ② /ping ─────────────────────

console.log('\n② /ping')
{
  const app = boot()
  const res = fakeRes()
  app.handler(`${API}/ping`)(fakeReq(`${API}/ping`), res)
  const body = res.json()
  ok('返回 ok', body.ok === true)
  ok('带 build 号（用来确认跑的是哪一版代码）', typeof body.build === 'number', body.build)
  ok('带配置回显', body.config && body.config.sseThrottleMs !== undefined)
}

// ───────────────────── ③ /trace 快照 ─────────────────────

console.log('\n③ /trace')
{
  const app = boot()
  const res0 = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace`), res0)
  ok('缺 session → 400', res0.status === 400, res0.status)

  const res1 = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=nope`), res1)
  const unknown = res1.json()
  ok('未知会话 → known:false 而不是报错', unknown.known === false && unknown.turns.length === 0)

  // 喂一帧两步
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  app.emit('agent/assistant-stream', chunkFrame('a1', 0, 'hello world'))
  app.emit('session/event', ...toolCall(1, 1, 'c1', 'bash'))
  app.emit('agent/assistant-stream', startFrame('a2', 1, 2))
  app.emit('agent/assistant-stream', chunkFrame('a2', 0, 'second step thinking'))

  const res2 = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), res2)
  const snap = res2.json()
  ok('known:true 且有一个 turn', snap.known === true && snap.turns.length === 1)
  ok('两步都在', snap.turns[0].steps.length === 2)
  ok('思考字数被统计（不是 0）', snap.turns[0].steps[0].reasoningChars === 11, snap.turns[0].steps[0].reasoningChars)
  ok('工具调用被记录', snap.turns[0].steps[0].tools.length === 1)
  ok('只有"当前步"带原文尾部（其余按需取）', snap.turns[0].steps[0].reasoningTail === undefined && typeof snap.turns[0].steps[1].reasoningTail === 'string')
  ok('快照带 serverTime', typeof snap.serverTime === 'number')
  // 正文开头（~160 字）：客户端拿它算**无工具步的行标题**（首句摘要）。
  // 没有正文的步**不给这个字段**（不白占带宽）。
  ok('没有正文的步不带 textHead', snap.turns[0].steps.every((s) => s.textHead === undefined),
    snap.turns[0].steps.map((s) => s.textHead))
  app.emit('session/event', { id: 's1' }, {
    type: 'assistant/message', time: T0 + 9,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已经改好了，测试也过了。后面还有一段。' }] } },
  })
  const res2b = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), res2b)
  const snap2 = res2b.json()
  ok('有正文的步带上 textHead（就是正文开头）',
    snap2.turns[0].steps[0].textHead === '已经改好了，测试也过了。后面还有一段。', snap2.turns[0].steps[0].textHead)
  ok('textHead 只给开头那一段（有上限）', snap2.turns[0].steps[0].textHead.length <= 160)
}

// ───────────────────── ④ /step 按需取原文 ─────────────────────

console.log('\n④ /step（面板展开历史步骤靠它）')
{
  const app = boot()
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  app.emit('agent/assistant-stream', chunkFrame('a1', 0, 'AAAA'))
  app.emit('agent/assistant-stream', chunkFrame('a1', 1, 'BBBB'))

  const bad = fakeRes()
  app.handler(`${API}/step`)(fakeReq(`${API}/step?session=s1`), bad)
  ok('缺参数 → 400', bad.status === 400, bad.status)

  const missing = fakeRes()
  app.handler(`${API}/step`)(fakeReq(`${API}/step?session=s1&turn=9&step=9`), missing)
  ok('不存在的步骤 → 404', missing.status === 404, missing.status)

  const good = fakeRes()
  app.handler(`${API}/step`)(fakeReq(`${API}/step?session=s1&turn=1&step=1`), good)
  const body = good.json()
  ok('返回完整原文', body.reasoning === 'AAAABBBB', body.reasoning)
  ok('带上 streamGap 标记', body.streamGap === false)
  ok('回显 turn/step', body.turn === 1 && body.step === 1)
  // ⚠️ 这一个接口同时给**思考**与**正文** —— 客户端展开区两块都用它（早先只取了 reasoning）
  ok('正文也在同一个响应里（展开区要用）', body.text === '', JSON.stringify(body.text))
  app.emit('session/event', { id: 's1' }, {
    type: 'assistant/message', time: T0 + 9,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '答案正文' }] } },
  })
  const good2 = fakeRes()
  app.handler(`${API}/step`)(fakeReq(`${API}/step?session=s1&turn=1&step=1`), good2)
  ok('有正文时 /step 同时回思考与正文',
    good2.json().reasoning === 'AAAABBBB' && good2.json().text === '答案正文',
    [good2.json().reasoning, good2.json().text])
}

// ───────────────────── ⑤ /stream SSE ─────────────────────

console.log('\n⑤ /stream')
{
  const app = boot()
  const bad = fakeRes()
  app.handler(`${API}/stream`)(fakeReq(`${API}/stream`), bad)
  ok('缺 session → 400', bad.status === 400, bad.status)

  const req = fakeReq(`${API}/stream?session=s1`)
  const res = fakeRes()
  app.handler(`${API}/stream`)(req, res)
  await new Promise((r) => setTimeout(r, 0))   // 快照在 hydrate 之后异步发
  ok('响应头是 text/event-stream', String(res.headers['content-type']).startsWith('text/event-stream'))
  ok('关掉中间层缓冲（否则流式会被攒成一批）', res.headers['x-accel-buffering'] === 'no')

  const first = res.events()
  ok('连上先发一份快照', first.length === 1 && first[0].t === 'snapshot')

  // 推一步：start + 增量，应当以 change 形式到达
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  app.emit('agent/assistant-stream', chunkFrame('a1', 0, 'hello'))
  await new Promise((r) => setTimeout(r, 200))
  const evts = res.events()
  const change = evts.find((e) => e.t === 'change')
  ok('增量以 change 推送', !!change, evts.map((e) => e.t))
  ok('change 带权威 status', change && change.change.status === 'thinking', change && change.change.status)

  req.close()
}

// ───────────────────── ⑥ 节流合并 ─────────────────────

console.log('\n⑥ 节流：连续增量要合并，不能逐字推')
{
  const app = boot({ sseThrottleMs: 100 })
  const req = fakeReq(`${API}/stream?session=s1`)
  const res = fakeRes()
  app.handler(`${API}/stream`)(req, res)
  await new Promise((r) => setTimeout(r, 0))
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  for (let i = 0; i < 30; i += 1) app.emit('agent/assistant-stream', chunkFrame('a1', i, 'x'))
  await new Promise((r) => setTimeout(r, 300))
  const changes = res.events().filter((e) => e.t === 'change')
  ok('30 个增量远少于 30 条推送', changes.length < 10, changes.length)
  const joined = changes.map((e) => (e.change && e.change.text) || '').join('')
  ok('合并后文本不丢', joined === 'x'.repeat(30), joined.length)
  req.close()
}

// ───────────────────── ⑦ 心跳 ─────────────────────

console.log('\n⑦ 心跳（防代理掐连接）')
{
  const app = boot({ heartbeatMs: 250 })
  const req = fakeReq(`${API}/stream?session=s1`)
  const res = fakeRes()
  app.handler(`${API}/stream`)(req, res)
  await new Promise((r) => setTimeout(r, 700))
  ok('收到至少一次 ping', res.events().some((e) => e.t === 'ping'))
  req.close()
  // 断开后不再继续写
  const before = res.chunks.length
  await new Promise((r) => setTimeout(r, 500))
  ok('断开后停止推送', res.chunks.length === before, [before, res.chunks.length])
}

// ───────────────────── ⑧ LRU 淘汰 ─────────────────────

console.log('\n⑧ 会话 LRU 上限')
{
  const app = boot({ maxSessions: 2 })
  for (const id of ['a', 'b', 'c']) {
    app.emit('agent/assistant-stream', { agent: { session: { id } }, frame: { type: 'start', attemptId: id + '1', revision: 1, turn: 1, step: 1 } })
  }
  const res = fakeRes()
  app.handler(`${API}/sessions`)(fakeReq(`${API}/sessions`), res)
  const list = res.json().sessions
  ok('最多保留 maxSessions 个', list.length <= 2, list.length)
  ok('最旧的被淘汰（a 不在）', !list.some((s) => s.sessionId === 'a'), list.map((s) => s.sessionId))
  ok('最新的还在（c 在）', list.some((s) => s.sessionId === 'c'))
}

// ───────────────────── ⑨ 原文长度上限 ─────────────────────

console.log('\n⑨ 单步原文上限（从尾部保留，并如实标记）')
{
  const app = boot({ maxReasoningCharsPerStep: 1000 })
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  // 攒超过 1000 字
  for (let i = 0; i < 12; i += 1) app.emit('agent/assistant-stream', chunkFrame('a1', i, 'y'.repeat(100)))
  const res = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), res)
  const step = res.json().turns[0].steps[0]
  ok('字数被限制在上限附近', step.reasoningChars <= 1200, step.reasoningChars)
  ok('截断过就标记 streamGap（不假装完整）', step.streamGap === true)
}


// ───────────────────── ⑩ /titles 中文标题（按需生成 + 缓存） ─────────────────────

console.log('\n⑩ /titles')
{
  /** 造一个会吐指定文本的 llm 桩，并记录调用次数。 */
  const makeLlm = (text) => {
    const calls = []
    return {
      calls,
      stream(options) {
        calls.push(options)
        return {
          async *[Symbol.asyncIterator]() {
            // 分两段吐，模拟真实的流式
            yield { type: 'text-delta', index: 0, text: text.slice(0, 8) }
            yield { type: 'text-delta', index: 0, text: text.slice(8) }
          },
        }
      },
    }
  }
  const model = { currentSelection: () => ({ provider: 'p', model: 'm' }) }

  // 缺参数（这一节要验"文件写出去了"，所以显式用那个共用路径）
  const app0 = boot({ titleCachePath: TMP_TITLES })
  const r0 = fakeRes()
  await app0.handler(`${API}/titles`)(fakeReq(`${API}/titles`), r0)
  ok('缺参数 → 400', r0.status === 400, r0.status)

  // 未知 turn
  const r1 = fakeRes()
  await app0.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=nope&turn=1`), r1)
  ok('未知 turn → 404', r1.status === 404, r1.status)

  // 正常生成
  const llm = makeLlm('{"titles":["读懂需求与手上范例","确认插件装配方式"]}')
  const app = boot({ titleCachePath: TMP_TITLES }, { llm, model })
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  app.emit('agent/assistant-stream', chunkFrame('a1', 0, 'The user wants a plugin'))
  app.emit('agent/assistant-stream', startFrame('a2', 1, 2))
  app.emit('agent/assistant-stream', chunkFrame('a2', 0, 'So plugins are installed as bundles'))

  const r2 = fakeRes()
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), r2)
  const out = r2.json()
  ok('生成成功', out.ok === true, out)
  ok('按步骤号映射标题', out.titles['1'] === '读懂需求与手上范例' && out.titles['2'] === '确认插件装配方式', out.titles)
  ok('首次不是缓存命中', out.cached === false)
  ok('调用了一次模型', llm.calls.length === 1, llm.calls.length)
  ok('请求带上了 provider/model', llm.calls[0].provider === 'p' && llm.calls[0].model === 'm')
  ok('用 system 传达了"只输出 JSON"', JSON.stringify(llm.calls[0].messages).includes('titles'))

  // 第二次应命中缓存，不再调用模型
  const r3 = fakeRes()
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), r3)
  ok('第二次命中缓存', r3.json().cached === true, r3.json())
  ok('缓存命中时没有再调模型', llm.calls.length === 1, llm.calls.length)

  // 缓存已落盘
  ok('缓存文件已写出', existsSync(TMP_TITLES))
  const onDisk = JSON.parse(readFileSync(TMP_TITLES, 'utf8'))
  // v2 缓存：**按步存**（增量生成要能一次只补几步），不再是"整轮一个数组 + 整轮指纹"
  ok('落盘内容按步存（v2）',
    onDisk['s1:1'] && onDisk['s1:1'].steps && onDisk['s1:1'].steps['1'] && onDisk['s1:1'].steps['1'].title === '读懂需求与手上范例',
    onDisk['s1:1'])

  // ── 工具说明的翻译（`bash` 的 description → 中文，贴在派生标题后面）──
  {
    const notesLlm = makeLlm('{"titles":["核对插槽注册的入参形状"],"notes":{"c1":"改动后重跑测试"}}')
    // ⚠️ 这两次调用要**共用**一个文件（第二次验的就是"命中缓存、没再调模型"），
    // 但又不能和别的用例共用（都用 s1:1 这个键）
    const appN = boot({ titleCachePath: NOTES_TITLES }, { llm: notesLlm, model })
    // 一步：有思考 + 一条带 description 的 bash 命令
    appN.emit('agent/assistant-stream', startFrame('n1', 1, 1))
    appN.emit('agent/assistant-stream', chunkFrame('n1', 0, 'Let me run the tests'))
    appN.emit('session/event', { id: 's1' }, {
      type: 'tool/call', time: T0,
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"cd /a && npm test","description":"Run tests after the change"}' },
    })
    const rN = fakeRes()
    await appN.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), rN)
    const outN = rN.json()
    ok('返回里带上了说明的中文翻译', outN.notes && outN.notes.c1 === '改动后重跑测试', outN.notes)
    // 提示词里必须带上那句英文说明（否则模型没得翻）
    const prompt = JSON.stringify(notesLlm.calls[0].messages)
    ok('提示词里带上了英文说明', prompt.includes('Run tests after the change'), prompt.slice(0, 200))
    ok('提示词里带上了工具 id（好让它按 key 回）', prompt.includes('c1'))
    ok('提示词里说明了要翻成中文', prompt.includes('翻'), prompt.slice(0, 300))

    // 快照要把它下发（按工具 id）—— 刷新页面不必重新生成
    const rSnap = fakeRes()
    await appN.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), rSnap)
    const snap = rSnap.json()
    ok('快照下发了 notes（按工具 id）', snap.turns[0].notes && snap.turns[0].notes.c1 === '改动后重跑测试', snap.turns[0].notes)
    // 快照**刻意不下发**工具的英文说明：客户端一个地方都不读它，
    // 纯占体积（实测 20 轮快照里 11.7KB / 5.2%）。翻译走 turn.notes。
    ok('快照不再下发工具的英文说明', snap.turns[0].steps[0].tools[0].note === undefined,
      snap.turns[0].steps[0].tools[0])

    // 说明变了 → 指纹变 → 不能吃旧缓存
    const rN2 = fakeRes()
    await appN.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), rN2)
    ok('第二次命中缓存（没再调模型）', rN2.json().cached === true && notesLlm.calls.length === 1, notesLlm.calls.length)

    const appN2 = boot({ titleCachePath: NOTES_TITLES }, { llm: notesLlm, model })
    appN2.emit('agent/assistant-stream', startFrame('n2', 1, 1))
    appN2.emit('agent/assistant-stream', chunkFrame('n2', 0, 'Let me run the tests'))
    appN2.emit('session/event', { id: 's1' }, {
      type: 'tool/call', time: T0,
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"cd /a && npm test","description":"A DIFFERENT note"}' },
    })
    const rN3 = fakeRes()
    await appN2.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), rN3)
    ok('说明改了 → 指纹变 → 重新生成', rN3.json().cached === false, rN3.json().cached)
  }

  // ── 增量生成：只补"还没有 / 已经变了"的步 ──
  {
    const resp = { text: '{"titles":["第一步的标题"]}' }
    const llm = {
      calls: [],
      stream(o) {
        llm.calls.push(o)
        const t = resp.text
        return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', index: 0, text: t } } }
      },
    }
    const appI = boot({}, { llm, model })
    appI.emit('agent/assistant-stream', startFrame('i1', 1, 1))
    appI.emit('agent/assistant-stream', chunkFrame('i1', 0, 'First step thinking'))
    const rA = fakeRes()
    await appI.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), rA)
    ok('先给第 1 步起标题', rA.json().titles['1'] === '第一步的标题' && llm.calls.length === 1, rA.json())

    // 同轮第 2 步出现 → 再点一次：**只补第 2 步**（第 1 步的缓存还有效，不重算）
    appI.emit('agent/assistant-stream', startFrame('i2', 1, 2))
    appI.emit('agent/assistant-stream', chunkFrame('i2', 0, 'Second step thinking'))
    resp.text = '{"titles":["第二步的标题"]}'
    const rB = fakeRes()
    await appI.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), rB)
    const promptB = JSON.stringify(llm.calls[1].messages)
    ok('第二次只发**新增那一步**（增量，不重算）',
      promptB.includes('Second step thinking') && !promptB.includes('First step thinking'), promptB.slice(0, 200))
    ok('返回里两步的标题都在（旧的来自缓存 + 新的刚生成）',
      rB.json().titles['1'] === '第一步的标题' && rB.json().titles['2'] === '第二步的标题', rB.json().titles)

    // force=1 → 整轮重来
    resp.text = '{"titles":["重算一","重算二"]}'
    const rC = fakeRes()
    await appI.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1&force=1`), rC)
    const promptC = JSON.stringify(llm.calls[2].messages)
    ok('force=1 时两步都重发',
      promptC.includes('First step thinking') && promptC.includes('Second step thinking'), promptC.slice(0, 200))
    ok('force 后标题被换掉', rC.json().titles['1'] === '重算一' && rC.json().titles['2'] === '重算二', rC.json().titles)

    // 内容变了（同一步又长了思考）→ 该步重算。
    // ⚠️ index 必须接在下一个（聚合器有缺口守卫：`index !== nextIndex` 直接丢，
    // 早先这里又写 0，于是那条增量根本没进去、断言假红）
    appI.emit('agent/assistant-stream', chunkFrame('i2', 1, ' more'))
    resp.text = '{"titles":["变过之后"]}'
    const rD = fakeRes()
    await appI.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), rD)
    ok('某一步内容变了 → 只重算那一步',
      llm.calls[3] && JSON.stringify(llm.calls[3].messages).includes('Second step thinking more')
      && !JSON.stringify(llm.calls[3].messages).includes('First step thinking'), rD.json().titles)
  }

  // ── 自动标题：开关 + 节拍器 ──
  {
    const autoLlm = makeLlm('{"titles":["自动起的标题"]}')
    const appA = boot({ autoTickMs: 20 }, { llm: autoLlm, model })
    // ⚠️ 先挂一个 SSE 订阅：宿主只给"**有人在看**"的会话自动生成
    // （插件同时跟踪最多 32 个会话，没人看就不该花 token）。
    // 真实场景里开关本来就是从面板点开的，那时订阅一定在。
    const sse = fakeRes()
    appA.handler(`${API}/stream`)(fakeReq(`${API}/stream?session=s1`), sse)
    await new Promise((r) => setTimeout(r, 0))
    appA.emit('agent/assistant-stream', startFrame('a1', 1, 1))
    appA.emit('agent/assistant-stream', chunkFrame('a1', 0, 'Auto title thinking'))

    // 默认关：不给这一步起标题（点一次 /titles 会报"没有待生成"，也不该调模型）
    const rOff = fakeRes()
    await appA.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), rOff)
    ok('默认是关的', rOff.json().auto === false, rOff.json().auto)

    // 开 → 立刻开始补（等节拍器跑一拍）
    const rOn = fakeRes()
    await appA.handler(`${API}/auto`)(fakeReq(`${API}/auto?session=s1&on=1`), rOn)
    ok('开关能打开', rOn.json().auto === true, rOn.json())
    await new Promise((r) => setTimeout(r, 120))
    ok('自动生成调了模型', autoLlm.calls.length === 1, autoLlm.calls.length)
    // ⚠️ 用户第 2 条：**轮结束**时才自动总结整轮标题。这一轮还在跑 → 自动那条路不该要它。
    ok('轮还在跑 → 自动路径不生成整轮标题',
      !JSON.stringify(autoLlm.calls[0].messages).includes('本轮最后的输出（请据此写整轮标题'),
      '素材块不该出现')
    // 补一条正文（AI 输出）再让轮结束 → 自动路径这时才要整轮标题
    appA.emit('session/event', { id: 's1' }, { type: 'assistant/message', time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Auto title thinking' }, { type: 'text', text: '这一轮的最终回答' }] } } })
    appA.emit('session/event', { id: 's1' }, { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: 'stop' } })
    await new Promise((r) => setTimeout(r, 160))
    const lastCall = autoLlm.calls[autoLlm.calls.length - 1]
    ok('轮结束后 → 自动路径要了整轮标题',
      JSON.stringify(lastCall.messages).includes('本轮最后的输出（请据此写整轮标题'),
      autoLlm.calls.length)
    const rSnap = fakeRes()
    await appA.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), rSnap)
    ok('快照里能看到自动起的标题', rSnap.json().turns[0].titles['1'] === '自动起的标题',
      rSnap.json().turns[0].titles)
    ok('快照里的开关状态是开', rSnap.json().auto === true, rSnap.json().auto)
    // 面板不是靠快照拿到新标题的，是靠 SSE **推**过来的
    const pushed = sse.events().filter((e) => e.t === 'titles')
    ok('新标题通过 SSE 推给了面板',
      pushed.length >= 1 && pushed[0].titles['1'] === '自动起的标题', pushed)
    // 面板上那枚「实时」胶囊靠这个脉冲，用户才知道它在干活
    const busy = sse.events().filter((e) => e.t === 'autoBusy').map((e) => e.busy)
    // 每一批都是"开始 true → 结束 false"成对出现（可能不止一批：步标题一批、整轮标题一批）
    const paired = busy.length > 0 && busy.length % 2 === 0
      && busy.every((b, i) => (i % 2 === 0 ? b === true : b === false))
    ok('busy 成对推送（每批都是 true → false）', paired, busy)

    // 关 → 不再自动生成
    const before = autoLlm.calls.length
    const rOff2 = fakeRes()
    await appA.handler(`${API}/auto`)(fakeReq(`${API}/auto?session=s1&on=0`), rOff2)
    appA.emit('agent/assistant-stream', startFrame('a2', 1, 2))
    appA.emit('agent/assistant-stream', chunkFrame('a2', 0, 'Another step'))
    await new Promise((r) => setTimeout(r, 120))
    ok('关掉之后不再自动调模型', autoLlm.calls.length === before, autoLlm.calls.length)
    ok('关掉后快照里的状态是关', (await (async () => {
      const r = fakeRes()
      await appA.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), r)
      return r.json().auto
    })()) === false)
  }

  // 新会话复用同一进程缓存：指纹不同 → 重新生成
  const r4 = fakeRes()
  app.emit('agent/assistant-stream', { agent: { session: { id: 's2' } }, frame: { type: 'start', attemptId: 'b1', revision: 1, turn: 1, step: 1 } })
  app.emit('agent/assistant-stream', { agent: { session: { id: 's2' } }, frame: { type: 'chunk', attemptId: 'b1', revision: 2, index: 0, time: T0, chunk: { type: 'reasoning-delta', index: 0, text: 'x'.repeat(50) } } })
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s2&turn=1`), r4)
  // 桩只返回 2 条，而 s2 只有 1 步 → 条数不符，应当拒绝而不是错位
  ok('条数对不上就拒绝（不错位）', r4.json().ok === false, r4.json())
  ok('拒绝的原因说清了条数不一致', String(r4.json().error).includes('条数'), r4.json().error)

  // 快照带上已缓存的标题
  const r5 = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), r5)
  const snap = r5.json()
  ok('快照里的标题按步骤号索引（不是数组，杜绝错位）', snap.turns[0].titles && snap.turns[0].titles['1'] === '读懂需求与手上范例', snap.turns[0].titles)
  ok('快照标题条数正确', Object.keys(snap.turns[0].titles).length === 2, snap.turns[0].titles)
  ok('快照标注了标题来自哪个模型', snap.turns[0].titlesFrom === 'p/m', snap.turns[0].titlesFrom)
}

// ───────────────────── ⑪ /titles：找不到模型路由 ─────────────────────

console.log('\n⑪0 整轮标题：轮结束才生成，素材是本轮最后的 AI 输出')
{
  const makeLlm = (text) => {
    const calls = []
    return {
      calls,
      stream(options) {
        calls.push(options)
        return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', index: 0, text } } }
      },
    }
  }
  const model = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
  const OUT = '这一轮把标题的第二行改成了两行层级布局'

  // 一轮：两步，第二步是最终回答（正文 = 整轮标题的素材）
  const seed = (app, sid) => {
    app.emit('agent/assistant-stream', startFrame('t1', 1, 1, sid))
    app.emit('agent/assistant-stream', chunkFrame('t1', 0, 'first step thinking', sid))
    app.emit('session/event', { id: sid }, { type: 'step/end', time: T0, data: { turn: 1, step: 1 } })
    app.emit('agent/assistant-stream', startFrame('t2', 1, 2, sid))
    app.emit('agent/assistant-stream', chunkFrame('t2', 0, 'second step thinking', sid))
    app.emit('session/event', { id: sid }, { type: 'assistant/message', time: T0 + 5,
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'second step thinking' }, { type: 'text', text: OUT }] } } })
  }
  const promptOf = (call) => JSON.stringify(call.messages)

  // ① **手动点按钮**：轮没结束也要生成整轮标题（用户明确要求：点「生成标题」也生成轮标题）
  const runningLlm = makeLlm('{"titles":["第一步","第二步"],"notes":{},"turnTitle":"按当前输出先总结一版"}')
  const appRun = boot({}, { llm: runningLlm, model })
  seed(appRun, 'run')
  const rRun = fakeRes()
  await appRun.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=run&turn=1`), rRun)
  // ⚠️ 不能拿"本轮最后的输出"这个字样去判 —— 系统提示里本来就有这句话。
  // 要看的是**素材正文**有没有进 user 消息。
  const userOf = (call) => JSON.stringify((call.messages || []).filter((m) => m.role === 'user'))
  ok('手动点（轮没结束）→ 素材进了提示词', userOf(runningLlm.calls[0]).includes(OUT))
  ok('手动点（轮没结束）→ 也返回 turnTitle',
    rRun.json().turnTitle === '按当前输出先总结一版', rRun.json().turnTitle)

  // ② 轮结束 → 生成整轮标题，且素材进了提示词
  const llm = makeLlm('{"titles":["第一步","第二步"],"notes":{},"turnTitle":"改好轮头两行层级"}')
  const app = boot({}, { llm, model })
  seed(app, 'done')
  app.emit('session/event', { id: 'done' }, { type: 'turn/end', time: T0 + 9, data: { turn: 1, reason: 'stop' } })
  const r1 = fakeRes()
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=done&turn=1`), r1)
  ok('轮结束 → 返回了 turnTitle', r1.json().turnTitle === '改好轮头两行层级', r1.json().turnTitle)
  ok('素材（本轮最后的输出）进了提示词', userOf(llm.calls[0]).includes(OUT))
  // 只看**素材块**那一段：步骤清单里本来就含第一步的思考原文，不能拿整条 user 消息判
  const materialOf = (call) => {
    const u = userOf(call)
    const i = u.indexOf('本轮最后的输出')
    return i < 0 ? '' : u.slice(i, i + 600)
  }
  ok('素材块用的是**最后**那条正文（不是第一步的思考）',
    materialOf(llm.calls[0]).includes(OUT) && !materialOf(llm.calls[0]).includes('first step thinking'),
    materialOf(llm.calls[0]).slice(0, 120))

  // ③ 快照下发（刷新页面不用重新生成）
  const r2 = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=done`), r2)
  ok('快照里带上了整轮标题', r2.json().turns[0].turnTitle === '改好轮头两行层级', r2.json().turns[0].turnTitle)

  // ④ 第二次点：命中缓存，不再调模型
  const before = llm.calls.length
  const r3 = fakeRes()
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=done&turn=1`), r3)
  ok('第二次命中缓存（没再调模型）', llm.calls.length === before, llm.calls.length - before)
  ok('缓存命中也回传 turnTitle', r3.json().turnTitle === '改好轮头两行层级', r3.json().turnTitle)

  // ⑤ 本轮最后的输出变了 → 整轮标题要重算
  app.emit('session/event', { id: 'done' }, { type: 'assistant/message', time: T0 + 20,
    data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: OUT + '（又改了一句）' }] } } })
  const r4 = fakeRes()
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=done&turn=1`), r4)
  ok('输出变了 → 重新调了模型', llm.calls.length === before + 1, llm.calls.length - before)
  ok('输出变了 → 新标题被采用', r4.json().turnTitle === '改好轮头两行层级', r4.json().turnTitle)
}

console.log('\n⑪ /titles：没有可用模型时给出可读错误')
{
  const app = boot({}, { llm: { stream() { throw new Error('不应被调用') } }, model: { currentSelection: () => undefined } })
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  app.emit('agent/assistant-stream', chunkFrame('a1', 0, 'some thinking'))
  const res = fakeRes()
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), res)
  const out = res.json()
  ok('返回失败而不是抛错', out.ok === false)
  ok('错误信息可读', String(out.error).includes('模型路由'), out.error)
}

// ───────────────────── ⑫ /titles：模型报错不炸插件 ─────────────────────

console.log('\n⑫ /titles：模型调用失败要被接住')
{
  const llm = {
    stream() {
      return { async *[Symbol.asyncIterator]() { throw new Error('upstream 500') } }
    },
  }
  const model = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
  const app = boot({}, { llm, model })
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  app.emit('agent/assistant-stream', chunkFrame('a1', 0, 'thinking'))
  const res = fakeRes()
  await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=s1&turn=1`), res)
  ok('HTTP 200 + ok:false（不把异常抛给服务器）', res.status === 200 && res.json().ok === false, res.json())
  ok('错误里带上游原因', String(res.json().error).includes('upstream 500'), res.json().error)
}


// ───────────────────── ⑬ 历史回看：从落盘会话折出轨迹 ─────────────────────

console.log('\n⑬ /trace 历史回看（内存里空 → 从落盘折）')
{
  // 造一份"落盘事件"，形状与真实 session 日志一致
  const persisted = [
    { type: 'turn/start', time: T0, data: { turn: 1 } },
    { type: 'tool/call', time: T0 + 10, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
    // ⚠️ 这条**逐字来自真实日志**（`session.v4.jsonl.zstd` 里那次参数少字段的
    //    ask_user_question）：失败结果的形状必须按真的来，见 ㉑ 的说明。
    failedResult(T0 + 15, 'c1', 'Error: invalid arguments: missing required property "questions[2].id"',
      { name: 'ToolArgsError', code: 'INVALID_ARGS' }),
    {
      type: 'assistant/message', time: T0 + 20,
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '从落盘读出来的思考' },
            { type: 'text', text: '这是正文' },
          ],
        },
      },
    },
    { type: 'step/end', time: T0 + 30, data: { turn: 1, step: 1 } },
    { type: 'turn/start', time: T0 + 40, data: { turn: 2 } },
    {
      type: 'assistant/message', time: T0 + 50,
      data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '第二轮的思考' }] } },
    },
    { type: 'step/end', time: T0 + 60, data: { turn: 2, step: 1 } },
    { type: 'turn/end', time: T0 + 70, data: { turn: 2, reason: 'stop' } },
  ]
  let opened = 0
  let closed = 0
  const persistence = {
    async open(id, mode) {
      opened += 1
      return {
        async read() { return { events: persisted } },
        async close() { closed += 1 },
      }
    },
  }

  const app = boot({}, { persistence })
  const res = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=old-session`), res)
  const snap = res.json()
  ok('回看后 known:true', snap.known === true)
  ok('折出了两个 turn', snap.turns.length === 2, snap.turns.length)
  ok('思考原文从落盘读出来了', snap.turns[0].steps[0].reasoningChars === '从落盘读出来的思考'.length,
    snap.turns[0].steps[0].reasoningChars)
  ok('工具调用也折出来了', snap.turns[0].steps[0].tools.length === 1)
  /**
   * 失败态在**历史回看**这条路上也要有 —— 面板最常被打开的场合恰恰是"回头看这一轮
   * 到底怎么了"，那时内存是空的，一切都从落盘折出来。
   */
  const histTool = snap.turns[0].steps[0].tools[0]
  ok('落盘的失败也被折出来', histTool.failed !== undefined, histTool.failed)
  ok('带机读码', histTool.failed.code === 'INVALID_ARGS', histTool.failed.code)
  ok('摘要去掉了 `Error: ` 前缀', histTool.failed.text.startsWith('invalid arguments:'), histTool.failed.text)
  ok('步状态正确（step/end → done）', snap.turns[0].steps[0].status === 'done', snap.turns[0].steps[0].status)
  ok('第二轮收尾正常（未被误判中断）', snap.turns[1].interrupted === false)
  ok('打开过落盘句柄', opened === 1)
  ok('句柄被关掉了（不泄漏）', closed === 1)

  // 第二次请求：内存里已经有了，不该再去读盘
  const res2 = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=old-session`), res2)
  ok('第二次不再读盘（内存已有）', opened === 1, opened)

  // 历史 turn 也能生成标题（原文已在内存里）
  const llm = {
    calls: [],
    stream(o) {
      this.calls.push(o)
      return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', index: 0, text: '{"titles":["从落盘折出的结论"]}' } } }
    },
  }
  const app2 = boot({}, { persistence, llm, model: { currentSelection: () => ({ provider: 'p', model: 'm' }) } })
  const r3 = fakeRes()
  await app2.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=old2&turn=1`), r3)
  // old2 的内存为空 → /titles 也会先 hydrate，拿到落盘的那份
  ok('历史 turn 也能生成标题', r3.json().ok === true, r3.json())
}

// ───────────────────── ⑭ 历史回看：读盘失败不能影响实时 ─────────────────────

console.log('\n⑭ 历史回看失败要静默降级')
{
  const persistence = { async open() { throw new Error('session is locked') } }
  const app = boot({}, { persistence })
  // 实时事件先喂进来
  app.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  app.emit('agent/assistant-stream', chunkFrame('a1', 0, 'live thinking'))
  const res = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), res)
  const snap = res.json()
  ok('读盘失败时实时数据照常返回', snap.turns.length === 1 && snap.turns[0].steps[0].reasoningChars === 13,
    snap.turns[0] && snap.turns[0].steps[0].reasoningChars)
}


// ───────────────────── ⑮ 会话状态：读不到 ≠ 还没开始 ─────────────────────

console.log('\n⑮ 会话状态（known 布尔说不清的三件事）')
{
  // ① 读不到：open 抛错
  const bad = boot({}, { persistence: { async open() { throw new Error('locked') } } })
  const r1 = fakeRes()
  await bad.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=gone`), r1)
  ok('读不到 → state:unreadable', r1.json().state === 'unreadable', r1.json().state)
  ok('读不到 → known:false', r1.json().known === false)

  // ② 新会话：能读但还没有事件
  const fresh = boot({}, { persistence: { async open() { return { async read() { return { events: [] } }, async close() {} } } } })
  const r2 = fakeRes()
  await fresh.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=new-one`), r2)
  ok('空会话 → state:empty（而不是 unreadable）', r2.json().state === 'empty', r2.json().state)

  // ③ 有实时事件：live
  const live = boot()
  live.emit('agent/assistant-stream', startFrame('a1', 1, 1))
  live.emit('agent/assistant-stream', chunkFrame('a1', 0, 'x'))
  const r3 = fakeRes()
  await live.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), r3)
  ok('收到实时事件 → state:live', r3.json().state === 'live', r3.json().state)

  // ④ 从落盘折出来的：hydrated
  const persisted = [
    { type: 'turn/start', time: T0, data: { turn: 1 } },
    { type: 'assistant/message', time: T0 + 10, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'old thinking' }] } } },
    { type: 'step/end', time: T0 + 20, data: { turn: 1, step: 1 } },
  ]
  const hydro = boot({}, { persistence: { async open() { return { async read() { return { events: persisted } }, async close() {} } } } })
  const r4 = fakeRes()
  await hydro.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=old`), r4)
  ok('从落盘折出 → state:hydrated', r4.json().state === 'hydrated', r4.json().state)
  ok('hydrated 同时 known:true', r4.json().known === true)

  // ⑤ 读不到之后来了实时事件 → 回到 live（别一直挂着"读不到"）
  bad.emit('agent/assistant-stream', startFrame('b1', 1, 1, 'gone'))
  bad.emit('agent/assistant-stream', chunkFrame('b1', 0, 'later live', 'gone'))
  const r5 = fakeRes()
  await bad.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=gone`), r5)
  ok('状态从 unreadable 回到 live', r5.json().state === 'live', r5.json().state)

  // ⑥ ⚠️ 回归：会话**正在跑**时打开面板 —— 流式帧先到（内存先长出 1 轮），
  //    这时 hydrate 也必须把历史折进来。早先的条件是"有轮次就早退"，
  //    于是历史**永远折不进来**（真机：日志里 103 轮 / 1747 步，面板只剩 1 轮 4 步）。
  //    夹具里把那一轮也放进"日志"，因为宿主的日志是随事件写的（真实情况下它就在里面）。
  const persistedRacy = [
    ...persisted,
    { type: 'turn/start', time: T0 + 100, data: { turn: 9 } },
    { type: 'assistant/message', time: T0 + 110, data: { turn: 9, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'live first' }] } } },
  ]
  const racy = boot({}, { persistence: { async open() { return { async read() { return { events: persistedRacy } }, async close() {} } } } })
  racy.emit('agent/assistant-stream', startFrame('z1', 9, 1, 'racy'))   // 先来实时帧
  racy.emit('agent/assistant-stream', chunkFrame('z1', 0, 'live first', 'racy'))
  const r6 = fakeRes()
  await racy.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=racy`), r6)
  const tsR = (r6.json().turns || []).map((t) => t.turn)
  ok('**实时帧先到时，历史照样折进来**（这正是 bug 的触发条件）', tsR.includes(1), tsR)
  ok('那一轮实时数据也在', tsR.includes(9), tsR)

  // ⑦ ⚠️ 回归：折叠**读盘期间**来的实时事件不能被抹掉
  //    （折叠最后一步是"清空 + 重放"，直接应用的事件会被这一下清掉）
  let releaseRead
  const readGate = new Promise((res) => { releaseRead = res })
  const slow = boot({}, { persistence: { async open() { return {
    async read() { await readGate; return { events: persisted } },
    async close() {},
  } } } })
  const pending = slow.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=slow`), fakeRes())
  slow.emit('agent/assistant-stream', startFrame('s1', 5, 1, 'slow'))      // 折叠还在读盘
  slow.emit('agent/assistant-stream', chunkFrame('s1', 0, 'during hydrate', 'slow'))
  releaseRead()
  await pending
  const r7 = fakeRes()
  await slow.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=slow`), r7)
  const tsS = (r7.json().turns || []).map((t) => t.turn)
  ok('折叠期间来的实时事件没被抹掉', tsS.includes(5), tsS)
  ok('历史也在（同一份轨迹里）', tsS.includes(1), tsS)
}


// ───────────────────── ⑯ 标题缓存要有上限 ─────────────────────

console.log('\n⑯ 标题缓存按 LRU 修剪（否则文件只增不减）')
{
  const counter = { n: 0 }
  const llm = {
    stream() {
      const i = counter.n++
      return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', index: 0, text: `{"titles":["标题${i}"]}` } } }
    },
  }
  const model = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
  // 上限 3，生成 5 个会话的标题（读的就是这个文件，显式指定）
  const app = boot({ maxTitledTurns: 3, titleCachePath: TMP_TITLES }, { llm, model })
  for (let i = 0; i < 5; i += 1) {
    const sid = 'cap' + i
    app.emit('agent/assistant-stream', startFrame('c' + i, 1, 1, sid))
    app.emit('agent/assistant-stream', chunkFrame('c' + i, 0, 'thinking ' + i, sid))
    const res = fakeRes()
    await app.handler(`${API}/titles`)(fakeReq(`${API}/titles?session=${sid}&turn=1`), res)
    // 每条时间戳至少差 1ms，LRU 才有确定性
    await new Promise((r) => setTimeout(r, 2))
  }
  // 落盘内容读回来（缓存写盘是异步的，等一拍）
  await new Promise((r) => setTimeout(r, 20))
  const onDisk = JSON.parse(readFileSync(TMP_TITLES, 'utf8'))
  const keys = Object.keys(onDisk)
  ok('缓存条数被限制在上限', keys.length <= 3, keys.length)
  ok('保留的是最新的几条（cap4 在）', keys.includes('cap4:1'), keys)
  ok('最旧的被淘汰（cap0 不在）', !keys.includes('cap0:1'), keys)
}

// ───────────────────── ⑰ 卸载要收干净连接 ─────────────────────

console.log('\n⑰ 卸载 / 热重载：已建立的 SSE 连接必须被关闭')
{
  // 症状：热重载后旧 fiber 不再收事件，但旧连接和心跳还活着，
  // 面板从此只收 ping、看起来像卡死，只能手动刷新（真机踩到）。
  const app = boot({ heartbeatMs: 60 })
  const req = fakeReq(`${API}/stream?session=s1`)
  const res = fakeRes()
  app.handler(`${API}/stream`)(req, res)
  await new Promise((r) => setTimeout(r, 0))
  ok('连接建立后还没结束', res.ended === false)
  ok('收到了快照', res.events().some((e) => e.t === 'snapshot'))

  app.dispose()
  ok('dispose 后连接被关闭（不是留成僵尸）', res.ended === true)

  // 心跳也必须停：否则每次热重载都留下一个永不停止的定时器
  const before = res.chunks.length
  await new Promise((r) => setTimeout(r, 200))
  ok('dispose 后心跳也停了', res.chunks.length === before, [before, res.chunks.length])

  // 清理后会话表应当空掉，重来一次是干净状态
  const list = fakeRes()
  app.handler(`${API}/sessions`)(fakeReq(`${API}/sessions`), list)
  ok('会话表被清空', list.json().sessions.length === 0, list.json().sessions.length)
}

// ───────────────────── ⑳ 全轮目录 / 按需取轮 / 搜索 ─────────────────────

/**
 * 这一段测的是"看更早的轮次"这件事：
 *   · 目录（`index`）必须比正文窗口（`turns`）长 —— 早先两者共用一个上限，
 *     133 轮的会话只能看到 20 轮；
 *   · 正文被丢掉的轮，**骨架必须还在**（否则连"更早还有几轮"都不知道）；
 *   · `/turn` 按需把某一轮折回来；
 *   · `/search` 走宿主的 `sessionQuery`，命中只给 seq，要能反查成轮号。
 */
console.log('\n⑳ 全轮目录 / 按需取轮 / 搜索')
{
  /** 造 5 轮，每轮占 6 个 seq（1..6 / 7..12 / …）。 */
  const persisted = []
  for (let n = 1; n <= 5; n += 1) {
    const base = (n - 1) * 6
    persisted.push(
      { seq: base + 1, type: 'turn/start', time: T0 + base, data: { turn: n } },
      { seq: base + 2, type: 'user/message', time: T0 + base + 1,
        data: { content: [{ type: 'text', text: `第${n}轮要什么` }], source: { kind: 'user' } } },
      { seq: base + 3, type: 'step/start', time: T0 + base + 2, data: { turn: n, step: 1 } },
      { seq: base + 4, type: 'assistant/message', time: T0 + base + 3,
        data: { turn: n, step: 1, message: { content: [{ type: 'reasoning', text: `第${n}轮的思考` }] } } },
      { seq: base + 5, type: 'step/end', time: T0 + base + 4, data: { turn: n, step: 1 } },
      { seq: base + 6, type: 'turn/end', time: T0 + base + 5, data: { turn: n, reason: 'stop' } },
    )
  }
  const reads = { open: 0 }
  const persistence = {
    async open() {
      reads.open += 1
      return { async read() { return { events: persisted } }, async close() {} }
    },
  }

  // 正文窗口只留 2 轮 → 目录里应当有 5 轮
  const app = boot({ maxTurnsPerSession: 2 }, { persistence })
  const res = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=old`), res)
  const snap = res.json()
  ok('正文窗口只有 2 轮', snap.turns.length === 2, snap.turns.length)
  ok('目录里 5 轮（正文窗口之外也在）', snap.index.length === 5, snap.index.length)
  ok('目录最新在前', snap.index[0].turn === 5 && snap.index[4].turn === 1,
    [snap.index[0].turn, snap.index[4].turn])
  const s1 = snap.index.find((x) => x.turn === 1)
  ok('丢掉的轮骨架还在（轮号/用户消息/步数）',
    s1 && s1.userText === '第1轮要什么' && s1.steps === 1, s1)
  ok('骨架标了"不在内存里"', s1 && s1.inMemory === false, s1 && s1.inMemory)
  ok('窗口里的轮标了"在内存里"',
    snap.index.find((x) => x.turn === 5).inMemory === true)
  ok('骨架里没有正文（只有字数）',
    s1 && s1.reasoningChars === '第1轮的思考'.length && s1.reasoning === undefined, s1)

  // /turn：把第 1 轮折回来
  const before = reads.open
  const t1 = fakeRes()
  await app.handler(`${API}/turn`)(fakeReq(`${API}/turn?session=old&turn=1`), t1)
  const t1b = t1.json()
  ok('/turn 取回第 1 轮', t1b.ok === true && t1b.turn.turn === 1, t1b.turn && t1b.turn.turn)
  ok('/turn 返回的形状和快照里的一致（客户端能直接塞进去）',
    t1b.turn.steps[0].reasoningChars === '第1轮的思考'.length && t1b.turn.userText === '第1轮要什么', t1b.turn.steps[0])
  ok('/turn 真的又读了一次盘（那一轮不在内存里）', reads.open > before, [before, reads.open])

  const again = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=old`), again)
  ok('取回之后骨架改标成"在内存里"',
    again.json().index.find((x) => x.turn === 1).inMemory === true)

  const t2 = fakeRes()
  await app.handler(`${API}/turn`)(fakeReq(`${API}/turn?session=old&turn=2`), t2)
  const opensAfterFirst = reads.open
  await app.handler(`${API}/turn`)(fakeReq(`${API}/turn?session=old&turn=2`), fakeRes())
  ok('同一轮取第二次不再读盘（冷缓存命中）', reads.open === opensAfterFirst, [opensAfterFirst, reads.open])

  const bad = fakeRes()
  await app.handler(`${API}/turn`)(fakeReq(`${API}/turn?session=old`), bad)
  ok('/turn 缺参数 → 400', bad.status === 400, bad.status)
  const missing = fakeRes()
  await app.handler(`${API}/turn`)(fakeReq(`${API}/turn?session=old&turn=99`), missing)
  ok('/turn 不存在的轮 → 404', missing.status === 404, missing.status)

  // 冷缓存预算：丢正文，但骨架不许丢
  const tiny = boot({ maxTurnsPerSession: 2, maxColdChars: 1 }, { persistence })
  await tiny.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=old`), fakeRes())
  await tiny.handler(`${API}/turn`)(fakeReq(`${API}/turn?session=old&turn=1`), fakeRes())
  const tinyRes = fakeRes()
  await tiny.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=old`), tinyRes)
  const tinySnap = tinyRes.json()
  ok('冷缓存超预算：正文被丢，骨架仍在（5 轮）', tinySnap.index.length === 5, tinySnap.index.length)
  ok('超预算的那轮改回"不在内存里"',
    tinySnap.index.find((x) => x.turn === 1).inMemory === false)
}

console.log('\n㉑ 工具失败：快照与增量都要带上（宿主说了失败，面板才看得见）')
{
  const app = boot()
  app.emit('session/event', ...toolCall(1, 1, 'c1', 'ask_user_question'))
  app.emit('session/event', { id: 's1' },
    failedResult(T0 + 20, 'c1', 'Error: invalid arguments: missing required property "questions[2].id"',
      { name: 'ToolArgsError', code: 'INVALID_ARGS' }))
  app.emit('session/event', ...toolCall(1, 1, 'c2', 'read'))
  app.emit('session/event', { id: 's1' }, okResult(T0 + 30, 'c2', '文件内容'))
  // 没有 error 字段的那种失败（审批被拒 / 派发前被取消）—— 实测 104 条里 7 条这样
  app.emit('session/event', ...toolCall(1, 1, 'c3', 'bash'))
  app.emit('session/event', { id: 's1' }, failedResult(T0 + 40, 'c3', 'Error: tool call aborted before dispatch', undefined))

  const res = fakeRes()
  await app.handler(`${API}/trace`)(fakeReq(`${API}/trace?session=s1`), res)
  const tools = res.json().turns[0].steps[0].tools
  const by = (id) => tools.find((t) => t.id === id)
  ok('快照里带上失败', by('c1').failed !== undefined, by('c1').failed)
  ok('码与类名都在', by('c1').failed.code === 'INVALID_ARGS' && by('c1').failed.name === 'ToolArgsError', by('c1').failed)
  ok('摘要不带 `Error: ` 前缀', by('c1').failed.text.startsWith('invalid arguments:'), by('c1').failed.text)
  ok('没有 error 字段的失败照样带 failed（只是没有码）',
    by('c3').failed !== undefined && by('c3').failed.code === undefined, by('c3').failed)
  /**
   * 成功的工具**连这个键都没有**：快照每 20 轮要序列化一次，
   * 给占 99% 的成功路径加一个恒为 undefined 的字段是白占体积。
   */
  ok('成功的工具不带 failed 这个键', !Object.prototype.hasOwnProperty.call(by('c2'), 'failed'), Object.keys(by('c2')))

  // 增量：SSE 上的 tool-end 也要带失败 —— 否则实时看的时候要等下次快照才变红
  const req = fakeReq(`${API}/stream?session=s2`)
  const sres = fakeRes()
  app.handler(`${API}/stream`)(req, sres)
  await new Promise((r) => setTimeout(r, 0))
  app.emit('session/event', { id: 's2' }, { type: 'tool/call', time: T0, data: { turn: 1, step: 1, callId: 'x1', name: 'bash', arguments: '{}' } })
  app.emit('session/event', { id: 's2' },
    failedResult(T0 + 5, 'x1', 'Error: tool call timed out after 30000ms', { name: 'ToolCallTimeoutError', code: 'TOOL_TIMEOUT' }))
  await new Promise((r) => setTimeout(r, 250))
  const end = sres.events().map((e) => e.change).find((c) => c && c.k === 'tool-end')
  ok('SSE 的 tool-end 带权威状态', end && end.status !== undefined, end && end.status)
  ok('SSE 的 tool-end 带上失败（实时不等快照）', end && end.failed && end.failed.code === 'TOOL_TIMEOUT', end && end.failed)
  req.close()
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
