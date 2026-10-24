#!/usr/bin/env node
/**
 * 卸载/退出时"别把宿主钉住"的回归测试。
 *
 * 场景（真机踩过，2026-10）：宿主退出或更新时先 dispose 插件，再等事件循环排空。
 * 如果插件在"等外部事件"的地方挂了**没 unref 的长定时器**，进程就会空转到它到点
 * 为止 —— 外壳的优雅退出期限（10s）早就过了，于是一条 `shutdown-lingering` 把这次
 * 更新判失败（`dsh-selection-explain` 的 25s 截图轮询就是这么咬人的）。
 *
 * 这里用最贴近的形状量它：让一次"标题生成"卡在 LLM 流上（永不产出、自身不持有任何
 * 句柄），然后 dispose，看**进程多久能走**。生成里的 120s 超时定时器要是没 unref，
 * 这个子进程就得挂 120 秒。
 *
 * ⚠️ 断言前先校验"场景真的发生了"（流确实被调用），否则一个写坏的探针会假装通过。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVICE = pathToFileURL(join(ROOT, 'lib/host/title-service.js')).href
/** 最迟多久必须走完：修复后实测 ~0.3s，没修复则要等 120s 的生成超时。 */
const DEADLINE_MS = 1500
/** 子进程硬上限：到点强杀，断言按"没走完"记失败（别让测试自己等 120 秒）。 */
const CAP_MS = 4000

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

/** 子进程：建服务 → 起一次注定卡住的生成 → dispose → 什么都不做（等进程自己走）。 */
const CHILD = `
import { createTitleService } from ${JSON.stringify(SERVICE)}

let streamEntered = false
const hanging = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
const disposers = []
const ctx = {
  get: (k) => (k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'probe', model: 'probe' }) } : undefined),
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  llm: { stream: () => { streamEntered = true; return hanging } },
}
const config = {
  titleStepChars: 420, titleTotalChars: 24000, titleReasoningEffort: '',
  titleCachePath: ${JSON.stringify(join(ROOT, 'node_modules/.cache/tf-probe-titles.json'))},
  maxTitledTurns: 640, autoTickMs: 1000,
}
const titles = createTitleService(ctx, config, new Map(), () => {})
const turn = {
  turn: 1, startedAt: Date.now(), endedAt: Date.now(),
  steps: [{ step: 1, reasoning: '思考'.repeat(20), text: '', tools: [] }],
}
void titles.generateTitles('probe', turn, true)
await new Promise((r) => setTimeout(r, 250))   // 等它真的走进 stream
for (const d of disposers.reverse()) d()       // 模拟 fiber dispose
const active = process.getActiveResourcesInfo().filter((n) => n !== 'PipeWrap')
console.log('PROBE ' + JSON.stringify({ streamEntered, active }))
`

console.log('\n① 卸载时不许留下钉住宿主的定时器')
{
  const t0 = process.hrtime.bigint()
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', () => { /* 只用 stdout 的结构化结果 */ })
  const cap = setTimeout(() => child.kill('SIGKILL'), CAP_MS)

  const { code, signal } = await new Promise((resolve) => {
    child.on('exit', (c, s) => resolve({ code: c, signal: s }))
  })
  clearTimeout(cap)
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6

  const line = out.split('\n').find((l) => l.startsWith('PROBE '))
  const probe = line === undefined ? undefined : JSON.parse(line.slice('PROBE '.length))
  ok('探针的前提成立（生成真的走进了 LLM 流）', probe?.streamEntered === true, probe)
  ok(
    `dispose 后进程在 ${DEADLINE_MS}ms 内退出（实测 ${elapsed.toFixed(0)}ms）`,
    signal !== 'SIGKILL' && elapsed < DEADLINE_MS,
    { elapsed: Math.round(elapsed), signal, code, active: probe?.active },
  )
  ok('退出码正常（不是被强杀 / 异常退出）', code === 0 && signal === null, { code, signal })
  ok(
    'dispose 之后没有遗留的 Timeout 句柄',
    Array.isArray(probe?.active) && !probe.active.includes('Timeout'),
    probe?.active,
  )
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
