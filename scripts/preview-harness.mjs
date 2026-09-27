/**
 * 预览页的共用底座：跑**真组件** + 序列化成 HTML。
 *
 * 为什么单独一个模块：预览页现在有两个（`ui-preview.html` 看长相、
 * `history-toggle.html` 做交互稿），它们必须**同一套底座** —— 否则两个页面
 * 会长得不一样，而"看着不一样"正是这类预览最容易骗人的地方。
 *
 * 这里不做任何手写替身：跑的是构建产物 `lib/client.js` 里的真组件，
 * 用组件自己那份 CSS，配宿主 `dsh-client-ui-theme` 里整段抓出来的真 token。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')
export const BUNDLE = join(ROOT, 'lib', 'client.js')

/**
 * 找 DSH 运行时里的主题包。
 *
 * 三个来源，按可靠程度排：
 *   ① `DSH_CHECKOUT` —— 显式指定的 DSH 安装目录（CI / 多版本共存时用这个）
 *   ② 本包的 `node_modules/@deepseek-ai/dsh-client-ui-theme` —— `npm i` 装上的
 *      devDependency 就是这个（公开仓库里走这条）
 *   ③ `~/.npm/_npx/*` 里任意一份 npx 缓存 —— 兜底，**通配**而不是写死某个哈希：
 *      那个哈希是本机的缓存目录名，换台机器/换次安装就变，写死了等于把
 *      "只在我这台机器上跑得起来"藏进代码里。
 * @returns 主题 bundle 的路径；都找不到返回 null。
 */
export function themePath() {
  const candidates = [
    process.env.DSH_CHECKOUT && join(process.env.DSH_CHECKOUT, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
    join(ROOT, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
    ...npxCacheCandidates('@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  ].filter(Boolean)
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

/**
 * 在 `~/.npm/_npx/<hash>/node_modules/` 里找某个相对路径（兜底用）。
 * @param rel - 相对 node_modules 的路径。
 * @returns 存在的候选路径（可能为空）。
 */
function npxCacheCandidates(rel) {
  const root = join(process.env.HOME || '', '.npm', '_npx')
  if (!existsSync(root)) return []
  const out = []
  try {
    for (const hash of readdirSync(root)) {
      const p = join(root, hash, 'node_modules', rel)
      if (existsSync(p)) out.push(p)
    }
  } catch { /* 读不了就当没有 */ }
  return out
}

// ───────────────────── ① 抓宿主的主题 CSS ─────────────────────

/**
 * 从主题 bundle 里把内联的样式表整段取出来。
 *
 * 这些 CSS 是以 `var xxx_css_default = "…"` 的字符串字面量存在的，
 * 所以按字面量边界扫描（要正确处理 \" 转义），比解析 CSS 本身可靠。
 * @param file - 主题 bundle 路径。
 * @returns 拼接后的 CSS 文本。
 */
export function extractThemeCss(file) {
  const src = readFileSync(file, 'utf8')
  const names = ['base_css_default', 'corner_shape_css_default', 'design_platform_css_default',
    'gradient_shadow_text_css_default', 'scrollbar_css_default']
  const out = []
  for (const name of names) {
    const at = src.indexOf(`var ${name} = "`)
    if (at < 0) continue
    let i = at + `var ${name} = "`.length
    let text = ''
    while (i < src.length) {
      const ch = src[i]
      if (ch === '\\') {                       // 转义：\" \\ \n 等
        const next = src[i + 1]
        text += next === 'n' ? '\n' : next === 't' ? '\t' : next
        i += 2
        continue
      }
      if (ch === '"') break
      text += ch
      i += 1
    }
    out.push(`/* ===== ${name} ===== */\n${text}`)
  }
  return out.join('\n\n')
}

// ───────────────────── ② 跑真组件 ─────────────────────

/** 最小 React 运行时（与单测同款：hooks 的 cell 跨渲染保留）。 */
export function makeReact() {
  let cells = []
  let cursor = 0
  let effects = []
  const React = {
    createElement(type, props) {
      const children = []
      for (let i = 2; i < arguments.length; i += 1) {
        const c = arguments[i]
        if (c === null || c === undefined || c === false) continue
        if (Array.isArray(c)) children.push(...c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false))
        else children.push(c)
      }
      return { type, props: props || {}, children }
    },
    Fragment: 'Fragment',
    useRef(init) { if (cells[cursor] === undefined) cells[cursor] = { current: init }; return cells[cursor++] },
    useState(init) {
      if (cells[cursor] === undefined) cells[cursor] = typeof init === 'function' ? init() : init
      const i = cursor++
      return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v }]
    },
    useReducer(reducer, init) {
      if (cells[cursor] === undefined) cells[cursor] = init
      const i = cursor++
      return [cells[i], (a) => { cells[i] = reducer(cells[i], a) }]
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = cells[i]
      const changed = prev === undefined || deps === undefined || prev.deps === undefined ||
        deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
      if (changed) { cells[i] = { deps: deps ? deps.slice() : undefined }; if (prev && prev.cleanup) prev.cleanup(); effects.push(() => { cells[i].cleanup = fn() }) }
    },
  }
  return {
    React,
    cells: () => cells,
    reset() { cells = []; cursor = 0; effects = [] },
    render(Component, props) {
      cursor = 0; effects = []
      let tree = Component(props)
      // 摊平外壳层：ThinkFlowTabHost 只负责按 sessionId 重挂载内层，不产出 DOM
      while (tree && typeof tree.type === 'function') tree = tree.type(tree.props)
      effects.forEach((f) => f())
      return tree
    },
  }
}

/** 序列化时用到的转义。 */
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const camel = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())

/**
 * React 的 `style` 是对象，转成 CSS 声明文本；已经是字符串的原样用。
 * @param v - 组件的 style 值。
 * @returns CSS 声明文本（空串 = 没有可写的）。
 */
export function styleText(v) {
  if (typeof v === 'string') return v
  if (v === null || typeof v !== 'object') return ''
  return Object.entries(v)
    .filter(([, val]) => val !== null && val !== undefined && val !== false && val !== '')
    .map(([k, val]) => camel(k) + ':' + val)
    .join(';')
}

export function serialize(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escText(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (typeof node.type === 'function') return serialize(node.type(node.props))
  if (node.type === 'Fragment') return serialize(node.children)
  const props = node.props || {}
  const attrs = []
  // class 放最前，读起来顺
  if (props.className) attrs.push(`class="${escAttr(String(props.className))}"`)
  if (props.style !== undefined) {
    const st = styleText(props.style)
    if (st) attrs.push(`style="${escAttr(st)}"`)
  }
  for (const [k, v] of Object.entries(props)) {
    // ⚠️ `className` / `style` **必须序列化**。早先两个都 skip 了，生成出来的页面
    // 于是是**一坨没有样式的纯文本** —— 面板 CSS 一条都匹配不上、容量条也没有宽度，
    // 而页头还写着"样式是组件自己那份 CSS"（拿真机截图对照才发现，见 README 坑 20）。
    // `ref` 也 skip：React 的 ref 对象会被印成 [object Object]。
    if (k === 'className' || k === 'style' || k === 'children' || k === 'key' || k === 'ref') continue
    if (typeof v === 'function' || v === undefined || v === null || v === false) continue
    // React 里 SVG 属性是驼峰（strokeWidth），HTML 里是连字符
    const name = /^(viewBox|preserveAspectRatio|xmlns)$/.test(k) ? k
      : /^(aria|data)-/.test(k) ? k : camel(k)
    attrs.push(`${name}="${escAttr(String(v))}"`)
  }
  const tag = node.type
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${serialize(node.children)}</${tag}>`
}

/**
 * 静态 DOM 的「跟随」补丁。
 *
 * 组件里"跟随当前步 / 展开就滚到那段原文 / 本轮结束滚到小结"是**运行时行为**，
 * 而预览页与截图里的面板是**序列化出来的死 DOM** —— 不补这一下，拍出来的永远是
 * "面板停在最顶上"，恰恰看不出跟随这个功能。
 *
 * 规则与组件内保持一致，但**展开时对齐的是那一整步**（`.tf-step`），不是原文块：
 * 对齐原文块会把这一步的标题与工具行留在视野外，图上就变成"从半行开始"。
 *
 * 页面里 `tfFollow()` 调一次即可。
 */
export const FOLLOW_SCRIPT = `
function tfFollow() {
  document.querySelectorAll('.tf-body').forEach(function (box) {
    var br = box.getBoundingClientRect()
    var raw = box.querySelector('.tf-raw')
    if (raw) {
      // 对齐承载它的那一步（早先对齐 .tf-raw 本身 → 步标题与工具行被顶出视野）
      var step = raw.closest ? (raw.closest('.tf-step') || raw) : raw
      var sr = step.getBoundingClientRect()
      box.scrollTop += (sr.top - br.top) - 10
      return
    }
    var cur = box.querySelector('.tf-step.is-live, .tf-step.is-wait')
    if (cur) {
      var nr = cur.getBoundingClientRect()
      box.scrollTop += (nr.top - br.top) - Math.max(0, box.clientHeight / 3)
      return
    }
    if (box.querySelector('.tf-recap')) box.scrollTop = box.scrollHeight
  })
}
`

// ───────────────────── ③ 把真组件装起来 ─────────────────────

/** 收集树里带 onClick 的按钮，供交互用例点击。 */
export function findButtons(node, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((x) => findButtons(x, acc)); return acc }
  if (node.type === 'button' && node.props && node.props.onClick) acc.push(node)
  ;(node.children || []).forEach((x) => findButtons(x, acc))
  return acc
}

/**
 * 收集树里 `className` 含某串的节点（不限标签）。
 *
 * 为什么不复用 `findButtons`：**双击进目录**的入口是第二行标题那一格（`<span>` 或
 * `<div>`），它不是 button，`findButtons` 的 `type === 'button'` 条件直接把它筛掉。
 * @param node - 树根。
 * @param cls - 类名子串。
 * @param acc - 累积数组（内部递归用）。
 * @returns 命中的节点数组。
 */
export function findNodes(node, cls, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((x) => findNodes(x, cls, acc)); return acc }
  if (node.props && String(node.props.className || '').includes(cls)) acc.push(node)
  ;(node.children || []).forEach((x) => findNodes(x, cls, acc))
  return acc
}

/** 元素树的纯文本。 */
export function textOfNode(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOfNode).join('')
  return (node.children || []).map(textOfNode).join('')
}

/**
 * 装好一套预览底座：React 桩 + 真 bundle + 渲染/交互。
 * @returns 底座对象。
 */
export function createHarness() {
  const react = makeReact()
  const loaded = {}
  let source = null
  class FakeES {
    constructor(url) { this.url = url; source = this }
    emit(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }) }
    open() { if (this.onopen) this.onopen() }
    close() {}
  }
  const win = { __ModuleLoader__: { load: (s) => { loaded.spec = s } } }
  const doc = { head: { appendChild() {} }, getElementById: () => undefined, createElement: () => ({ setAttribute() {}, remove() {} }) }
  globalThis.window = win
  globalThis.document = doc
  globalThis.EventSource = FakeES
  const req = (n) => (n === 'react' ? react.React : undefined)
  new Function('window', 'document', 'require', 'EventSource', readFileSync(BUNDLE, 'utf8'))(win, doc, req, FakeES)
  const mod = loaded.spec.factory(req)
  const SESSION = 's-preview'

  /**
   * 渲染一个状态：喂快照（+ 变更）→ 按需点击/双击 → 返回 HTML。
   *
   * 第 4 个参数有两种写法：
   *   · **字符串**（老写法）：`renderState(B, snap, ch, '.tf-chev', 10)`
   *     —— 按文案（或 `.类名`）点一个 **button**。
   *   · **对象**（新写法）：`renderState(B, snap, ch, { clicks: [...], dblClick: 'tf-turn-title' })`
   *     —— `clicks` 依次执行，每项 `{ cls, index }` 按**类名**点任意节点的真实 `onClick`。
   *
   * 为什么要有对象这种：面板里"展开某个阶段"（`.tf-phase-h`）和"展开某一步"（`.tf-chev`）
   * 挂 click 的节点**都不是 button**，`findButtons` 的 `type === 'button'` 直接把它们筛掉；
   * 而"双击第二行标题进目录"挂的是 `onDoubleClick` —— 三条路各有各的挂法，
   * 位置参数越加越长，不如一次说清。
   *
   * @param Component - 组件。
   * @param snap - 快照。
   * @param changes - 之后要喂的增量。
   * @param clickLabel - 老写法的点法，或新写法的选项对象（见上）。
   * @param clickIndex - 老写法：命中多个时取第几个（0 基）。
   * @param dblClickClass - 老写法：双击类名含该串的节点。
   */
  async function renderState(Component, snap, changes, clickLabel, clickIndex, dblClickClass) {
    const plan = clickLabel && typeof clickLabel === 'object'
      ? { clicks: clickLabel.clicks || [], dblClick: clickLabel.dblClick }
      : {
        clicks: [{ label: clickLabel, index: clickIndex }].filter((c) => c.label),
        dblClick: dblClickClass,
      }

    react.reset()          // 每个面板独立挂载
    source = null
    react.render(Component, { sessionId: SESSION })
    if (source) {
      source.open()
      source.emit({ t: 'snapshot', snapshot: snap })
      for (const c of changes || []) source.emit({ t: 'change', change: c })
    }
    let tree = react.render(Component, { sessionId: SESSION })

    const settle = async () => {
      await new Promise((r) => setTimeout(r, 0))   // 让 /step 的 Promise 落地
      tree = react.render(Component, { sessionId: SESSION })
    }

    for (const c of plan.clicks) {
      if (c.cls !== undefined) {
        const hit = findNodes(tree, c.cls).filter((n) => n.props && typeof n.props.onClick === 'function')
        const node = hit[c.index === undefined ? 0 : c.index]
        if (node) { node.props.onClick(); await settle() }
        continue
      }
      const byClass = c.label.startsWith('.')
      const hits = findButtons(tree).filter((b) => (byClass
        ? String(b.props.className || '').includes(c.label.slice(1))
        : textOfNode(b).includes(c.label)))
      const btn = hits[c.index === undefined ? 0 : c.index]
      if (btn) { btn.props.onClick(); await settle() }
    }

    if (plan.dblClick) {
      const hit = findNodes(tree, plan.dblClick).find((n) => n.props && typeof n.props.onDoubleClick === 'function')
      if (hit) { hit.props.onDoubleClick(); await settle() }
    }
    return serialize(tree)
  }

  return {
    React: react.React, harness: react, mod, renderState, serialize, findButtons, findNodes, textOfNode, SESSION,
    /**
     * 组件这次挂载时 `new` 出来的那个 EventSource。
     *
     * 为什么要暴露它：bundle 里的 `EventSource` 是**构造函数的参数**（不是 globalThis），
     * 所以外面 patch `globalThis.EventSource` 接不到它 —— 想手动喂快照/增量
     * （比如"真数据端到端"那种验证）就够不着。`renderState` 用的是同一个实例。
     */
    getSource: () => source,
  }
}

/**
 * 从构建产物里取插件的 slot 注册件（`sidebar.right.pane.tab` 的 body 组件等）。
 * @param mod - bundle 导出的模块。
 * @returns `{ Body, HeaderButton, typeDef }`。
 */
export function collectSlots(mod) {
  const regs = []
  const typeRegs = []
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get(name) {
      if (name === 'sidebarRightTabs') return { register(def) { typeRegs.push(def); return () => {} } }
      if (name === 'sidebarRight') return { openTab() {} }
      return undefined
    },
    inject(deps, cb) { return deps.every((d) => ctx.get(d) !== undefined) ? cb(ctx) : undefined },
    slots: {
      inject(slot, factory) { regs.push({ slot, factory }); return () => {} },
      register(spec, C) { return { spec, Component: C } },
    },
  }
  mod.apply(ctx)
  let Body = null
  let HeaderButton = null
  for (const r of regs) {
    const reg = r.factory()
    if (r.slot === 'sidebar.right.pane.tab') Body = reg.Component
    if (r.slot === 'conversation.session.header.utilities') HeaderButton = reg.Component
  }
  return { Body, HeaderButton, typeDef: typeRegs[0] }
}

/**
 * 预览页的**共用外壳**。
 *
 * ⚠️ 为什么要有这个：之前每张预览页都把 `.stage/.col/.panel` 这套 CSS 各写一遍，
 * 于是同一个布局 bug 被抄了五份 —— 最要命的两条：
 *   ① 面板里的长命令串（`{"command":"cd /tmp && curl …`）撑爆了 flex 项的**固有宽度**
 *      （flex 项默认 `min-width:auto`），右栏被挤到下面、还渲染成一条窄带；
 *   ② 面板被套进 `max-height` 滚动盒，下半截被裁掉 —— 看着就像"页面不完整"。
 *
 * 所以这里统一：面板按真实宽度、**不裁高**（整页滚动），左右两栏都不许被内容撑开。
 *
 * @param {object} o
 * @param {string} o.title   页面标题
 * @param {string} o.caption 面板上方的说明
 * @param {string} o.panel   面板 HTML
 * @param {string} o.side    右栏说明 HTML
 * @param {string} o.extraCss 页面自己的 CSS（追加在最后）
 * @param {string} o.script  页面自己的脚本（放最后）
 */
export function previewPage(o) {
  const title = o.title ?? '预览'
  const caption = o.caption ?? ''
  const side = o.side ?? ''
  const extraCss = o.extraCss ?? ''
  const script = o.script ?? ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${o.themeCss ?? ''}</style>
<style>${o.componentCss ?? ''}</style>
<style>
/* ── 共用外壳 ── */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.wrap{display:flex;align-items:flex-start;gap:28px;padding:24px 28px 64px}
/* 左栏固定 380px：min-width:0 是关键 —— 不加的话 flex 项的 min-width:auto
   会被面板里的长命令串撑开，整页布局跟着崩 */
.pane{flex:0 0 380px;width:380px;min-width:0}
.pane h2{font:var(--dsw-font-s-strong-14);margin:0 0 10px}
/* 面板**不裁高**（之前套了 max-height，下半截被切，看着像"不完整"）。
   溢出用 hidden：长命令串不许把面板撑宽。 */
.panel{display:flex;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;
  background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-panel);overflow:hidden}
.panel>.tf-root{flex:1 1 auto;min-width:0;overflow-x:hidden}
.notes{flex:1 1 360px;min-width:300px;max-width:560px}
.notes h2{font:var(--dsw-font-s-strong-14);margin:0 0 10px}
.notes p{font:var(--dsw-font-xxs-12);line-height:1.85;color:var(--dsw-alias-label-tertiary);margin:0 0 10px}
.notes b{color:var(--dsw-alias-label-secondary)}
.notes code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,monospace);
  font-size:.92em;background:var(--dsw-alias-bg-layer-2);border-radius:3px;padding:0 3px}
.notes kbd{border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;font:inherit}
/* 窄屏：单列，面板仍然不被撑开 */
@media (max-width:820px){.wrap{flex-wrap:wrap}.pane{flex:1 1 380px}.notes{flex:1 1 100%;max-width:none}}
${extraCss}
</style>
</head>
<body>
<div class="wrap">
  <div class="pane">
    <h2>${caption}</h2>
    <!-- ⚠️ 面板 HTML **整段原样注入**，id 挂在 .panel 上。
         早先的写法是把组件的 <div class="tf-root"> **开标签剥掉**、再自己套一层同名的，
         结果剥掉的开标签没有对应的闭标签被剥 → 多出一个 </div> → 浏览器提前把
         .wrap/.pane 关掉，右栏被甩进 <body>（两张预览页都是这个病）。 -->
    <div class="panel" id="root">${o.panel ?? ''}</div>
  </div>
  <div class="notes">${side}</div>
</div>
${script}
</body>
</html>
`
}
