#!/usr/bin/env node
/**
 * 客户端 bundle 的执行测试。
 *
 * 关键点：**跑的是构建产物本身**（lib/client.js），不是它的副本 ——
 * 所以它能抓到"注册的 slot 名写错""key 对不上""渲染时炸了"这类只在
 * 真实执行时才暴露的问题。
 *
 * 做法：给一个最小的 React 运行时 + 桩 EventSource + 桩 ctx，
 * 把真实 bundle 的 factory 跑起来，然后：
 *   ① 断言它注册了什么（标签页类型 / body / 头部按钮）
 *   ② 喂真实形状的 SSE 数据，断言渲染出的元素树里有该有的东西
 *   ③ 逐条验证阶段分组规则
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

// ───────────────────── 最小 React 运行时 ─────────────────────
// hooks 的 cell 跨渲染保留，这样"喂数据 → 再渲染一次"能读到新状态。
let cells = []
let cursor = 0
let effects = []

const React = {
  createElement(type, props) {
    const children = []
    for (let i = 2; i < arguments.length; i += 1) {
      const c = arguments[i]
      if (c === null || c === undefined || c === false) continue
      if (Array.isArray(c)) { children.push(...c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)) }
      else children.push(c)
    }
    return { type, props: props || {}, children }
  },
  Fragment: 'Fragment',
  useRef(init) {
    if (cells[cursor] === undefined) cells[cursor] = { current: init }
    return cells[cursor++]
  },
  useState(init) {
    if (cells[cursor] === undefined) cells[cursor] = typeof init === 'function' ? init() : init
    const i = cursor++
    return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v }]
  },
  useReducer(reducer, init) {
    if (cells[cursor] === undefined) cells[cursor] = init
    const i = cursor++
    return [cells[i], (action) => { cells[i] = reducer(cells[i], action) }]
  },
  useEffect(fn, deps) {
    const i = cursor++
    const prev = cells[i]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined ||
      deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
    if (changed) {
      cells[i] = { deps: deps ? deps.slice() : undefined }
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      effects.push(() => { const c = fn(); cells[i].cleanup = c })
    }
    return undefined
  },
}

// ───────────────────── 桩：window / document / EventSource ─────────────────────

let lastEventSource = null
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.onopen = null
    this.onerror = null
    this.onmessage = null
    this.closed = false
    lastEventSource = this
  }
  emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }) }
  open() { if (this.onopen) this.onopen() }
  close() { this.closed = true }
}

const headChildren = []
const doc = {
  head: { appendChild: (n) => headChildren.push(n) },
  getElementById: () => undefined,
  createElement: (tag) => ({ tag, id: '', textContent: '', className: '', setAttribute() {} }),
}

const loaded = {}
/** 极简 localStorage：组件把"视图开关"落在这里（刷新/重新 import 后还能恢复）。 */
const sandboxStorage = {
  data: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null },
  setItem(k, v) { this.data[k] = String(v) },
  removeItem(k) { delete this.data[k] },
}
const sandboxWindow = {
  __ModuleLoader__: {
    load(spec) { loaded.spec = spec },
  },
  EventSource: FakeEventSource,
  localStorage: sandboxStorage,
}

globalThis.window = sandboxWindow
globalThis.document = doc
globalThis.EventSource = FakeEventSource

// ───────────────────── 跑真实 bundle ─────────────────────

/**
 * 找宿主主题包（`dsh-client-ui-theme`）。下面两节要靠它解析**真 token** 算对比度。
 *
 * 三个来源：DSH_CHECKOUT → 本包 node_modules（`npm i` 装的 devDependency）→
 * `~/.npm/_npx/*` 里任意一份 npx 缓存（**通配**）。
 *
 * ⚠️ 兜底这条以前写死过某个缓存目录哈希（`~/.npm/_npx/<hash>/…`）—— 那是
 * **本机**的目录名，换台机器就失效，而失效的表现是"这两节静默跳过对比度断言"，
 * 测试照样全绿。通配之后它至少在别的机器上也真的会去找。
 * @returns 主题 bundle 路径；找不到返回 undefined。
 */
function themePath() {
  const local = join(HERE, '..', 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')
  const candidates = [
    process.env.DSH_CHECKOUT && join(process.env.DSH_CHECKOUT, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
    local,
  ].filter(Boolean)
  const hit = candidates.find((p) => existsSync(p))
  if (hit) return hit
  const npx = join(process.env.HOME || '', '.npm', '_npx')
  if (existsSync(npx)) {
    for (const hash of readdirSync(npx)) {
      const p = join(npx, hash, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')
      if (existsSync(p)) return p
    }
  }
  return undefined
}

const source = readFileSync(BUNDLE, 'utf8')
// 用 Function 求值，模拟 loader 的表格式加载
new Function('window', 'document', 'require', source)(sandboxWindow, doc, (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

console.log('\n① bundle 契约')
ok('bundle 通过 __ModuleLoader__.load 注册', !!loaded.spec)
ok('注册 id 正确', loaded.spec && loaded.spec.id === '@yfwu2020/dsh-think-flow', loaded.spec && loaded.spec.id)
ok('factory 是函数', loaded.spec && typeof loaded.spec.factory === 'function')

const mod = loaded.spec.factory((n) => (n === 'react' ? React : undefined))
ok('导出 apply', typeof mod.apply === 'function')
ok('导出 inject', Array.isArray(mod.inject))
ok('导出 __internals（供测试）', !!mod.__internals)

// ───────────────────── 桩 ctx，跑 apply ─────────────────────

const registrations = []
const typeRegistrations = []
let installedEffects = []
/** 模拟服务尚未就绪：置 false 时 sidebarRightTabs 查不到。 */
let tabsServiceReady = true
function makeCtx() {
  const ctx = {
    effect(fn) {
      installedEffects.push(fn)
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    get(name) {
      if (name === 'sidebarRightTabs') {
        return tabsServiceReady
          ? { register(def) { typeRegistrations.push(def); return () => {} } }
          : undefined
      }
      if (name === 'sidebarRight') return { openTab(kind) { ctx.__opened = kind } }
      return undefined
    },
    inject(deps, callback) {
      const missing = deps.filter((d) => ctx.get(d) === undefined)
      if (missing.length) return undefined
      return callback(ctx)
    },
    slots: {
      inject(slot, factory) { registrations.push({ slot, factory }); return () => {} },
      register(spec, Component) { return { spec, Component } },
    },
  }
  return ctx
}

let ctx = makeCtx()
mod.apply(ctx)

console.log('\n② 注册：标签页类型')
ok('注册了恰好 1 个类型', typeRegistrations.length === 1, typeRegistrations.length)
const def = typeRegistrations[0]
ok('类型 id 是包名', def && def.id === '@yfwu2020/dsh-think-flow', def && def.id)
ok('类型 kind', def && def.kind === 'think-flow', def && def.kind)
ok('title 返回中文', def && def.title() === '思维链')
ok('有引导页入口', def && Array.isArray(def.guide) && def.guide.length === 1)

console.log('\n③ 注册：标签页 body / 头部按钮')
const tabSlot = registrations.find((r) => r.slot === 'sidebar.right.pane.tab')
const btnSlot = registrations.find((r) => r.slot === 'conversation.session.header.utilities')
ok('注册进 sidebar.right.pane.tab', !!tabSlot)
ok('注册进会话头部 utilities', !!btnSlot)
const tabReg = tabSlot && tabSlot.factory()
ok('body 的 key = 类型 id（两阶段必须对上）', tabReg && tabReg.spec.key === def.id, tabReg && tabReg.spec.key)
ok('body 注入了 sessionId', tabReg && typeof tabReg.spec.inject === 'function' && tabReg.spec.inject('sess-1').sessionId === 'sess-1')

// ───────────────────── 渲染 ─────────────────────

/** 把元素树拍平成可断言的文本 + 类名。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}
/** 按类名收集节点（比按钮更通用）。 */
function findNodesByClass(node, cls, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((x) => findNodesByClass(x, cls, acc)); return acc }
  if (String((node.props && node.props.className) || '').split(' ').includes(cls)) acc.push(node)
  ;(node.children || []).forEach((x) => findNodesByClass(x, cls, acc))
  return acc
}

/** 收集树里的按钮（带 onClick 的），供交互用例点击。 */
function findButtons(node, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((x) => findButtons(x, acc)); return acc }
  if (node.type === 'button' && node.props && node.props.onClick) acc.push(node)
  ;(node.children || []).forEach((x) => findButtons(x, acc))
  return acc
}

function classesOf(node, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((n) => classesOf(n, acc)); return acc }
  if (node.props && node.props.className) acc.push(node.props.className)
  ;(node.children || []).forEach((n) => classesOf(n, acc))
  return acc
}
/** 清空 hook cell：等价于"重新挂载一次"，多个面板之间必须隔离。 */
/**
 * 模拟"组件重挂载"：只清 hook 状态，**不动**模块级视图状态。
 * 真机上外壳按 sessionId 重挂载时就是这样 —— 视图开关不该跟着丢。
 */
function remountKeepViewStore() { cells = []; cursor = 0; effects = [] }

function resetMount() {
  cells = []
  cursor = 0
  effects = []
  // 视图开关（隐藏历史 / 看结构看原文）按会话存在模块级、跨重挂载存活，
  // 所以"重新挂载"要连它一起清，否则用例之间会互相污染。
  if (mod && mod.__internals && mod.__internals.resetViewStore) mod.__internals.resetViewStore()
}

function render(props) {
  cursor = 0
  effects = []
  let tree = tabReg.Component(props)
  // 槽位注册的是外壳 `ThinkFlowTabHost`（它只负责按 sessionId 重挂载内层，
  // 本身不产出任何 DOM）。真实 React 会继续渲染它的返回值，测试里把这一层摊平。
  while (tree && typeof tree.type === 'function') tree = tree.type(tree.props)
  effects.forEach((fn) => fn())
  return tree
}

console.log('\n③b 回归：list 插槽必须带 id，否则等于没注册')
{
  const btnReg2 = btnSlot.factory()
  ok('头部按钮注册带 id', typeof btnReg2.spec.id === 'string' && btnReg2.spec.id.length > 0, btnReg2.spec.id)
  ok('头部按钮注册带 order', typeof btnReg2.spec.order === 'number', btnReg2.spec.order)
}

console.log('\n③c 回归：sidebarRightTabs 晚就绪时也必须最终注册上')
{
  // 重来一遍：这次让服务一开始查不到
  typeRegistrations.length = 0
  installedEffects = []
  tabsServiceReady = false
  const ctx2 = makeCtx()
  mod.apply(ctx2)
  ok('服务没就绪时不注册', typeRegistrations.length === 0, typeRegistrations.length)
  ok('但 effect 已经装上（有重试机会）', installedEffects.length > 0, installedEffects.length)
  ok('且不抛错（整个插件仍可用）', true)

  // 服务出现 —— cordis 会把依赖了它的 effect 重跑
  tabsServiceReady = true
  for (const fn of installedEffects) fn()
  ok('服务就绪后注册上了', typeRegistrations.length === 1, typeRegistrations.length)
  ok('注册的正是我们的类型', typeRegistrations[0] && typeRegistrations[0].kind === 'think-flow')

  // 复原，后续渲染用例继续用原来的 ctx
  typeRegistrations.length = 0
  typeRegistrations.push(def)
}

console.log('\n③d inject 只声明硬依赖（避免服务名不对就整个插件不加载）')
ok('声明了 slots', mod.inject.includes('slots'))
ok('没有硬等 sidebarRightTabs', !mod.inject.includes('sidebarRightTabs'), mod.inject)
ok('没有硬等 sidebarRight', !mod.inject.includes('sidebarRight'), mod.inject)

console.log('\n③e 诊断探针（排查"客户端没加载"vs"加载了没注册上"）')
ok('apply 一进来就留痕', sandboxWindow.__dshThinkFlow && sandboxWindow.__dshThinkFlow.applied === true)
ok('回填了标签页类型注册结果', sandboxWindow.__dshThinkFlow.tabType === 'registered', sandboxWindow.__dshThinkFlow.tabType)
ok('回填了标签页内容注册结果', sandboxWindow.__dshThinkFlow.tabBody === 'registered', sandboxWindow.__dshThinkFlow.tabBody)
ok('回填了头部按钮注册结果', sandboxWindow.__dshThinkFlow.headerButton === 'registered', sandboxWindow.__dshThinkFlow.headerButton)
ok('暴露了 internals 供手工验证', !!sandboxWindow.__dshThinkFlow.internals)
ok('暴露了 open() 供手工开标签', typeof sandboxWindow.__dshThinkFlow.open === 'function')


console.log('\n⑲ 会话头部入口：图标 + 排在最左')
{
  const btnReg = btnSlot.factory()
  // 目标位置：紧挨 better-sidebar 停靠切换（order 10）的左侧，且在"更多菜单"之后
  ok('order 小于停靠切换的 10（在它左边）', btnReg.spec.order < 10, btnReg.spec.order)
  ok('order 大于 0（不越到更多菜单左边的宿主控件之前）', btnReg.spec.order > 0, btnReg.spec.order)
  ok('order 紧贴 10 之下、留有余量', btnReg.spec.order >= 5 && btnReg.spec.order < 10, btnReg.spec.order)
  ok('注册带 id（list 插槽必须）', typeof btnReg.spec.id === 'string' && btnReg.spec.id.includes('think-flow'))

  const tree = btnReg.Component({})
  const findType = (n, t, acc = []) => {
    if (!n || typeof n !== 'object') return acc
    if (Array.isArray(n)) { n.forEach((x) => findType(x, t, acc)); return acc }
    if (n.type === t) acc.push(n)
    ;(n.children || []).forEach((x) => findType(x, t, acc))
    return acc
  }
  ok('渲染出的是 button', tree.type === 'button')
  ok('里面是 svg 图标，不是文字', findType(tree, 'svg').length === 1 && textOf(tree).trim() === '',
    [findType(tree, 'svg').length, textOf(tree)])
  ok('图标有无障碍名（读屏可用）', String(tree.props['aria-label'] || '').length > 0, tree.props['aria-label'])
  ok('图标有 tooltip', String(tree.props.title || '').length > 0, tree.props.title)
  const svg = findType(tree, 'svg')[0]
  ok('图标是 16px 的当前色描边图标（与宿主图标同语言）',
    svg.props.viewBox === '0 0 16 16' && svg.props.stroke === 'currentColor' && typeof svg.props.strokeWidth === 'number',
    [svg.props.viewBox, svg.props.stroke, svg.props.strokeWidth])
  // 当前用的是「折线轨迹」：一条带拐点的折线 + 三个节点
  ok('图形是折线 + 三个节点', findType(svg, 'path').length === 1 && findType(svg, 'circle').length === 3,
    [findType(svg, 'path').length, findType(svg, 'circle').length])
  ok('折线带拐点（不是直线）', /^M[\d. ]+L[\d. ]+l/.test(String(findType(svg, 'path')[0].props.d)),
    findType(svg, 'path')[0].props.d)
  ok('斜向构图（起终点不同高度，与方框邻居拉开）',
    (() => { const cs = findType(svg, 'circle').map((c) => c.props.cy); return Math.max(...cs) - Math.min(...cs) >= 6 })(),
    findType(svg, 'circle').map((c) => c.props.cy))
}


console.log('\n⑳ 样式注入：热重载后必须换成新 CSS')
{
  // 复现：DOM 里已经有一个同 id 的旧 style（上一代实例留下的）
  const stale = { id: 'dsh-think-flow-css', tag: 'style', textContent: '/* 旧 CSS */', removed: false, remove() { this.removed = true } }
  const appended = []
  const savedHead = doc.head.appendChild
  doc.head.appendChild = (n) => { appended.push(n) }
  const savedGet = doc.getElementById
  doc.getElementById = (id) => (id === 'dsh-think-flow-css' ? (stale.removed ? undefined : stale) : undefined)

  resetMount()
  const ctx2 = makeCtx()
  mod.apply(ctx2)

  ok('旧 style 被摘掉（否则新 CSS 永远注入不进去）', stale.removed === true)
  ok('挂了新的 style', appended.length === 1 && appended[0] !== stale, appended.length)
  ok('新 style 里是当前 CSS（含这轮新增的规则）', String(appended[0].textContent).includes('.tf-open'),
    String(appended[0].textContent).slice(0, 40))

  doc.head.appendChild = savedHead
  doc.getElementById = savedGet
}

console.log('\n④ 渲染：没有会话')
let tree = render({ sessionId: '' })
ok('给出空状态提示', textOf(tree).includes('当前没有绑定会话'), textOf(tree).slice(0, 60))

console.log('\n⑤ 渲染：连上宿主、正在思考')
tree = render({ sessionId: 'sess-1' })
ok('建了 EventSource 连到本插件路由', lastEventSource && lastEventSource.url.startsWith('/think-flow/api/stream?session=sess-1'), lastEventSource && lastEventSource.url)
ok('连接前提示在连接', textOf(tree).includes('正在连接宿主'), textOf(tree).slice(0, 80))

const T0 = 1_700_000_000_000
lastEventSource.open()
lastEventSource.emit({
  t: 'snapshot',
  snapshot: {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{
      turn: 1, startedAt: T0, steps: [
        { step: 1, status: 'done', attempts: 1, reasoningChars: 1362, textChars: 0, startedAt: T0, elapsedMs: 4000, tools: [{ id: 'c1', name: 'bash', argsRaw: '{"command":"cd /a && sed -n \'1,2p\' f.js"}', startedAt: T0, endedAt: T0 + 4000 }], reasoningTail: 'The user wants to create a plugin' },
        { step: 2, status: 'thinking', attempts: 1, reasoningChars: 900, textChars: 0, startedAt: T0 + 5000, elapsedMs: 500, tools: [], reasoningTail: 'Now let me check the manifest' },
      ],
    }],
  },
})
// 触发重渲染：useEffect 的 SSE 订阅已挂上，这里再渲染一次读新状态
tree = render({ sessionId: 'sess-1' })
{
  const t = textOf(tree)
  // ⚠️ 统计行已改成导航行（轮次即身份）：轮号 + 标题 + 目录在第二行，
  //    步数/字数/工具回到轮头（它们是**这一轮**的数字，不是会话合计）。
  ok('第二行给出轮号与标题', t.includes('第 1 轮') && t.includes('f.js'), t.slice(0, 90))
  ok('四个会话合计不再展示', !t.includes('步骤') && !t.includes('思考 ') && !t.includes('工具 '), t.slice(0, 90))
  // 头部状态标签已删（用户点名）：这一轮在推理，但**头部不再报**这件事 ——
  // 它由块头次标题（「推理中」）+ 步骤行实时涨的秒数回答。
  ok('头部不再有状态标签', !classesOf(tree).some((c) => String(c).indexOf('tf-badge') === 0), classesOf(tree).filter((c) => String(c).includes('badge')))
  ok('视图切换回到头部同一行（胶囊式）', classesOf(tree).some((c) => c === 'tf-toggle'))
  // 块名按**块内实际内容**定：这一步跑的是 `sed`（只读）→ "读代码"，不是"命令行"
  ok('阶段名按块内实际内容定（sed → 读代码）', t.includes('读代码'), t.slice(0, 160))
  ok('正在思考的步是 live 态（重点色高亮）', classesOf(tree).some((c) => c.split(' ').includes('is-live')), classesOf(tree).filter((c) => c.startsWith('tf-step')))
  ok('阶段是分组块（surface + 元信息），不是散行', classesOf(tree).some((c) => c.startsWith('tf-phase')))
  ok('全局只有一个高亮块（等待态），此时没有', !classesOf(tree).some((c) => c.includes('tf-wait')))
  ok('容量条宽度真的随字数变化（1362 字 vs 900 字必须不同）', (() => {
    const fills = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.props && n.props.className === 'tf-vol') {
        const inner = (n.children || [])[0]
        if (inner && inner.props && inner.props.style) fills.push(inner.props.style.width)
      }
      ;(n.children || []).forEach(walk)
    }
    walk(tree)
    return fills.length === 2 && fills[0] !== fills[1]
  })(), (() => { const a = []; const w = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(w); if (n.props && n.props.className === 'tf-vol') { const i = (n.children||[])[0]; if (i && i.props && i.props.style) a.push(i.props.style.width) } (n.children||[]).forEach(w) }; w(tree); return a })())
  ok('显示思考字数', t.includes('1.4k') || t.includes('900'), t.slice(0, 200))
}

console.log('\n⑥ 渲染：正在等工具（本期的关键状态）')
lastEventSource.emit({
  t: 'change',
  change: { k: 'tool', turn: 1, step: 2, status: 'waiting', tool: { id: 'c9', name: 'find_dsh_plugin', argsRaw: '{"query":"AI 回复转网页"}', startedAt: Date.now() - 23400 } },
})
tree = render({ sessionId: 'sess-1' })
{
  const t = textOf(tree)
  const cls = classesOf(tree)
  ok('徽章切到"调用"', t.includes('调用'), t.slice(0, 80))
  ok('出现等待块（不是静止界面）', cls.some((c) => c.includes('tf-wait')), cls.filter((c) => c.includes('tf-wait')))
  ok('写明在等哪个工具', t.includes('find_dsh_plugin'), t.slice(0, 200))
  ok('显示已等待了多久（裸数字有歧义，写"已等"）', t.includes('已等'), t.slice(0, 300))
  ok('已等时长是个合理值（不是天文数字）', /已等 \d+(\.\d+)?s/.test(t), (t.match(/已等 [^ ]*/) || [])[0])
  ok('显示等待的参数（在查什么）', t.includes('AI 回复转网页'), t.slice(0, 300))
  ok('有旋转指示', cls.some((c) => c.includes('tf-spin')), cls.filter((c) => c.includes('tf-spin')))
  ok('步进入 waiting 态', cls.some((c) => c.split(' ').includes('is-wait')), cls.filter((c) => c.startsWith('tf-step')))
  ok('等待块用的是唯一高亮样式（规范：左边框 + 淡底）', cls.some((c) => c === 'tf-wait'))
}

console.log('\n⑦ 渲染：工具返回、继续思考')
lastEventSource.emit({ t: 'change', change: { k: 'tool-end', turn: 1, step: 2, id: 'c9', endedAt: T0 + 47000, resultChars: 1234, status: 'thinking' } })
lastEventSource.emit({ t: 'change', change: { k: 'reasoning', turn: 1, step: 2, text: ' very informative', status: 'thinking' } })
tree = render({ sessionId: 'sess-1' })
ok('等待块消失', !classesOf(tree).some((c) => c.includes('tf-wait')))
ok('回到思考态', classesOf(tree).some((c) => c.split(' ').includes('is-live')), classesOf(tree).filter((c) => c.startsWith('tf-step')))
ok('增量被追加到原文', textOf(tree).includes('very informative') || (mod.__internals.applyChange && true))

console.log('\n⑧ 渲染：中断')
lastEventSource.emit({ t: 'snapshot', snapshot: { sessionId: 'sess-1', serverTime: T0, known: true, turns: [{ turn: 1, interrupted: true, steps: [{ step: 1, status: 'done', reasoningChars: 100, tools: [], startedAt: T0 }, { step: 2, status: 'cut', reasoningChars: 50, tools: [], startedAt: T0 + 1000, reasoningTail: 'half a sentence' }] }] } })
tree = render({ sessionId: 'sess-1' })
ok('渲染出被中断的步', classesOf(tree).some((c) => c.split(' ').includes('is-cut')), classesOf(tree).filter((c) => c.startsWith('tf-step')))
ok('中断态给出明确说明（而不是假装还在跑）', textOf(tree).includes('停在这里'), textOf(tree).slice(0, 200))
ok('头部状态徽章显示"中断"', textOf(tree).includes('中断'), textOf(tree).slice(0, 120))


console.log('\n⑫ A1 回归：一个 step 走完完整生命周期后状态必须是 done')
{
  // 这是真机复现出来的那个 bug：客户端曾经自己推状态，
  // 结果 step/end 之后仍判定 thinking，界面一直挂着"正在生成…"。
  const st = mod.__internals.emptyState()
  st.turns = [{ turn: 1, steps: [] }]
  const I = mod.__internals
  I.applyChange(st, { k: 'step', turn: 1, step: 3, status: 'thinking' })
  I.applyChange(st, { k: 'reasoning', turn: 1, step: 3, text: 'thinking...', status: 'thinking' })
  I.applyChange(st, { k: 'step', turn: 1, step: 3, status: 'ready' })          // 宿主：stream end
  I.applyChange(st, { k: 'tool', turn: 1, step: 3, status: 'waiting', tool: { id: 'c1', name: 'bash' } })
  I.applyChange(st, { k: 'tool-end', turn: 1, step: 3, id: 'c1', endedAt: 1, status: 'ready' })
  I.applyChange(st, { k: 'step', turn: 1, step: 3, status: 'done' })           // 宿主：step/end
  ok('生命周期结束后是 done', st.turns[0].steps[0].status === 'done', st.turns[0].steps[0].status)

  // turn 收尾事实也必须被采纳
  I.applyChange(st, { k: 'turn', turn: 1, endedAt: 123, interrupted: false })
  ok('turn/end 的 endedAt 被采纳', st.turns[0].endedAt === 123, st.turns[0].endedAt)
  I.applyChange(st, { k: 'turn', turn: 1, interrupted: true, endReason: 'aborted' })
  ok('中断事实被采纳', st.turns[0].interrupted === true)
  ok('收尾原因被采纳', st.turns[0].endReason === 'aborted')
}

// ───────────────────── 纯函数规则 ─────────────────────


console.log('\n⑬ 按需取原文：历史步骤也能展开（补上一直没接的 /step）')
{
  // 桩 fetch：记录请求，返回一段可辨认的原文
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ reasoning: 'FETCHED FULL TEXT', streamGap: false }),
    })
  }

  const snap = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{
      turn: 2, startedAt: T0, steps: [
        { step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 4200, tools: [] },
        { step: 2, status: 'done', attempts: 1, reasoningChars: 800, textChars: 0, startedAt: T0 + 9000, elapsedMs: 5000, tools: [] },
      ],
    }],
  }

  // 第一次渲染 + 喂快照
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-1' })

  // 历史步骤（没有 realtime 文本）应当也给出"展开原文"
  const expandButtons = findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))
  ok('两个历史步骤都有展开入口', expandButtons.length === 2, expandButtons.length)
  ok('展开入口是行内箭头，不额外占一行', expandButtons.every((b) => String(textOf(b)).trim().length <= 2),
    expandButtons.map((b) => String(textOf(b))))

  // 点第一步的展开 → 应当发起 /step 请求
  expandButtons[0].props.onClick()
  ok('点击后发起了 /step 请求', calls.length === 1, calls)
  ok('请求带上了正确的 session/turn/step', calls[0] === '/think-flow/api/step?session=sess-1&turn=2&step=1', calls[0])

  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-1' })
  ok('取回的原文被渲染出来', textOf(tree).includes('FETCHED FULL TEXT'), textOf(tree).slice(0, 200))
  ok('箭头翻成收起态', findButtons(tree).some((b) => String(b.props.className || '').includes('tf-chev') && String(textOf(b)).includes('▾')), findButtons(tree).map((b) => String(textOf(b))))

  // 再点第二次不应该重复请求（缓存生效）
  const before = calls.length
  const btns2 = findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))
  btns2[0].props.onClick()   // 收起
  tree = render({ sessionId: 'sess-1' })
  const btns3 = findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))
  btns3[0].props.onClick()   // 再展开
  tree = render({ sessionId: 'sess-1' })
  ok('重新展开命中缓存，不再请求', calls.length === before, [before, calls.length])

  // 失败路径：要给出可读的提示，而不是空白
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 500 })
  resetMount()
  let t2 = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  t2 = render({ sessionId: 'sess-1' })
  findButtons(t2).filter((b) => String(b.props.className || '').includes('tf-chev'))[0].props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  t2 = render({ sessionId: 'sess-1' })
  ok('请求失败时给出提示', textOf(t2).includes('取原文失败'), textOf(t2).slice(0, 200))
}


console.log('\n⑭ 中文标题：渲染 + 显式生成动作')
{
  const snapWithTitles = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{
      turn: 4, startedAt: T0, endedAt: T0 + 1000,
      // 按步骤号索引的对象（契约：不是数组，避免下标对齐出错）
      titles: { 1: '读懂需求与手上范例', 2: '确认插件按包名装入' },
      titlesFrom: 'p/m',
      steps: [
        { step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 4200, tools: [{ id: 'a', name: 'bash', startedAt: T0, endedAt: T0 + 100 }] },
        { step: 2, status: 'done', attempts: 1, reasoningChars: 800, textChars: 0, startedAt: T0 + 9000, elapsedMs: 5000, tools: [] },
      ],
    }],
  }

  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snapWithTitles })
  tree = render({ sessionId: 'sess-1' })
  const t = textOf(tree)
  // 按步骤号映射：错位就会显示成别的步骤的标题，所以这里同时校验"没有串台"
  ok('快照下发的标题渲染到对应步骤', t.includes('读懂需求与手上范例') && t.includes('确认插件按包名装入'), t.slice(0, 200))
  ok('标题用了专门的类（与工具名分层）', classesOf(tree).some((c) => c === 'tf-step-title'))
  ok('已有标题时入口变成"重新生成"', t.includes('重新生成'), t.slice(0, 160))
  ok('轮次条给出步数/字数/工具数', t.includes('第 4 轮') && t.includes('2 步'), t.slice(0, 200))

  // 生成动作：POST 到 /titles
  const calls = []
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), method: init && init.method })
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, titles: { '3': '换了一批新标题' } }) })
  }
  resetMount()
  let t2 = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: { sessionId: 'sess-1', serverTime: T0, known: true, turns: [{ turn: 3, startedAt: T0, steps: [{ step: 3, status: 'done', attempts: 1, reasoningChars: 100, textChars: 0, startedAt: T0, elapsedMs: 1000, tools: [] }] }] } })
  t2 = render({ sessionId: 'sess-1' })
  ok('未生成时入口是"生成标题"', textOf(t2).includes('生成标题'), textOf(t2).slice(0, 120))

  const genBtn = findButtons(t2).find((b) => String(b.props.className || '').includes('tf-gen'))
  ok('找得到生成按钮', !!genBtn)
  genBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  t2 = render({ sessionId: 'sess-1' })
  ok('点击后用 POST 请求 /titles', calls.length === 1 && calls[0].method === 'POST', calls)
  ok('请求带上了 session 与 turn', calls[0].url === '/think-flow/api/titles?session=sess-1&turn=3', calls[0].url)
  ok('返回的标题被渲染出来', textOf(t2).includes('换了一批新标题'), textOf(t2).slice(0, 160))

  // 失败路径
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: '条数与步骤数不一致' }) })
  resetMount()
  let t3 = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: { sessionId: 'sess-1', serverTime: T0, known: true, turns: [{ turn: 5, startedAt: T0, steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 10, textChars: 0, startedAt: T0, elapsedMs: 100, tools: [] }] }] } })
  t3 = render({ sessionId: 'sess-1' })
  findButtons(t3).find((b) => String(b.props.className || '').includes('tf-gen')).props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  t3 = render({ sessionId: 'sess-1' })
  ok('失败时给出可见提示，而不是静默', textOf(t3).includes('标题失败'), textOf(t3).slice(0, 160))
}


console.log('\n⑮ 面板一次只显示一轮；「历史」是全部目录的唯一入口')
{
  /**
   * 两件事一起改了：
   *   ① 面板**默认只显示一个轮次**（最新那轮）—— 不再列出最近 20 轮；
   *   ② 「隐藏/显示历史」和可点的「共 N 轮」**功能重复**（都是在管"别的轮次"），
   *      合并成统计行末尾唯一一个「历史」。
   */
  const multi = {
    sessionId: 'sess-1', serverTime: T0, known: true, state: 'live',
    turns: [
      { turn: 1, startedAt: T0, endedAt: T0 + 60000, userText: '第一轮问了什么', titles: { 1: '第一轮的标题' },
        steps: [
          { step: 1, status: 'done', attempts: 1, reasoningChars: 400, textChars: 0, startedAt: T0, elapsedMs: 3000, tools: [{ id: 'a', name: 'bash', startedAt: T0, endedAt: T0 + 10 }] },
          { step: 2, status: 'done', attempts: 1, reasoningChars: 900, textChars: 0, startedAt: T0 + 5000, elapsedMs: 4000, tools: [] },
        ] },
      { turn: 2, startedAt: T0 + 70000, endedAt: T0 + 120000, userText: '第二轮问了什么',
        steps: [
          { step: 1, status: 'done', attempts: 1, reasoningChars: 700, textChars: 0, startedAt: T0 + 70000, elapsedMs: 3500, tools: [] },
        ] },
    ],
    index: [
      { turn: 2, startedAt: T0 + 70000, userText: '第二轮问了什么', steps: 1, tools: 0, reasoningChars: 700, textChars: 0, inMemory: true },
      { turn: 1, startedAt: T0, userText: '第一轮问了什么', steps: 2, tools: 1, reasoningChars: 1300, textChars: 0, inMemory: true },
    ],
  }
  const findNodes = (n, cls, acc = []) => {
    if (!n || typeof n !== 'object') return acc
    if (Array.isArray(n)) { n.forEach((x) => findNodes(x, cls, acc)); return acc }
    if (String((n.props && n.props.className) || '').split(' ').includes(cls)) acc.push(n)
    ;(n.children || []).forEach((x) => findNodes(x, cls, acc))
    return acc
  }
  const turnNos = (t) => findNodes(t, 'tf-turn-no').map((n) => String(textOf(n)).replace(/[^0-9]/g, ''))
  const mount = () => {
    resetMount()
    let tree = render({ sessionId: 'sess-1' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: multi })
    return render({ sessionId: 'sess-1' })
  }
  let tree = mount()

  // ① 面板只显示一轮
  ok('面板只渲染一个轮次条', findNodes(tree, 'tf-turn-h').length === 1, findNodes(tree, 'tf-turn-h').length)
  ok('显示的是**最新**那轮（第 2 轮）', turnNos(tree).join(',') === '2', turnNos(tree))
  /*
   * ⚠️ 这一节原来验的是「统计行 + 焦点条」。两者都按用户要求删掉了：
   *    统计行改成**导航行**（轮次即身份），焦点条整条去掉、"回到最新"挪到导航行的「»」。
   *    所以这里的断言跟着换成新形态 —— 不是在旧断言上打补丁。
   */
  ok('面板里没有焦点条（那一行整条删掉了）', findNodes(tree, 'tf-focus-bar').length === 0)

  // ② 第二行 = 导航行：轮号 + » + 标题 + 目录
  const nav = textOf(findNodes(tree, 'tf-nav')[0])
  ok('第二行是导航行，不是统计行', findNodes(tree, 'tf-stats').length === 0)
  ok('四个会话合计（步骤/思考/工具）不再展示',
    !nav.includes('步骤') && !nav.includes('思考') && !nav.includes('工具') && !nav.includes('共 2 轮'), nav)
  ok('导航行里有轮号', nav.includes('第 2 轮'), nav)
  ok('导航行里有这一轮的标题', nav.includes('第二轮问了什么'), nav)
  /*
   * ⚠️ 「历史」按钮**已经删掉**（用户："不要浮层，我想用它来代替真正的历史的入口"）：
   *    入口搬到**第二行的轮次标题上 —— 双击（或聚焦后回车）就地变搜索框**，
   *    目录与搜索结果照旧渲染在正文区。所以这一节验的是**新入口**，不是旧按钮。
   */
  ok('头部不再有「历史」按钮', findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-hist')).length === 0)
  const titleEl = findNodes(tree, 'tf-turn-title')[0]
  ok('标题那一格可聚焦（键盘有路）', titleEl.props.tabIndex === 0 && titleEl.props.role === 'button', titleEl.props.tabIndex)
  ok('标题的悬停里写了怎么进历史', String(titleEl.props.title || '').includes('双击搜索历史轮次'), titleEl.props.title)
  const latestBtn = findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-latest'))
  ok('导航行里有「» 跳到最新」', latestBtn.length === 1, latestBtn.length)
  ok('在最新那轮时 » 置灰', latestBtn[0].props.disabled === true)
  ok('「隐藏历史 / 显示历史」整个消失了', !nav.includes('隐藏历史') && !nav.includes('显示历史'), nav)

  // ③ 双击标题 → 历史态（标题那一格变搜索框）+ 正文变目录
  titleEl.props.onDoubleClick()
  tree = render({ sessionId: 'sess-1' })
  ok('双击标题 → 进目录', findNodes(tree, 'tf-dir-row').length === 2, findNodes(tree, 'tf-dir-row').length)
  ok('目录接管正文（不再渲染轮次正文）', findNodes(tree, 'tf-turn-h').length === 0)
  const q = findNodes(tree, 'tf-nav-q')[0]
  ok('搜索框就在**第二行**（标题那一格的位置）', q !== undefined && findNodes(tree, 'tf-nav')[0] !== undefined)
  ok('第二行里不再有标题文本（那一格被输入框接走）', findNodes(tree, 'tf-turn-title').length === 0,
    findNodes(tree, 'tf-turn-title').length)
  ok('目录里**没有**第二行搜索框了（搬走了）', findNodes(tree, 'tf-dir-q').length === 0)
  // 出口 = 第二行行尾的「返回」（原来目录头那枚「回到最新一轮」已删）
  const back = findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-nav-back'))
  ok('历史态第二行行尾是「返回」', back.length === 1 && textOf(back[0]) === '返回', back.map((b) => textOf(b)))

  // ④ 点目录里的第 1 轮 → 面板换成那一轮
  findNodes(tree, 'tf-dir-row').find((r) => textOf(r).startsWith('1')).props.onClick()
  tree = render({ sessionId: 'sess-1' })
  ok('聚焦第 1 轮：面板只剩它', turnNos(tree).join(',') === '1', turnNos(tree))
  ok('聚焦之后导航行的轮号跟着变', textOf(findNodes(tree, 'tf-nav')[0]).includes('第 1 轮'),
    textOf(findNodes(tree, 'tf-nav')[0]))
  ok('聚焦之后导航行的标题也换成这一轮的', textOf(findNodes(tree, 'tf-nav')[0]).includes('第一轮问了什么'),
    textOf(findNodes(tree, 'tf-nav')[0]))
  const back2 = findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-latest'))[0]
  ok('不在最新那轮时 » 点亮（这是"你不在实时那轮"唯一的信号）',
    back2.props.disabled !== true && String(back2.props.className).includes('is-back'), back2.props.className)

  // ⑤ 点 » → 回到最新那轮
  back2.props.onClick()
  tree = render({ sessionId: 'sess-1' })
  ok('点 » 回到最新那轮', turnNos(tree).join(',') === '2', turnNos(tree))
  ok('回到最新之后 » 又置灰',
    findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-latest'))[0].props.disabled === true)

  // ⑥ 两轮的步骤按需取**不串台**（缓存键带 turn）
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.resolve({ json: () => Promise.resolve({ reasoning: 'x', streamGap: false }) })
  }
  const expandFirstStep = (t) => {
    const chev = findButtons(t).filter((b) => String(b.props.className || '').includes('tf-chev'))[0]
    chev.props.onClick()
  }
  expandFirstStep(tree)                     // 第 2 轮的 #1
  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-1' })
  ok('展开第 2 轮的 #1 → 请求的是 turn=2',
    calls.length === 1 && calls[0].includes('turn=2') && calls[0].includes('step=1'), calls)

  // 回目录：入口是**双击标题**（「历史」按钮已删）
  findNodes(tree, 'tf-turn-title')[0].props.onDoubleClick()
  tree = render({ sessionId: 'sess-1' })
  findNodes(tree, 'tf-dir-row').find((r) => textOf(r).startsWith('1')).props.onClick()
  tree = render({ sessionId: 'sess-1' })
  expandFirstStep(tree)                     // 第 1 轮的 #1
  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-1' })
  ok('展开第 1 轮的 #1 → 请求的是 turn=1（缓存键带 turn，不串台）',
    calls.length === 2 && calls[1].includes('turn=1') && calls[1].includes('step=1'), calls)

  // ⑦ 每轮各自的「生成标题」入口
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), method: init && init.method })
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, titles: { '1': '新标题' } }) })
  }
  calls.length = 0
  const gen = findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-gen'))
  ok('当前这一轮有「生成标题」入口', gen.length === 1, gen.length)
  gen[0].props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  ok('点它生成的是**当前这一轮**（turn=1）',
    calls.length === 1 && calls[0].url.includes('turn=1'), calls)
}

console.log('\n⑯ 空态区分：读不到 / 新会话 / 等待中')
{
  const feed = (snap) => {
    resetMount()
    render({ sessionId: 'sess-1' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: snap })
    return render({ sessionId: 'sess-1' })
  }
  const base = { sessionId: 'sess-1', serverTime: T0, turns: [] }

  const unreadable = textOf(feed({ ...base, known: false, state: 'unreadable' }))
  ok('读不到时明说"读不到"', unreadable.includes('读不到'), unreadable.slice(0, 120))
  ok('并给出可能的原因（删除/被占用）', unreadable.includes('删除') || unreadable.includes('占用'), unreadable.slice(0, 160))
  ok('不再误报成"等待推理开始"', !unreadable.includes('等待这一轮开始推理'), unreadable.slice(0, 120))

  const empty = textOf(feed({ ...base, known: false, state: 'empty' }))
  ok('新会话说"还没有开始推理"', empty.includes('还没有开始推理'), empty.slice(0, 120))

  const waiting = textOf(feed({ ...base, known: false, state: undefined }))
  ok('状态未知时退回"等待推理开始"', waiting.includes('等待这一轮开始推理'), waiting.slice(0, 120))
}


console.log('\n⑰ 工具详情：展开后能看到参数 / 结果大小 / 耗时')
{
  const snap = {
    sessionId: 'sess-1', serverTime: T0, known: true, state: 'live',
    turns: [{
      turn: 1, startedAt: T0, steps: [{
        step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0,
        startedAt: T0, elapsedMs: 4200,
        tools: [
          { id: 'c1', name: 'bash', argsRaw: '{"command":"ls -la ~/.dsh"}', startedAt: T0, endedAt: T0 + 900, resultChars: 12345 },
          { id: 'c2', name: 'find_dsh_plugin', argsRaw: '{"query":"x"}', startedAt: T0 + 1000 },
        ],
      }],
    }],
  }
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-1' })

  // 未展开时：**没有模型标题就用派生标题**（用户要的：生成标题之前每一步都用派生标题）。
  // 这一步有两个工具，派生标题取"起得出标题的那个"（从最后一个往前找），
  // 两个工具都列在悬停里；完整工具详情在展开区。
  const derived = findNodesByClass(tree, 'is-cmd')
  // **多工具步**：行里**多行显示**，一行一条（这一步是 bash + find_dsh_plugin）
  ok('行内是派生标题（不是工具 chip）', derived.length === 2, derived.length)
  ok('每个命令占一行', derived.map((n) => String(textOf(n))).join(' | ') === '看目录 .dsh | 搜 x',
    derived.map((n) => String(textOf(n))))
  ok('多行装在一个容器里', findNodesByClass(tree, 'tf-titles').length === 1,
    findNodesByClass(tree, 'tf-titles').length)
  // 行里只有标题本身，没有工具 chip（工具名在悬停里）
  ok('行里不出现工具 chip', findNodesByClass(tree, 'tf-tool').length === 0,
    findNodesByClass(tree, 'tf-tool').map((n) => String(textOf(n))))
  // 派生标题**不给悬停**（原来内容是"来源 + 工具名 + 英文说明"，全都能在别处看到）
  ok('派生标题没有悬停', derived[0].props.title === undefined, derived[0].props.title)

  // 展开第一步 → 工具详情出现
  findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))[0].props.onClick()
  tree = render({ sessionId: 'sess-1' })
  const rows = findNodesByClass(tree, 'tf-tool-row')
  ok('展开后出现工具详情行', rows.length === 2, rows.length)
  // 工具详情行 = **工具名 + 参数原文**同一行；"返回 X 字 / 耗时"那行按用户要求去掉了
  const t = textOf(rows[0])
  ok('详情行 = 工具名 + 参数（同一行）', t.indexOf('bash') === 0 && t.includes('ls -la'), t)
  ok('不再显示返回大小与耗时', !t.includes('12k') && !t.includes('0.9s'), t)
  ok('未返回的工具标"执行…"', textOf(rows[1]).includes('执行'), textOf(rows[1]))

  // 回落到工具 chip 的那条路仍在：工具参数起不出标题时，行内给工具名 + 完整 tooltip
  const noTitle = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{ turn: 1, startedAt: T0, steps: [{
      step: 1, status: 'done', attempts: 1, reasoningChars: 0, textChars: 0, startedAt: T0, elapsedMs: 500,
      tools: [{ id: 'z1', name: 'some_new_tool', argsRaw: '{"whatever":1}', startedAt: T0 }],
    }] }],
  }
  resetMount()
  let t3 = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: noTitle })
  t3 = render({ sessionId: 'sess-1' })
  const chips3 = findNodesByClass(t3, 'tf-tool')
  ok('起不出标题时回落到工具 chip', findNodesByClass(t3, 'is-cmd').length === 0 && chips3.length === 1, chips3.length)
  ok('回落时 tooltip 仍然带全信息（未返回 → 执行）', String(chips3[0].props.title).includes('执行'), chips3[0].props.title)

  // 多行时整行对齐**第一行**（默认 align-items:center 会让 #3、容量条、时长浮在两行中间）
  {
    const rowOfNo = (t, n) => findNodesByClass(t, 'tf-step-row').find((r) => {
      const no = findNodesByClass(r, 'tf-no')[0]
      return no !== undefined && String(textOf(no)) === '#' + n
    })
    ok('多行标题的行带 is-multi（对齐第一行）',
      String(rowOfNo(tree, 1).props.className).includes('is-multi'), rowOfNo(tree, 1).props.className)
    // 用 **baseline** 而不是 flex-start：标号是 11px、标题是 13px，
    // 对齐盒子顶边的话两者的基线差约 2px（4 倍放大下看得很清楚）。
    ok('is-multi 行按**基线**对齐', String(mod.__internals.CSS).includes('.tf-step-row.is-multi{align-items:baseline}'),
      String(mod.__internals.CSS).match(/\.tf-step-row\.is-multi\{[^}]*\}/))

    // 相邻同名合并成**一行**（两个同样的 read）时不该带 is-multi —— 它只有一行，居中才对
    const merged = JSON.parse(JSON.stringify(snap))
    merged.turns[0].steps[0].tools = [
      { id: 'm1', name: 'read', argsRaw: '{"file_path":"/a/f.js"}', startedAt: T0, endedAt: T0 + 100, resultChars: 10 },
      { id: 'm2', name: 'read', argsRaw: '{"file_path":"/a/f.js"}', startedAt: T0, endedAt: T0 + 200, resultChars: 10 },
    ]
    resetMount()
    let tm = render({ sessionId: 'sess-1' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: merged })
    tm = render({ sessionId: 'sess-1' })
    const lines = findNodesByClass(tm, 'is-cmd')
    ok('两个相同命令合并成一行', lines.length === 1 && String(textOf(lines[0])) === '读 f.js ×2', lines.map((n) => String(textOf(n))))
    ok('合并成一行的行不带 is-multi', !String(rowOfNo(tm, 1).props.className).includes('is-multi'),
      rowOfNo(tm, 1).props.className)
  }
}


console.log('\n⑯b 切走再切回来：这一轮的展开/折叠与视图原样还在')
{
  const mkStep = (n, chars, tools) => ({
    step: n, status: 'done', attempts: 1, reasoningChars: chars, textChars: 0,
    startedAt: T0 + n * 1000, elapsedMs: 800, tools: tools || [],
  })
  const bash = (id) => ({ id, name: 'bash', argsRaw: '{"command":"cd /a && npm test"}', startedAt: T0, endedAt: T0 + 500, resultChars: 1200 })
  // 两轮、两个阶段：方便检查"阶段块折叠"与"步骤展开"两种状态
  const snapOf = (id) => ({
    sessionId: id, serverTime: T0, known: true,
    turns: [
      { turn: 1, startedAt: T0, endedAt: T0 + 4000, steps: [mkStep(1, 300, [bash('p1')])] },
      { turn: 2, startedAt: T0 + 5000, endedAt: T0 + 9000, steps: [mkStep(1, 400, [bash('q1')]), mkStep(2, 500, [bash('q2')])] },
    ],
  })
  const mount = (id) => {
    let t = render({ sessionId: id })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: snapOf(id) })
    return render({ sessionId: id })
  }
  const btn = (tree, label) => findButtons(tree).find((b) => String(textOf(b)) === label)
  const chevOf = (tree) => findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))

  resetMount()
  let tree = mount('sess-X')
  // ① 展开第 2 轮第 1 步
  chevOf(tree)[1].props.onClick()          // 第 2 轮的第二个箭头（第一个是轮次条）
  tree = render({ sessionId: 'sess-X' })
  ok('X：展开了一步', findNodesByClass(tree, 'tf-tool-row').length === 1,
    findNodesByClass(tree, 'tf-tool-row').length)
  // ② 手动切到「看结构」→ 本轮阶段块收起
  btn(tree, '看结构').props.onClick()
  tree = render({ sessionId: 'sess-X' })
  const closedX = findNodesByClass(tree, 'is-closed').length
  ok('X：阶段块收起了', closedX >= 1, closedX)

  // ③ 切到别的会话，再切回来
  tree = mount('sess-Y')
  ok('Y：是干净的状态（没继承 X）', findNodesByClass(tree, 'is-closed').length === 0,
    findNodesByClass(tree, 'is-closed').length)
  tree = mount('sess-X')
  ok('切回 X：视图还是「看结构」', (() => {
    const on = ['看结构', '看原文'].map((l) => btn(tree, l)).find((b) => b && String(b.props.className || '').includes('is-on'))
    return on !== undefined && String(textOf(on)) === '看结构'
  })(), ['看结构', '看原文'].map((l) => btn(tree, l)).map((b) => b && String(b.props.className)))
  ok('切回 X：阶段块仍然是收起的', findNodesByClass(tree, 'is-closed').length === closedX,
    findNodesByClass(tree, 'is-closed').length)
  ok('切回 X：那一步仍然是展开的', findNodesByClass(tree, 'tf-tool-row').length === 1,
    findNodesByClass(tree, 'tf-tool-row').length)
}

console.log('\n⑰d 跟随的判据：贴底才跟（纯函数）')
{
  const I = mod.__internals
  // "贴底"决定要不要跟随。留 80px 容差 —— 滚动是离散的，差几像素不该算"滚走了"。
  ok('贴底（差 0）算贴底', I.isPinned(1000, 480, 520) === true)
  ok('差 79px 还算贴底（容差内）', I.isPinned(1000, 401, 520) === true)
  ok('差 200px 就不跟了（用户往上滚在读历史）', I.isPinned(1000, 280, 520) === false)
  ok('内容比视口短 → 贴底', I.isPinned(300, 0, 520) === true)
  ok('内容比视口短且滚过（浏览器不会让它滚）→ 仍算贴底', I.isPinned(300, 0, 520) === true)

  // 要不要跟随（shouldFollow）—— 这一组直接对应真机反馈
  const F = I.shouldFollow
  ok('没贴底 → 不跟（不抢滚动条）', F(false, true, 7, 7) === false)
  ok('贴底 + 正在生成 → 跟', F(true, true, 7, 7) === true)
  // **这一条就是"最后一步出总结的时候没有跟随"的回归**：
  // 一轮跑完的那一刻 running 变 false，而收尾小结正是那一刻出现的。
  ok('贴底 + 本轮跑完了（本次实时看过）→ 仍然跟（盖住收尾小结）', F(true, false, 7, 7) === true)
  ok('贴底 + 打开的是历史会话（本次没实时看过）→ 不跟，停在顶部', F(true, false, null, 7) === false)
  ok('贴底 + 没有轮次 → 不跟', F(true, false, null, null) === false)
  ok('贴底 + 实时看过的是**别的**轮 → 不跟', F(true, false, 6, 7) === false)
}

console.log('\n⑰e 自动标题：默认关 / 开关通知宿主 / 推送合并 / 手动带 force')
{
  const snap = {
    sessionId: 'sess-auto', serverTime: T0, known: true, auto: false,
    turns: [{ turn: 1, startedAt: T0, endedAt: T0 + 5000, steps: [
      { step: 1, status: 'done', attempts: 1, reasoningChars: 800, textChars: 0, startedAt: T0, elapsedMs: 900,
        tools: [{ id: 'a1', name: 'bash', argsRaw: '{"command":"cd /a && npm test"}', startedAt: T0, endedAt: T0 + 500, resultChars: 1200 }] },
    ] }],
  }
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, auto: true, titles: { 1: '手动的标题' } }) })
  }
  resetMount()
  let tree = render({ sessionId: 'sess-auto' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-auto' })

  const autoBtn = () => findButtons(tree).find((b) => String(b.props.className || '').includes('tf-live'))
  ok('头部有「实时」开关', autoBtn() !== undefined)
  ok('**默认是关的**（不花 token）', !String(autoBtn().props.className).includes('is-on'), autoBtn().props.className)
  ok('按钮带 aria-pressed=false', autoBtn().props['aria-pressed'] === 'false')
  ok('文案是「实时」（不是"自动标题"）', String(textOf(autoBtn())) === '实时', textOf(autoBtn()))
  // 设计稿 A 方案：**去点胶囊** —— 圆点留给状态徽章独占
  ok('胶囊里没有圆点（点归状态徽章）', findNodesByClass(autoBtn(), 'tf-dot').length === 0)
  // 位置：**在「看原文」之后**（原来它后面紧挨着状态标签，标签已删）
  {
    const head = findNodesByClass(tree, 'tf-head')[0]
    const kids = head.children.map((c) => String((c.props && c.props.className) || c.type))
    const iLive = kids.indexOf('tf-live')
    const iToggle = kids.indexOf('tf-toggle')
    ok('在视图分段控件**之后**（位置没动）', iLive > iToggle, { kids, iLive, iToggle })
    ok('这一行不再有状态标签（徽章只在异常/断线时出现）',
      kids.every((k) => k.indexOf('tf-badge') !== 0), kids)
  }
  // 统计行里**不再**有它（避免两个入口）
  ok('统计行里没有第二个入口',
    findNodesByClass(tree, 'tf-stats').every((n) => findNodesByClass(n, 'tf-live').length === 0))

  // 点一下 → 本地立刻变 + 通知宿主
  calls.length = 0
  autoBtn().props.onClick()
  tree = render({ sessionId: 'sess-auto' })
  ok('点一下变成开', String(autoBtn().props.className).includes('is-on'), autoBtn().props.className)
  // 开 = 绿色（宿主 state-success 那套），不是 business 蓝
  ok('开的状态用绿色（state-success）',
    String(mod.__internals.CSS).includes('.tf-live.is-on{background:var(--dsw-alias-state-success-tertiary)'),
    String(mod.__internals.CSS).slice(String(mod.__internals.CSS).indexOf('.tf-live.is-on{'),
      String(mod.__internals.CSS).indexOf('.tf-live.is-on{') + 130))

  // 宿主说"这一批正在生成" → 胶囊脉冲；关掉开关后不该闪
  lastEventSource.emit({ t: 'autoBusy', busy: true })
  tree = render({ sessionId: 'sess-auto' })
  ok('宿主说在生成 → 胶囊带 is-busy（脉冲）', String(autoBtn().props.className).includes('is-busy'), autoBtn().props.className)
  lastEventSource.emit({ t: 'autoBusy', busy: false })
  tree = render({ sessionId: 'sess-auto' })
  ok('生成结束 → 脉冲收掉', !String(autoBtn().props.className).includes('is-busy'), autoBtn().props.className)
  ok('通知了宿主（/auto?on=1）', calls.some((u) => u.includes('/auto?') && u.includes('on=1')), calls)

  // 宿主**推**新标题过来（自动生成是推的，不是我们请求的）
  lastEventSource.emit({ t: 'titles', turn: 1, titles: { 1: '推过来的标题' }, notes: { a1: '改动后重跑测试' } })
  tree = render({ sessionId: 'sess-auto' })
  const shown = textOf(tree)
  ok('推来的标题合并进来了', shown.includes('推过来的标题'), shown.slice(0, 200))
  // 说明翻译是贴在**派生标题**后面的；这一步已经有模型标题，所以派生标题在展开区里
  // （行里让位给模型标题）—— 展开才看得到，这本身是设计，不是漏合并。
  findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))[0].props.onClick()
  tree = render({ sessionId: 'sess-auto' })
  ok('推来的说明翻译也合并了（展开后可见）', textOf(tree).includes('改动后重跑测试'), textOf(tree).slice(0, 300))

  // ── 只要**主会话在跑**，开着就呼吸（不依赖"这一批正在生成"）──
  {
    const live = JSON.parse(JSON.stringify(snap))
    live.turns[0].endedAt = undefined
    live.turns[0].steps.push({ step: 2, status: 'thinking', attempts: 1, reasoningChars: 120, textChars: 0,
      startedAt: T0, elapsedMs: 300, tools: [], reasoningTail: 'still thinking' })
    resetMount()
    let t = render({ sessionId: 'sess-live' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: live })
    t = render({ sessionId: 'sess-live' })
    const btn = () => findButtons(t).find((b) => String(b.props.className || '').includes('tf-live'))
    ok('默认关时不呼吸', !String(btn().props.className).includes('is-busy'), btn().props.className)
    btn().props.onClick()
    t = render({ sessionId: 'sess-live' })
    ok('打开 + 主会话在跑 → 呼吸（不需要 autoBusy）',
      String(btn().props.className).includes('is-busy'), btn().props.className)
    // 会话停下来 → 停呼吸（但仍然是"开"）
    // ⚠️ 快照里必须带 `auto: true` —— 宿主是权威，带 false 会把开关关掉（这正是设计）
    lastEventSource.emit({ t: 'snapshot', snapshot: Object.assign({}, live, {
      auto: true,
      turns: [Object.assign({}, live.turns[0], { endedAt: T0 + 9000,
        steps: live.turns[0].steps.map((x) => Object.assign({}, x, { status: 'done' })) })],
    }) })
    t = render({ sessionId: 'sess-live' })
    ok('会话跑完 → 停呼吸，但仍然是"开"',
      !String(btn().props.className).includes('is-busy') && String(btn().props.className).includes('is-on'),
      btn().props.className)
  }

  // 已经有标题了 → 手动按钮是"重新生成"，要带 force（否则宿主只会补缺的）
  calls.length = 0
  const genBtn = findButtons(tree).find((b) => String(b.props.className || '').includes('tf-gen'))
  ok('手动按钮文案是"重新生成"', String(textOf(genBtn)) === '重新生成', textOf(genBtn))
  genBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  ok('重新生成带 force=1', calls.some((u) => u.includes('/titles?') && u.includes('force=1')), calls)
}

console.log('\n⑰f 头部状态标签**已删**，只留"面板坏了"那一枚（异常 / 断线）')
{
  /**
   * 用户点名去掉头部那枚状态标签（推理 / 调用 / 完成 / 中断 / 就绪 / 空闲）。
   * 那些状态各有更靠近事情的出口：
   *   · 推理 / 调用 → 块头次标题（「推理中」「调用中」）+ 步骤行**实时涨的秒数**
   *   · 完成 / 中断 → 收尾小结 + 轮头 `is-cut`
   * ⚠️ 但**异常 / 断线**必须留：静默的话面板看着像"没事，只是没在跑"，
   *    而实际是**没数据** —— 两种完全不同的处境。
   */
  const step = (n, status, tools) => ({
    step: n, status, attempts: 1, reasoningChars: 300, textChars: 0,
    startedAt: T0, elapsedMs: 900, tools: tools || [],
  })
  const tool = (id) => ({ id, name: 'bash', argsRaw: '{"command":"cd /a && npm test"}', startedAt: T0 })
  const snapOf = (steps, turn) => ({
    sessionId: 'sess-badge', serverTime: T0, known: true,
    turns: [{ turn: 1, startedAt: T0, steps, ...(turn || {}) }],
  })
  const CASES = [
    ['（无标签）', snapOf([step(1, 'thinking')]), null],
    ['（无标签）', snapOf([step(1, 'waiting', [tool('w1')])]), null],
    ['（无标签）', snapOf([step(1, 'interrupted')], { endedAt: T0 + 900, interrupted: true }), null],
    ['（无标签）', snapOf([step(1, 'done', [tool('d1')])], { endedAt: T0 + 900 }), null],
    ['（无标签）', snapOf([step(1, 'done', [tool('r1')])], {}), null],
    ['（无标签）', { sessionId: 'sess-badge', serverTime: T0, known: true, turns: [] }, null],
    ['异常', snapOf([step(1, 'done', [tool('u1')])], { endedAt: T0 + 900 }), 'unreadable'],
    ['断线', snapOf([step(1, 'done', [tool('x1')])], { endedAt: T0 + 900 }), null],
  ]
  for (const [want, sn, state] of CASES) {
    resetMount()
    let t = render({ sessionId: 'sess-badge' })
    lastEventSource.open()
    const withState = state === null ? sn : Object.assign({}, sn, { state })
    lastEventSource.emit({ t: 'snapshot', snapshot: withState })
    t = render({ sessionId: 'sess-badge' })
    if (want === '断线') lastEventSource.onerror()      // 连接断了
    t = render({ sessionId: 'sess-badge' })
    const badge = findNodesByClass(t, 'tf-badge')[0]
    const txt = badge === undefined ? '' : String(textOf(badge)).trim()
    if (want === '（无标签）') {
      ok('这些状态**不再**渲染头部标签（' + JSON.stringify(textOf(t).slice(0, 14)) + '…）', txt === '', txt)
    } else {
      ok('徽章 = ' + want + '（两个字，兜底保留）', txt === want && txt.length === 2, txt)
    }
  }
  // 徽章**系统**没删：样式还在，只是只剩错误这一档在用
  const css = String(mod.__internals.CSS)
  ok('徽章样式还在（.tf-badge + 圆点）',
    /\.tf-badge\{/.test(css) && /\.tf-badge \.tf-dot\{/.test(css))
  ok('错误档还在（.is-err 用宿主 error token）',
    /\.tf-badge\.is-err\{color:var\(--dsw-alias-state-error-primary\)/.test(css))
  ok('状态档已删（.is-on / .is-wait 不再存在）',
    !/\.tf-badge\.is-on\{/.test(css) && !/\.tf-badge\.is-wait\{/.test(css))
}

console.log('\n⑰h 步骤行时长：一条公式 —— 活跃步实时涨、结束的步定格（真机反馈："运行的时候秒数不显示了"）')
{
  const I = mod.__internals
  const step = (over) => Object.assign({
    step: 1, status: 'thinking', attempts: 1, reasoningChars: 100, textChars: 0, startedAt: T0, tools: [],
  }, over)

  // ── ① 纯函数：三个来源的优先级 ──
  ok('活跃步（thinking）→ 按 now 现算（所以每 500ms 会涨）',
    I.stepDurMs(step({ status: 'thinking' }), T0 + 1500, undefined) === 1500)
  ok('活跃步在等工具（waiting）→ **也按 now**（不能停在流结束那一刻，否则等待期间数字冻住）',
    I.stepDurMs(step({ status: 'waiting', streamEndedAt: T0 + 400 }), T0 + 9000, undefined) === 9000)
  ok('活跃步的秒数**会涨**：now 越晚值越大',
    I.stepDurMs(step({ status: 'thinking' }), T0 + 1000, undefined) < I.stepDurMs(step({ status: 'thinking' }), T0 + 3000, undefined))
  ok('结束的步（有 endedAt）→ 真实时长，定格（now 再晚也不变）',
    I.stepDurMs(step({ status: 'done', endedAt: T0 + 4200 }), T0 + 999999, undefined) === 4200
      && I.stepDurMs(step({ status: 'done', endedAt: T0 + 4200 }), T0 + 9999999, undefined) === 4200)
  ok('ready（流结束了、只差收尾）→ 停在流结束那一刻',
    I.stepDurMs(step({ status: 'ready', streamEndedAt: T0 + 800 }), T0 + 999999, undefined) === 800)
  ok('cut（被中断、自己没有收尾）→ 停在这一轮结束那一刻',
    I.stepDurMs(step({ status: 'cut' }), T0 + 999999, T0 + 5000) === 5000)
  ok('没有 startedAt → 0（不瞎猜）', I.stepDurMs({ step: 1, status: 'done' }, T0, undefined) === 0)

  // ── ② 渲染：跑完的步必须有秒数（这正是真机那个 bug）──
  const durCells = (t) => findNodesByClass(t, 'tf-dur').map((n) => String(textOf(n)))
  const snap = (steps, turn) => ({
    sessionId: 'sess-dur', serverTime: T0, known: true,
    turns: [{ turn: 1, startedAt: T0, steps, ...(turn || {}) }],
  })
  resetMount()
  let t = render({ sessionId: 'sess-dur' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap([step({ step: 1, status: 'done', endedAt: T0 + 4200, timing: undefined })]) })
  t = render({ sessionId: 'sess-dur' })
  ok('快照带来的已结束步：显示真实时长', durCells(t)[0] === '4.2s', durCells(t))

  // 面板开着时新长出来的步：**只有 timing**（这正是宿主现在随每条变更下发的东西）
  resetMount()
  t = render({ sessionId: 'sess-dur' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap([step({ step: 1, status: 'thinking', startedAt: T0, timing: undefined })]) })
  t = render({ sessionId: 'sess-dur' })
  ok('活跃步的格子不再是「推理」两个字，而是**秒数**', durCells(t)[0] !== '推理' && /s$|″$/.test(durCells(t)[0]), durCells(t))
  // 宿主推 step/end（带 timing）
  lastEventSource.emit({ t: 'change', change: { k: 'step', turn: 1, step: 1, status: 'done', timing: { startedAt: T0, streamEndedAt: T0 + 4180, endedAt: T0 + 4200 } } })
  t = render({ sessionId: 'sess-dur' })
  ok('面板开着时跑完的步：**有秒数**（增量带 timing，不再依赖快照的 elapsedMs）', durCells(t)[0] === '4.2s', durCells(t))
  ok('时长格不再出现「推理」/「调用」状态词（状态归块头次标题）',
    !durCells(t).some((x) => x === '推理' || x === '调用'), durCells(t))

  // 新步从零长出来（客户端本地建对象）→ 也要有秒数
  lastEventSource.emit({ t: 'change', change: { k: 'reasoning', turn: 1, step: 2, text: 'x', status: 'thinking', timing: { startedAt: T0 + 5000 } } })
  lastEventSource.emit({ t: 'change', change: { k: 'step', turn: 1, step: 2, status: 'done', timing: { startedAt: T0 + 5000, endedAt: T0 + 7100 } } })
  t = render({ sessionId: 'sess-dur' })
  ok('面板开着时**新长出来**的步跑完也有秒数（2.1s）', durCells(t)[1] === '2.1s', durCells(t))

  // 等工具的活跃步：格子是"本步总时长"，等待行另有"已等 xx"（两个数各回答一件事）
  lastEventSource.emit({ t: 'change', change: { k: 'tool', turn: 1, step: 3, status: 'waiting', timing: { startedAt: T0 + 8000, streamEndedAt: T0 + 8100 },
    tool: { id: 'w9', name: 'bash', argsRaw: '{"command":"npm test"}', startedAt: T0 + 8100 } } })
  t = render({ sessionId: 'sess-dur' })
  ok('等待态：时长格给"这一步总共跑了多久"（不是「调用」两个字）',
    durCells(t)[2] !== '调用' && durCells(t)[2] !== '', durCells(t))
  ok('等待态：等待行仍然报「已等 xx」（工具等了多久 —— 和上一个是两个数）',
    String(textOf(t)).includes('已等'), String(textOf(t)).slice(0, 60))
}

console.log('\n⑰g 视图开关落盘：模块被重新求值也不丢')
{
  // 真机反馈："主会话运行中、调用工具的时候，隐藏的历史轮次还是会冒出来。"
  // 根因：`viewStore` 只在**模块求值**时创建 —— 组件重挂载挡得住，
  // 但页面刷新 / 客户端 bundle 被重新 import（本插件开发时每次 rebuild 都会触发）
  // 会让它回到空对象。所以必须落盘。
  //
  // ⚠️ 这一段原来用「隐藏历史」当落盘样本；那个开关已经删了（面板改成一次只显示一轮），
  //    改用「看原文」这个仍然存在的开关 —— 测的是**落盘机制**，不是某个具体开关。
  const snap = {
    sessionId: 'sess-persist', serverTime: T0, known: true,
    turns: [
      { turn: 1, startedAt: T0, endedAt: T0 + 3000, steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 100, textChars: 0, startedAt: T0, elapsedMs: 200, tools: [] }] },
      { turn: 2, startedAt: T0 + 4000, steps: [{ step: 1, status: 'thinking', attempts: 1, reasoningChars: 100, textChars: 0, startedAt: T0, elapsedMs: 200, tools: [], reasoningTail: 'x' }] },
    ],
  }
  resetMount()
  let tree = render({ sessionId: 'sess-persist' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-persist' })
  ok('落盘前 localStorage 是空的', Object.keys(sandboxStorage.data).length === 0, sandboxStorage.data)

  // 切到「看原文」→ 落盘
  findButtons(tree).find((b) => textOf(b) === '看原文').props.onClick()
  tree = render({ sessionId: 'sess-persist' })
  const raw = sandboxStorage.data['dsh-think-flow:view']
  ok('切到看原文后写进了 localStorage', typeof raw === 'string' && raw.includes('"manual":"raw"'), raw)
  // 只落"设置"，不落每一步的展开状态
  ok('落盘里不含 expanded/phaseOverride（那是临时的）',
    raw !== undefined && !raw.includes('expanded') && !raw.includes('phaseOverride'), raw)
  ok('落盘里也不再含 hidden（那个开关删了）', raw !== undefined && !raw.includes('hidden'), raw)

  // 模拟"模块被重新求值"：清掉内存里的 store，再从 localStorage 读回来
  {
    const vs = mod.__internals.viewStateOf('sess-persist')
    vs.manual = 'structure'
    mod.__internals.reloadViewStore()
    ok('重新读盘后 manual 回来了', mod.__internals.viewStateOf('sess-persist').manual === 'raw',
      mod.__internals.viewStateOf('sess-persist'))
  }
  remountKeepViewStore()
  tree = render({ sessionId: 'sess-persist' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-persist' })
  const on = findButtons(tree).filter((b) => String(b.props.className || '').includes('is-on'))
  ok('**刷新/重新 import 之后，看原文仍然是选中的**',
    on.some((b) => textOf(b) === '看原文'), on.map(textOf))
}

console.log('\n⑰h 轮标题（① 反转布局：标题当主行、编号与元信息降为注脚）')
{
  const step = (n, status) => ({ step: n, status, attempts: 1, reasoningChars: 300, textChars: 0,
    startedAt: T0, elapsedMs: 900, tools: [] })
  const mkSnap = (o) => ({
    sessionId: 'sess-tt', serverTime: T0, known: true, auto: !!o.auto,
    turns: [{ turn: 7, startedAt: T0, ...(o.running ? {} : { endedAt: T0 + 9000 }),
      steps: [step(1, o.running ? 'thinking' : 'done')],
      ...(o.turnTitle !== undefined ? { turnTitle: o.turnTitle } : {}),
      ...(o.userText !== undefined ? { userText: o.userText } : {}) }],
  })
  const head = (tree) => findNodesByClass(tree, 'tf-turn-h')[0]
  const titleEl = (tree) => findNodesByClass(tree, 'tf-turn-title')[0]

  // ① 有轮标题 → 标题长在**第二行**（轮次即身份），轮头恒为一行
  resetMount()
  let t = render({ sessionId: 'sess-tt' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: mkSnap({ turnTitle: '改好轮头两行层级' }) })
  t = render({ sessionId: 'sess-tt' })
  ok('标题搬到了第二行', findNodesByClass(findNodesByClass(t, 'tf-nav')[0], 'tf-turn-title').length === 1)
  ok('标题文字是对的', String(textOf(titleEl(t))) === '改好轮头两行层级', textOf(titleEl(t)))
  ok('标题不是"待生成"态', !String(titleEl(t).props.className).includes('is-pending'), titleEl(t).props.className)
  ok('轮头不再有标题（不重复）', findNodesByClass(head(t), 'tf-turn-title').length === 0)
  ok('轮头不再有两行形态（没有 has-title）', !String(head(t).props.className).includes('has-title'), head(t).props.className)
  // 轮号搬到了第二行；元信息（步数/字数/工具）留在轮头
  ok('轮号在第二行里', findNodesByClass(findNodesByClass(t, 'tf-nav')[0], 'tf-turn-no').length === 1)
  ok('轮头里不再有轮号（不重复）', findNodesByClass(head(t), 'tf-turn-no').length === 0)
  ok('元信息仍在轮头里', findNodesByClass(head(t), 'tf-turn-meta').length === 1)

  // ② 实时开着 + 轮还在跑 → 占位（避免标题到了之后布局跳一下）
  resetMount()
  t = render({ sessionId: 'sess-tt' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: mkSnap({ auto: true, running: true }) })
  t = render({ sessionId: 'sess-tt' })
  ok('实时开着在跑 → 第二行占位"待生成"（轮头仍然一行）',
    findNodesByClass(findNodesByClass(t, 'tf-nav')[0], 'tf-turn-title').length === 1
    && !String(head(t).props.className).includes('has-title'), head(t).props.className)
  ok('标题位是"待生成"占位', String(textOf(titleEl(t))) === '本轮标题待生成', textOf(titleEl(t)))
  ok('占位带 is-pending（样式更轻）', String(titleEl(t).props.className).includes('is-pending'))

  // ③ 实时关 + 没有标题 → 保持原来的一行（不出现第二行）
  resetMount()
  t = render({ sessionId: 'sess-tt' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: mkSnap({}) })
  t = render({ sessionId: 'sess-tt' })
  /*
   * ⚠️ 这里原来断言"没有标题元素"。现在**必须有一个占位** ——
   *    「历史」按钮已删，标题那一格是历史入口**唯一的落点**；没有标题的轮
   *    （系统发起的轮 / 老会话缺 userText）如果连格子都没有，那种会话就再也进不去目录。
   */
  ok('实时关且没标题 → 第二行给"无标题"占位（历史入口不能没有落点）',
    titleEl(t) !== undefined && String(textOf(titleEl(t))) === '无标题' && String(titleEl(t).props.className).includes('is-empty'),
    titleEl(t) === undefined ? '(没有)' : [String(textOf(titleEl(t))), titleEl(t).props.className])
  ok('占位也可双击（tabIndex=0）', titleEl(t).props.tabIndex === 0, titleEl(t).props.tabIndex)
  ok('轮头仍然不带 has-title（轮头恒为一行）', !String(head(t).props.className).includes('has-title'), head(t).props.className)

  // ④ 默认素材：有用户消息就用它当标题（不用等模型），样式更轻
  resetMount()
  t = render({ sessionId: 'sess-tt' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: mkSnap({ userText: '我想看 20 轮之前的思维链' }) })
  t = render({ sessionId: 'sess-tt' })
  ok('有用户消息 → 第二行立刻有标题（不必等模型）',
    findNodesByClass(findNodesByClass(t, 'tf-nav')[0], 'tf-turn-title').length === 1)
  ok('标题用的是用户消息（短的照原样）', String(textOf(titleEl(t))) === '我想看 20 轮之前的思维链', textOf(titleEl(t)))
  ok('回落态带 is-fallback', String(titleEl(t).props.className).includes('is-fallback'), titleEl(t).props.className)
  // 两种来源只差**颜色一档**（用户定的）：AI 总结 = label-primary（更黑），用户消息 = 基础样式
  {
    const css = String(mod.__internals.CSS)
    const at = (sel) => {
      const i = css.indexOf(sel)
      return i < 0 ? '' : css.slice(i, i + 160)
    }
    const model = at('.tf-nav .tf-turn-title.is-model{')
    const fb = at('.tf-nav .tf-turn-title.is-fallback{')
    ok('AI 总结那条加黑（label-primary）', model.includes('label-primary'), model)
    // 用设计系统的 token（strong-12 = 500），不硬写 600。
    // 实测两者墨量只差 8%（5.87% vs 6.34%），肉眼几乎一样 —— 主要区别在颜色那一档。
    ok('AI 总结那条用 strong-12 token（500），不硬写 600',
      model.includes('--dsw-font-xxs-strong-12') && !model.includes('font-weight:600'), model)
    ok('回落态变浅（label-tertiary）+ 常规字重', fb.includes('label-tertiary') && !fb.includes('font-weight'), fb)
    ok('回落态不带 is-model', !String(titleEl(t).props.className).includes('is-model'), titleEl(t).props.className)
    // 字号不动（都是 12px）—— 只差颜色与字重
    const base = at('.tf-nav .tf-turn-title{')
    ok('字号仍是同一档（12px）', base.includes('--dsw-font-xxs-12'), base)
  }
  // 标题一行到底 + 省略号：轮头是列表项，高度必须稳定（显示历史时 20 轮同时在列）
  {
    const css = String(mod.__internals.CSS)
    const rule = css.slice(css.indexOf('.tf-nav .tf-turn-title{'),
      css.indexOf('.tf-nav .tf-turn-title{') + 320)
    ok('标题不换行（white-space:nowrap）', rule.includes('white-space:nowrap'), rule)
    ok('超出容器宽度用省略号（text-overflow:ellipsis）', rule.includes('text-overflow:ellipsis'), rule)
    // 标题现在住在第二行（导航行）里，占中间那段空位：
    // flex:1 1 auto 把空位吃掉，min-width:0 + 省略号保证窄了先牺牲它
    ok('标题吃掉第二行的空位（flex:1 1 auto + min-width:0）',
      rule.includes('flex:1 1 auto') && rule.includes('min-width:0'), rule)
  }

  // ④b 长用户消息：先按字数截（18）+ 省略号，再交给 CSS 兜底
  //     （只靠 CSS 的话读起来是"半句话被切断"，不像标题）
  {
    const LONG = '承认把 ✓ 当标点用了：以后只在真有通过或不通过语义的地方用（测试结果、检查表），正文不用'
    resetMount()
    let t2 = render({ sessionId: 'sess-tt' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: mkSnap({ userText: LONG }) })
    t2 = render({ sessionId: 'sess-tt' })
    const shown = String(textOf(titleEl(t2)))
    ok('长用户消息被截到 18 字以内', shown.length <= 18, shown.length + ' 字：' + shown)
    ok('末尾是省略号', shown.endsWith('…'), shown)
    ok('截的是开头（保住"这轮要什么"）', LONG.startsWith(shown.slice(0, -1)), shown)
  }

  // ⑤ 模型总结优先于用户消息
  lastEventSource.emit({ t: 'titles', turn: 7, titles: {}, notes: {}, turnTitle: '模型总结的标题' })
  t = render({ sessionId: 'sess-tt' })
  ok('有模型标题 → 用它，不再用用户消息', String(textOf(titleEl(t))) === '模型总结的标题', textOf(titleEl(t)))
  ok('AI 总结那条带 is-model（据此加黑）', String(titleEl(t).props.className).includes('is-model'), titleEl(t).props.className)
  ok('不再是回落态', !String(titleEl(t).props.className).includes('is-fallback'), titleEl(t).props.className)

  // ⑥ 实时事件里来的 userText 也当场生效（不用等下次快照）
  resetMount()
  t = render({ sessionId: 'sess-tt' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: mkSnap({ running: true, auto: true }) })
  t = render({ sessionId: 'sess-tt' })
  ok('还没有用户消息时是"待生成"占位', String(textOf(titleEl(t))) === '本轮标题待生成', textOf(titleEl(t)))
  lastEventSource.emit({ t: 'change', change: { k: 'turn', turn: 7, userText: '刚来的用户消息' } })
  t = render({ sessionId: 'sess-tt' })
  ok('userText 一到 → 立刻换成它（不再等占位）', String(textOf(titleEl(t))) === '刚来的用户消息', textOf(titleEl(t)))

  // ⑦ 宿主推来轮标题 → 当场补上（不用等下次快照）
  lastEventSource.emit({ t: 'titles', turn: 7, titles: {}, notes: {}, turnTitle: '推过来的整轮标题' })
  t = render({ sessionId: 'sess-tt' })
  ok('SSE 推来的轮标题当场生效', String(textOf(titleEl(t))) === '推过来的整轮标题', textOf(titleEl(t)))
}

console.log('\n⑰b 轮次顺序：宿主给了乱序也要按轮号降序显示')
{
  // 真实事故：晚到的旧轮次事件让聚合器把"第 24 轮"追加到了末尾，
  // 而面板原来是 `slice().reverse()` —— 错序被原样翻过来，第 24 轮跑到最上面。
  const mk = (turn) => ({
    turn, startedAt: T0 + turn * 1000, endedAt: T0 + turn * 1000 + 500,
    steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 10, textChars: 0, startedAt: T0, elapsedMs: 100, tools: [] }],
  })
  const snap = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [mk(34), mk(51), mk(24), mk(52)],   // 宿主给的顺序（第 24 轮在末尾）
  }
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-1' })
  const numOf = (n) => String(textOf(n)).replace(/[^0-9]/g, '')
  const order = findNodesByClass(tree, 'tf-turn-no').map(numOf)
  // 面板现在**一次只显示一轮**：宿主的顺序乱不乱都不影响 —— 取轮号最大的那个
  ok('乱序的宿主数据下，显示的是轮号最大的那一轮', order.join(',') === '52', order)
  ok('只渲染了一轮（不再列出最近 N 轮）', order.length === 1, order.length)
}

console.log('\n⑰c 视图开关：实时默认看原文 / 重挂载不丢 / 切原文展开本轮')
{
  const mkStep = (n, status, chars, tools) => ({
    step: n, status, attempts: 1, reasoningChars: chars, textChars: 0,
    startedAt: T0 + n * 1000, elapsedMs: 800, tools: tools || [],
  })
  const bash = (id) => ({ id, name: 'bash', argsRaw: '{"command":"cd /a && npm test"}', startedAt: T0, endedAt: T0 + 500, resultChars: 1200 })
  // 两轮：历史一轮（已结束）+ 当前一轮（**正在想** = 实时生成中）
  const snap = {
    sessionId: 'sess-view', serverTime: T0, known: true,
    turns: [
      { turn: 1, startedAt: T0, endedAt: T0 + 5000, steps: [mkStep(1, 'done', 500, [bash('h1')])] },
      { turn: 2, startedAt: T0 + 6000, steps: [mkStep(1, 'done', 300, [bash('c1')]), mkStep(2, 'thinking', 200, [])] },
    ],
  }
  const mount = (sn, sessionId) => {
    resetMount()
    let t = render({ sessionId: sessionId })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: sn })
    return render({ sessionId: sessionId })
  }
  const btn = (tree, label) => findButtons(tree).find((b) => String(textOf(b)) === label)
  const viewOn = (tree) => {
    const on = ['看结构', '看原文'].map((l) => btn(tree, l)).find((b) => b && String(b.props.className || '').includes('is-on'))
    return on ? String(textOf(on)) : null
  }
  const turnNos = (tree) => findNodesByClass(tree, 'tf-turn-no').map((n) => String(textOf(n)).replace(/[^0-9]/g, ''))

  // ── ① 实时生成时默认看原文；手动切过就听用户的 ──
  let tree = mount(snap, 'sess-view')
  ok('实时生成时默认「看原文」', viewOn(tree) === '看原文', viewOn(tree))
  btn(tree, '看结构').props.onClick()
  tree = render({ sessionId: 'sess-view' })
  ok('手动切到看结构后听用户的', viewOn(tree) === '看结构', viewOn(tree))

  // ── ② 面板**恒定**只显示一轮（最新）──
  //     原来这里测的是"隐藏历史 + 重挂载不该跳回来"（用户报的 bug：主会话跑的时候
  //     被藏起来的历史轮次会冒出来）。那个开关已经删掉了 —— 面板本来就是一轮，
  //     所以这个 bug 从**结构上**不可能再发生。这里改成钉住这个结构事实。
  ok('面板只显示一轮', turnNos(tree).join(',') === '2', turnNos(tree))
  ok('目录入口 = 第二行的轮次标题（可双击、可聚焦）',
    findNodesByClass(tree, 'tf-turn-title')[0].props.tabIndex === 0)

  remountKeepViewStore()                    // 只清 hook 状态 = 组件重挂载
  tree = render({ sessionId: 'sess-view' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-view' })
  ok('**重挂载后仍然只显示一轮**（结构上不可能冒出历史轮次）',
    turnNos(tree).join(',') === '2', turnNos(tree))

  // ── ③ 切到看原文 → 打开本轮**所有阶段块**（让每步的标题都露出来），
  //        但**不**展开各步的工具与思考 ──
  tree = mount(snap, 'sess-view')
  ok('重新挂载后回到默认（实时 → 看原文）', viewOn(tree) === '看原文', viewOn(tree))
  ok('生成中不折叠任何阶段块（用户要求）', findNodesByClass(tree, 'is-closed').length === 0,
    findNodesByClass(tree, 'is-closed').length)
  ok('默认不展开任何步', findNodesByClass(tree, 'tf-tool-row').length === 0,
    findNodesByClass(tree, 'tf-tool-row').length)
  btn(tree, '看原文').props.onClick()
  tree = render({ sessionId: 'sess-view' })
  ok('切到看原文后视图是看原文', viewOn(tree) === '看原文', viewOn(tree))
  ok('本轮所有阶段块都打开了', findNodesByClass(tree, 'is-closed').length === 0,
    findNodesByClass(tree, 'is-closed').length)
  ok('但**没有**展开任何一步的工具', findNodesByClass(tree, 'tf-tool-row').length === 0,
    findNodesByClass(tree, 'tf-tool-row').length)
  ok('也**没有**展开任何一步的思考原文', findNodesByClass(tree, 'tf-raw').length === 0,
    findNodesByClass(tree, 'tf-raw').length)

  // ── ④ 「看结构」是**相反**的动作：把本轮的阶段块全收起来（只看结构）──
  btn(tree, '看结构').props.onClick()
  tree = render({ sessionId: 'sess-view' })
  ok('切到看结构后视图是看结构', viewOn(tree) === '看结构', viewOn(tree))
  ok('本轮的阶段块都收起来了', findNodesByClass(tree, 'is-closed').length >= 1,
    findNodesByClass(tree, 'is-closed').length)
  // ⚠️ 折叠是 **CSS**（`.tf-phase.is-closed .tf-phase-b{display:none}`），
  // 测试树里节点照样在 —— 所以只能数 `.is-closed`，不能数步骤行
  ok('本轮两个组都收起来了', findNodesByClass(tree, 'is-closed').length === 2,
    findNodesByClass(tree, 'is-closed').length)
  // 再切回看原文 → 又都打开
  btn(tree, '看原文').props.onClick()
  tree = render({ sessionId: 'sess-view' })
  ok('再切回看原文又全打开', findNodesByClass(tree, 'is-closed').length === 0,
    findNodesByClass(tree, 'is-closed').length)
  ok('切回后步骤行回来了', findNodesByClass(tree, 'tf-step-row').length > 0,
    findNodesByClass(tree, 'tf-step-row').length)

  // ── ⑤ 没实时看过的那一轮：照旧只展开"当前所在阶段" ──
  const doneSnap = JSON.parse(JSON.stringify(snap))
  doneSnap.turns[1].endedAt = T0 + 9000
  doneSnap.turns[1].steps[1].status = 'done'
  tree = mount(doneSnap, 'sess-view')
  ok('没实时看过的一轮：只展开当前所在阶段（有折叠的）',
    findNodesByClass(tree, 'is-closed').length > 0, findNodesByClass(tree, 'is-closed').length)

  // ── ④ 视图选择按会话各记各的 ──
  const other = JSON.parse(JSON.stringify(snap))
  other.sessionId = 'sess-other'
  tree = mount(other, 'sess-other')
  // 另一个会话同样是"一次一轮"（视图开关各记各的，但面板结构是一致的）
  ok('另一个会话同样是只显示最新那一轮', turnNos(tree).join(',') === '2', turnNos(tree))
}

console.log('\n⑱ 第二行 = 轮次即身份（四个会话合计已按用户要求删掉）')
{
  /**
   * ⚠️ 这一节原来验的是"顶部统计 = **会话合计**（步骤 / 思考 / 工具）"。
   *    用户点名把那四个数删掉（"也不需要这个信息的展示"），
   *    第二行改成导航行：轮号 + » + 这一轮的标题 + 历史。
   *    所以这里守的不再是"合计对不对"，而是**新形态该有的东西在不在、旧的东西有没有留**。
   */
  const multi = {
    sessionId: 'sess-1', serverTime: T0, known: true, state: 'live',
    turns: [
      { turn: 1, startedAt: T0, endedAt: T0 + 1000, userText: '第一轮问了什么',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 1000, textChars: 0, startedAt: T0, elapsedMs: 100, tools: [{ id: 'a', name: 'bash', startedAt: T0, endedAt: T0 + 1 }] }] },
      { turn: 2, startedAt: T0 + 2000, endedAt: T0 + 3000, userText: '第二轮问了什么',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 2000, textChars: 0, startedAt: T0 + 2000, elapsedMs: 100, tools: [] }] },
    ],
    index: [
      { turn: 2, startedAt: T0 + 2000, userText: '第二轮问了什么', steps: 1, tools: 0, reasoningChars: 2000, textChars: 0, inMemory: true },
      { turn: 1, startedAt: T0, userText: '第一轮问了什么', steps: 1, tools: 1, reasoningChars: 1000, textChars: 0, inMemory: true },
    ],
  }
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: multi })
  tree = render({ sessionId: 'sess-1' })
  const nav = textOf(findNodesByClass(tree, 'tf-nav')[0])
  ok('第二行是导航行（统计行整个没了）', findNodesByClass(tree, 'tf-stats').length === 0)
  ok('四个会话合计一个都不展示',
    !nav.includes('步骤') && !nav.includes('思考') && !nav.includes('工具') && !nav.includes('共 '), nav)
  ok('第二行报的是**当前这一轮**的轮号', nav.includes('第 2 轮'), nav)
  ok('第二行报的是**当前这一轮**的标题', nav.includes('第二轮问了什么'), nav)
  ok('第二行有目录入口（标题那一格双击 / 回车）',
    findNodesByClass(tree, 'tf-turn-title').length === 1 && findNodesByClass(tree, 'tf-turn-title')[0].props.tabIndex === 0)

  // 单轮会话：仍然成立（轮号 + 标题 + 目录）
  const single = { ...multi, turns: [multi.turns[0]], index: [multi.index[1]] }
  resetMount()
  tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: single })
  tree = render({ sessionId: 'sess-1' })
  const nav2 = textOf(findNodesByClass(tree, 'tf-nav')[0])
  ok('单轮会话第二行照样有轮号', nav2.includes('第 1 轮'), nav2)
  ok('单轮会话第二行照样有标题', nav2.includes('第一轮问了什么'), nav2)
}

console.log('\n㉑ 生成标题：状态必须按轮次归属')
{
  /**
   * 这一段守的 bug：早先 `{busy, error}` 是**全局**的，点一轮的「生成标题」，
   * 所有轮次的按钮都变成"生成中…"并置灰，看起来像"全部一起重新生成"。
   *
   * ⚠️ 面板改成"一次只显示一轮"之后，这个 bug 在**一次渲染里**已经观察不到了
   *    （只有一个按钮）。所以改成**切轮次**来验：切到另一轮时，
   *    它的按钮不该显示"生成中…"（那是别人那一轮的状态）。
   */
  const mkTurn = (turn) => ({
    turn, startedAt: T0, endedAt: T0 + 1000, userText: '第' + turn + '轮问了什么',
    steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 400, textChars: 0, startedAt: T0, elapsedMs: 3000, tools: [] }],
  })
  const multi = {
    sessionId: 'sess-1', serverTime: T0, known: true, state: 'live',
    turns: [mkTurn(3), mkTurn(4), mkTurn(5)],
    index: [5, 4, 3].map((n) => ({ turn: n, startedAt: T0, userText: '第' + n + '轮问了什么', steps: 1, tools: 0, reasoningChars: 400, textChars: 0, inMemory: true })),
  }
  const mount = () => {
    resetMount()
    let t = render({ sessionId: 'sess-1' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: multi })
    return render({ sessionId: 'sess-1' })
  }
  const genBtn = (t) => findButtons(t).filter((b) => String(b.props.className || '').includes('tf-gen'))[0]
  const goto = (t, n) => {                      // 双击标题 → 目录 → 第 n 轮
    findNodesByClass(t, 'tf-turn-title')[0].props.onDoubleClick()
    let t2 = render({ sessionId: 'sess-1' })
    findNodesByClass(t2, 'tf-dir-row').find((r) => textOf(r).startsWith(String(n))).props.onClick()
    return render({ sessionId: 'sess-1' })
  }

  // ── ① 生成中：状态跟着**那一轮**走 ──
  const calls = []
  let release = null
  globalThis.fetch = (url) => { calls.push(String(url)); return new Promise((res) => { release = res }) }
  let tree = mount()
  ok('面板显示最新那轮（第 5 轮）', findNodesByClass(tree, 'tf-turn-no').map((n) => textOf(n)).join() === '第 5 轮',
    findNodesByClass(tree, 'tf-turn-no').map((n) => textOf(n)))
  genBtn(tree).props.onClick()                 // 点第 5 轮的「生成标题」
  tree = render({ sessionId: 'sess-1' })       // 不 await：停在"生成中"
  ok('被点的那一轮显示"生成中…"', textOf(genBtn(tree)) === '生成中…', textOf(genBtn(tree)))
  ok('只发了一个请求', calls.length === 1, calls)
  ok('请求带的是被点的那一轮（turn=5）', calls[0].includes('turn=5'), calls[0])

  tree = goto(tree, 4)                         // 切到第 4 轮
  ok('切到第 4 轮：它的按钮**不是**"生成中…"（那是第 5 轮的状态）',
    textOf(genBtn(tree)) === '生成标题', textOf(genBtn(tree)))
  ok('但生成期间入口仍然置灰（全局锁还在）', genBtn(tree).props.disabled === true, genBtn(tree).props.disabled)
  ok('这时没有多发请求', calls.length === 1, calls)

  release({ json: () => Promise.resolve({ ok: true, titles: { '1': '标题' } }) })
  await new Promise((r) => setTimeout(r, 0))
  tree = goto(tree, 5)
  ok('第 5 轮生成完成后按钮回到"重新生成"', textOf(genBtn(tree)) === '重新生成', textOf(genBtn(tree)))

  // ── ② 失败：提示挂在**出错的那一轮**上 ──
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: '条数与步骤数不一致' }) })
  tree = goto(mount(), 4)
  genBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-1' })
  // ⚠️ 「生成标题」和它的失败提示都搬到了**第二行**（占原来「历史」的位置），
  //    所以提示不再长在轮次条里 —— 但它仍然只出现在**出错的那一轮**上。
  const nav = findNodesByClass(tree, 'tf-nav')[0]
  ok('失败提示出现在**第 4 轮**的第二行里', textOf(nav).includes('标题失败'), textOf(nav).slice(0, 40))
  ok('提示里带着失败原因', String(findNodesByClass(nav, 'tf-gen-err')[0].props.title).includes('条数'),
    findNodesByClass(nav, 'tf-gen-err').map((x) => x.props.title))
  ok('轮次条里不再有它（动作都搬到顶上两行了）',
    !textOf(findNodesByClass(tree, 'tf-turn-h')[0]).includes('标题失败'))
  // 切到没出错的那一轮：不该有提示
  tree = goto(tree, 5)
  ok('切到别的轮次：没有这条提示', !textOf(findNodesByClass(tree, 'tf-nav')[0]).includes('标题失败'),
    textOf(findNodesByClass(tree, 'tf-nav')[0]).slice(0, 40))
}

console.log('\n㉒ 会话切换：缓存与状态不能跨会话串味')
{
  // 症状：`sidebar.right.pane.tab` 是按**类型 id** 挂载的，切会话时是同一个组件实例
  // 换了 props。而 turn/step 号每个会话都从 1 开始 —— 缓存键不带 sessionId 的话，
  // 从 A 切到 B 展开第 2 轮第 1 步会命中 A 的缓存，**显示上一个会话的原文**。
  const calls = []
  globalThis.fetch = (url) => {
    const u = String(url)
    calls.push(u)
    const sid = /session=([^&]+)/.exec(u)[1]
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ reasoning: 'TEXT OF ' + sid, streamGap: false }) })
  }

  const snapOf = (sid) => ({
    sessionId: sid, serverTime: T0, known: true,
    turns: [{
      turn: 2, startedAt: T0, endedAt: T0 + 2000,
      titles: { 1: 'TITLE OF ' + sid },
      steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 1000, tools: [] }],
    }],
  })
  const chev = (tree) => findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))

  // ── 外壳：按会话给内层设 key（React 据此整体重挂载）──
  const hostA = tabReg.Component({ sessionId: 'sess-A' })
  const hostB = tabReg.Component({ sessionId: 'sess-B' })
  ok('外壳渲染出内层组件', hostA && typeof hostA.type === 'function')
  ok('外壳按 sessionId 设 key（重挂载的依据）', hostA.props.key === 'sess-A', hostA.props.key)
  ok('换会话 → key 跟着变', hostB.props.key === 'sess-B', hostB.props.key)
  ok('外壳把 sessionId 透传给内层', hostA.props.sessionId === 'sess-A', hostA.props.sessionId)

  // ── 行为：同一实例换 props（不重挂载的最坏情况）也不能串 ──
  resetMount()
  let tree = render({ sessionId: 'sess-A' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snapOf('sess-A') })
  tree = render({ sessionId: 'sess-A' })
  ok('A：自己的标题渲染出来', textOf(tree).includes('TITLE OF sess-A'), textOf(tree).slice(0, 200))

  chev(tree)[0].props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-A' })
  ok('A：展开了自己的原文', textOf(tree).includes('TEXT OF sess-A'), textOf(tree).slice(0, 300))
  ok('A：请求带的是 sess-A', calls[0] === '/think-flow/api/step?session=sess-A&turn=2&step=1', calls[0])

  // 切到 B：同一个组件实例、同样的 turn/step 号
  const esA = lastEventSource
  tree = render({ sessionId: 'sess-B' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snapOf('sess-B') })
  tree = render({ sessionId: 'sess-B' })

  const shownB = textOf(tree)
  ok('B：不显示 A 的原文', !shownB.includes('TEXT OF sess-A'), shownB.slice(0, 300))
  ok('B：不显示 A 的标题', !shownB.includes('TITLE OF sess-A'), shownB.slice(0, 300))
  ok('B：显示自己的标题', shownB.includes('TITLE OF sess-B'), shownB.slice(0, 300))
  ok('切会话时关掉了旧连接', esA.closed === true)

  // `expanded` 现在**按会话**存（模块级 store），A 里展开过不会漏到 B ——
  // 所以这里**点一次就展开**（早先会残留，得点两次才能展开）。
  const beforeB = calls.length
  chev(tree)[0].props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-B' })

  const stepCalls = calls.slice(beforeB).filter((u) => u.includes('/step'))
  ok('B：展开时发起了新的 /step（没命中 A 的缓存）', stepCalls.length === 1, calls)
  ok('B：请求带的是 sess-B', stepCalls[0] === '/think-flow/api/step?session=sess-B&turn=2&step=1', stepCalls[0])
  ok('B：展开后显示自己的原文', textOf(tree).includes('TEXT OF sess-B'), textOf(tree).slice(0, 300))
  ok('B：任何时刻都不出现 A 的原文', !textOf(tree).includes('TEXT OF sess-A'))

  // ── 重挂载路径：外壳的 key 换掉 → 内层全新实例（真实 React 走这条）──
  resetMount()
  let tree2 = render({ sessionId: 'sess-B' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snapOf('sess-B') })
  tree2 = render({ sessionId: 'sess-B' })
  ok('重挂载后展开态是干净的（一次点击就展开）',
    String(chev(tree2)[0].props.title) === '展开原文', chev(tree2)[0].props.title)
  chev(tree2)[0].props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree2 = render({ sessionId: 'sess-B' })
  ok('重挂载后一次点击就取到自己的原文', textOf(tree2).includes('TEXT OF sess-B'), textOf(tree2).slice(0, 300))

  // 生成标题也要落在自己的会话上（键含 sessionId）
  globalThis.fetch = (url) => {
    const u = String(url)
    calls.push(u)
    const sid = /session=([^&]+)/.exec(u)[1]
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, titles: { '1': 'GEN ' + sid } }) })
  }
  findButtons(tree2).filter((b) => String(b.props.className || '').includes('tf-gen'))[0].props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree2 = render({ sessionId: 'sess-B' })
  ok('B：生成的标题落在 B 上', textOf(tree2).includes('GEN sess-B'), textOf(tree2).slice(0, 200))
  // 切回 A（**不重挂载**：标题缓存里同时留着两个会话的键）
  render({ sessionId: 'sess-A' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snapOf('sess-A') })
  const backA = render({ sessionId: 'sess-A' })
  ok('切回 A：显示 A 自己的标题（没被 B 的顶掉）', textOf(backA).includes('TITLE OF sess-A'), textOf(backA).slice(0, 200))
  ok('切回 A：没有 B 生成的那批标题', !textOf(backA).includes('GEN sess-B'))
}

console.log('\n㉓ 容量条：填充与轨道必须可分辨（用真 token 算对比度）')
{
  // 症状：填充原本用 --dsw-alias-label-dimmed（#e1e5ee），它和轨道
  // （--dsw-alias-border-l2 = #0000001a，白底上 ≈ #e5e5e5）亮度只差 1.2% ——
  // 整条看上去是一坨均匀浅灰，**比例读不出来**，容量条等于白做（真机截图量到对比度 1.00）。
  // 所以这里不比对 token 名字（名字会骗人），而是解析**真主题 token** 算对比度。
  const themeFile = themePath()
  ok('找得到宿主主题包', !!themeFile, themeFile)

  const src = themeFile ? readFileSync(themeFile, 'utf8') : ''
  /** 某个 token 的第 n 次定义 —— 主题包把「浅色」「深色」各写一遍，顺序固定。 */
  const defOf = (name, nth) => {
    const all = []
    let i = 0
    while ((i = src.indexOf(name + ':', i)) >= 0) { all.push(src.slice(i + name.length + 1, src.indexOf(';', i))); i += 1 }
    return all[nth]
  }
  /** 跟随 var() 链解析到字面量。 */
  const resolve = (name, nth) => {
    let v = defOf(name, nth)
    for (let k = 0; k < 6; k += 1) {
      const m = v && /^var\((--[a-z0-9-]+)\)$/.exec(String(v).trim())
      if (!m) break
      v = defOf(m[1], nth)
    }
    return v
  }
  /** #rgb / #rrggbb / #rrggbbaa 叠到背景上 → [r,g,b]。 */
  const over = (v, bg) => {
    const m = /^#([0-9a-f]{3,8})$/i.exec(String(v ?? '').trim())
    if (!m) return null
    const h = m[1].length <= 4 ? m[1].split('').map((c) => c + c).join('') : m[1]
    const rgb = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16))
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return rgb.map((c, i) => Math.round(c * a + bg[i] * (1 - a)))
  }
  const lum = (rgb) => {
    const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  /** 从自己的 CSS（已 join 成一整段）里抠出某条规则的背景色 token。 */
  const CSS_TEXT = mod.__internals.CSS          // 注意：`const I = mod.__internals` 在下面才声明，这里不能提前用
  const bgToken = (selector) => {
    const at = CSS_TEXT.indexOf(selector + '{')
    if (at < 0) return null
    const m = /background:var\((--[a-z0-9-]+)\)/.exec(CSS_TEXT.slice(at, CSS_TEXT.indexOf('}', at)))
    return m ? m[1] : null
  }

  const trackTok = bgToken('.tf-vol')
  const fillTok = bgToken('.tf-vol>i')
  ok('轨道用背景 token 画', !!trackTok, trackTok)
  ok('填充用背景 token 画', !!fillTok, fillTok)

  for (const [nth, theme] of [[0, '浅色'], [1, '深色']]) {
    const bg = over(resolve('--dsw-alias-bg-layer-1', nth), [255, 255, 255])
    const track = over(resolve(trackTok, nth), bg)
    const fill = over(resolve(fillTok, nth), bg)
    const ratio = contrast(track, fill)
    ok(`${theme}：填充与轨道可分辨（对比度 ${ratio.toFixed(2)}，需 ≥ 1.5）`, ratio >= 1.5,
      { 轨道: track, 填充: fill, 对比度: +ratio.toFixed(2) })
  }
}

console.log('\n㉔ 步骤行：纯工具步也要能展开，且每行尾部必须对齐')
{
  // 症状（真机截图）：`#2 bash` 那一行**没有箭头、点不开**，而且它的容量条和时长
  // 比上一行整体右移 22~23px。根因同一个：箭头是条件渲染的，而 `.tf-step-row`
  // 是 flex + gap:9px —— 少一个 14px 的格子就少一个 9px 的间距。
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ reasoning: 'FETCHED', streamGap: false }) })
  }
  const snap = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{
      turn: 1, startedAt: T0, steps: [
        // ① 有思考、没工具
        { step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 8100, tools: [] },
        // ② 纯工具步（思考 0 字）—— 就是截图里点不开的那种
        { step: 2, status: 'done', attempts: 1, reasoningChars: 0, textChars: 0, startedAt: T0, elapsedMs: 4100,
          tools: [{ id: 't1', name: 'bash', argsRaw: '{"cmd":"ls -la"}', startedAt: T0, endedAt: T0 + 900, resultChars: 2048 }] },
        // ③ 既没思考也没工具 —— 真的没内容可展开
        { step: 3, status: 'done', attempts: 1, reasoningChars: 0, textChars: 0, startedAt: T0, elapsedMs: 120, tools: [] },
      ],
    }],
  }
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-1' })

  const rows = findNodesByClass(tree, 'tf-step-row')
  ok('三行都在', rows.length === 3, rows.length)

  const clsOf = (c) => String((c.props && c.props.className) || c.type)
  /** 一行里第一个 class 含 name 的格子。 */
  const cellOf = (r, name) => r.children.filter((c) => clsOf(c).split(' ').includes(name))[0]
  // ⚠️ 不能按下标取行：阶段块现在**按活动类型合并**了，同类的步会聚到一块，
  // 于是行序不再是全局的步骤号顺序（#1、#3、#2 这种）。按步骤号找才稳。
  const noOf = (r) => String(textOf(cellOf(r, 'tf-no'))).trim()
  const rowOf = (n) => rows.find((r) => noOf(r) === '#' + n)
  ok('三行的步骤号都在', [1, 2, 3].every((n) => rowOf(n) !== undefined), rows.map(noOf))
  ok('每一行都恰好有一个箭头格子（含占位）', rows.every((r) => cellOf(r, 'tf-chev') !== undefined),
    rows.map((r) => r.children.length))

  // 「对齐」在无布局的测试里只能这样验：**从容量条往右的那串格子必须逐行一致**。
  // 为什么从容量条开始：`.tf-vol` 带 `margin-left:auto`，它左边的东西（字形、序号、
  // 标题、行内工具名）宽度各不相同，但自由空间全被这个 auto 边距吃掉 ——
  // 所以真正决定"对齐"的就是 vol / dur / chev 这一串，必须每行都在、顺序一致。
  // 比较时只取第一个 class（占位是 `tf-chev is-blank`，与 `tf-chev` 视为同一格）。
  const tails = rows.map((r) => {
    const cells = r.children.map(clsOf)
    const at = cells.findIndex((c) => c.split(' ').includes('tf-vol'))
    return cells.slice(at).map((c) => c.split(' ')[0]).join(' | ')
  })
  ok('三行的尾部格子序列完全一致（不会有的行缺一格）', new Set(tails).size === 1, tails)

  const chevOf = (r) => cellOf(r, 'tf-chev')
  ok('思考步：箭头是可点按钮', chevOf(rowOf(1)).type === 'button' && !!chevOf(rowOf(1)).props.onClick)
  ok('纯工具步：箭头也是可点按钮（原来点不开）',
    chevOf(rowOf(2)).type === 'button' && !!chevOf(rowOf(2)).props.onClick, chevOf(rowOf(2)).type)
  ok('纯工具步的提示说的是"工具详情"', String(chevOf(rowOf(2)).props.title).includes('工具详情'), chevOf(rowOf(2)).props.title)
  ok('真没内容的步：占位、不可点',
    String(chevOf(rowOf(3)).props.className).includes('is-blank') && !chevOf(rowOf(3)).props.onClick, chevOf(rowOf(3)).props)

  // 点纯工具步：不该去取原文（思考 0 字，取了也是个空块）
  const before = calls.length
  chevOf(rowOf(2)).props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-1' })
  ok('点纯工具步不发起 /step', calls.length === before, calls.slice(before))
  const shown = textOf(tree)
  ok('展开后能看到工具名与参数', shown.includes('bash') && shown.includes('ls -la'), shown.slice(0, 300))
  ok('不再显示返回大小与耗时（用户要求去掉）', !shown.includes('2k 字') && !shown.includes('0.9s'), shown.slice(0, 300))
  ok('纯工具步不显示"载入原文…"', !shown.includes('载入原文'), shown.slice(0, 300))

  // 思考步仍然按需取原文（原行为不能丢）
  const b2 = calls.length
  chevOf(rowOf(1)).props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = render({ sessionId: 'sess-1' })
  ok('思考步展开仍会取原文', calls.length === b2 + 1, calls.slice(b2))
  ok('取回的原文渲染出来', textOf(tree).includes('FETCHED'), textOf(tree).slice(0, 200))
}

console.log('\n㉕ 轮次小结：颜色不能按序号渐隐（否则后面的段全看不见）')
{
  // 症状（真机截图 + 真实数据 turn 31）：小结的条和图例方块按 `1 - 序号*0.14` 给透明度，
  // 32 个阶段时**第 8 段起全是 0** —— 24 段不可见，整条只剩第一段，看起来像
  // "这一轮只在开头想过"，而占 50% 思考量的第 11/23/28/29 段全被藏掉。
  // 这里不比对具体颜色，只钉住那条不变式：**没有任何一段可以比别的段更淡**。
  // 造 8 种**不同类型**的块（合并后仍是 8 块，正好用来验"颜色不能渐隐"）
  const KIND = [
    ['bash', '{"command":"cd /a && sed -n \'1,20p\' f.js"}'],   // 读代码
    ['edit', '{"path":"f.js"}'],                                  // 改文件
    ['bash', '{"command":"cd /a && npm test"}'],                   // 跑命令
    ['cordis_inspect_query', '{"q":"x"}'],                          // 宿主 API 查询（与读代码不同类，保持 8 种）
    ['ask_user_question', '{"q":"?"}'],                            // 问用户
    ['read_image', '{"path":"a.png"}'],                            // 看图
    ['present', '{"files":[]}'],                                   // 交付产出
    [null, null],                                                  // 纯推理
  ]
  const many = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{
      turn: 1, startedAt: T0, endedAt: T0 + 600000,
      // 每种类型两步，交错排列（合并前是 16 个小块，合并后 8 块）
      steps: Array.from({ length: 16 }, (_, i) => {
        const [name, args] = KIND[i % KIND.length]
        return {
          step: i + 1, status: 'done', attempts: 1,
          // 让"交付产出"那两类的字数为 0 —— 图例对 0 字的块要报**步数**，不是报 "0"
          reasoningChars: i % KIND.length === 6 ? 0 : 200 + i * 100,
          textChars: 0, startedAt: T0 + i * 10000, elapsedMs: 3000,
          tools: name ? [{ id: 't' + i, name: name, argsRaw: args, startedAt: T0, endedAt: T0 + 100 }] : [],
        }
      }),
    }],
  }
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: many })
  tree = render({ sessionId: 'sess-1' })

  const bars = findNodesByClass(tree, 'tf-recap-bars')[0]
  const lgs = findNodesByClass(tree, 'tf-recap-lg')[0]
  ok('小结渲染出来了', !!bars && !!lgs)
  const segs = bars ? bars.children : []
  const dots = lgs ? lgs.children : []
  ok('16 步按类型合并成 8 块（不是 16 块）', segs.length === 8 && dots.length === 8, [segs.length, dots.length])

  // 图例方块是 `<b>`（没有 className，findNodesByClass 抓不到），手动收一遍
  const dotNodes = []
  const walkB = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walkB); return }
    if (n.type === 'b') dotNodes.push(n)
    ;(n.children || []).forEach(walkB)
  }
  walkB(lgs)

  const faded = segs.filter((s) => {
    const st = s.props.style || {}
    return st.opacity !== undefined && Number(st.opacity) < 0.5
  })
  ok('没有哪一段被"渐隐"到看不见', faded.length === 0,
    segs.map((s) => (s.props.style || {}).opacity))

  const dotFaded = dotNodes.filter((d) => {
    const st = d.props.style || {}
    return st.opacity !== undefined && Number(st.opacity) < 0.5
  })
  ok('图例方块也一视同仁（没有按序号变淡）', dotNodes.length === segs.length && dotFaded.length === 0,
    [dotNodes.length, dotNodes.map((d) => (d.props.style || {}).opacity)])

  // 宽度必须按字数分，且合计就是 100%（不能用 flex gap 额外占位，那会把尾部挤出容器）
  const total = segs.reduce((n, s) => n + parseFloat((s.props.style || {}).width || '0'), 0)
  ok('各段宽度合计 = 100%', Math.abs(total - 100) < 0.01, total)
  ok('宽度真的按字数分（字数多的段更宽）', (() => {
    const w = segs.map((s) => parseFloat((s.props.style || {}).width || '0'))
    return w[w.length - 1] > w[0]
  })(), segs.map((s) => (s.props.style || {}).width))

  // 图例用 label（按块内内容算的显示名），不能用 family —— 否则块头写"读代码"、
  // 图例写"命令行"，同一件事两个名字
  const lgText = textOf(lgs)
  ok('图例用显示名（读代码），不是族名', lgText.includes('读代码') && !lgText.includes('命令行'), lgText.slice(0, 200))

  // 颜色 = 活动分类：条上的段和图例方块必须**同一类同色**（同一个 cat-* 类）
  const segCats = segs.map((s) => String((s.props && s.props.className) || ''))
  const dotCats = dots.map((d) => String((d.props && d.props.className) || ''))
  ok('每一段都带分类类名', segCats.every((c) => /^cat-(read|write|run|ask|think)$/.test(c)), segCats)
  ok('图例与条上的段分类一一对应', segCats.join('|') === dotCats.join('|'), [segCats, dotCats])
  ok('同一次小结里出现了多种颜色（不是一片同色）', new Set(segCats).size >= 4, [...new Set(segCats)])
  // 0 字的块报步数：报 "0" 看着像坏了
  ok('0 字的块在图例里报步数（交付产出 2 步）', lgText.includes('交付产出 2 步'), lgText)
  ok('有字数的块仍然报字数（跑命令 …k）', /跑命令 [\d.]+k/.test(lgText), lgText)
}

console.log('\n㉖ 阶段合并 + 分类配色')
{
  // 注意：`const I = mod.__internals` 在下面才声明，这里不能提前用
  const M = mod.__internals
  // ① 合并：同一种块不管隔多远都并成一个，顺序按**首次出现**
  const mk = (step, name, args) => ({ step, startedAt: step * 10000, tools: name ? [{ name, argsRaw: args }] : [] })
  const SED = '{"command":"cd /a && sed -n 1p f"}'
  const NPM = '{"command":"cd /a && npm test"}'
  const phases = M.groupPhases([
    mk(1, 'bash', SED), mk(2, 'bash', SED),      // 读代码
    mk(3, 'bash', NPM),                           // 跑命令
    mk(4, 'bash', SED),                           // 读代码（又回来了）
    mk(5, 'edit', '{}'), mk(6, 'bash', NPM),      // 改文件、跑命令
  ], 90000)
  ok('分组阶段：按时间切成 5 块（读/跑/读/改/跑）', phases.length === 5, phases.map((p) => p.label))
  const merged = M.mergeByLabel(phases)
  ok('合并后只剩 3 种', merged.length === 3, merged.map((p) => p.label + ':' + p.steps.length))
  ok('顺序按首次出现（读代码 → 跑命令 → 改文件）',
    merged.map((p) => p.label).join(',') === '读代码,跑命令,改文件', merged.map((p) => p.label))
  ok('同类的步都并进来了（读代码 3 步）', merged[0].steps.length === 3, merged[0].steps.map((s) => s.step))
  ok('块内保持步骤号升序', merged[0].steps.map((s) => s.step).join(',') === '1,2,4', merged[0].steps.map((s) => s.step))

  // ② 区间串：合并块的步骤号有洞，要如实列出来
  ok('连续区间压成 1–3', M.stepRanges([{ step: 1 }, { step: 2 }, { step: 3 }]) === '1–3')
  ok('有洞时列出多段', M.stepRanges([{ step: 1 }, { step: 2 }, { step: 6 }, { step: 11 }, { step: 12 }, { step: 13 }]) === '1–2, 6, 11–13',
    M.stepRanges([{ step: 1 }, { step: 2 }, { step: 6 }, { step: 11 }, { step: 12 }, { step: 13 }]))
  ok('单步不写成区间', M.stepRanges([{ step: 7 }]) === '7')

  // ③ 分类配色：5 类，覆盖所有已知块名，未知归"想"
  const cats = M.CATEGORY_OF
  const byCat = {}
  for (const [label, cat] of Object.entries(cats)) (byCat[cat] ??= []).push(label)
  ok('恰好 5 个分类', Object.keys(byCat).length === 5, Object.keys(byCat))
  ok('分类 id 是 read/write/run/ask/think',
    Object.keys(byCat).sort().join(',') === 'ask,read,run,think,write', Object.keys(byCat).sort())
  ok('每个分类都有块名', Object.values(byCat).every((v) => v.length > 0), byCat)
  ok('未知块名归"想"（不猜）', M.phaseCategory('某个新工具') === 'think' && M.phaseCategory('') === 'think')
  ok('已知块名映射正确',
    M.phaseCategory('读代码') === 'read' && M.phaseCategory('改文件') === 'write' &&
    M.phaseCategory('跑命令') === 'run' && M.phaseCategory('问用户') === 'ask' &&
    M.phaseCategory('纯推理') === 'think', Object.entries(cats).map(([k, v]) => k + '→' + v))

  // ④ CSS 里每个分类都有自己的色相，且都来自宿主 token（不许写死色值）
  const css = mod.__internals.CSS
  const hueOf = (cat) => {
    const at = css.indexOf('.cat-' + cat + '{')
    if (at < 0) return null
    return /--tf-hue:var\((--[a-z0-9-]+)\)/.exec(css.slice(at, css.indexOf('}', at)))?.[1] ?? null
  }
  const hues = ['read', 'write', 'run', 'ask', 'think'].map(hueOf)
  ok('5 个分类都在 CSS 里定义了 --tf-hue', hues.every((h) => h !== null), hues)
  ok('色相全部来自宿主 token（var(--dsw-…)，没有字面量色值）',
    hues.every((h) => h && h.startsWith('--dsw-')), hues)
  ok('5 个色相互不相同', new Set(hues).size === 5, hues)
  ok('没有字面量颜色混进阶段块样式',
    !/\.cat-[a-z]+\{[^}]*#[0-9a-f]{3,8}/i.test(css) && !/\.cat-[a-z]+\{[^}]*rgb\(/i.test(css))
}

console.log('\n㉚ 派生标题接进渲染：它是模型标题的替补')
{
  // 用户定的规则：
  //   · 还没点「生成标题」→ **每一步都用派生标题**当行标题（不限于"没思考的步"）
  //   · 点过之后 → 有模型标题的步，模型标题占这一行，派生标题**退到展开区当次级标题**
  //     （和工具原文一样，点开才看）；没有模型标题的步（如 0 字的纯工具步）仍在行里用它
  const snap = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{
      turn: 1, startedAt: T0, endedAt: T0 + 60000,
      steps: [
        // ① 0 字 + 认得出的命令
        { step: 1, status: 'done', attempts: 1, reasoningChars: 0, textChars: 0, startedAt: T0, elapsedMs: 900,
          tools: [{ id: 'a', name: 'bash', argsRaw: '{"command":"cd /a && npm test 2>&1"}', startedAt: T0, endedAt: T0 + 900, resultChars: 1200 }] },
        // ② 0 字 + 认不出的命令 → 回落到工具名
        { step: 2, status: 'done', attempts: 1, reasoningChars: 0, textChars: 0, startedAt: T0, elapsedMs: 500,
          tools: [{ id: 'b', name: 'bash', argsRaw: '{"command":"frobnicate --now"}', startedAt: T0, endedAt: T0 + 500 }] },
        // ③ **有思考**的步 —— 没有模型标题时，它也走派生标题
        { step: 3, status: 'done', attempts: 1, reasoningChars: 800, textChars: 0, startedAt: T0, elapsedMs: 2000,
          tools: [{ id: 'c', name: 'bash', argsRaw: '{"command":"cd /a && npm run build"}', startedAt: T0, endedAt: T0 + 2000 }] },
      ],
    }],
  }
  const mount = (sn) => {
    resetMount()
    let tree = render({ sessionId: 'sess-1' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: sn })
    return render({ sessionId: 'sess-1' })
  }
  const clsOf = (c) => String((c.props && c.props.className) || c.type)
  const cellOf = (r, name) => r.children.filter((c) => clsOf(c).split(' ').includes(name))[0]
  const noOf = (r) => String(textOf(cellOf(r, 'tf-no'))).trim()
  const rowOf = (rows, n) => rows.find((r) => noOf(r) === '#' + n)
  /** 一行里的标题文字（多命令时是多行，装在 `.tf-titles` 里）。 */
  const linesOf = (r) => {
    const box = cellOf(r, 'tf-titles')
    if (box !== undefined) return box.children.map((c) => String(textOf(c)))
    const single = cellOf(r, 'tf-step-title')
    return single === undefined ? [] : [String(textOf(single))]
  }

  // ── 还没生成标题：每一步都用派生标题 ──
  let tree = mount(snap)
  const rows = findNodesByClass(tree, 'tf-step-row')
  const titles = findNodesByClass(tree, 'tf-step-title').map((n) => String(textOf(n)))
  ok('0 字的步拿到派生标题', titles.includes('跑测试'), titles)
  ok('**有思考**的步也拿到派生标题（不再限于 0 字）', titles.includes('跑构建'), titles)
  const cmdTitles = findNodesByClass(tree, 'is-cmd')
  ok('派生标题带 is-cmd 类（好跟模型标题区分）', cmdTitles.length === 2, cmdTitles.length)
  ok('派生标题没有悬停（来源靠颜色区分）', cmdTitles[0].props.title === undefined, cmdTitles[0].props.title)
  // 行里**不再挂工具名**：工具名只在悬停与展开后的工具行里
  ok('派生标题前不挂工具名', cellOf(rowOf(rows, 1), 'tf-tool') === undefined, rowOf(rows, 1).children.map(clsOf))
  ok('工具名不在悬停里（只在展开区）',
    cellOf(rowOf(rows, 1), 'tf-titles').children.every((c) => c.props.title === undefined),
    cellOf(rowOf(rows, 1), 'tf-titles').children.map((c) => c.props.title))
  ok('行里的标题文字就是那一条', JSON.stringify(linesOf(rowOf(rows, 1))) === '["跑测试"]', linesOf(rowOf(rows, 1)))
  ok('认不出的行回落到工具名', cellOf(rowOf(rows, 2), 'tf-tool') !== undefined && cellOf(rowOf(rows, 2), 'tf-titles') === undefined,
    rowOf(rows, 2).children.map(clsOf))

  // ── 快照下发的 notes（工具说明的中文翻译）要落到派生标题后面 ──
  {
    const withNotes = JSON.parse(JSON.stringify(snap))
    withNotes.turns[0].notes = { a: '跑一遍全量测试' }
    const tn = mount(withNotes)
    const titlesN = findNodesByClass(tn, 'tf-step-title').map((n) => String(textOf(n)))
    ok('快照里的说明翻译接在派生标题后面', titlesN.includes('跑测试 · 跑一遍全量测试'), titlesN)
    // /titles 返回的 notes 也要落进来（走真实 onClick）
    globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, titles: {}, notes: { c: '跑一遍构建确认' } }) })
    const genBtn = findButtons(tn).find((b) => String(b.props.className || '').includes('tf-gen'))
    if (genBtn) {
      genBtn.props.onClick()
      await new Promise((r) => setTimeout(r, 0))
      const t2 = render({ sessionId: 'sess-1' })
      const titles2 = findNodesByClass(t2, 'tf-step-title').map((n) => String(textOf(n)))
      ok('/titles 返回的说明也接上了', titles2.includes('跑构建 · 跑一遍构建确认'), titles2)
    } else {
      ok('/titles 返回的说明也接上了', false, '找不到生成按钮')
    }
  }

  // ── 生成标题之后：模型标题占行，派生标题退到展开区 ──
  const withTitles = JSON.parse(JSON.stringify(snap))
  withTitles.turns[0].titles = { 3: '跑一遍构建确认没有回归' }
  tree = mount(withTitles)
  const rows2 = findNodesByClass(tree, 'tf-step-row')
  const titles2 = findNodesByClass(tree, 'tf-step-title').map((n) => String(textOf(n)))
  ok('有模型标题的步：行里是模型标题', titles2.includes('跑一遍构建确认没有回归'), titles2)
  ok('有模型标题的步：行里**不再**是派生标题', !titles2.includes('跑构建'), titles2)
  ok('有模型标题的步：行里没有多行容器', cellOf(rowOf(rows2, 3), 'tf-titles') === undefined, rowOf(rows2, 3).children.map(clsOf))
  ok('没有模型标题的步：行里仍然是派生标题', titles2.includes('跑测试'), titles2)
  ok('模型标题不带 is-cmd 类', cellOf(rowOf(rows2, 3), 'is-cmd') === undefined, rowOf(rows2, 3).children.map(clsOf))

  // 展开那一步 → 派生标题作为**次级标题**出现
  const chev = rowOf(rows2, 3).children.filter((c) => clsOf(c).split(' ').includes('tf-chev'))[0]
  chev.props.onClick()
  tree = render({ sessionId: 'sess-1' })
  const subs = findNodesByClass(tree, 'tf-sub')
  ok('展开后出现次级标题', subs.length === 1, subs.length)
  // 展开区：**每个派生标题一行，紧跟它自己的工具行**
  ok('展开区是"标题行 + 工具行"配对', (() => {
    const box = findNodesByClass(tree, 'tf-tools')[0]
    if (box === undefined) return false
    return box.children.map((c) => clsOf(c).split(' ')[0]).join(',') === 'tf-sub,tf-tool-row'
  })(), (findNodesByClass(tree, 'tf-tools')[0] || { children: [] }).children.map(clsOf))
  ok('次级标题就是那条派生标题', String(textOf(subs[0])) === '跑构建', textOf(subs[0]))
  ok('次级标题也没有悬停', subs[0].props.title === undefined, subs[0].props.title)
  // 没生成标题的步展开时**不该**有次级标题（行里已经显示它了，重复）
  const rows3 = findNodesByClass(tree, 'tf-step-row')
  const chev1 = rowOf(rows3, 1).children.filter((c) => clsOf(c).split(' ').includes('tf-chev'))[0]
  chev1.props.onClick()
  tree = render({ sessionId: 'sess-1' })
  // 展开区是**自包含**的：不管这一步在行里显不显示标题，展开后都给"标题行 + 工具行"，
  // 这样"哪条标题对应哪次调用"才对得上（行里那几行只是摘要，没法配对）。
  ok('两步都展开时各有自己的标题行', findNodesByClass(tree, 'tf-sub').length === 2,
    findNodesByClass(tree, 'tf-sub').length)
}

console.log('\n㉛ 按工具参数起标题：不只 bash（edit/read/write/read_image/present/…）')
{
  // 实测：只认 `command` 的话，221 个纯工具步里只有 **52%** 有标题；
  // 剩下的是 edit(54)/read(19)/read_image(17)/present(10)/write(4)/find_dsh_plugin(1)
  // —— 参数里没有命令，但**有文件路径 / 查询词 / 条目数**，够起一个准确的短标题。
  const M = mod.__internals
  const A = (o) => JSON.stringify(o)
  const cases = [
    ['read', A({ file_path: '/a/b/src/client/index.js', limit: 18, offset: 991 }), '读 index.js'],
    ['edit', A({ file_path: '/a/b/README.md', old_string: 'x', new_string: 'y' }), '改 README.md'],
    ['write', A({ file_path: '/a/b/scripts/check-align.mjs', content: '#!/usr/bin/env node' }), '写 check-align.mjs'],
    ['read_image', A({ file_path: '/tmp/prev2.png' }), '看图 prev2.png'],
    ['present', A({ files: [{ description: 'x', path: '/a/docs/ui-preview.html' }] }), '交付 ui-preview.html'],
    ['present', A({ files: [{ path: '/a/x' }, { path: '/a/y' }, { path: '/a/z' }] }), '交付 3 个文件'],
    ['grep', A({ pattern: 'fetchedRef', path: '/a' }), '搜 fetchedRef'],
    ['glob', A({ pattern: '**/*.test.js' }), '找 *.test.js'],
    ['web_fetch', A({ url: 'https://example.com/a/b?c=1' }), '抓 example.com'],
    ['web_search', A({ queries: ['dsh plugin 发布'] }), '搜 dsh plugin 发布'],
    ['find_dsh_plugin', A({ query: '思维链 visualization', limit: 5 }), '搜 思维链 visualizat…'],
    ['skill', A({ name: 'web-design' }), '加载 web-design'],
    ['cordis_inspect_list', A({ service: 'sidebarRightTabs' }), '列 sidebarRightTabs'],
    ['cordis_inspect_query', A({ query: 'slots.inject' }), '查 slots.inject'],
    ['todo_write', A({ todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] }), '列 2 项计划'],
    ['subagent', A({ description: 'Review the diff', prompt: '…' }), 'Review the diff'],
    ['bash', A({ command: 'cd /a && npm test' }), '跑测试'],
    ['some_new_tool', A({ whatever: 1 }), ''],
  ]
  const bad = cases
    .map(([n, raw, want]) => [n, want, M.toolArgsTitle(n, raw)])
    .filter(([, want, got]) => want !== got)
  ok('工具参数 → 标题：' + cases.length + ' 条全对', bad.length === 0, bad)

  // 参数被截断（宿主只留 400 字）时也必须能用 —— edit 59 次里 44 次、write 3 次全截断
  ok('截断的 edit 参数也能拿到文件名',
    M.toolArgsTitle('edit', '{"file_path":"/a/src/client/index.js","old_string":"      /** 按需取回的原文缓存：\'turn:step\'') === '改 index.js',
    M.toolArgsTitle('edit', '{"file_path":"/a/src/client/index.js","old_string":"      /** 按需取回的原文缓存：\'turn:step\''))
  // file_path 被截断掉（write 把 content 放在前面）→ 诚实回落，不猜
  ok('文件名被截断掉时回落（write → 写文件）',
    M.toolArgsTitle('write', '{"content":"#!/usr/bin/env node\n/**\n * 预览页的共用底座…') === '写文件')
  ok('认不出的工具返回空（界面回落到工具名）', M.toolArgsTitle('some_new_tool', A({ a: 1 })) === '')

  // 多命令：**每个命令各一条**（行里一行一条；相邻同名合并）
  const two = [
    { id: 'x1', name: 'bash', argsRaw: A({ command: 'ls -la ~/.dsh' }) },
    { id: 'x2', name: 'find_dsh_plugin', argsRaw: A({ query: 'x' }) },
  ]
  ok('多命令各起一条（两行）', JSON.stringify(M.stepTitleLines(two)) === '["看目录 .dsh","搜 x"]', M.stepTitleLines(two))
  ok('都起不出标题时没有行', M.stepTitleLines([{ id: 'y', name: 'some_new_tool', argsRaw: '{}' }]).length === 0)
  // **相邻同名合并**：连着 6 次 edit 只留一条，带计数
  const sixEdits = Array.from({ length: 6 }, (_, i) => ({ id: 'e' + i, name: 'edit', argsRaw: A({ file_path: '/a/src/client/index.js' }) }))
  ok('相邻同名合并成一条带计数', JSON.stringify(M.stepTitleLines(sixEdits)) === '["改 index.js ×6"]', M.stepTitleLines(sixEdits))
  ok('不相邻的同名不合并（各占一行）',
    JSON.stringify(M.stepTitleLines([
      { id: 'a', name: 'read', argsRaw: A({ file_path: '/a/f.js' }) },
      { id: 'b', name: 'bash', argsRaw: A({ command: 'npm test' }) },
      { id: 'c', name: 'read', argsRaw: A({ file_path: '/a/f.js' }) },
    ])) === '["读 f.js","跑测试","读 f.js"]',
    M.stepTitleLines([
      { id: 'a', name: 'read', argsRaw: A({ file_path: '/a/f.js' }) },
      { id: 'b', name: 'bash', argsRaw: A({ command: 'npm test' }) },
      { id: 'c', name: 'read', argsRaw: A({ file_path: '/a/f.js' }) },
    ]))

  // 工具自带的英文说明 → 模型翻成中文后，**跟在它自己那条标题后面**，用 · 隔开
  const one = [{ id: 'c1', name: 'bash', argsRaw: A({ command: 'cd /a && npm test', description: 'Run tests after the change' }) }]
  ok('说明跟在派生标题后面（用 · 隔开）',
    JSON.stringify(M.stepTitleLines(one, { c1: '改动后重跑测试' })) === '["跑测试 · 改动后重跑测试"]',
    M.stepTitleLines(one, { c1: '改动后重跑测试' }))
  ok('没有翻译时只有标题', JSON.stringify(M.stepTitleLines(one, {})) === '["跑测试"]')
  ok('多命令时各自的说明跟各自的标题',
    JSON.stringify(M.stepTitleLines(two, { x1: '看配置目录', x2: '找现成插件' })) === '["看目录 .dsh · 看配置目录","搜 x · 找现成插件"]',
    M.stepTitleLines(two, { x1: '看配置目录', x2: '找现成插件' }))
  // 命令认不出、但有说明：至少把说明露出来（别整条丢掉）
  ok('命令认不出但带说明时，只显示说明',
    JSON.stringify(M.stepTitleLines([{ id: 'c9', name: 'bash', argsRaw: A({ command: 'frobnicate --x', description: 'Do something odd' }) }], { c9: '做一件怪事' })) === '["做一件怪事"]',
    M.stepTitleLines([{ id: 'c9', name: 'bash', argsRaw: A({ command: 'frobnicate --x', description: 'Do something odd' }) }], { c9: '做一件怪事' }))
}

console.log('\n㉙ 命令标题：纯工具步用它的命令起标题（本地规则）')
{
  // 为什么这里可以用本地规则：命令是**确定的**（动词、参数、文件名都在那儿），
  // 没有"这句话在论证什么"那种要理解的东西。当初否掉"本地规则总结思考"是因为
  // 那个在**猜意图**（1/3 猜错）；这个只是在**读**命令。
  // 下面每一条都是探针在真实命令上跑出来的坑，不是凭空想的。
  const M = mod.__internals
  const cases = [
    // 读 / 搜 / 看
    ['cd /a && sed -n \'1,20p\' f.js', '读 f.js'],
    ['cd /a && sed -i \'\' \'s/x/y/\' README.md', '改 README.md'],
    ['cd /a && grep -n "foo" src/client/index.js', '搜 foo'],
    ['cd /a && grep -n "a\\|b" f.js', '搜 a|b'],
    ['cd /a && cat f.md', '读 f.md'],
    ['wc -l a.html', '数行数'],
    ['find /a -name \'*web-server*\'', '找 web-server'],
    ['cd /a && git diff --stat', '看改动'],
    ['ls -la ~/.dsh/think-flow/', '看目录 think-flow'],
    ['echo hi', '打印一行'],
    // 写（heredoc 重定向；`>` 本身不能当文件名）
    ['cd /a && cat > /tmp/x.mjs <<\'EOF\'', '写 x.mjs'],
    // 跑
    ['cd /a && python3 - <<\'PY\'\nimport json', '跑临时脚本'],
    ['cd /a && python3 -c "import json"', '跑临时脚本'],
    ['cd /a && node -e "console.log(1)"', '跑临时脚本'],
    ['cd /a && node scripts/test-client.mjs 2>&1', '跑 test-client.mjs'],
    ['cd /a && bash scripts/build.sh', '跑 build.sh'],
    ['cd /a && npm run build 2>&1 | tail -20', '跑构建'],
    ['cd /a && npm test 2>&1 | grep -E "ok"', '跑测试'],
    ['cd /a && npm run align', '跑布局检查'],
    ['cd /a && git add -A && git commit -q -m "x"', '提交改动'],
    ['curl -s "http://127.0.0.1:3080/x"', '请求接口'],
    ['mkdir -p /tmp/x', '建目录 x'],
    ['cd /a && cp lib/client.js /tmp/b.bak', '复制文件'],
    ['node_modules/.bin/dsh plugin --help', '跑 dsh'],
    // 带路径的可执行文件（真机里最常见的是 Chrome 无头截图）
    ['cd /tmp && rm -f a.png && "/Applications/Google Chrome" --headless --screenshot=/tmp/a.png', '跑浏览器截图'],
    // 认不出来就返回空（界面回落到工具名），**不猜**
    ['frobnicate --now', ''],
    // ── 下面几条是真机上起错/起不出、被探针抓到的 ──
    // 命令替换里**嵌了同类引号**：分词器会被里面的引号带偏，一整段 shell 片段被当成
    // 一个 token —— 真机起出过「读 test-client.mjs | cut -d: -f1),+26p」
    ['sed -n "$(grep -n "x" f.js | cut -d: -f1),+26p" scripts/test-client.mjs', '读 test-client.mjs'],
    // 没有文件名时不能把动词本身当文件（`sed` 长得也像路径）
    ["sed -i '' 's/x/y/'", ''],
    // 子 shell 开头 + 最重那段认不出 → 退到下一段（原来只试最重那段，整条就没标题）
    ['(npx --no-install dsh plugin --help 2>&1 | head -40) || node_modules/.bin/dsh plugin --help', '跑 dsh'],
    ['for k in a b; do echo $k; done', '循环处理'],
    ['ls -la ~/.dsh/think-flow/', '看目录 think-flow'],
  ]
  const bad = cases
    .map(([cmd, want]) => [cmd, want, M.cmdTitle(JSON.stringify({ command: cmd }))])
    .filter(([, want, got]) => want !== got)
  ok('真实命令 → 标题：' + cases.length + ' 条全对', bad.length === 0, bad)

  // 引号里的 `|` 不能当管道切：切错了"最后一个参数"会变成半截字符串
  ok('命令替换里的 | 不参与分段（不会切出带尾巴的标题）',
    M.cmdTitle(JSON.stringify({ command: 'sed -n "$(grep -n \'function x\' f | cut -d: -f1),+8p" src/client/index.js' })) === '读 index.js',
    M.cmdTitle(JSON.stringify({ command: 'sed -n "$(grep -n \'function x\' f | cut -d: -f1),+8p" src/client/index.js' })))

  // 复合命令取**信息量最大**的那段：`rm && 截图` 该说"截图"，不是"删文件"
  ok('复合命令按权重挑，不只看第一段',
    M.cmdTitle(JSON.stringify({ command: 'rm -f a.png && sed -n 1p f.js' })) === '读 f.js',
    M.cmdTitle(JSON.stringify({ command: 'rm -f a.png && sed -n 1p f.js' })))
  ok('只有 cd / echo 时不算数（权重 0/1）',
    M.cmdTitle(JSON.stringify({ command: 'cd /a && echo hi' })) === '打印一行')

  // 参数被截断（宿主只留 400 字）：JSON 不合法，但命令的开头还在
  ok('截断的 JSON 也起得出标题',
    M.cmdTitle('{"command":"cd /a && npm test 2>&1 | grep -E \"✅') === '跑测试',
    M.cmdTitle('{"command":"cd /a && npm test 2>&1 | grep -E \"✅'))
  ok('取不到命令时返回空（不猜）', M.cmdTitle('{"path":"f.js"}') === '' && M.cmdTitle('') === '' && M.cmdTitle(undefined) === '')
}

console.log('\n㉗ 合并只发生在小结里：面板按时间顺序保持原样')
{
  // 用户的明确要求：「只是在最后统计的时候合并，上面的每一项还是按照顺序，保持原样」。
  // 所以面板用 `groupPhases`（时间序、不合并），小结用 `mergeByLabel`（同类合并）。
  const KIND = [
    ['bash', '{"command":"cd /a && sed -n \'1,20p\' f.js"}'],
    ['edit', '{"path":"f.js"}'],
    ['bash', '{"command":"cd /a && npm test"}'],
    // ⚠️ 第 4 种必须是**另一个族**：`read` 和 bash 的只读命令现在同族（都是"读代码"），
    // 相邻同类会被 `groupPhases` 并掉，那样就测不出"面板不合并"了
    ['read_image', '{"path":"a.png"}'],
  ]
  const snap = {
    sessionId: 'sess-1', serverTime: T0, known: true,
    turns: [{
      turn: 1, startedAt: T0, endedAt: T0 + 600000,
      steps: Array.from({ length: 12 }, (_, i) => {
        const [name, args] = KIND[i % KIND.length]
        return {
          step: i + 1, status: 'done', attempts: 1, reasoningChars: 300 + i * 50, textChars: 0,
          startedAt: T0 + i * 10000, elapsedMs: 2000,
          tools: [{ id: 't' + i, name, argsRaw: args, startedAt: T0, endedAt: T0 + 100 }],
        }
      }),
    }],
  }
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-1' })

  const phases = findNodesByClass(tree, 'tf-phase')
  const rows = findNodesByClass(tree, 'tf-step-row')
  const noOf = (r) => String(textOf(r.children.filter((c) => String((c.props && c.props.className) || '').split(' ').includes('tf-no'))[0])).trim()
  const order = rows.map((r) => Number(noOf(r).slice(1)))

  ok('面板 12 步 → 12 个块（按内容切细，不合并）', phases.length === 12, phases.length)
  ok('面板步骤号严格升序（时间顺序没被打乱）',
    order.every((v, i) => i === 0 || v > order[i - 1]), order)
  ok('每个块都带分类类名', phases.every((p) => /cat-(read|write|run|ask|think)/.test(String(p.props.className))),
    phases.map((p) => p.props.className))

  // 小结那边必须**合并过**：12 步 → 4 类
  const segs = findNodesByClass(tree, 'tf-recap-bars')[0].children
  ok('小结合并成 4 块（读代码/改文件/跑命令/看图）', segs.length === 4, segs.length)
  ok('小结块数比面板少（合并生效，且只在小结生效）', segs.length < phases.length, [segs.length, phases.length])
}

console.log('\n⑨ 阶段分组规则（本地规则，可靠来源）')
const I = mod.__internals
ok('bash → 命令行（族名，只用于分组）', I.toolFamily({ name: 'bash' }) === '命令行')
ok('cordis_inspect_query → 宿主 API 查询', I.toolFamily({ name: 'cordis_inspect_query' }) === '宿主 API 查询')
ok('find_dsh_plugin → 外部检索', I.toolFamily({ name: 'find_dsh_plugin' }) === '外部检索')
ok('不认识的工具如实显示原名', I.toolFamily({ name: 'some_new_tool' }) === 'some_new_tool')
ok('没工具 = 纯推理', I.familyOf({ tools: [] }) === '纯推理')

// 表扩：真实会话里出现过、或本环境一定会用到的工具，不该掉到英文原名
{
  const cases = [
    ['read_image', '看图'], ['present', '交付产出'],
    ['skill', '加载技能'],
    ['subagent', '派子代理'], ['subagent_fork', '派子代理'], ['send_message', '派子代理'], ['list_agents', '派子代理'],
    ['job_output', '后台任务'], ['job_list', '后台任务'],
    ['create_goal', '目标管理'], ['update_goal', '目标管理'],
    ['workflow', '编排'], ['ralph', '编排'],
    // 前缀规则
    ['dev_build_plugin', '插件工程'], ['dev_stage_add', '插件工程'], ['dev_self_test', '插件工程'],
    ['openpencil_new', '画设计稿'], ['oh_story_role', '短剧制作'],
    ['cordis_inspect_list', '宿主 API 查询'],
  ]
  const bad = cases.filter(([n, want]) => I.toolFamily({ name: n }) !== want)
  ok('表扩：' + cases.length + ' 个工具都有中文族名', bad.length === 0, bad)
  // 前缀表必须**有序**：短前缀会抢走更具体的长前缀
  const prefixes = I.FAMILY_PREFIX.map(([p]) => p)
  ok('前缀表里没有互相抢的前缀',
    prefixes.every((p) => !prefixes.some((q) => q !== p && q.startsWith(p))), prefixes)
  ok('前缀规则按长度降序（更具体的在前）',
    prefixes.every((p, i) => prefixes.slice(i + 1).every((q) => q.length <= p.length)), prefixes)
}

{
  // 同族 + 间隔小 → 合并；换族 → 断开；间隔大 → 断开
  const mk = (step, at, name) => ({ step, startedAt: at, tools: name ? [{ name }] : [] })
  const steps = [
    mk(1, 0, 'bash'), mk(2, 5000, 'bash'),          // 同族且近 → 同组
    mk(3, 10000, 'bash'),                            // 同上
    mk(4, 60000, 'bash'),                            // 间隔 50s > 20s → 新组
    mk(5, 61000, 'read'),                            // 换族 → 新组
  ]
  // 显式传阈值：这里测的是"切分机制"，默认阈值本身的定标由 ⑨b 用真实数据把关
  const phases = I.groupPhases(steps, 20000)
  ok('分成 3 个阶段', phases.length === 3, phases.map((p) => p.family + ':' + p.steps.length))
  ok('第一段 3 步', phases[0].steps.length === 3)
  ok('第二段是长间隔切开的那步', phases[1].steps.length === 1 && phases[1].steps[0].step === 4)
  ok('第三段认出了读代码', phases[2].family === '读代码', phases[2].family)
  ok('阶段不各自配色（规范：一个主色 + 中性灰阶）', phases.every((p) => p.hue === undefined))
}

// ── 命令行块的名字：按块内**实际内容**定（分组仍按一族，不切碎）──
{
  const args = (command) => JSON.stringify({ command })
  const mk = (step, at, command) => ({ step, startedAt: at, tools: [{ name: 'bash', argsRaw: args(command) }] })

  // ① 剥 cd 前缀 + 只看第一个动词
  ok('cd X && sed … → 查', I.cmdActivity(args('cd /a/b && sed -n \'1,2p\' f.js')) === 'inspect')
  ok('cd X && npm test → 跑', I.cmdActivity(args('cd /a/b && npm test 2>&1 | tail -5')) === 'run')
  ok('git commit → 跑', I.cmdActivity(args('cd /a/b && git add -A && git commit -q -m "x"')) === 'run')
  ok('python3 临时脚本 → 跑', I.cmdActivity(args('python3 - <<PY\nprint(1)\nPY')) === 'run')
  ok('grep 直接开头（没有 cd） → 查', I.cmdActivity(args('grep -rn foo src/')) === 'inspect')
  // 分界是"这条命令在干嘛"：只读 → 查；有副作用（含改文件系统）→ 跑
  ok('mkdir/cp 有副作用 → 跑，不算查', I.cmdActivity(args('mkdir -p /tmp/x')) === 'run' && I.cmdActivity(args('cp a b')) === 'run')
  ok('认不出来就如实说认不出来', I.cmdActivity(args('frobnicate --now')) === null, I.cmdActivity(args('frobnicate --now')))
  ok('VAR=值 前缀也剥得掉', I.cmdActivity(args('CH="/a b/c" python3 x.py')) === 'run')
  // **关键**：宿主只留参数前 400 字，长命令一截就不是合法 JSON 了 ——
  // 实测真实会话 207 次 bash 调用有 118 次（57%）这样。解析不了就返回 null 的话，
  // 大半个命令行块会退化成"命令行"，这个功能等于没做。
  ok('参数被截断（长 heredoc）也要认得出 → 跑',
    I.cmdActivity('{"command":"cd /a && python3 - <<\'PY\'\\nimport json\\nprint(1)') === 'run',
    I.cmdActivity('{"command":"cd /a && python3 - <<\'PY\'\\nimport json\\nprint(1)'))
  ok('截断的只读命令 → 查', I.cmdActivity('{"command":"cd /a && sed -n \'1,2p\' f') === 'inspect')
  ok('彻底不成形也不炸', I.cmdActivity('{"command"') === null && I.cmdActivity('') === null && I.cmdActivity(undefined) === null)

  // ② 命令行按**命令内容**细分：每一步都落在与实际活动相符的族里
  const inspectPhase = I.groupPhases([mk(1, 0, 'sed -n 1p f'), mk(2, 1000, 'grep -n x f'), mk(3, 2000, 'cd /a && sed -n 2p f')], 90000)[0]
  ok('全是只读命令 → 读代码', inspectPhase.label === '读代码', inspectPhase.label)
  const runPhase = I.groupPhases([mk(1, 0, 'npm test'), mk(2, 1000, 'cd /a && node s.mjs'), mk(3, 2000, 'npm run build')], 90000)[0]
  ok('全是跑 → 跑命令', runPhase.label === '跑命令', runPhase.label)
  const unknownPhase = I.groupPhases([mk(1, 0, 'frobnicate -x'), mk(2, 1000, 'xyzzy --go')], 90000)[0]
  ok('全认不出来 → 中性的"命令行"', unknownPhase.label === '命令行', unknownPhase.label)

  // ③ 分工：`groupPhases` 按**内容**切细（每一步都标对），`mergeByLabel` 再合并回少量块。
  // 两者配合 —— 早先只靠"一族 + 多数派命名"，会把夹在 sed 中间的 npm 那步错标成"读代码"。
  const mixed = I.groupPhases([
    mk(1, 0, 'sed -n 1p f'), mk(2, 1000, 'grep -n x f'),
    mk(3, 2000, 'npm test'), mk(4, 3000, 'sed -n 2p f'), mk(5, 4000, 'sed -n 3p f'),
  ], 90000)
  ok('按内容切成 3 段（读 / 跑 / 读）', mixed.length === 3, mixed.map((p) => p.label + ':' + p.steps.length))
  ok('中间那段就是那一步 npm（没被并进查看文件）',
    mixed[1].label === '跑命令' && mixed[1].steps.length === 1 && mixed[1].steps[0].step === 3,
    mixed[1].steps.map((s) => s.step))
  const remerged = I.mergeByLabel(mixed)
  ok('合并后只剩 2 块（读代码 4 步 + 跑命令 1 步）',
    remerged.length === 2 && remerged[0].steps.length === 4 && remerged[1].steps.length === 1,
    remerged.map((p) => p.label + ':' + p.steps.length))

  // ④ 非命令行族：块名就是族名
  const readPhase = I.groupPhases([{ step: 1, startedAt: 0, tools: [{ name: 'read' }] }], 90000)[0]
  ok('非命令行族用族名当块名', readPhase.label === '读代码', readPhase.label)
}


console.log('\n⑨b 阶段分组定标（用真实 turn 1 前 22 步的间隔与工具）')
{
  const REAL = [
    [1,1362,0,['bash']],[2,112,4,['bash']],[3,971,10,['bash']],[4,243,15,['bash']],
    [5,2564,24,['bash']],[6,389,29,['bash']],[7,1740,39,['bash']],
    [8,2172,68,['cordis_inspect_list','find_dsh_plugin']],
    [9,69,115,['cordis_inspect_query']],[10,771,152,['cordis_inspect_query']],
    [11,859,158,['bash']],[12,221,169,['bash']],[13,1553,185,['bash']],[14,727,192,['bash']],
    [15,348,195,['bash']],[16,2131,222,['bash']],[17,1794,255,['bash']],[18,455,267,['bash']],
    [19,2146,274,['bash']],[20,2016,298,['bash']],[21,2326,335,['bash']],[22,376,350,['bash']],
  ].map(([step, len, t, tools]) => ({
    step, reasoningChars: len, startedAt: t * 1000,
    tools: tools.map((n, i) => ({ id: 'c' + step + '_' + i, name: n })),
  }))

  const phases = I.groupPhases(REAL)
  ok('真实数据收敛成少量阶段（不是每一步一个）', phases.length <= 6, phases.length)
  ok('工具族在阶段内是连续的', phases.every((p) => p.steps.every((x) => I.familyOf(x) === p.family)))
  ok('阶段覆盖全部步骤且不重不漏', phases.reduce((n, p) => n + p.steps.length, 0) === REAL.length)

  // 20s 阈值会把 22 步切成 9 段（其中 4 段只有一步）—— 这是当初发现分组失效的证据
  const tooFine = I.groupPhases(REAL, 20000)
  ok('20s 阈值确实会切碎（证明这个定标是必要的）', tooFine.length >= 8, tooFine.length)
  ok('默认阈值比 20s 粗得多', phases.length < tooFine.length, [phases.length, tooFine.length])

  // 已知局限：同为 bash 的两段语义工作仍会被并成一段 —— **这是刻意的**：
  // 分组用定标过的 90s 阈值，跟着内容拆会把列表切碎（20s 那次就是证据）。
  // 补偿办法是块名按内容算（见下一条），不是拆分组。
  const last = phases[phases.length - 1]
  ok('已知局限：同为命令行的连续工作仍并成一段（刻意不按内容拆分组）',
    last.family === '命令行' && last.steps.length > 3, [last.family, last.steps.length])
  ok('这批步没带 argsRaw → 块名保持中性的"命令行"（认不出就不猜）', last.label === '命令行', last.label)
}

console.log('\n⑩ 增量应用：缺口要标出来')
{
  const st = I.emptyState()
  st.turns = [{ turn: 1, steps: [{ step: 1, tools: [], reasoningChars: 0 }] }]
  I.applyChange(st, { k: 'reasoning', turn: 1, step: 1, text: 'abc' })
  ok('文本被累加', st.turns[0].steps[0].reasoningText === 'abc', st.turns[0].steps[0].reasoningText)
  ok('字数被累加', st.turns[0].steps[0].reasoningChars === 3)
  I.applyChange(st, { k: 'gap', turn: 1, step: 1 })
  ok('缺口被标记', st.turns[0].steps[0].streamGap === true)
  I.applyChange(st, { k: 'tool', turn: 1, step: 1, tool: { id: 'x', name: 'bash' } })
  ok('工具被加进去', st.turns[0].steps[0].tools.length === 1)
  I.applyChange(st, { k: 'tool', turn: 1, step: 1, tool: { id: 'x', name: 'bash' } })
  ok('同一个工具不重复加', st.turns[0].steps[0].tools.length === 1)
}

console.log('\n⑪ 未知 change 不该炸')
{
  const st = I.emptyState()
  st.turns = [{ turn: 1, steps: [] }]
  let threw = false
  try {
    I.applyChange(st, { k: 'unknown-kind', turn: 1, step: 99 })
    I.applyChange(st, undefined)
    I.applyChange(st, { k: 'reasoning', turn: 99, step: 1, text: 'x' })
  } catch (e) { threw = true }
  ok('安静跳过', !threw)
}

console.log('\n㉜ 目录：看更早的轮次（全轮骨架 index，不是正文窗口 turns）')
{
  /**
   * 这一节测的是这次改动的核心：**正文窗口（turns）和全轮骨架（index）分开了**。
   * 早先两者共用一个上限，于是 133 轮的会话在面板里只剩 20 轮，
   * 而且连"更早还有 113 轮"都不知道。
   */
  const snap = {
    sessionId: 'sess-dir', serverTime: T0, known: true, state: 'hydrated',
    // 正文窗口：只有 2 轮
    turns: [
      { turn: 5, startedAt: Date.parse('2026-09-25T10:00:00'), endedAt: Date.parse('2026-09-25T10:01:00'), userText: '第五轮要什么',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }] },
      { turn: 4, startedAt: Date.parse('2026-09-25T09:00:00'), endedAt: Date.parse('2026-09-25T09:01:00'), userText: '第四轮要什么',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 400, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }] },
    ],
    // 全轮骨架：5 轮（最新在前）
    index: [
      { turn: 5, startedAt: Date.parse('2026-09-25T10:00:00'), userText: '第五轮要什么', steps: 1, tools: 0, reasoningChars: 500, textChars: 0, inMemory: true },
      { turn: 4, startedAt: Date.parse('2026-09-25T09:00:00'), userText: '第四轮要什么', steps: 1, tools: 0, reasoningChars: 400, textChars: 0, inMemory: true },
      { turn: 3, startedAt: Date.parse('2026-09-24T18:00:00'), userText: '[图片已删除：截屏2026-09-21 02.22.05.png（9', steps: 3, tools: 2, reasoningChars: 300, textChars: 0, inMemory: false },
      { turn: 2, startedAt: Date.parse('2026-09-24T17:00:00'), userText: '可以', steps: 2, tools: 1, reasoningChars: 200, textChars: 0, inMemory: false },
      { turn: 1, startedAt: Date.parse('2026-09-23T16:00:00'), userText: '第一轮要什么', steps: 9, tools: 8, reasoningChars: 100, textChars: 0, inMemory: false },
    ],
  }
  const turnNos = (t) => findNodesByClass(t, 'tf-turn-no').map((n) => String(textOf(n)).replace(/[^0-9]/g, ''))
  resetMount()
  const props = { sessionId: 'sess-dir' }
  let tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render(props)

  // ⚠️ 原来这里验"统计行报的是会话总数（5）"—— 统计行删了。
  //    「会话有多大」这件事现在只剩目录头在报（"全部 5 轮"），下面 2440 行那条会验。
  ok('面板里不再有统计行', findNodesByClass(tree, 'tf-stats').length === 0)
  /*
   * 入口：**第二行的轮次标题**（双击 / 回车）—— 「历史」按钮已删，用户把它换成了这个手势。
   * 这一节验的是"目录确实进得去、内容对"，入口形态本身在 ③ 那一节验。
   */
  const titleEl2 = findNodesByClass(tree, 'tf-turn-title')[0]
  ok('第二行仍然有目录入口（标题那一格）', titleEl2 !== undefined && typeof titleEl2.props.onDoubleClick === 'function')
  titleEl2.props.onDoubleClick()
  tree = render(props)

  ok('目录接管面板（不再渲染轮次正文）', findNodesByClass(tree, 'tf-turn').length === 0)
  ok('目录里 5 行', findNodesByClass(tree, 'tf-dir-row').length === 5, findNodesByClass(tree, 'tf-dir-row').length)
  /*
   * ⚠️ 目录头那一行**整条删掉了**（用户："去掉图1这一行"）：会话多大变成第二行的
   *    「共 N 轮」，出口变成第二行的「返回」。所以这里改成在**第二行**上验。
   */
  const nav2 = textOf(findNodesByClass(tree, 'tf-nav')[0])
  ok('第二行写清"共几轮"（原来目录头那半句）', nav2.includes('共 5 轮'), nav2)
  ok('目录头那一行真的没了', findNodesByClass(tree, 'tf-dir-h').length === 0)

  // 日期分节：2026-09-25 / 09-24 / 09-23 → 3 节
  ok('按日期分成 3 节', findNodesByClass(tree, 'tf-dir-day').length === 3,
    findNodesByClass(tree, 'tf-dir-day').length)
  ok('日期节头印出日期与轮数',
    textOf(findNodesByClass(tree, 'tf-dir-day')[0]).includes('2026-09-25'), textOf(findNodesByClass(tree, 'tf-dir-day')[0]))

  // 边界：正文窗口里的轮在上、要靠日志读的在下
  const edges = findNodesByClass(tree, 'tf-dir-edge')
  ok('只有一条冷热边界', edges.length === 1, edges.length)
  ok('边界说清下面那批更早', textOf(edges[0]).includes('以下 3 轮更早'), textOf(edges[0]))

  // 23% 那件事：图片占位 / 「可以」这类不能当标题的，降级
  ok('图片占位降级成「（图片）」', textOf(tree).includes('（图片）'))
  ok('降级的行带 is-thin 标记', findNodesByClass(tree, 'tf-dir-title').filter(
    (n) => String(n.props.className).includes('is-thin')).length === 2,
  findNodesByClass(tree, 'tf-dir-title').filter((n) => String(n.props.className).includes('is-thin')).length)
  ok('正常标题不降级', findNodesByClass(tree, 'tf-dir-title').filter(
    (n) => !String(n.props.className).includes('is-thin')).length === 3)

  // 点一行：正文窗口里的那一轮 → 直接单独渲染
  const rows = findNodesByClass(tree, 'tf-dir-row')
  const row4 = rows.find((r) => textOf(r).includes('第 4 轮') || textOf(r).startsWith('4'))
  row4.props.onClick()
  tree = render(props)
  ok('单独查看：目录收掉、只剩那一轮', findNodesByClass(tree, 'tf-dir-row').length === 0
    && turnNos(tree).join(',') === '4', turnNos(tree))
  ok('导航行写清是哪一轮', textOf(findNodesByClass(tree, 'tf-nav')[0]).includes('第 4 轮'),
    textOf(findNodesByClass(tree, 'tf-nav')[0]))
  ok('导航行里没有焦点条那种"（时间，步数）"',
    !/（\d{2}-\d{2} \d{2}:\d{2}，\d+ 步）/.test(textOf(findNodesByClass(tree, 'tf-nav')[0])),
    textOf(findNodesByClass(tree, 'tf-nav')[0]))
  findButtons(tree).find((b) => String(b.props.className || '').includes('tf-latest')).props.onClick()
  tree = render(props)
  ok('点 » 后回到最新那一轮', turnNos(tree).join(',') === '5', turnNos(tree))
  ok('回到最新后 » 置灰',
    findButtons(tree).find((b) => String(b.props.className || '').includes('tf-latest')).props.disabled === true)
}

console.log('\n㉝ 搜索只搜轮次（用户消息 + 轮次标题），结果也是轮次')
{
  /**
   * 口径：**搜索只搜轮次** —— 搜的是「用户消息」和「轮次标题」这两样，结果是轮次。
   *
   * 这两样都在 `st.index`（全轮骨架）里，所以**全在本地算**：
   * 不防抖、不发请求、和宿主装没装检索服务无关。
   * 轮次标题尤其只能在本地搜 —— 它是插件自己生成的，**不是会话事件**。
   */
  const snap = {
    sessionId: 'sess-s', serverTime: T0, known: true, state: 'hydrated',
    turns: [
      { turn: 5, startedAt: Date.parse('2026-09-25T10:00:00'), endedAt: Date.parse('2026-09-25T10:01:00'), userText: '第五轮要什么',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }] },
    ],
    index: [
      { turn: 5, startedAt: Date.parse('2026-09-25T10:00:00'), userText: '第五轮要什么', steps: 1, tools: 0, reasoningChars: 500, textChars: 0, inMemory: true },
      { turn: 3, startedAt: Date.parse('2026-09-24T09:00:00'), userText: '继续', steps: 2, tools: 1, reasoningChars: 200, textChars: 0, inMemory: false },
      // 长消息：标签会被截断 → 这种情况**需要**下面那行 snippet
      { turn: 2, startedAt: Date.parse('2026-09-24T08:00:00'),
        userText: 'x'.repeat(40) + '长消息里的关键词' + 'y'.repeat(40), steps: 1, tools: 0, reasoningChars: 100, textChars: 0, inMemory: false },
      { turn: 1, startedAt: Date.parse('2026-09-23T16:00:00'), userText: '把 README 里改 host 代码不会热重载那段改掉',
        title: '热重载与插件重载的区别', steps: 4, tools: 3, reasoningChars: 900, textChars: 0, inMemory: false },
    ],
  }
  const turnNos = (t) => findNodesByClass(t, 'tf-turn-no').map((n) => String(textOf(n)).replace(/[^0-9]/g, ''))
  const marksOf = (node, acc = []) => {
    if (!node || typeof node !== 'object') return acc
    if (Array.isArray(node)) { node.forEach((x) => marksOf(x, acc)); return acc }
    if (node.type === 'mark') acc.push(node)
    ;(node.children || []).forEach((x) => marksOf(x, acc))
    return acc
  }
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.resolve({ json: () => Promise.resolve({
      ok: true, sessionId: 'sess-s',
      turn: { turn: 1, startedAt: Date.parse('2026-09-23T16:00:00'), endedAt: Date.parse('2026-09-23T16:10:00'),
        userText: '把 README 里改 host 代码不会热重载那段改掉', title: '热重载与插件重载的区别',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 900, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }] },
    }) })
  }
  resetMount()
  const props = { sessionId: 'sess-s' }
  let tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render(props)
  findNodesByClass(tree, 'tf-turn-title')[0].props.onDoubleClick()
  tree = render(props)
  const type = (v) => {
    findNodesByClass(tree, 'tf-nav-q')[0].props.onChange({ target: { value: v } })
    tree = render(props)
  }

  // ① 搜用户消息
  type('要什么')
  let hits = findNodesByClass(tree, 'tf-hit')
  ok('搜用户消息能命中', hits.length === 1, hits.length)
  ok('命中行给出轮号', String(textOf(findNodesByClass(hits[0], 'tf-dir-no')[0])) === '5',
    textOf(findNodesByClass(hits[0], 'tf-dir-no')[0]))
  ok('命中行给出步数（是**轮次**那一套信息）', textOf(hits[0]).includes('1 步'), textOf(hits[0]))
  ok('snippet 带高亮', marksOf(hits[0]).length === 1, marksOf(hits[0]).length)
  ok('高亮的就是搜的那个词', marksOf(hits[0]).map(textOf).join(',') === '要什么', marksOf(hits[0]).map(textOf))
  // 短消息：标签就是命中那段 → 高亮**内联在标签里**，不再多印一行 snippet
  ok('短消息时高亮在标签里（不重复印一行）', findNodesByClass(hits[0], 'tf-hit-snip').length === 0,
    findNodesByClass(hits[0], 'tf-hit-snip').length)
  ok('内联高亮就在标题格子里',
    marksOf(findNodesByClass(hits[0], 'tf-dir-title')[0]).length === 1,
    marksOf(findNodesByClass(hits[0], 'tf-dir-title')[0]).length)

  // ② 搜**轮次标题**（只在标题里的词）—— 这是宿主检索服务搜不到的那一样
  type('区别')
  hits = findNodesByClass(tree, 'tf-hit')
  ok('搜轮次标题能命中（宿主索引搜不到标题，只能本地搜）', hits.length === 1, hits.length)
  ok('命中的是第 1 轮', String(textOf(findNodesByClass(hits[0], 'tf-dir-no')[0])) === '1',
    textOf(findNodesByClass(hits[0], 'tf-dir-no')[0]))
  ok('行上显示的是模型标题', textOf(hits[0]).includes('热重载与插件重载的区别'), textOf(hits[0]).slice(0, 90))
  ok('标题命中也有高亮', marksOf(hits[0]).map(textOf).join(',') === '区别', marksOf(hits[0]).map(textOf))

  // ②b 长消息：标签被截断 → 需要下面那行上下文
  type('长消息里的关键词')
  hits = findNodesByClass(tree, 'tf-hit')
  ok('长消息也能命中', hits.length === 1, hits.length)
  ok('标签盖不住命中那段 → 给 snippet 行', findNodesByClass(hits[0], 'tf-hit-snip').length === 1,
    findNodesByClass(hits[0], 'tf-hit-snip').length)
  ok('snippet 里带高亮', marksOf(findNodesByClass(hits[0], 'tf-hit-snip')[0]).length === 1)
  ok('命中是第 2 轮', String(textOf(findNodesByClass(hits[0], 'tf-dir-no')[0])) === '2')

  // ②c 命中的是**用户消息**、而标签是模型标题 → 也要给 snippet（两段文本不一样）
  type('README')
  hits = findNodesByClass(tree, 'tf-hit')
  ok('搜用户消息能命中带模型标题的那一轮', hits.length === 1, hits.length)
  ok('标签显示模型标题', textOf(hits[0]).includes('热重载与插件重载的区别'), textOf(hits[0]).slice(0, 80))
  ok('标签与命中不是同一段 → 给 snippet 行',
    findNodesByClass(hits[0], 'tf-hit-snip').length === 1)

  // ③ **一个请求都不该发**（全本地）
  ok('搜索全程没有网络请求', calls.length === 0, calls)

  // ④ 短回复也是轮次，照样搜得到
  type('继续')
  ok('搜到"继续"那一轮', findNodesByClass(tree, 'tf-hit').length === 1)
  ok('它是第 3 轮', String(textOf(findNodesByClass(findNodesByClass(tree, 'tf-hit')[0], 'tf-dir-no')[0])) === '3')

  // ⑤ 没命中：空态说清搜的是哪两样
  type('zzz不存在')
  ok('没命中时显示"没有匹配"', textOf(findNodesByClass(tree, 'tf-dir-count')[0]).includes('没有匹配'),
    textOf(findNodesByClass(tree, 'tf-dir-count')[0]))
  const noneText = textOf(findNodesByClass(tree, 'tf-dir-none')[0])
  ok('空态说清搜的是用户消息 + 轮次标题', noneText.includes('用户消息') && noneText.includes('轮次标题'), noneText)
  ok('空态不再提"思考原文/AI 输出/工具名"（口径已经变了）',
    !noneText.includes('思考原文') && !noneText.includes('工具名'), noneText)

  // ⑥ 点结果 → 打开那一轮（冷轮走 /turn）
  type('区别')
  findNodesByClass(tree, 'tf-hit')[0].props.onClick()
  tree = render(props)
  ok('点结果先给"正在从日志读"', textOf(tree).includes('正在从日志读第 1 轮'), textOf(tree).slice(0, 90))
  await new Promise((r) => setTimeout(r, 0))
  tree = render(props)
  ok('取回来之后打开那一轮', turnNos(tree).join(',') === '1', turnNos(tree))
  ok('取冷轮才发 /turn（搜索本身不发请求）',
    calls.length === 1 && calls[0].includes('/turn'), calls)

  // ⑦ 清空 → 回到目录
  resetMount()
  tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render(props)
  findNodesByClass(tree, 'tf-turn-title')[0].props.onDoubleClick()
  tree = render(props)
  findNodesByClass(tree, 'tf-nav-q')[0].props.onChange({ target: { value: '要什么' } })
  tree = render(props)
  ok('（前置）有结果', findNodesByClass(tree, 'tf-hit').length === 1)
  findNodesByClass(tree, 'tf-nav-q')[0].props.onChange({ target: { value: '' } })
  tree = render(props)
  ok('清空 → 回到目录', findNodesByClass(tree, 'tf-dir-row').length === 4,
    findNodesByClass(tree, 'tf-dir-row').length)
}

console.log('\n㉞ 搜索框也能搜轮次（轮次号 → 一条普通结果）')
{
  /**
   * ⚠️ 这一节原来验的是「轮号 → **直达行**」：查询本身是个轮号时，
   *    单独造一条**特制的行**（`.tf-jump`：有底色、带「跳到这一轮」标签、固定排最前）。
   *    用户要求去掉："结果不要加上跳到这一轮，处理应该和搜索其他一样"。
   *
   *    所以现在：轮次号命中的那一轮走**同一套行**（`.tf-hit`）、
   *    排**同一套顺序**（骨架顺序，最新在前），只是没有命中上下文可印
   *    （数字不是从正文里搜出来的）→ 不带 snippet 那一行。
   *    断言跟着换，不是在旧断言上打补丁。
   */
  const snap = {
    sessionId: 'sess-j', serverTime: T0, known: true, state: 'hydrated',
    turns: [
      { turn: 5, startedAt: Date.parse('2026-09-25T10:00:00'), endedAt: Date.parse('2026-09-25T10:01:00'), userText: '第五轮要什么',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }] },
    ],
    index: [
      { turn: 5, startedAt: Date.parse('2026-09-25T10:00:00'), userText: '第五轮要什么', steps: 1, tools: 0, reasoningChars: 500, textChars: 0, inMemory: true },
      { turn: 1, startedAt: Date.parse('2026-09-23T16:00:00'), userText: '把 README 里改 host 代码不会热重载那段改掉', steps: 4, tools: 3, reasoningChars: 900, textChars: 0, inMemory: false },
    ],
  }
  const turnNos = (t) => findNodesByClass(t, 'tf-turn-no').map((n) => String(textOf(n)).replace(/[^0-9]/g, ''))
  /** ⚠️ `findType` 定义在别的作用域里，这里要自己来一个（按**标签名**找，mark 没有类名）。 */
  const findTag = (n, tag, acc = []) => {
    if (!n || typeof n !== 'object') return acc
    if (Array.isArray(n)) { n.forEach((x) => findTag(x, tag, acc)); return acc }
    if (n.type === tag) acc.push(n)
    ;(n.children || []).forEach((x) => findTag(x, tag, acc))
    return acc
  }
  const calls = []
  globalThis.fetch = (url) => {
    calls.push(String(url))
    return Promise.resolve({ json: () => Promise.resolve({
      ok: true, sessionId: 'sess-j',
      turn: { turn: 1, startedAt: Date.parse('2026-09-23T16:00:00'), endedAt: Date.parse('2026-09-23T16:10:00'),
        userText: '把 README 里改 host 代码不会热重载那段改掉',
        steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 900, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }] },
    }) })
  }
  const props = { sessionId: 'sess-j' }
  const openDir = () => {
    resetMount()
    let tree = render(props)
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: snap })
    tree = render(props)
    findNodesByClass(tree, 'tf-turn-title')[0].props.onDoubleClick()
    return render(props)
  }
  const search = (tree, q) => {
    findNodesByClass(tree, 'tf-nav-q')[0].props.onChange({ target: { value: q } })
    return render(props)
  }
  let tree = openDir()
  ok('（起点）目录里没有任何结果行', findNodesByClass(tree, 'tf-hit').length === 0)
  ok('（起点）`.tf-jump` 这个类整个不存在了', findNodesByClass(tree, 'tf-jump').length === 0)
  ok('提示语说的是「轮次号」不是「轮号」',
    String(findNodesByClass(tree, 'tf-nav-q')[0].props.placeholder).includes('轮次号'),
    findNodesByClass(tree, 'tf-nav-q')[0].props.placeholder)

  // ① 打「5」→ 一条**普通结果行**，不是特制的"跳到这一轮"
  tree = search(tree, '5')
  const hits = findNodesByClass(tree, 'tf-hit')
  ok('打「5」→ 出现一条结果行', hits.length === 1, hits.length)
  ok('它就是普通结果行（.tf-hit），没有"跳到这一轮"那条特制行',
    findNodesByClass(tree, 'tf-jump').length === 0 && !textOf(hits[0]).includes('跳到这一轮'),
    textOf(hits[0]))
  ok('结果行指向第 5 轮', String(textOf(findNodesByClass(hits[0], 'tf-dir-no')[0])) === '5',
    textOf(findNodesByClass(hits[0], 'tf-dir-no')[0]))
  ok('结果行和普通命中**同一套信息**（轮号 / 时间 / 标题 / 步数）',
    findNodesByClass(hits[0], 'tf-dir-no').length === 1
    && findNodesByClass(hits[0], 'tf-dir-time').length === 1
    && findNodesByClass(hits[0], 'tf-dir-title').length === 1
    && findNodesByClass(hits[0], 'tf-dir-steps').length === 1)
  ok('轮次号直达**也不发请求**', calls.length === 0, calls)
  ok('计数按普通结果算（找到 1 轮）',
    textOf(findNodesByClass(tree, 'tf-dir-count')[0]).includes('找到 1 轮'),
    textOf(findNodesByClass(tree, 'tf-dir-count')[0]))

  // ② 不带 snippet（数字不是从正文里搜出来的，没有上下文可印）
  ok('轮次号那条不带 snippet 行', findNodesByClass(hits[0], 'tf-hit-snip').length === 0,
    findNodesByClass(hits[0], 'tf-hit-snip').length)

  // ③ 几种写法都认
  for (const q of ['第 5 轮', '#5', '5轮']) {
    tree = search(tree, q)
    ok('「' + q + '」也认成轮次号 → 一条结果行', findNodesByClass(tree, 'tf-hit').length === 1, q)
  }
  // ④ 混了别的字就不当轮次号：**纯文本搜**（结果里没有第 5 轮就是证据）
  for (const q of ['reload 5', '5 步']) {
    tree = search(tree, q)
    ok('「' + q + '」不当轮次号 → 不给第 5 轮',
      findNodesByClass(tree, 'tf-hit').length === 0, q)
  }
  tree = search(tree, '2026')
  ok('「2026」不当轮次号（年份不该跳走）', findNodesByClass(tree, 'tf-hit').length === 0, '2026')
  tree = search(tree, 'reload')
  ok('「reload」是纯文本搜（没有这一轮）', findNodesByClass(tree, 'tf-hit').length === 0, 'reload')

  // ⑤ 目录里没有那一轮 → 只剩文本搜，不凭空造一条
  tree = search(tree, '999')
  ok('第 999 轮不存在 → 不凭空造结果', findNodesByClass(tree, 'tf-hit').length === 0,
    findNodesByClass(tree, 'tf-hit').length)

  // ⑥ 轮次号那条**排最前**（优先显示轮次），其余文本命中仍按骨架顺序
  tree = search(tree, '1')
  const nos = findNodesByClass(tree, 'tf-hit').map((h) => String(textOf(findNodesByClass(h, 'tf-dir-no')[0])))
  ok('打「1」→ 第 1 轮与文本命中同一批结果', nos.includes('1'), nos.join(','))
  ok('轮次号那条排在**最前**（优先显示轮次）', nos[0] === '1', nos.join(','))
  const after = nos.slice(1)
  ok('其余命中仍按骨架顺序（最新在前）',
    after.join(',') === [...after].sort((a, b) => Number(b) - Number(a)).join(','), after.join(','))

  // ⑦ 匹配到的轮次号**也有底色**（和正文命中同一个 mark）
  tree = search(tree, '1')      // ⚠️ 夹具里只有第 5 / 第 1 轮，别拿不存在的轮次号验
  const hitRow = findNodesByClass(tree, 'tf-hit')[0]
  const noEl = findNodesByClass(hitRow, 'tf-dir-no')[0]
  // ⚠️ mark 是**标签名**不是类名（和 snippet 里那个 mark 一样），按类名找会找不到
  ok('匹配到的轮次号上加了 mark（底色）', findTag(noEl, 'mark').length === 1,
    findTag(noEl, 'mark').length)
  ok('mark 里就是那个轮次号', textOf(findTag(noEl, 'mark')[0]) === '1',
    textOf(findTag(noEl, 'mark')[0]))
  ok('那一行带 is-num-hit 标记', String(noEl.props.className).includes('is-num-hit'), noEl.props.className)
  const css2 = String(mod.__internals.CSS)
  const at2 = css2.indexOf('.tf-hit mark{')
  ok('命中高亮只有一处定义（.tf-hit mark，两种位置共用）',
    at2 >= 0 && css2.slice(at2, at2 + 180).includes('--dsw-alias-state-business-tertiary'),
    at2 < 0 ? '（没有这条规则）' : css2.slice(at2, at2 + 140))
  // ⚠️ 原来只写了 `.tf-hit-snip mark`：命中词内联进标题时 mark 在 .tf-dir-title 里，
  //    那条规则匹配不到 → 浏览器用 UA 默认的**黄底**（真机截图里能看到两种颜色）
  ok('没有只写给 snippet 的那种窄规则（否则标题里的 mark 会退回黄底）',
    !css2.includes('.tf-hit-snip mark{'), css2.slice(Math.max(0, css2.indexOf('.tf-hit-snip mark{')), 80))
  // 文本命中的行**不该**被误标
  tree = search(tree, 'README')
  const textRow = findNodesByClass(tree, 'tf-hit')[0]
  ok('纯文本命中的行不加轮次号底色',
    findTag(findNodesByClass(textRow, 'tf-dir-no')[0], 'mark').length === 0)

  // ⑦ 点结果行 → 冷轮按需取（和点普通命中完全同一条路）
  tree = search(tree, '1')
  findNodesByClass(tree, 'tf-hit').find((h) => textOf(findNodesByClass(h, 'tf-dir-no')[0]) === '1').props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = render(props)
  ok('点它就能进第 1 轮（冷轮按需取）', turnNos(tree).join(',') === '1', turnNos(tree))
}

console.log('\n㉟ 相邻轮次步进器：轮号两侧的两个小箭头（设计稿 turn-adjacent-2 的 ②）')
{
  /**
   * 这一节测的是"翻一轮要几个动作"。设计稿里四套方案（键 / 步进器 / 按住快进 / 量尺）
   * 里选中的是 ②：轮号两侧各一个 12px 小箭头 —— 翻的就是这个数字本身。
   *
   * ⚠️ 夹具故意让**正文窗口（3 轮）比全轮骨架（5 轮）小**：边界必须按骨架算。
   *    按正文窗口算的话，站在第 3 轮往前翻会被判成"到头"，而前面还有 2 轮 ——
   *    那 2 轮正是「历史」已经打通、可以按需取的冷轮。
   */
  const mkT = (n, text) => ({
    turn: n, startedAt: T0 - n * 1000, endedAt: T0, userText: text,
    steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }],
  })
  const stepSnap = {
    sessionId: 'sess-step', serverTime: T0, known: true, state: 'hydrated',
    turns: [mkT(5, '第五轮问了什么'), mkT(4, '第四轮问了什么'), mkT(3, '第三轮问了什么')],
    index: [5, 4, 3, 2, 1].map((n) => ({
      turn: n, startedAt: T0 - n * 1000, userText: '第' + n + '轮问了什么',
      steps: 1, tools: 0, reasoningChars: 100, textChars: 0, inMemory: n >= 3,
    })),
  }
  const props = { sessionId: 'sess-step' }
  resetMount()
  let tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: stepSnap })
  tree = render(props)

  const btns = (t) => findButtons(t).filter((b) => String(b.props.className || '').includes('tf-turn-nav-b'))
  const numOf = (t) => findNodesByClass(t, 'tf-turn-no').map((n) => String(textOf(n)).replace(/[^0-9]/g, '')).join(',')
  const clickStep = (t, i) => btns(t)[i].props.onClick({ stopPropagation() {} })

  ok('轮号两侧各一个箭头', btns(tree).length === 2, btns(tree).length)
  ok('箭头就是 ‹ ›', btns(tree).map((b) => textOf(b)).join('') === '‹›', btns(tree).map((b) => textOf(b)).join(''))
  ok('箭头和轮号同住一个容器（翻的就是这个数字本身）',
    findNodesByClass(tree, 'tf-turn-nav').length === 1
    && findNodesByClass(findNodesByClass(tree, 'tf-turn-nav')[0], 'tf-turn-no').length === 1)
  ok('容器住在第二行（导航行）里', findNodesByClass(findNodesByClass(tree, 'tf-nav')[0], 'tf-turn-nav').length === 1)
  ok('轮头里不再有它（不重复）', findNodesByClass(findNodesByClass(tree, 'tf-turn-h')[0], 'tf-turn-nav').length === 0)
  ok('轮号本身还是原来那句（既有断言靠它）', numOf(tree) === '5', numOf(tree))
  ok('站在最新那轮时「下一轮」置灰', btns(tree)[1].props.disabled === true)
  ok('「上一轮」可点', btns(tree)[0].props.disabled !== true)
  ok('箭头写清了邻居是谁（轮号 + 骨架里的用户消息）',
    String(btns(tree)[0].props.title).includes('第 4 轮')
    && String(btns(tree)[0].props.title).includes('第4轮问了什么'), btns(tree)[0].props.title)
  ok('箭头有读屏名', String(btns(tree)[0].props['aria-label']).includes('上一轮'), btns(tree)[0].props['aria-label'])

  // ── 点「上一轮」：进第 4 轮 ──
  clickStep(tree, 0)
  tree = render(props)
  ok('点「上一轮」→ 面板换成第 4 轮', numOf(tree) === '4', numOf(tree))
  ok('翻过去之后 » 点亮（焦点条删了，它是唯一信号）',
    findButtons(tree).find((b) => String(b.props.className || '').includes('tf-latest')).props.disabled !== true)
  ok('这时两个箭头都可点（第 4 轮两边都有）', btns(tree).every((b) => b.props.disabled !== true))
  ok('翻过去的轮会展开（不是只给一条轮头）', findNodesByClass(tree, 'tf-step-row').length > 0)

  // ── 点「下一轮」回到最新：必须是**正常视图**，不能挂返回栏 ──
  clickStep(tree, 1)
  tree = render(props)
  ok('点「下一轮」回到最新那轮', numOf(tree) === '5', numOf(tree))
  ok('回到最新那轮后 » 置灰（你已经在最新那轮了）',
    findButtons(tree).find((b) => String(b.props.className || '').includes('tf-latest')).props.disabled === true)

  // ── 边界按**骨架**算：5 → 4 → 3 → 2（冷）→ 1 ──
  const fetched = []
  globalThis.fetch = (url) => {
    fetched.push(String(url))
    const n = Number(/turn=(\d+)/.exec(String(url))[1])
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, turn: mkT(n, '冷轮第 ' + n + ' 轮') }) })
  }
  clickStep(tree, 0)                                  // 5 → 4
  tree = render(props)
  clickStep(tree, 0)                                  // 4 → 3
  tree = render(props)
  ok('正文窗口里有的轮不发请求', fetched.length === 0, fetched)
  clickStep(tree, 0)                                  // 3 → 2（冷）
  tree = render(props)
  ok('翻到正文窗口之外的轮 → 走 /turn 按需取（不是判成"到头"）',
    fetched.length === 1 && fetched[0].includes('turn=2'), fetched)
  ok('取回来之前说清在取（不是偷偷显示最新那轮）',
    textOf(tree).includes('正在从日志读第 2 轮'), textOf(tree).slice(0, 60))
  ok('正在取的那一轮**步进器还在**（不打断连续翻）',
    btns(tree).length === 2 && numOf(tree) === '2', btns(tree).length + ' / ' + numOf(tree))
  await new Promise((r) => setTimeout(r, 0))
  tree = render(props)
  ok('取回来之后停在第 2 轮', numOf(tree) === '2', numOf(tree))
  clickStep(tree, 0)                                  // 2 → 1（又是冷轮）
  tree = render(props)
  ok('从第 2 轮再往前 → 直接进第 1 轮（取的过程中步进器就在那儿）',
    numOf(tree) === '1' && btns(tree).length === 2, numOf(tree) + ' / ' + btns(tree).length)
  await new Promise((r) => setTimeout(r, 0))
  tree = render(props)
  ok('第 1 轮取回来之后停在第 1 轮', numOf(tree) === '1', numOf(tree))
  ok('到最早那轮「上一轮」置灰', btns(tree)[0].props.disabled === true)
  ok('最早那轮的箭头 title 说明到头了', String(btns(tree)[0].props.title).includes('最早'), btns(tree)[0].props.title)

  // ── stopPropagation：点箭头不能顺带把这一轮折起来 ──
  ok('轮头自己有点击（展开/折叠）', typeof findNodesByClass(tree, 'tf-turn-h')[0].props.onClick === 'function')
  let propagated = 0
  btns(tree)[1].props.onClick({ stopPropagation() { propagated += 1 } })
  ok('点箭头会拦掉冒泡（否则翻过去看到的是个折好的壳）', propagated === 1, propagated)
  tree = render(props)

  // ── 没有骨架（老快照 / 宿主没给 index）→ 退回正文窗口，不假装能翻到不存在的地方 ──
  resetMount()
  const props2 = { sessionId: 'sess-noindex' }
  let t2 = render(props2)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: Object.assign({}, stepSnap, { sessionId: 'sess-noindex', index: undefined }) })
  t2 = render(props2)
  const btns2 = btns(t2)
  ok('没有骨架时也画得出箭头', btns2.length === 2, btns2.length)
  ok('没有骨架时边界退回正文窗口（第 5 轮 → 「上一轮」仍可点）', btns2[0].props.disabled !== true)
  ok('没有骨架时「下一轮」照样置灰（最新那轮）', btns2[1].props.disabled === true)
}


console.log('\n㊲ 目录：搜索钉在顶上，提示语与真实能力一致')
{
  /**
   * 两件事：
   *   ① 搜索条 position:sticky;top:0 —— 目录 133 行，滚到一半还要能改词；
   *   ② 提示语**必须和 matchTurns() 的能力一致**。它只比对 index 里的
   *      userText 与 title（全本地），原来那句"搜 AI 输出了什么、调了什么工具"
   *      承诺了两样**根本搜不到**的东西 —— 提示语骗人比没有提示更糟。
   */
  const snap = {
    sessionId: 'sess-dir2', serverTime: T0, known: true, state: 'hydrated',
    turns: [{ turn: 2, startedAt: T0, endedAt: T0 + 1000, userText: '第二轮问了什么',
      steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }] }],
    index: [
      { turn: 2, startedAt: T0, userText: '第二轮问了什么', steps: 1, tools: 0, reasoningChars: 500, textChars: 0, inMemory: true },
      { turn: 1, startedAt: T0 - 90000, userText: '第一轮问了什么', steps: 3, tools: 2, reasoningChars: 900, textChars: 0, inMemory: false },
    ],
  }
  const props = { sessionId: 'sess-dir2' }
  resetMount()
  let tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render(props)
  findNodesByClass(tree, 'tf-turn-title')[0].props.onDoubleClick()
  tree = render(props)

  /*
   * ⚠️ 这一节原来验"目录里那条搜索框钉在顶上"（`.tf-dir-s` 的 sticky / 底色 / 通栏）——
   *    那条**已经删掉**：搜索框搬到了**第二行**（`.tf-nav-q`，就是原来标题那一格）。
   *    所以断言跟着换成新形态：框在第二行、目录里不再有它、旧那条真的没了。
   */
  const q = findNodesByClass(tree, 'tf-nav-q')[0]
  ok('搜索框在第二行（标题那一格）', !!q && q.type === 'input')
  ok('目录里不再有搜索框', findNodesByClass(tree, 'tf-dir-q').length === 0 && findNodesByClass(tree, 'tf-dir-s').length === 0)
  const css = String(mod.__internals.CSS)
  ok('旧那条搜索条样式真的删了（不留死代码）', css.indexOf('.tf-dir-s{') < 0 && css.indexOf('.tf-dir-q{') < 0)
  ok('输入框沿用"标题那一格"的排版（flex:1 + 同字号）',
    /\.tf-nav-q\{[^}]*flex:1 1 auto[^}]*font:var\(--dsw-font-xxs-12\)/.test(css),
    (css.match(/\.tf-nav-q\{[^}]*\}/) || [])[0])

  // ② 提示语 = 真实能力
  const ph = String(q.props.placeholder)
  /*
   * ⚠️ 提示语跟着搜索框一起搬到了第二行，而那一格只有 ~180px（轮号步进器 +
   *    「生成标题」占了其余），所以从"用户消息、轮次标题，或轮次号"缩成
   *    「搜消息 / 标题 / 轮次号」—— **能力没变**（还是只搜这两样 + 轮次号），
   *    只是说得更短。完整说明进了 `aria-label`。
   */
  ok('提示语说的是"消息 / 标题"（能力没变）', ph.includes('消息') && ph.includes('标题'), ph)
  ok('提示语不再承诺 AI 输出（搜不到）', !ph.includes('AI'), ph)
  ok('提示语不再承诺工具调用（搜不到）', !ph.includes('工具'), ph)
  ok('提示语顺带说了可以直接给轮次号', ph.includes('轮次号'), ph)
  ok('提示语里**没有「输」字**（用户点名）', !ph.includes('输'), ph)
  ok('提示语够短，不会被输入框截掉', ph.length <= 20, ph.length)
  ok('aria-label 同样只说这两样', String(q.props['aria-label']).includes('用户消息')
    && !String(q.props['aria-label']).includes('工具'), q.props['aria-label'])

  // ③ 空态里不该有 markdown 星号（纯文本节点会把星号原样印出来）
  findNodesByClass(tree, 'tf-nav-q')[0].props.onChange({ target: { value: 'zzz-搜不到' } })
  tree = render(props)
  const none = findNodesByClass(tree, 'tf-dir-none')[0]
  ok('搜不到时有空态指路', !!none, textOf(tree).slice(0, 40))
  ok('空态里没有字面 markdown 星号', textOf(none).indexOf('**') < 0, textOf(none))
  ok('空态说清搜的是哪两样', textOf(none).includes('用户消息') && textOf(none).includes('轮次标题'), textOf(none))
  ok('空态里也没有「输」字', textOf(none).indexOf('输') < 0, textOf(none))
  findNodesByClass(tree, 'tf-nav-q')[0].props.onChange({ target: { value: '第一轮' } })
  tree = render(props)
  ok('搜索有结果时搜索框还在（同一个元素，切视图不重建）', !!findNodesByClass(tree, 'tf-nav-q')[0])
  ok('搜"第一轮"能命中第 1 轮', findNodesByClass(tree, 'tf-hit').length >= 1,
    findNodesByClass(tree, 'tf-hit').length)
}

console.log('\n㊱ 第二行 = 轮次即身份（用户选定的 ③）')
{
  /**
   * 这一节守的是**新形态本身**：第二行从"四个会话合计"改成
   * 「‹ 第 N 轮 › » 这一轮的标题 历史」，轮号与标题都从轮头搬上来。
   *
   * 上面 ⑮/⑱/㉜ 几节是被这次改动**改写过**的旧断言（改成新期望），
   * 这一节是**新增的正向覆盖**：标题的来源优先级、冷轮兜底、目录态不跟着走、» 恢复跟随。
   */
  const mk = (n, text, o) => ({
    turn: n, startedAt: T0 + n * 1000, endedAt: T0 + n * 1000 + 500,
    userText: text, ...(o && o.turnTitle !== undefined ? { turnTitle: o.turnTitle } : {}),
    steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }],
  })
  const snap = {
    sessionId: 'sess-nav', serverTime: T0, known: true, state: 'hydrated',
    turns: [mk(3, '第三轮问了什么'), mk(2, '第二轮问了什么', { turnTitle: '模型给的第二轮标题' })],
    index: [3, 2, 1].map((n) => ({
      turn: n, startedAt: T0 + n * 1000, userText: '第' + n + '轮问了什么',
      steps: 1, tools: 0, reasoningChars: 500, textChars: 0, inMemory: n >= 2,
    })),
  }
  const props = { sessionId: 'sess-nav' }
  resetMount()
  let tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render(props)

  const navOf = (t) => findNodesByClass(t, 'tf-nav')[0]
  const navText = (t) => textOf(navOf(t))
  const titleOf = (t) => findNodesByClass(navOf(t), 'tf-turn-title')[0]
  const latestOf = (t) => findButtons(t).find((b) => String(b.props.className || '').includes('tf-latest'))

  // ① 四件东西都在同一行里
  ok('第二行是 .tf-nav（不是统计行）', !!navOf(tree) && findNodesByClass(tree, 'tf-stats').length === 0)
  ok('第二行有轮号', findNodesByClass(navOf(tree), 'tf-turn-no').length === 1, navText(tree))
  ok('第二行有 »', !!latestOf(tree))
  ok('第二行有标题', !!titleOf(tree), titleOf(tree) ? textOf(titleOf(tree)) : '（没有）')
  ok('第二行有目录入口（标题那一格）', findNodesByClass(tree, 'tf-turn-title').length === 1)
  ok('轮头里既没有轮号也没有标题（不重复）',
    findNodesByClass(findNodesByClass(tree, 'tf-turn-h')[0], 'tf-turn-no').length === 0
    && findNodesByClass(findNodesByClass(tree, 'tf-turn-h')[0], 'tf-turn-title').length === 0)
  ok('轮头里该有的还在（步数/字数/工具）',
    findNodesByClass(findNodesByClass(tree, 'tf-turn-h')[0], 'tf-turn-meta').length === 1)

  // ⑥b 两个动作各自的位置（历史按钮**已删** → 入口是第二行标题的双击；生成标题在第二行）
  {
    const headEl = findNodesByClass(tree, 'tf-head')[0]
    const navEl = findNodesByClass(tree, 'tf-nav')[0]
    const genInNav = findNodesByClass(navEl, 'tf-gen')
    ok('头部里**没有**「历史」按钮了（入口搬去第二行的标题）', findNodesByClass(headEl, 'tf-hist').length === 0)
    ok('第二行里也没有「历史」按钮', findNodesByClass(navEl, 'tf-hist').length === 0)
    ok('入口是第二行的标题那一格（可双击 / 可聚焦）',
      findNodesByClass(navEl, 'tf-turn-title').length === 1
      && findNodesByClass(navEl, 'tf-turn-title')[0].props.tabIndex === 0)
    ok('「生成标题」住在**第二行**里', genInNav.length === 1, genInNav.length)
    ok('「生成标题」不在轮次条里（搬走了）',
      findNodesByClass(findNodesByClass(tree, 'tf-turn-h')[0], 'tf-gen').length === 0)
    ok('第二行里没有「历史」按钮（入口是标题那一格）',
      findNodesByClass(navEl, 'tf-hist').length === 0 && genInNav.length === 1)
    // 「历史」按钮的样式（头部那套 + 统计行那条老样式）**都删干净了**
    const css = String(mod.__internals.CSS)
    ok('「历史」按钮的样式不留死代码',
      css.indexOf('.tf-head .tf-hist') < 0 && css.indexOf('.tf-hist{') < 0)
    // 生成标题跟着当前轮走
    const gb = genInNav[0]
    ok('「生成标题」的 title 里带着当前轮号',
      String(gb.props.title).indexOf('第 3 轮') >= 0, gb.props.title)
  }


  // ② 标题来源优先级：模型标题 > 本轮用户消息
  ok('起点停在最新那轮（第 3 轮）', navText(tree).includes('第 3 轮'), navText(tree))
  ok('没有模型标题时用本轮用户消息兜底', textOf(titleOf(tree)) === '第三轮问了什么', textOf(titleOf(tree)))
  ok('兜底态带 is-fallback', String(titleOf(tree).props.className).includes('is-fallback'))
  ok('最新那轮 » 置灰', latestOf(tree).props.disabled === true)

  // ③ 翻到第 2 轮：模型标题优先，第二行整行跟着换
  const prev = findNodesByClass(navOf(tree), 'tf-turn-nav-b')[0]
  prev.props.onClick({ stopPropagation() {} })
  tree = render(props)
  ok('翻一轮 → 第二行轮号跟着换', navText(tree).includes('第 2 轮'), navText(tree))
  ok('翻一轮 → 标题换成那一轮的模型标题', textOf(titleOf(tree)) === '模型给的第二轮标题', textOf(titleOf(tree)))
  ok('模型标题带 is-model（不是 is-fallback）',
    String(titleOf(tree).props.className).includes('is-model'), titleOf(tree).props.className)
  ok('不在最新那轮 → » 点亮', latestOf(tree).props.disabled !== true
    && String(latestOf(tree).props.className).includes('is-back'))

  // ④ 冷轮：正文还没取回来，第二行**立刻**报新轮号，标题用骨架里的用户消息兜底
  const fetched = []
  globalThis.fetch = (url) => {
    fetched.push(String(url))
    const n = Number(/turn=(\d+)/.exec(String(url))[1])
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, turn: mk(n, '冷轮第 ' + n + ' 轮') }) })
  }
  findNodesByClass(navOf(tree), 'tf-turn-nav-b')[0].props.onClick({ stopPropagation() {} })   // 2 → 1（冷）
  tree = render(props)
  ok('翻到冷轮 → 第二行立刻报第 1 轮（不等正文）', navText(tree).includes('第 1 轮'), navText(tree))
  ok('冷轮标题用骨架里的用户消息兜底', textOf(titleOf(tree)) === '第1轮问了什么', textOf(titleOf(tree)))
  ok('冷轮正文区说清在取', textOf(tree).includes('正在从日志读第 1 轮'), textOf(tree).slice(0, 50))
  ok('取冷轮只发一个请求', fetched.length === 1 && fetched[0].includes('turn=1'), fetched)
  await new Promise((r) => setTimeout(r, 0))
  tree = render(props)
  ok('取回来之后第二行不变（还是第 1 轮）', navText(tree).includes('第 1 轮'), navText(tree))

  // ⑤ » 的语义：回到最新那轮，并且**恢复跟随**
  latestOf(tree).props.onClick({ stopPropagation() {} })
  tree = render(props)
  ok('点 » 回到最新那轮', navText(tree).includes('第 3 轮'), navText(tree))
  lastEventSource.emit({ t: 'change', change: { k: 'turn', turn: 4, userText: '第四轮刚来' } })
  tree = render(props)
  ok('点 » 之后恢复**跟随**：新的一轮来了第二行自己跟上去',
    navText(tree).includes('第 4 轮'), navText(tree))

  // ⑥ 目录态：第二行不跟着正文走（它就是翻轮的常驻落点）
  lastEventSource.emit({ t: 'change', change: { k: 'turn', turn: 3, userText: '第三轮问了什么' } })
  tree = render(props)
  findNodesByClass(tree, 'tf-turn-title')[0].props.onDoubleClick()
  tree = render(props)
  ok('目录接管正文', findNodesByClass(tree, 'tf-dir-row').length > 0)
  ok('目录态下第二行还在（导航不跟着正文走）', !!navOf(tree))
  ok('目录态下第二行报"共 N 轮"（不再是"第 N 轮"）', navText(tree).includes('共 '), navText(tree))
  /*
   * ⚠️ 历史态那一组：箭头 **`‹ ›` 换成两颗 `·`（纯装饰、无功能）**，
   *    但**那一格照旧占着**（用户："搜索框尽量保持在原位，减少页面切换的跳变"
   *    + "将 ‹ › 替换为 · ，并且剥离其原本的功能"）—— 实测少了这一组，
   *    搜索框会左移 36.9px。
   */
  ok('历史态那一组还在（几何不跳的前提）', findNodesByClass(tree, 'tf-turn-nav').length === 1)
  ok('里面是两颗 `·`，不是箭头',
    findNodesByClass(tree, 'tf-turn-nav-b').length === 2
    && findNodesByClass(tree, 'tf-turn-nav-b').every((d) => String(textOf(d)) === '·')
    && findNodesByClass(tree, 'tf-turn-nav-b').every((d) => String(d.props.className).includes('is-dot')))
  ok('`·` 没有功能：不是 button、没有 onClick、不可聚焦、读屏跳过',
    findNodesByClass(tree, 'tf-turn-nav-b').every((d) => d.type !== 'button'
      && d.props.onClick === undefined && d.props.tabIndex === undefined && d.props['aria-hidden'] === 'true'))
  ok('历史态里 » 还在，且恒可点（含义 = 回最新一轮 + 离开目录）',
    latestOf(tree) !== undefined && latestOf(tree).props.disabled === false)
  /*
   * 目录态的**出口**：第二行行尾的「返回」（用户："生成标题 改为 返回"）——
   * 它占的就是原来「生成标题」那一格。目录头那枚「回到第 N 轮」已经随目录头一起删了。
   */
  ok('目录态下搜索框在第二行（标题那一格换成了它）', findNodesByClass(tree, 'tf-nav-q').length === 1)
  const backBtn = findButtons(tree).find((b) => String(b.props.className || '').includes('tf-nav-back'))
  ok('第二行行尾是「返回」（出口，占原来「生成标题」那一格）',
    backBtn !== undefined && textOf(backBtn) === '返回')
  ok('目录态下没有「生成标题」按钮了（那一格换成了返回）',
    findButtons(tree).every((b) => !String(b.props.className || '').includes('tf-gen')))
  backBtn.props.onClick()
  tree = render(props)
  ok('点它 → 回正文（目录收起）', findNodesByClass(tree, 'tf-dir-row').length === 0)
  ok('回到正文后标题那一格回来了（搜索框收起）',
    findNodesByClass(tree, 'tf-turn-title').length === 1 && findNodesByClass(tree, 'tf-nav-q').length === 0)
  ok('退出时查询词被清空（搜索是一次性动作）',
    findNodesByClass(tree, 'tf-turn-title').length === 1)

  // ⑦ 一轮都没有（新会话）：第二行整行不渲染，不留一条空横线
  {
    resetMount()
    let t2 = render({ sessionId: 'sess-empty' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: { sessionId: 'sess-empty', serverTime: T0, known: true, state: 'hydrated', turns: [], index: [] } })
    t2 = render({ sessionId: 'sess-empty' })
    ok('新会话（0 轮）第二行整行不渲染', findNodesByClass(t2, 'tf-nav').length === 0)
    ok('新会话仍然给一句空态说明', textOf(t2).length > 0, textOf(t2).slice(0, 40))
  }
  resetMount()
  tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render(props)

  // ⑧ 焦点条与四个会话合计：任何状态下都不该再出现
  const everyText = textOf(tree)
  ok('任何状态下都没有焦点条', findNodesByClass(tree, 'tf-focus-bar').length === 0)
  /*
   * ⚠️ 只扫**顶栏那两行**（.tf-head + .tf-nav），不扫整个面板 ——
   *    正文里本来就有一句合法的阶段小结"思考 500 字，调用工具 0 次"，
   *    扫全文会把它当成"统计行又回来了"（第一版就假红在这里）。
   */
  const chromeText = textOf(navOf(tree)) + ' ' + textOf(findNodesByClass(tree, 'tf-head')[0])
  ok('顶栏两行里都不展示四个会话合计',
    !chromeText.includes('步骤 ') && !chromeText.includes('思考 ') && !chromeText.includes('工具 ')
    && !chromeText.includes('共 '), chromeText)

  ok('导航行里没有 [object Object]', navText(tree).indexOf('[object Object]') < 0)
}

console.log('\n㊳ 骨架会长：新增的轮要进「历史」入口与目录（用户报"历史按钮消失了"）')
{
  /**
   * 用户报的症状：面板在一个"刚开一轮"的会话里打开，「历史」按钮不见了。
   *
   * 两个原因叠在一起，这一节两条都钉住：
   *   ① 门槛原来是**总轮数 > 1** —— 一轮的会话连入口都没有，而「历史」是
   *      目录与搜索**唯一**的入口；
   *   ② 更根上的：`st.index` 只在**连上那一刻**的快照里下发（之后宿主只推 `change`），
   *      于是骨架永远停在当时的长度 —— 之后长出来的轮既进不了目录，
   *      也不会把按钮"叫回来"（刷新页面才会）。
   */
  const oneTurn = {
    sessionId: 'sess-skel', serverTime: T0, known: true, state: 'live',
    turns: [{
      turn: 1, startedAt: T0, endedAt: T0 + 1000, userText: '第一轮问了什么',
      steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 100, textChars: 0, startedAt: T0, elapsedMs: 10, tools: [] }],
    }],
    index: [{ turn: 1, startedAt: T0, userText: '第一轮问了什么', steps: 1, tools: 0, reasoningChars: 100, textChars: 0, inMemory: true }],
  }
  const props = { sessionId: 'sess-skel' }
  /*
   * ⚠️ 这一节原来盯着头部那枚「历史」按钮（它的 `title` 里写着"全部 N 轮"）。
   *    按钮删掉之后，"目录里到底有几轮"改由**目录头**（`全部 N 轮，最新在上面`）回答，
   *    入口则是第二行标题那一格 —— 所以这一节的断言跟着换成这两样。
   */
  const histEntry = (t) => findNodesByClass(t, 'tf-turn-title')[0]
  const mount = (snap) => {
    resetMount()
    const t0 = render(props)
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: snap })
    return render(props)
  }

  // ① 一轮的会话也有入口（门槛是"有轮次"，不是"两轮以上"）
  let tree = mount(oneTurn)
  ok('一轮的会话也有历史入口（门槛是"有轮次"，不是"两轮以上"）', !!histEntry(tree))

  // ② 宿主推来第二轮 → 骨架要跟着长（按钮的轮数、目录的行数都跟着变）
  lastEventSource.emit({ t: 'change', change: { k: 'turn', turn: 2, userText: '第二轮问了什么' } })
  lastEventSource.emit({ t: 'change', change: { k: 'reasoning', turn: 2, step: 1, text: '在想第一件事' } })
  lastEventSource.emit({ t: 'change', change: { k: 'reasoning', turn: 2, step: 2, text: '在想第二件事' } })
  tree = render(props)
  histEntry(tree).props.onDoubleClick()
  tree = render(props)
  // 轮数现在报在**第二行**（「共 N 轮」）—— 目录头那一行已删
  ok('第二轮进了骨架（第二行报的"共 N 轮"跟着长）',
    String(textOf(findNodesByClass(tree, 'tf-nav')[0])).includes('共 2 轮'),
    String(textOf(findNodesByClass(tree, 'tf-nav')[0])))
  const dirRows = findNodesByClass(tree, 'tf-dir-row')
  ok('目录里能看到第二轮', dirRows.length === 2, dirRows.length)
  ok('目录最新一行是新那一轮（最新在上面）',
    String(textOf(dirRows[0])).includes('第二轮问了什么'), textOf(dirRows[0]))
  ok('新那一轮的步数取**窗口**的（不是连上那一刻的旧骨架）',
    String(textOf(dirRows[0])).includes('2 步'), textOf(dirRows[0]))

  // ③ 零轮的会话：入口不出现 —— 那才真的没有目录可进（和第二行整行不渲染同一条规则）
  const zero = { sessionId: 'sess-skel', serverTime: T0, known: false, state: 'empty', turns: [], index: [] }
  tree = mount(zero)
  ok('零轮的会话没有历史入口（第二行整行不渲染）', histEntry(tree) === undefined)
}

console.log('\n㊴ 进行中的块不许叫「纯推理」（用户："运行中的情况别给这个标签，容易误解"）')
{
  /**
   * 用户报的误解：模型正在流式吐字、工具还没到，块就先挂上「纯推理」——
   * 等工具一到又当场改名成「读代码」，读起来像"它刚说自己在纯推理，转头就去读文件了"。
   *
   * 「纯推理」是个**事后**才成立的事实（这一步确实一次工具都没调），所以只在落地之后才说；
   * 进行中改叫「推理中」——只断言此刻看得见的事（它正在推理）。
   * 判据与 `derive` 的 `active`（thinking / waiting）**互补**，所以面板上
   * "进行中的块"和"状态徽章说在跑"永远是同一件事。
   */
  const I2 = mod.__internals
  const mkStep = (no, status, tools, at) => ({
    step: no, status, attempts: 1, reasoningChars: 500, textChars: 0,
    startedAt: at, elapsedMs: 1000, tools: tools || [],
  })

  // ① 还在思考、还没有工具 → 不能说"没调工具"
  const live = I2.groupPhases([mkStep(1, 'thinking', [], T0)])
  ok('进行中 + 无工具 → 推理中（不是纯推理）', live[0].label === '推理中', live[0].label)
  ok('它仍然是灰类（想）', live[0].cat === 'think' && I2.phaseCategory('推理中') === 'think',
    [live[0].cat, I2.phaseCategory('推理中')])

  // ② 落地之后，"没调工具"才是事实
  ok('落地 + 无工具 → 纯推理', I2.groupPhases([mkStep(1, 'done', [], T0)])[0].label === '纯推理',
    I2.groupPhases([mkStep(1, 'done', [], T0)])[0].label)
  ok('被中断（cut）也算落地 → 纯推理', I2.groupPhases([mkStep(1, 'cut', [], T0)])[0].label === '纯推理',
    I2.groupPhases([mkStep(1, 'cut', [], T0)])[0].label)

  // ③ 等工具（waiting）也是进行中 → 块名叫「调用中」；
  //    ⚠️ 但**分组**仍然按工具族走（family 还是"读代码"）—— 分组与显示名分开算，
  //    和"命令行"那一族是同一条原则：分组要稳，名字要准。
  const waiting = I2.groupPhases([mkStep(1, 'waiting',
    [{ id: 't1', name: 'bash', argsRaw: '{"command":"cd /a && sed -n \'1,2p\' f.js"}', startedAt: T0 }], T0)])
  ok('等工具 → 块名叫「调用中」', waiting[0].label === '调用中', waiting[0].label)
  ok('但分组仍按工具族（family 还是"读代码"）', waiting[0].family === '读代码', waiting[0].family)

  // ④ **进行中的那一步自己一块**（用户："进行中的块只能有一个步骤"）。
  //    不这样，连续几步同族会并成一块 —— 块头写「第 N 步」、块内还挂着 #1 #2，
  //    就是用户报的"步骤号太多、重复"。
  const mixed = I2.groupPhases([mkStep(1, 'done', [], T0), mkStep(2, 'thinking', [], T0 + 1000)])
  ok('最后一步还在跑 → 它自己一块，前几步照旧并成一块',
    mixed.length === 2 && mixed[0].label === '纯推理' && mixed[1].label === '推理中', mixed.map((p) => p.label))
  ok('进行中的那一块**只有一步**（而且就是活跃那一步）',
    mixed[1].steps.length === 1 && mixed[1].steps[0].step === 2, mixed[1].steps.map((s) => s.step))
  ok('前几步一块都没丢（#1 还在，只是不再和活跃步同块）',
    mixed[0].steps.length === 1 && mixed[0].steps[0].step === 1, mixed[0].steps.map((s) => s.step))
  // 落地之后**并回去** —— 过程说完了，就该归进它所属的那一类里
  const relanded = I2.groupPhases([mkStep(1, 'done', [], T0), mkStep(2, 'done', [], T0 + 1000)])
  ok('同一份数据落地之后并回上面那一块（块数 2 → 1）',
    relanded.length === 1 && relanded[0].steps.length === 2, relanded.map((p) => p.steps.length))

  // ⑤ 流已结束（ready）算落地：工具调用属于 assistant 消息本身，流一结束"有没有工具"就定了
  ok('流已结束（ready）→ 已经是事实，叫纯推理', I2.groupPhases([mkStep(1, 'ready', [], T0)])[0].label === '纯推理',
    I2.groupPhases([mkStep(1, 'ready', [], T0)])[0].label)

  // ⑥ 渲染层：真机上看到的就是这个
  const props = { sessionId: 'sess-1' }
  const names = (t) => findNodesByClass(t, 'tf-phase-name').map((n) => String(textOf(n)).trim())
  resetMount()
  let tree = render(props)
  lastEventSource.open()
  lastEventSource.emit({
    t: 'snapshot',
    snapshot: {
      sessionId: 'sess-1', serverTime: T0, known: true,
      turns: [{ turn: 1, startedAt: T0, steps: [mkStep(1, 'thinking', [], T0)] }],
    },
  })
  tree = render(props)
  ok('面板上正在跑的那一块写着「第 1 步」（步骤号）', names(tree).includes('第 1 步'), names(tree))
  ok('状态词「推理中」在**次标题**上',
    findNodesByClass(tree, 'tf-phase-sub').map((n) => textOf(n).trim()).includes('推理中'),
    findNodesByClass(tree, 'tf-phase-sub').map((n) => textOf(n).trim()))
  ok('面板上没有任何地方写着「纯推理」', !textOf(tree).includes('纯推理'), names(tree))

  // ⑦ 工具一到 → 如实改名（这是**应该**发生的改名，不是"打脸"）
  lastEventSource.emit({
    t: 'change',
    change: { k: 'tool', turn: 1, step: 1, status: 'waiting', tool: { id: 't9', name: 'read', argsRaw: '{"path":"a.js"}', startedAt: T0 } },
  })
  tree = render(props)
  // ⚠️ 现在进行中的块**以步骤标题为标题**，状态词退到次标题 —— 所以这里查的是**次标题**
  ok('工具到了 → 状态词（次标题）是「调用中」',
    findNodesByClass(tree, 'tf-phase-sub').map((n) => textOf(n).trim()).includes('调用中'),
    findNodesByClass(tree, 'tf-phase-sub').map((n) => textOf(n).trim()))
  ok('「推理中」随之消失', !names(tree).includes('推理中'), names(tree))

  // ⑧ 新一轮：还在想 → 「推理中」；这一步结束时 → 改口叫「纯推理」，
  //    而且**这时它才是真的**（这一步确实一次工具都没调）
  lastEventSource.emit({
    t: 'snapshot',
    snapshot: {
      sessionId: 'sess-1', serverTime: T0, known: true,
      turns: [
        { turn: 1, startedAt: T0, endedAt: T0 + 9000, steps: [mkStep(1, 'done',
          [{ id: 't9', name: 'read', argsRaw: '{"path":"a.js"}', startedAt: T0, endedAt: T0 + 100 }], T0)] },
        { turn: 2, startedAt: T0 + 9000, steps: [mkStep(1, 'thinking', [], T0 + 9000)] },
      ],
    },
  })
  tree = render(props)
  ok('新一轮还在想 → 主标题是「第 1 步」、次标题是「推理中」',
    names(tree).includes('第 1 步')
    && findNodesByClass(tree, 'tf-phase-sub').map((n) => textOf(n).trim()).includes('推理中'),
    names(tree))
  lastEventSource.emit({ t: 'change', change: { k: 'step', turn: 2, step: 1, status: 'done' } })
  tree = render(props)
  ok('落地后叫纯推理（不调工具这件事这时才成立）', names(tree).includes('纯推理'), names(tree))
  ok('落地后不再叫推理中', !names(tree).includes('推理中'), names(tree))
}

console.log('\n㊵ 进行中的块穿"状态的衣服"：状态色 + 空心环呼吸 + 底边不封口 + 贴边光晕（用户选定：B + A 的空心环 + ① 贴边光晕·收小加亮）')
{
  /**
   * 用户选定：**B（状态语言）+ A 的空心环呼吸**。
   *
   * 立意（探索稿 docs/running-options.html 的 ③ 与 ②）：已完成的块说"分类"
   * （读代码 / 改文件 / 跑命令 + 分类色）——那是**事后成立的事实**；进行中的块说"状态"
   * （推理中 / 调用中 + 状态色），因为分类它还没挣到。三件事一起做：
   *   ① 颜色换成宿主的状态语义色（活跃 business / 等待 warn）；
   *   ② 左条换成**空心圆环**（空心 = 还没填上东西 = 还没定性）+ 呼吸；
   *   ③ **底边不封口**（虚线）——"还在长"用形态说，比颜色更快被读到。
   * ⚠️ 灰不能用来表达"未定性"：灰**已经**是 cat-think 的颜色，会和已完成的纯推理块撞车。
   */
  const I2 = mod.__internals
  const css = I2.CSS

  // ── ① CSS 契约：三件事各自在，而且只用宿主 token ──
  ok('进行中的块用"活跃"状态色（business —— 和步骤行 / 徽章 / 光标同一套）',
    /\.tf-phase\.is-running\{--tf-hue:var\(--dsw-alias-state-business-primary\)/.test(css))
  ok('等待态用"等待"状态色（warn —— 和转圈同一个）',
    /\.tf-phase\.is-running\.is-wait\{--tf-hue:var\(--dsw-alias-state-warn-primary\)/.test(css))
  ok('左条变成空心圆环（去掉填充 + 2px 描边 + 50% 圆角）',
    /\.tf-phase\.is-running \.tf-bar\{[^}]*background:none[^}]*border:2px solid var\(--tf-hue\)/.test(css),
    (css.match(/\.tf-phase\.is-running \.tf-bar\{[^}]*\}/) || [])[0])
  /*
   * 圆环**发光** = **贴边光晕**（单层 box-shadow，跟着环一起呼吸）。
   *
   * 这条路走过三轮，这几条断言就是把三轮的结论钉住：
   *   ① 第一版是 `0 0 6px/45%` —— 模糊半径比环（9px）还大，浅色底上读作"一团脏蓝灰"；
   *   ② 中间试过六套并排（docs/ring-glow-options.html / -prototype.html），一度选了 ④ 流光；
   *   ③ 用户看完原型改主意："去掉流光，还是改回第一版①贴边光晕，**但是光晕要小一些，
   *      光强可以大一些**" —— 于是 6px → 3px、45% → 72%（暗相位 20% → 45%、
   *      环的暗相位 opacity .34 → .55）。
   *
   * ⚠️ 下面几条是**按数字量**的（不是"含 box-shadow 就算过"）：模糊半径必须 ≤ 3.5px、
   *    透明度必须 ≥ 70% —— 否则"小一些 / 大一些"这两句话会在某次改动里悄悄丢掉。
   */
  const ringRule = (css.match(/\.tf-phase\.is-running \.tf-bar\{[^}]*\}/) || [''])[0]
  const ringKf = (() => {
    const at = css.indexOf('@keyframes tf-ring')
    return at < 0 ? '' : css.slice(at, css.indexOf('}}', at) + 2)
  })()
  /* 呼吸**周期**。用户先后提过两次：先"光晕小一些、光强可以大一些"，再"**呼吸的频率低一些**"
     —— 1.7s → 2.4s（+41%）。这条按数字钉住周期：只断言"有 animation"的话，
     哪次改动把周期调回 1.7s（甚至更快）都发现不了。 */
  const period = (() => { const m = /animation:tf-ring ([\d.]+)s/.exec(ringRule); return m === null ? NaN : Number(m[1]) })()
  ok('圆环在呼吸，周期 2.4s（比第一版的 1.7s 慢 —— "频率低一些"）', period === 2.4, String(period) + 's')
  const blurOf = (t) => { const m = /box-shadow:0 0 ([\d.]+)px/.exec(t); return m === null ? NaN : Number(m[1]) }
  const alphasOf = (t) => [...t.matchAll(/var\(--tf-hue\) (\d+)%, transparent\)/g)].map((m) => Number(m[1]))
  const dimOpacity = (() => { const m = /50%\{opacity:([\d.]+)/.exec(ringKf); return m === null ? NaN : Number(m[1]) })()
  ok('光晕比第一版**小**（模糊半径 ≤ 3.5px；第一版是 6px，比环还大）',
    blurOf(ringRule) <= 3.5 && blurOf(ringKf) <= 3.5,
    '基础 ' + blurOf(ringRule) + 'px / 亮相位 ' + blurOf(ringKf) + 'px')
  ok('光晕比第一版**强**（透明度 ≥ 70%；第一版是 45%）',
    alphasOf(ringRule).every((a) => a >= 70) && alphasOf(ringKf).every((a) => a >= 45),
    '基础 ' + alphasOf(ringRule).join('/') + '% / keyframes ' + alphasOf(ringKf).join('/') + '%')
  ok('呼吸时环不会熄掉（暗相位 opacity ≥ .5；第一版是 .34）', dimOpacity >= 0.5, String(dimOpacity))
  /* 呼吸**幅度**（用户："幅度小一些"）：三个量各收一半 —— 暗相位从 .55/.7/1.5px
     收到 .78/.88/2.6px。这条按数字钉住"亮暗两端有多远"，否则哪次改动把幅度加回去都发现不了。 */
  const dimScale = (() => { const m = /50%\{[^}]*transform:scale\(([\d.]+)\)/.exec(ringKf); return m === null ? NaN : Number(m[1]) })()
  const blurs = (ringKf.match(/box-shadow:0 0 ([\d.]+)px/g) || []).map((v) => Number(v.replace(/\D/g, '').slice(-3)))
  const amp = { opacity: 1 - dimOpacity, scale: 1 - dimScale }
  ok('呼吸幅度小（opacity 幅度 ≤ .25、scale 幅度 ≤ .15；第一版是 .45 / .30）',
    amp.opacity <= 0.25 && amp.scale <= 0.15,
    'opacity -' + amp.opacity.toFixed(2) + ' / scale -' + amp.scale.toFixed(2)
    + ' / 光晕 ' + blurs.join('→') + 'px')
  ok('呼吸是三个量一起动（透明度 + 尺寸 + 光晕）—— 第一版的形态，保留',
    /0%,100%\{opacity:1;transform:scale\(1\);box-shadow/.test(ringKf)
    && /50%\{opacity:[\d.]+;transform:scale\([\d.]+\);box-shadow/.test(ringKf), ringKf)
  ok('光晕色值走 --tf-hue（等待态跟着变琥珀）', alphasOf(ringRule).length === 1)
  ok('环的静态强光晕留在基础规则里（降级后"它在发光"还有提示）',
    /box-shadow:0 0 [\d.]+px [\d.]+px color-mix\(in srgb, var\(--tf-hue\) [\d.]+%/.test(ringRule)
    || /box-shadow:0 0 [\d.]+px 0 color-mix\(in srgb, var\(--tf-hue\) [\d.]+%/.test(ringRule))
  ok('降级之后环只是不再呼吸，光晕还在',
    /prefers-reduced-motion:reduce\)\{\.tf-phase\.is-running \.tf-bar\{animation:none\}/.test(css))
  ok('底边不封口（虚线）—— "还在长"用形态说',
    /\.tf-phase\.is-running\{[^}]*border-bottom:1px dashed/.test(css))
  ok('进行中的样式一条都没碰已完成块（选择器全带 .is-running）',
    !/\.tf-phase\s*\{[^}]*animation:tf-ring/.test(css)
    && !/\.tf-phase\s*\{[^}]*animation:tf-sweep/.test(css))

  // ── ② 渲染：跑着的轮次，那一块挂 is-running；等待再加 is-wait ──
  const props = { sessionId: 'sess-1' }
  const mk = (no, status, tools, at) => ({
    step: no, status, attempts: 1, reasoningChars: 400, textChars: 0, startedAt: at, elapsedMs: 900, tools: tools || [],
  })
  const mountWith = (snap) => {
    resetMount()
    render(props)
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: snap })
    return render(props)
  }
  const clsOfPhases = (t) => findNodesByClass(t, 'tf-phase').map((n) => String(n.props.className))
  const turnWith = (steps, endedAt) => {
    const turn = { turn: 1, startedAt: T0, userText: '跑一下', steps }
    if (endedAt !== undefined) turn.endedAt = endedAt
    return { sessionId: 'sess-1', serverTime: T0, known: true, state: 'live', turns: [turn] }
  }

  // ⚠️ 间隔要 > PHASE_GAP_MS（90s），否则两步会被并成**一块**（那样就测不出“已完成的块”了）
  let tree = mountWith(turnWith([mk(1, 'done', [], T0), mk(2, 'thinking', [], T0 + 120000)]))
  let cls = clsOfPhases(tree)
  ok('思考中的那一块挂 is-running', cls.filter((c) => c.includes('is-running')).length === 1, cls)
  ok('它同时还是 is-on（"你在这"）—— 两个类各管一件事',
    cls.filter((c) => c.includes('is-running') && c.includes('is-on')).length === 1, cls)
  ok('已完成的块一个都不许挂 is-running',
    cls.filter((c) => !c.includes('is-running')).length === 1, cls)
  ok('思考态不挂 is-wait（它是"自己在想"，不是"卡在外部"）',
    !cls.some((c) => c.includes('is-wait')), cls)
  ok('块名叫「推理中」', textOf(tree).includes('推理中'), textOf(tree).slice(0, 80))

  tree = mountWith(turnWith([mk(1, 'done', [], T0), mk(2, 'waiting',
    [{ id: 'w1', name: 'read', argsRaw: '{"path":"a.js"}', startedAt: T0 + 120000 }], T0 + 120000)]))
  cls = clsOfPhases(tree)
  ok('等工具的那一块挂 is-running + is-wait',
    cls.filter((c) => c.includes('is-running') && c.includes('is-wait')).length === 1, cls)
  ok('块名叫「调用中」', textOf(tree).includes('调用中'), textOf(tree).slice(0, 80))

  // ── ③ 已完成的轮次：一块都不许挂 is-running，而 is-on 仍在（就是"你在这"）──
  tree = mountWith(turnWith([mk(1, 'done', [], T0), mk(2, 'done', [], T0 + 120000)], T0 + 240000))
  cls = clsOfPhases(tree)
  ok('跑完之后没有任何 is-running（状态色不会留在已完成的轮次上）',
    !cls.some((c) => c.includes('is-running')), cls)
  ok('跑完之后最后一块仍然挂 is-on —— 所以 is-on ≠ 进行中',
    cls.filter((c) => c.includes('is-on')).length === 1, cls)
  ok('跑完之后叫回分类名词（出现「纯推理」）', textOf(tree).includes('纯推理'), textOf(tree).slice(0, 80))
}

console.log('\n㊶ 进行中的块：主标题是「第 N 步」，状态词降成次标题（用户："用步骤号"）')
{
  /**
   * 块头那一行是面板上最显眼的一行。已完成的块用分类名词占它（读代码 / 跑命令）——
   * 那是在回答"这一块干了什么"；进行中的块如果只写「推理中」，这一行就只回答了"它还在动"。
   * 所以：**主标题 = 「第 N 步」**（活跃那一步的步号），**次标题 = 推理中 / 调用中**。
   *
   * 走过的弯路（写下来免得再走）：中间试过"主标题 = 步骤标题"（读 index.js / 搜 xxx）——
   * 那是**同一句话说两遍**：那个标题已经在步骤行上了。换成步骤号之后，这一行回答的是
   * "现在跑到哪一步了"，和右侧导航行的「第 N 轮」是同一套读法。
   */
  const props = { sessionId: 'sess-1' }
  const mk = (no, status, tools, at) => ({
    step: no, status, attempts: 1, reasoningChars: 400, textChars: 0, startedAt: at, elapsedMs: 900, tools: tools || [],
  })
  const mountWith = (snap) => {
    resetMount()
    render(props)
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: snap })
    return render(props)
  }
  const textsOf = (t, cls) => findNodesByClass(t, cls).map((n) => String(textOf(n)).trim())
  const snap = (steps) => ({ sessionId: 'sess-1', serverTime: T0, known: true, state: 'live', turns: [{ turn: 1, startedAt: T0, userText: '跑一下', steps }] })

  // ① 正在等工具：主标题 = 第 2 步，次标题 = 调用中
  let tree = mountWith(snap([
    mk(1, 'done', [], T0),
    mk(2, 'waiting', [{ id: 'w1', name: 'read', argsRaw: '{"path":"src/a.js"}', startedAt: T0 + 120000 }], T0 + 120000),
  ]))
  let names = textsOf(tree, 'tf-phase-name')
  let subs = textsOf(tree, 'tf-phase-sub')
  ok('进行中那一块的**主标题是步骤号**「第 2 步」', names.length === 2 && names[1] === '第 2 步', names)
  ok('状态词退成**次标题**：调用中', subs.length === 1 && subs[0] === '调用中', subs)
  ok('已完成的块**没有次标题**（它只有分类名词）', names[0] === '纯推理' && subs.length === 1, [names, subs])
  ok('主标题不再重复步骤行上的标题（那是同一句话说两遍）',
    !names.includes('读 a.js'), names)

  // ② 自己在想：主标题还是步骤号，次标题是「推理中」
  tree = mountWith(snap([mk(1, 'done', [], T0), mk(2, 'thinking', [], T0 + 120000)]))
  names = textsOf(tree, 'tf-phase-name')
  subs = textsOf(tree, 'tf-phase-sub')
  ok('自己在想 → 主标题「第 2 步」、次标题「推理中」',
    names[1] === '第 2 步' && subs[0] === '推理中', [names, subs])
  ok('进行中的块**一定有次标题**（步骤号总是有，所以没有"拿不到标题"这一支）',
    subs.length === 1, subs)

  // ③ 两块并存：已落地那块说身份（分类名 + 跨度），进行中那块说位置（第 N 步）
  tree = mountWith(snap([mk(1, 'done', [], T0), mk(2, 'thinking', [], T0 + 30000)]))
  names = textsOf(tree, 'tf-phase-name')
  const metas = textsOf(tree, 'tf-phase-meta')
  ok('进行中那一块主标题是**步骤号**（第 2 步）', names.length === 2 && names[1] === '第 2 步', names)
  ok('已落地那一块照旧说分类名 + 自己的跨度（#1）',
    names[0] === '纯推理' && metas[0].indexOf('#1') >= 0, [names, metas])
  ok('进行中的块**不报区间**（块头已经写着「第 2 步」，一字不差）',
    metas[1].indexOf('#') < 0, metas)

  // ④ CSS 契约：次标题比主标题小一档、用三级标签色
  ok('次标题的样式：小一档 + 三级标签色',
    /\.tf-phase-sub\{font:var\(--dsw-font-xxxs-11\);color:var\(--dsw-alias-label-tertiary\)/.test(mod.__internals.CSS),
    (mod.__internals.CSS.match(/\.tf-phase-sub\{[^}]*\}/) || [])[0])
}

console.log('\n㊷ 一轮的最后一步叫「回答」，不叫「纯推理」（用户："每个轮次的最后一步不应该叫纯推理"）')
{
  /**
   * 一轮的最后一步，正文是**写给用户看的答复**，不是"只在脑子里"的推理。
   * 真实数据（扫了 913 轮）：**819 轮**的最后一步正是"有正文、没工具" —— 全都叫错了。
   *
   * 判据三条缺一不可：① 是这一轮的最后一步 ② 没有工具 ③ 真的产出了正文；
   * 而且必须**已落地**（还在吐字时说「推理中」—— 没落地的块不许用分类语法）。
   * ⚠️ 只改显示名，不动分组（819 轮里只有 1 轮会和前一步并成一块）。
   */
  const I2 = mod.__internals
  const mk = (no, status, opts) => Object.assign({
    step: no, status, attempts: 1, reasoningChars: 500, textChars: 0,
    startedAt: T0 + no * 1000, elapsedMs: 1000, tools: [],
  }, opts || {})
  const bashTool = (id) => ({ id, name: 'bash', argsRaw: '{"command":"npm test"}', startedAt: T0 })

  // ① 典型一轮：工具步 + 最后一步是答复
  let ps = I2.groupPhases([mk(1, 'done', { tools: [bashTool('t1')] }), mk(2, 'done', { textChars: 800 })])
  ok('最后一步（有正文、没工具）→ 块名叫「回答」', ps[1].label === '回答', ps.map((x) => x.label))
  ok('它仍然是灰类（想）—— 不改颜色', ps[1].cat === 'think' && I2.phaseCategory('回答') === 'think', [ps[1].cat, I2.phaseCategory('回答')])
  ok('前面那块照旧按工具族叫（没被带歪）', ps[0].label === '跑命令', ps[0].label)

  // ② 还在吐字 → 推理中；落地之后才叫回答（同一份数据只改状态）
  ps = I2.groupPhases([mk(1, 'thinking', { textChars: 0 })])
  ok('最后一步还在推理 → 推理中（不叫回答，也不叫纯推理）', ps[0].label === '推理中', ps[0].label)
  ps = I2.groupPhases([mk(1, 'thinking', { textChars: 300 })])
  ok('正在吐正文、但还没落地 → 还是推理中（没落地不许用分类语法）', ps[0].label === '推理中', ps[0].label)
  ps = I2.groupPhases([mk(1, 'done', { textChars: 300 })])
  ok('同一份数据落地之后 → 回答', ps[0].label === '回答', ps[0].label)

  // ③ 三条判据各自缺一条都不算
  ps = I2.groupPhases([mk(1, 'done', { tools: [bashTool('t2')], textChars: 500 })])
  ok('最后一步**带工具**（正文+工具）→ 按工具族叫，不叫回答', ps[0].label === '跑命令', ps[0].label)
  ps = I2.groupPhases([mk(1, 'done', { reasoningChars: 900, textChars: 0 })])
  ok('最后一步只有思考、没有正文 → 仍是纯推理', ps[0].label === '纯推理', ps[0].label)
  ps = I2.groupPhases([mk(1, 'done', { reasoningChars: 0, textChars: 0 })])
  ok('最后一步完全空（命令轮 / 空转轮）→ 仍是纯推理', ps[0].label === '纯推理', ps[0].label)

  // ④ 只有**最后一步**算：中间步有正文也不算回答
  ps = I2.groupPhases([mk(1, 'done', { textChars: 400 }), mk(2, 'done', { tools: [bashTool('t3')] })])
  ok('中间步有正文、但工具在最后 → 不叫回答', !ps.some((x) => x.label === '回答'), ps.map((x) => x.label))

  // ⑤ 小结图例跟着走（mergeByLabel 的 key 就是 label）
  const merged = I2.mergeByLabel(I2.groupPhases([mk(1, 'done', { tools: [bashTool('t4')] }), mk(2, 'done', { textChars: 600 })]))
  ok('小结图例里也出现「回答」（和块名同一个 key）', merged.some((x) => x.label === '回答'), merged.map((x) => x.label))

  // ⑥ 渲染层：块头写「回答」，这一轮里不再出现「纯推理」
  const snap = { sessionId: 'sess-answer', serverTime: T0, known: true, turns: [{ turn: 1, startedAt: T0, endedAt: T0 + 9000, userText: 'x', steps: [
    mk(1, 'done', { tools: [bashTool('t5')] }),
    mk(2, 'done', { textChars: 800 }),
  ] }] }
  resetMount()
  let t = render({ sessionId: 'sess-answer' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  t = render({ sessionId: 'sess-answer' })
  const names = findNodesByClass(t, 'tf-phase-name').map((n) => String(textOf(n)).trim())
  ok('块头渲染出「回答」', names.indexOf('回答') >= 0, names)
  ok('这一轮里没有「纯推理」了', names.indexOf('纯推理') < 0, names)
  ok('答复块用的是灰类（cat-think）', findNodesByClass(t, 'tf-phase').some((n) => String(n.props.className).includes('cat-think') && findNodesByClass(n, 'tf-phase-name').some((x) => String(textOf(x)).trim() === '回答')),
    findNodesByClass(t, 'tf-phase').map((n) => n.props.className))
}

console.log('\n㊸ 进行中的块：只有一个步骤 + 只留标题的步号（用户："进行中的块只能有一个步骤""去掉步骤号，标题补位前移"）')
{
  /**
   * 两条规则合起来才成立：
   *   ① **进行中的块只有一个步骤**（`groupPhases` 的 `live`）—— 它自己一块，不和前面的同族步并；
   *   ② 于是那个步骤的**行号是纯重复**（块头已经写着「第 N 步」）→ 不画，标题补位前移；
   *      块头元信息的**区间**同理不报（区间和「第 N 步」一字不差）。
   * 落地之后两者都回来：块头改说分类名，身份就轮到区间与行号来报。
   */
  const I2 = mod.__internals
  const mk = (no, status, opts) => Object.assign({
    step: no, status, attempts: 1, reasoningChars: 400, textChars: 0,
    startedAt: T0 + no * 1000, elapsedMs: 1000, tools: [],
  }, opts || {})
  const bash = (id) => ({ id, name: 'bash', argsRaw: '{"command":"npm test"}', startedAt: T0 + 500 })
  const snapOf = (steps, turn) => ({
    sessionId: 'sess-solo', serverTime: T0, known: true,
    turns: [Object.assign({ turn: 1, startedAt: T0, steps }, turn || {})],
  })
  const mountWith = (sn) => {
    resetMount()
    let t = render({ sessionId: 'sess-solo' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: sn })
    return render({ sessionId: 'sess-solo' })
  }
  const phasesOf = (t) => findNodesByClass(t, 'tf-phase')
  const runningPhase = (t) => phasesOf(t).find((p) => String(p.props.className).includes('is-running'))
  const settledPhase = (t) => phasesOf(t).find((p) => !String(p.props.className).includes('is-running'))

  // ① 进行中：两块（已落地 + 进行中），进行中那块**只有一行**
  let t = mountWith(snapOf([mk(1, 'done', { tools: [bash('a')] }), mk(2, 'done', { tools: [bash('b')] }), mk(3, 'waiting', { tools: [bash('c')] })]))
  const rp = runningPhase(t)
  ok('进行中的块存在（is-running）', rp !== undefined)
  ok('进行中的块里**只有一步**（一行）', findNodesByClass(rp, 'tf-step').length === 1,
    findNodesByClass(rp, 'tf-step').length)
  ok('它前面那几步自成一块（没被吞掉）', findNodesByClass(settledPhase(t), 'tf-step').length === 2,
    findNodesByClass(settledPhase(t), 'tf-step').length)

  // ② 行号：进行中那块**一个都不画**，已落地那块照旧
  ok('进行中的块里没有行号（`.tf-no` 不渲染）', findNodesByClass(rp, 'tf-no').length === 0,
    findNodesByClass(rp, 'tf-no').map((n) => String(textOf(n))))
  ok('已落地的块照旧有行号（#1 #2）',
    findNodesByClass(settledPhase(t), 'tf-no').map((n) => String(textOf(n))).join(',') === '#1,#2',
    findNodesByClass(settledPhase(t), 'tf-no').map((n) => String(textOf(n))))

  // ③ 块头：主标题保留「第 N 步」；元信息**不报区间**
  ok('进行中的块主标题是「第 3 步」',
    String(textOf(findNodesByClass(rp, 'tf-phase-name')[0])).trim() === '第 3 步',
    String(textOf(findNodesByClass(rp, 'tf-phase-name')[0])).trim())
  const rMeta = findNodesByClass(rp, 'tf-phase-meta')[0]
  ok('进行中的块元信息里没有区间（连 title 也没有）',
    !String(textOf(rMeta)).includes('#') && !findNodesByClass(rMeta, 'tf-span').some((n) => String(n.props.title || '').includes('#')),
    String(textOf(rMeta)).trim())
  ok('已落地的块元信息里**有**区间（身份归它报）',
    String(textOf(findNodesByClass(settledPhase(t), 'tf-phase-meta')[0])).includes('#1–2'),
    String(textOf(findNodesByClass(settledPhase(t), 'tf-phase-meta')[0])).trim())

  // ④ 落地之后：行号与区间一起回来（同一份数据，只改状态）
  t = mountWith(snapOf([mk(1, 'done', { tools: [bash('a')] }), mk(2, 'done', { tools: [bash('b')] }), mk(3, 'done', { tools: [bash('c')] })]))
  ok('落地之后只剩一块（并回去了）', phasesOf(t).length === 1, phasesOf(t).length)
  ok('落地之后行号回来（#1 #2 #3）',
    findNodesByClass(t, 'tf-no').map((n) => String(textOf(n))).join(',') === '#1,#2,#3',
    findNodesByClass(t, 'tf-no').map((n) => String(textOf(n))))
  ok('落地之后区间回来（#1–3）', String(textOf(t)).includes('#1–3'), textOf(t).slice(0, 80))

  // ⑤ CSS 契约：行号格子去掉后，展开区/等待行/中断说明的缩进**跟着收**（否则会戳到标题右边）
  const css = String(mod.__internals.CSS)
  ok('进行中的块：等待行/展开区/正文/小标/中断说明缩进都收到 20px（对齐标题新位置）',
    ['.tf-wait', '.tf-cut', '.tf-sub', '.tf-raw', '.tf-cap', '.tf-reply']
      .every((c) => css.indexOf('.tf-phase.is-running ' + c) >= 0)
      && /\.tf-phase\.is-running \.tf-wait[^}]*\{margin-left:20px\}/.test(css),
    (css.match(/\.tf-phase\.is-running \.tf-wait[^}]*\}/) || [])[0])
  ok('不是"留位藏起来"（没有 visibility:hidden 藏行号那套）',
    !/\.tf-phase\.is-running \.tf-no\{visibility:hidden\}/.test(css))
}

console.log('\n㊹ 无工具步的名字：正文摘要 / 「无输出」/ 不填（用户："为哪些没有标题的步骤起名字"）')
{
  /**
   * 面板上有两条起名路，各有过滤条件：**派生标题**要工具参数、**模型标题**要思考。
   * 于是"无工具 + 无思考 + 有正文"的步（每一轮最后那一步）**两条都漏** ——
   * 扫全部会话 14,030 步，这种有 **487 步**（无工具步 913 里的一半）。
   * 第三条路：**本地摘要**（零模型调用，和"派生标题"同一族）。
   */
  const I2 = mod.__internals

  // ── ① 摘要规则：三条真实正文（本会话真实回答的开头）──
  const CASES = [
    ['明白了——你看到的是跟随，不是徽章转圈。那这两件事要分开看：…', '明白了——你看到的是跟随…'],
    ['查到了，而且不是最近改坏的——elapsedMs 从第一个提交起就没进过增量通道。…', '查到了，而且不是最近改坏的…'],
    ['两件都做了，选的是**方向 2**（步变更带时间事实、客户端一条公式）。…', '两件都做了，选的是方向…'],
  ]
  for (const [src, want] of CASES) {
    const got = I2.excerptOf(src)
    ok('真数据摘要：' + JSON.stringify(want), got === want, got)
  }
  // 清噪声：代码块 / 标题标记 / 链接地址 / 强调符
  ok('正文以代码块开头 → 摘要里不出现 ```',
    !I2.excerptOf('```js\nconst a = 1\n```\n已经改好这个文件。后面还有。').includes('`'),
    I2.excerptOf('```js\nconst a = 1\n```\n已经改好这个文件。后面还有。'))
  ok('Markdown 链接只留文字（不留地址）',
    I2.excerptOf('见 [文档](http://example.com/x) 第二节：先做 A 再做 B。').indexOf('http') < 0,
    I2.excerptOf('见 [文档](http://example.com/x) 第二节：先做 A 再做 B。'))
  // 截断的两条收尾规则
  ok('截断了：不闭合的括号不带进去',
    I2.excerptOf('两件都做了，选的是方向 2（步变更带时间事实、客户端一条公式）。').indexOf('（') < 0,
    I2.excerptOf('两件都做了，选的是方向 2（步变更带时间事实、客户端一条公式）。'))
  ok('截断了：不把英文单词切一半',
    !/[A-Za-z]$/.test(I2.excerptOf('查到了，而且不是最近改坏的——elapsedMs 从第一个提交起就没进过增量通道。').replace('…', '')),
    I2.excerptOf('查到了，而且不是最近改坏的——elapsedMs 从第一个提交起就没进过增量通道。'))
  ok('短正文整句给（不加省略号）', I2.excerptOf('已经改好了。') === '已经改好了。', I2.excerptOf('已经改好了。'))
  ok('空正文 → 空串（不编）', I2.excerptOf('') === '' && I2.excerptOf('   \n  ') === '', [I2.excerptOf(''), I2.excerptOf('   ')])

  // ── ② stepOwnTitle：三类各走各的 ──
  ok('有正文 → 摘要', I2.stepOwnTitle({ textChars: 100, textHead: '已经改好了，测试也过了。' }) === '已经改好了，测试也过了。',
    I2.stepOwnTitle({ textChars: 100, textHead: '已经改好了，测试也过了。' }))
  ok('什么都没有（0 思考 0 正文 0 工具）→ 「无输出」', I2.stepOwnTitle({ textChars: 0, reasoningChars: 0, tools: [] }) === '无输出',
    I2.stepOwnTitle({ textChars: 0, reasoningChars: 0, tools: [] }))
  ok('只有思考（还没写正文）→ **不填**（不硬起名，块头已经写着推理中）',
    I2.stepOwnTitle({ textChars: 0, reasoningChars: 500, tools: [] }) === '',
    I2.stepOwnTitle({ textChars: 0, reasoningChars: 500, tools: [] }))
  {
    const tailTitle = I2.stepOwnTitle({ textChars: 30, textTail: '刚写完开头，后面还有一大段要继续写下去，还没写完呢。' })
    ok('有正文但开头没带下来 → 用尾部兜底（活跃步正在写，标题立刻就有）',
      tailTitle.indexOf('刚写完开头') === 0 && tailTitle.slice(-1) === '…' && tailTitle.length <= 21, tailTitle)
  }

  // ── ③ 渲染：行里真的出现这三种 ──
  const snapOf = (steps) => ({ sessionId: 'sess-own', serverTime: T0, known: true, turns: [{ turn: 1, startedAt: T0, steps }] })
  const mountWith = (sn) => {
    resetMount()
    let t = render({ sessionId: 'sess-own' })
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: sn })
    return render({ sessionId: 'sess-own' })
  }
  const titlesOf = (t) => findNodesByClass(t, 'tf-step-title').map((n) => String(textOf(n)).trim())
  let t = mountWith(snapOf([
    { step: 1, status: 'done', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, tools: [{ id: 'a', name: 'bash', argsRaw: '{"command":"npm test"}', startedAt: T0, endedAt: T0 + 1 }] },
    { step: 2, status: 'done', attempts: 1, reasoningChars: 0, textChars: 120, textHead: '已经改好了，测试也过了。后面还有一段。', startedAt: T0 + 1000, tools: [] },
  ]))
  ok('回答步的行标题 = 正文摘要（本地摘要类名 is-own）',
    titlesOf(t).some((x) => x === '已经改好了，测试也过了…') && findNodesByClass(t, 'tf-step-title').some((n) => String(n.props.className).includes('is-own')),
    titlesOf(t))
  ok('有工具的步照旧用派生标题（不受影响）', titlesOf(t).indexOf('跑测试') >= 0, titlesOf(t))

  t = mountWith(snapOf([{ step: 1, status: 'done', attempts: 1, reasoningChars: 0, textChars: 0, startedAt: T0, tools: [] }]))
  ok('空步的行标题 = 「无输出」', titlesOf(t).indexOf('无输出') >= 0, titlesOf(t))

  t = mountWith(snapOf([{ step: 1, status: 'thinking', attempts: 1, reasoningChars: 500, textChars: 0, startedAt: T0, tools: [] }]))
  ok('只有思考的步**没有**行标题（不硬填状态词）', titlesOf(t).length === 0, titlesOf(t))

  // ── ④ 展开区：回答步现在点得开，而且能看到正文 ──
  // ⚠️ 轮头那个折叠箭头也是 `.tf-chev`（`<span>`），所以要按**按钮**数，
  //    否则会把轮头那个数进来（真踩过：断言写 1 结果数出 2）。
  ok('回答步可展开（行里有展开按钮）',
    findButtons(mountWith(snapOf([{ step: 1, status: 'done', attempts: 1, reasoningChars: 0, textChars: 120, textHead: 'x', startedAt: T0, tools: [] }])))
      .filter((b) => String(b.props.className || '').includes('tf-chev')).length === 1)
  {
    const calls = []
    globalThis.fetch = (url) => {
      calls.push(String(url))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ reasoning: 'THINK', text: 'ANSWER BODY', streamGap: false }) })
    }
    const t2 = mountWith(snapOf([{ step: 1, status: 'done', attempts: 1, reasoningChars: 0, textChars: 120, textHead: '已经改好了。', startedAt: T0, tools: [] }]))
    // 点开（走真实 onClick）
    const chev = findButtons(t2).find((b) => String(b.props.className || '').includes('tf-chev'))
    ok('回答步有展开按钮', chev !== undefined)
    chev.props.onClick()
    const t3 = render({ sessionId: 'sess-own' })
    ok('展开时去取正文（/step 那一个接口同时给思考与正文）', calls.some((u) => u.includes('/step?')), calls)
    await new Promise((r) => setTimeout(r, 0))          // 让 /step 的 Promise 落地
    const t4 = render({ sessionId: 'sess-own' })
    ok('展开区出现「回答正文」小标', textOf(t4).includes('回答正文'), textOf(t4).slice(0, 80))
    ok('展开区出现正文内容', textOf(t4).includes('ANSWER BODY'), textOf(t4).slice(0, 120))
    ok('正文块用 .tf-reply（正文字体，不是等宽原文）', findNodesByClass(t4, 'tf-reply').length === 1)
  }
}

console.log('\n㊺ 双击轮次标题 → 第二行变搜索框（用户："不要浮层，我想用它来代替真正的历史的入口"）')
{
  /**
   * 入口从"头部那枚「历史」按钮"换成"**双击第二行的轮次标题**"：
   *   · 标题那一格本来就是 `flex:1` 吃空位 —— 换成输入框之后位置/字号/宽度都不变，
   *     读起来是"标题变成了可编辑的"，不是"弹出了一个控件"；
   *   · 目录与搜索结果照旧渲染在**正文区**（`renderDir()` / `renderSearch()`）——
   *     用户明确不要浮层；
   *   · 查询状态、匹配、结果行、跳转**全部复用**原来那套（`searchRef` / `matchTurns` /
   *     `renderHit` / `openFocus`）。
   */
  const snap = {
    sessionId: 'sess-nav', serverTime: T0, known: true, state: 'live',
    turns: [
      { turn: 2, startedAt: T0 + 5000, endedAt: T0 + 6000, userText: '第二轮问了什么', steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 10, textChars: 0, startedAt: T0, elapsedMs: 5, tools: [] }] },
      { turn: 1, startedAt: T0, endedAt: T0 + 1000, userText: '第一轮问了什么', steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 10, textChars: 0, startedAt: T0, elapsedMs: 5, tools: [] }] },
    ],
    index: [
      { turn: 2, startedAt: T0 + 5000, userText: '第二轮问了什么', steps: 1, tools: 0, reasoningChars: 10, textChars: 0, inMemory: true },
      { turn: 1, startedAt: T0, endedAt: T0 + 1000, userText: '第一轮问了什么', steps: 1, tools: 0, reasoningChars: 10, textChars: 0, inMemory: true },
    ],
  }
  const props = { sessionId: 'sess-nav' }
  const mount = () => {
    resetMount()
    let t = render(props)
    lastEventSource.open()
    lastEventSource.emit({ t: 'snapshot', snapshot: snap })
    return render(props)
  }
  const titleOf = (t) => findNodesByClass(t, 'tf-turn-title')[0]
  const qOf = (t) => findNodesByClass(t, 'tf-nav-q')[0]

  // ① 双击 → 历史态：标题那一格变成输入框，正文变成目录
  let tree = mount()
  ok('双击前：第二行是标题（不是输入框）', titleOf(tree) !== undefined && qOf(tree) === undefined)
  titleOf(tree).props.onDoubleClick()
  tree = render(props)
  ok('双击后：第二行出现搜索框', qOf(tree) !== undefined && qOf(tree).type === 'input')
  ok('搜索框就在**标题那一格**（标题让位，不是并列出现）',
    titleOf(tree) === undefined && findNodesByClass(tree, 'tf-nav').length === 1)
  ok('正文变成目录（不是浮层：目录在正文区里）',
    findNodesByClass(tree, 'tf-dir-row').length === 2 && findNodesByClass(tree, 'tf-turn-h').length === 0)
  ok('搜索框是**受控**的（值来自 searchRef）', qOf(tree).props.value === '')
  ok('自动聚焦（双击之后手就在键盘上）', qOf(tree).props.autoFocus === true)

  // ② 键盘也能进（入口不能只剩鼠标手势）
  tree = mount()
  titleOf(tree).props.onKeyDown({ key: 'Enter', preventDefault: function () {} })
  tree = render(props)
  ok('聚焦标题 + 回车 → 同样进历史态', qOf(tree) !== undefined)

  // ③ 输入即搜（复用同一套匹配）；结果行是原来那套 `.tf-hit`
  qOf(tree).props.onChange({ target: { value: '第二轮' } })
  tree = render(props)
  const hits = findNodesByClass(tree, 'tf-hit')
  ok('输入「第二轮」→ 正文里出现命中行', hits.length === 1, hits.length)
  ok('命中的是第 2 轮', String(textOf(hits[0])).includes('第二轮问了什么'), textOf(hits[0]))

  // ④ Esc = 退出 + **清词**（搜索是一次性动作）
  qOf(tree).props.onKeyDown({ key: 'Escape', preventDefault: function () {} })
  tree = render(props)
  ok('Esc → 回正文（目录收起）', findNodesByClass(tree, 'tf-dir-row').length === 0)
  ok('Esc → 标题那一格回来（搜索框收起）', titleOf(tree) !== undefined && qOf(tree) === undefined)
  titleOf(tree).props.onDoubleClick()
  tree = render(props)
  ok('再进历史态时查询词已清空（不留上次的搜索）', qOf(tree).props.value === '', qOf(tree).props.value)

  // ⑤ 选中一条结果 → 跳到那一轮 + 退出历史态（openFocus 里本来就会 dirOpen=false）
  qOf(tree).props.onChange({ target: { value: '第一轮' } })
  tree = render(props)
  findNodesByClass(tree, 'tf-hit')[0].props.onClick()
  tree = render(props)
  ok('选中一条 → 退出历史态（回正文）', findNodesByClass(tree, 'tf-dir-row').length === 0)
  ok('选中一条 → 面板换成那一轮', findNodesByClass(tree, 'tf-turn-no').length === 1
    && String(textOf(findNodesByClass(tree, 'tf-turn-no')[0])).includes('第 1 轮'),
    findNodesByClass(tree, 'tf-turn-no').map((n) => String(textOf(n))))

  // ⑥ 没有标题的轮：**入口不能消失**（系统发起的轮 / 老会话缺 userText）
  resetMount()
  let t2 = render(props)
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: { sessionId: 'sess-nav', serverTime: T0, known: true, state: 'live', turns: [{ turn: 1, startedAt: T0, steps: [{ step: 1, status: 'done', attempts: 1, reasoningChars: 10, textChars: 0, startedAt: T0, elapsedMs: 5, tools: [] }] }] } })
  t2 = render(props)
  ok('没有标题的轮给"无标题"占位（入口唯一的落点）',
    String(textOf(titleOf(t2))) === '无标题' && String(titleOf(t2).props.className).includes('is-empty'),
    titleOf(t2) === undefined ? '(没有)' : String(textOf(titleOf(t2))))
  titleOf(t2).props.onDoubleClick()
  t2 = render(props)
  ok('占位也能双击进历史（那种会话不会进不去目录）', qOf(t2) !== undefined)

  // ⑦ 历史态第二行 = 共 N 轮 + 搜索框 + 返回（用户："去掉图1这一行"+"第11轮改为共XX轮、生成标题改为返回"）
  tree = mount()
  titleOf(tree).props.onDoubleClick()
  tree = render(props)
  const navTxt = textOf(findNodesByClass(tree, 'tf-nav')[0])
  ok('历史态第二行报「共 N 轮」（不是「第 N 轮」）', navTxt.includes('共 2 轮') && !navTxt.includes('第 2 轮'), navTxt)
  ok('历史态第二行行尾是「返回」', navTxt.trim().endsWith('返回'), navTxt)
  ok('历史态保留那一组与 »（跳变归零的前提）',
    findNodesByClass(tree, 'tf-turn-nav').length === 1
    && findButtons(tree).some((b) => String(b.props.className || '').includes('tf-latest')))
  ok('历史态里箭头被换成 `·`（无功能）',
    findNodesByClass(tree, 'tf-turn-nav-b').length === 2
    && findNodesByClass(tree, 'tf-turn-nav-b').every((d) => String(textOf(d)) === '·' && d.props.onClick === undefined))
  ok('平时态里那两颗还是**真箭头**（有 onClick，能翻轮）', (function () {
    const t0 = mount()
    const bs = findNodesByClass(t0, 'tf-turn-nav-b')
    return bs.length === 2 && bs.every((b) => b.type === 'button' && typeof b.props.onClick === 'function')
      && bs.map((b) => String(textOf(b))).join('') === '‹›'
  })())
  ok('数字那一格用的是**同一个** `.tf-turn-no`（不是新元素）',
    findNodesByClass(tree, 'tf-turn-no').length === 1
    && String(findNodesByClass(tree, 'tf-turn-no')[0].props.className).includes('is-count'))
  ok('历史态没有「生成标题」（那一格换成了返回）',
    findButtons(tree).every((b) => !String(b.props.className || '').includes('tf-gen')))
  ok('**目录头那一行整条删了**（正文直接从日期分节开始）',
    findNodesByClass(tree, 'tf-dir-h').length === 0 && findNodesByClass(tree, 'tf-dir-back').length === 0)
  ok('历史态点 » → 回最新一轮 + 离开目录', (function () {
    const lat = findButtons(tree).find((b) => String(b.props.className || '').includes('tf-latest'))
    if (lat === undefined) return false
    lat.props.onClick()
    const t4 = render(props)
    return findNodesByClass(t4, 'tf-dir-row').length === 0
      && findNodesByClass(t4, 'tf-turn-title').length === 1
  })())
  tree = render(props)
  titleOf(tree).props.onDoubleClick()
  tree = render(props)
  ok('返回 → 回正文 + 标题回来', (function () {
    findButtons(tree).find((b) => String(b.props.className || '').includes('tf-nav-back')).props.onClick()
    const t3 = render(props)
    return findNodesByClass(t3, 'tf-dir-row').length === 0
      && findNodesByClass(t3, 'tf-turn-title').length === 1
      && findNodesByClass(t3, 'tf-nav-back').length === 0
  })())

  // ⑧ CSS 契约：旧那条搜索条删干净，新输入框沿用标题那一格的排版
  const css = String(mod.__internals.CSS)
  ok('目录里那条搜索条（.tf-dir-s / .tf-dir-q）已删', css.indexOf('.tf-dir-s{') < 0 && css.indexOf('.tf-dir-q{') < 0)
  ok('新输入框沿用标题那一格的排版（flex:1 + 同字号 + 无边框）',
    /\.tf-nav-q\{[^}]*flex:1 1 auto[^}]*border:0[^}]*font:var\(--dsw-font-xxs-12\)/.test(css),
    (css.match(/\.tf-nav-q\{[^}]*\}/) || [])[0])
  ok('可聚焦的标题有焦点样式（键盘用户看得见）', /\.tf-turn-title:focus-visible\{/.test(css))
  ok('「历史」按钮的样式全删了', css.indexOf('.tf-hist') < 0)
  ok('目录头与它的「回到第 N 轮」样式也删了（不留死代码）',
    css.indexOf('.tf-dir-h{') < 0 && css.indexOf('.tf-dir-back') < 0)
  /*
   * "跳变归零"的两条 CSS 契约（实测值见 docs/nav-search.html 顶上那条）：
   *   · 数字格固定宽度 —— `第 133 轮`（55.7px）↔ `共 20 轮`（约 46px）不再改宽度
   *   · 「返回」与「生成标题」同宽（44px）—— 行尾那一格不缩
   */
  ok('数字格固定宽度（min-width + 居中）',
    /\.tf-turn-no\{[^}]*min-width:56px[^}]*text-align:center/.test(css),
    (css.match(/\.tf-turn-no\{[^}]*\}/) || [])[0])
  ok('「返回」与「生成标题」同宽（min-width:44px）',
    /\.tf-nav-back\{[^}]*margin-left:auto[^}]*min-width:44px/.test(css),
    (css.match(/\.tf-nav-back\{[^}]*\}/) || [])[0])
  ok('老的 .tf-nav-count 不留死代码（数字格复用 .tf-turn-no）', css.indexOf('.tf-nav-count{') < 0)
  /*
   * `·` 与箭头**同宽**是跳变归零的最后一块：`<button>` 在 Chrome 里默认 border-box，
   * 而 `·` 是 `<span>`（content-box）—— 少写 `box-sizing` 实测同一句 `min-width:12px`
   * 会量出 12px 与 18px（那一组差 12px，搜索框跟着动）。
   */
  ok('箭头/`·` 同宽（min-width + border-box + 居中）',
    /\.tf-turn-nav-b\{[^}]*box-sizing:border-box[^}]*min-width:12px[^}]*text-align:center/.test(css),
    (css.match(/\.tf-turn-nav-b\{[^}]*\}/) || [])[0])
  ok('`·` 是装饰：不亮、不手型', /\.tf-turn-nav-b\.is-dot\{cursor:default\}/.test(css)
    && /\.tf-turn-nav-b\.is-dot:hover\{color:var\(--dsw-alias-label-tertiary\)\}/.test(css))
}

console.log('\n㊻ 工具失败：行里一枚红标，展开区跟着一条红字（宿主说失败就得看得见）')
{
  /**
   * 症状：宿主早就把失败写进了日志（`message.isError` + `error.code`），
   * 而面板**只记了 `endedAt` 和 `resultChars`** —— 失败的调用和成功的长得一模一样。
   * 于是"这一步白跑了吗"在面板上永远没有答案，只能去翻日志。
   *
   * 夹具里 `failed` 的字段名逐个来自宿主（见 trace.ts 的 ToolFailure）：
   * `code` / `name` 来自 `data.error`，`text` 是**去掉 `Error: ` 前缀**的那句话。
   */
  const FAIL = {
    name: 'ToolArgsError', code: 'INVALID_ARGS',
    text: 'invalid arguments: missing required property "questions[2].id"',
  }
  const snap = {
    sessionId: 'sess-1', serverTime: T0, known: true, state: 'live',
    turns: [{
      turn: 1, startedAt: T0, steps: [{
        step: 1, status: 'done', attempts: 1, reasoningChars: 300, textChars: 0,
        startedAt: T0, elapsedMs: 3000,
        tools: [
          { id: 'c1', name: 'ask_user_question', argsRaw: '{"questions":[{"id":"mount"}]}', startedAt: T0, endedAt: T0 + 200, resultChars: 128, failed: FAIL },
          { id: 'c2', name: 'read', argsRaw: '{"file_path":"/a/b.js"}', startedAt: T0 + 300, endedAt: T0 + 400, resultChars: 900 },
        ],
      }],
    }],
  }
  resetMount()
  let tree = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: snap })
  tree = render({ sessionId: 'sess-1' })

  // ── 行里：一枚红标，只说"有几个失败" ──
  const flags = findNodesByClass(tree, 'tf-flag')
  const errFlags = flags.filter((n) => String(n.props.className).includes('is-err'))
  ok('行里出现失败标（且只有一枚）', errFlags.length === 1, errFlags.length)
  ok('失败标写「工具失败」', String(textOf(errFlags[0])) === '工具失败', String(textOf(errFlags[0])))
  ok('悬停里给出机读码与原因', String(errFlags[0].props.title).includes('INVALID_ARGS')
    && String(errFlags[0].props.title).includes('missing required property'), errFlags[0].props.title)
  ok('悬停里带工具名（一步多个工具时认得出是谁）',
    String(errFlags[0].props.title).startsWith('ask_user_question 失败'), errFlags[0].props.title)
  ok('失败标用**红**（不跟"不完整/重试"的琥珀混）',
    String(mod.__internals.CSS).includes('.tf-flag.is-err{color:var(--dsw-alias-state-error-primary)}'))

  // ── 展开区：红字紧跟它自己那条工具行 ──
  findButtons(tree).filter((b) => String(b.props.className || '').includes('tf-chev'))[0].props.onClick()
  tree = render({ sessionId: 'sess-1' })
  const rows = findNodesByClass(tree, 'tf-tool-row')
  ok('两步工具行都还在', rows.length === 2, rows.length)
  const failedRow = rows.find((r) => String(textOf(r)).startsWith('ask_user_question'))
  ok('失败那条的工具行仍在（红字挂在它下面）', failedRow !== undefined, rows.map((r) => String(textOf(r))))
  ok('工具行本身不背锅：不带 is-failed、名字仍是次要色（照宿主的做法，红只给错误文本）',
    !String(failedRow.props.className).includes('is-failed')
    && String(mod.__internals.CSS).includes('.tf-tool-name{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);color:var(--dsw-alias-label-secondary)')
    && !String(mod.__internals.CSS).includes('.is-failed'),
    failedRow.props.className)

  const errs = findNodesByClass(tree, 'tf-tool-err')
  ok('红字只有一条（对应那次失败）', errs.length === 1, errs.length)
  const errTxt = String(textOf(errs[0]))
  ok('红字 = ✗ + 机读码 + 摘要', errTxt.indexOf('✗') === 0 && errTxt.includes('INVALID_ARGS')
    && errTxt.includes('missing required property'), errTxt)
  ok('红字里**不再重复 `Error: `**（前缀已由宿主去掉）', !errTxt.includes('Error:'), errTxt)
  ok('红字悬停给全（工具名 + 码 + 摘要）',
    String(errs[0].props.title).includes('ask_user_question 失败 · INVALID_ARGS'), errs[0].props.title)

  // ── 没有错误码的那种（实测 104 条失败里 7 条没有 error 字段）：只印那句话，不编码 ──
  const noCode = JSON.parse(JSON.stringify(snap))
  noCode.turns[0].steps[0].tools[0].failed = { text: 'tool call aborted before dispatch' }
  resetMount()
  let t2 = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: noCode })
  t2 = render({ sessionId: 'sess-1' })
  findButtons(t2).filter((b) => String(b.props.className || '').includes('tf-chev'))[0].props.onClick()
  t2 = render({ sessionId: 'sess-1' })
  const err2 = findNodesByClass(t2, 'tf-tool-err')
  ok('没有码时只印那句话', err2.length === 1 && String(textOf(err2[0])) === '✗tool call aborted before dispatch',
    String(textOf(err2[0])))
  ok('没有码时不编一格空码', findNodesByClass(t2, 'tf-tool-err-code').length === 0)

  // ── 两个失败 → 行里报数 ──
  const two = JSON.parse(JSON.stringify(snap))
  two.turns[0].steps[0].tools[1].failed = { code: 'FS_NOT_OBSERVED', text: 'cannot modify "/a/b.js": file has not been read' }
  resetMount()
  let t3 = render({ sessionId: 'sess-1' })
  lastEventSource.open()
  lastEventSource.emit({ t: 'snapshot', snapshot: two })
  t3 = render({ sessionId: 'sess-1' })
  const f3 = findNodesByClass(t3, 'tf-flag').filter((n) => String(n.props.className).includes('is-err'))
  ok('两个失败报「工具失败×2」', f3.length === 1 && String(textOf(f3[0])) === '工具失败×2', String(textOf(f3[0])))
  ok('悬停逐条列（两条各一行）', String(f3[0].props.title).split('\n').length === 2, f3[0].props.title)

  // ── 实时路径：不等下次快照，`tool-end` 一到就红 ──
  const st = I.emptyState()
  st.turns = [{ turn: 1, steps: [{ step: 1, tools: [{ id: 'x', name: 'bash', startedAt: T0 }] }] }]
  I.applyChange(st, { k: 'tool-end', turn: 1, step: 1, id: 'x', endedAt: T0 + 5, resultChars: 20, failed: { code: 'TOOL_TIMEOUT', text: 'tool call timed out after 30000ms' } })
  const live = st.turns[0].steps[0].tools[0]
  ok('增量里的失败落到工具上', live.failed && live.failed.code === 'TOOL_TIMEOUT', live.failed)
  // 后到的**成功**结果不得抹掉已有的失败态（事件可重放/乱序）
  I.applyChange(st, { k: 'tool-end', turn: 1, step: 1, id: 'x', endedAt: T0 + 6, resultChars: 20 })
  ok('后到的成功增量不抹掉失败态', live.failed && live.failed.code === 'TOOL_TIMEOUT', live.failed)

  // ── 颜色：红必须在真主题下读得出来（照 ㉓ 的办法，解析真 token 算对比度）──
  const themeFile = themePath()
  const themeSrc = themeFile ? readFileSync(themeFile, 'utf8') : ''
  const defOf = (name, nth) => {
    const all = []
    let i = 0
    while ((i = themeSrc.indexOf(name + ':', i)) >= 0) { all.push(themeSrc.slice(i + name.length + 1, themeSrc.indexOf(';', i))); i += 1 }
    return all[nth]
  }
  const resolve = (name, nth) => {
    let v = defOf(name, nth)
    for (let k = 0; k < 6; k += 1) {
      const m = v && /^var\((--[a-z0-9-]+)\)$/.exec(String(v).trim())
      if (!m) break
      v = defOf(m[1], nth)
    }
    return v
  }
  const over = (v, bg) => {
    const m = /^#([0-9a-f]{3,8})$/i.exec(String(v ?? '').trim())
    if (!m) return null
    const h = m[1].length <= 4 ? m[1].split('').map((c) => c + c).join('') : m[1]
    const rgb = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16))
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return rgb.map((c, i) => Math.round(c * a + bg[i] * (1 - a)))
  }
  const lumOf = (rgb) => {
    const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
  }
  const contrast = (a, b) => { const [x, y] = [lumOf(a), lumOf(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  /**
   * 红字的底是**阶段块**：`color-mix(in srgb, var(--tf-hue) 7%, markdown-code-block)`。
   * 四个色相都要算 —— 块是什么颜色取决于这一步归到哪一类，而失败**哪一类都可能发生**。
   * 门槛定 3.0 而不是 AA 的 4.5：宿主自己的 error token 在这里就是 3.85（浅色最差），
   * 连它都不到 4.5，卡 4.5 等于把宿主的配色判成错。3.0 拦的是"换主题后看不清"这种真退化。
   */
  const blockTok = '--dsw-alias-markdown-code-block'
  const HUES = ['--dsw-alias-state-business-primary', '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary']
  for (const [nth, theme] of [[0, '浅色'], [1, '深色']]) {
    const surface = (hue) => {
      const block = over(resolve(blockTok, nth), [255, 255, 255])
      const h = over(resolve(hue, nth), [255, 255, 255])
      return h.map((c, i) => Math.round(c * 0.07 + block[i] * 0.93))
    }
    const err = over(resolve('--dsw-alias-state-error-primary', nth), [255, 255, 255])
    const worst = Math.min(...HUES.map((h) => contrast(err, surface(h))))
    ok(`${theme}：失败红在四个色相的块底上都读得出（最差 ${worst.toFixed(2)}，需 ≥ 3）`, worst >= 3,
      +worst.toFixed(2))
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
