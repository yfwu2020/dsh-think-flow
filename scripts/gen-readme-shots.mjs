#!/usr/bin/env node
/**
 * 生成 README 用的功能截图（`assets/*.png`）。
 *
 * 为什么这么写：README 里的图必须是**插件真实的样子**，不能另画一版"示意界面"。
 * 所以这里不重写样式，而是把构建产物 `lib/client.js` 里**真组件**渲染出来
 * （与 `docs/ui-preview.html` 同一套底座、**同一份场景**），配宿主主题包里
 * 整段抓出来的真 token，再用 headless Chrome 拍下来。样式一旦漂移，图会跟着变，
 * 不会出现"图好看但和插件不一样"。
 *
 * 数据来自 `scripts/demo-data.mjs` —— **全部是合成的**：这些图会进公开仓库，
 * 掺进真实会话片段就等于把个人数据随 README 发出去。
 *
 * 用法：
 *   npm run build && node scripts/gen-readme-shots.mjs          # 全部场景
 *   node scripts/gen-readme-shots.mjs running waiting          # 指定场景
 *   DSH_CHROME=/path/to/chrome node scripts/gen-readme-shots.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ROOT, themePath, extractThemeCss, createHarness, collectSlots, FOLLOW_SCRIPT,
} from './preview-harness.mjs'
import { SCENES, STEP_STUB } from './demo-scenes.mjs'

const ASSETS = join(ROOT, 'assets')

/** 找 Chrome。找不到就报错退出 —— 这个脚本的产物是图，没有图就没有意义。 */
function findChrome() {
  const candidates = [
    process.env.DSH_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || ''
}

/**
 * 一张图的外壳：380px 的右栏面板 + 一圈背景留白。
 *
 * 面板外框照 DSH 右栏的样子（1px 边 + 圆角 + 面板阴影），这样图里那 380px
 * 就是真机上真实的宽度，不会被"截得更窄"骗了。
 *
 * 深色走 `body[data-ds-dark-theme]` —— 宿主主题包就是按这个属性分深浅的
 * （不是 `.dark` 类，也不是 `prefers-color-scheme`）。
 *
 * 高度不写死：`#measure` 那一趟把 `.sb` 放开成 auto，量出内容的真实高度，
 * 再由调用方按这个高度拍 —— 图里就不会留下半屏空白（早先写死 620px，
 * 内容只有 470px，下半截全是空的）。
 *
 * @param o - 主题 CSS / 组件 CSS / 面板 HTML / 深色与否。
 * @returns 一个自包含的 HTML 页面。
 */
function shotPage(o) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>${o.themeCss}</style>
<style>${o.componentCss}</style>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{background:var(--dsw-alias-bg-layer-1);padding:20px}
/* 右栏真实外框：380px 宽，与 DSH 的右侧栏一致 */
.sb{width:380px;height:${o.height}px;display:flex;flex-direction:column;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);
  box-shadow:var(--dsw-elevation-panel)}
.sb>.tf-root{flex:1;min-height:0}
/* 量尺寸那一趟：放开高度，让内容自己决定有多高 */
html[data-measure] .sb{height:auto;min-height:0}
html[data-measure] .sb>.tf-root{flex:0 0 auto}
</style>
</head>
<body${o.dark ? ' data-ds-dark-theme' : ''}>
<div class="sb" id="root">${o.panel}</div>
<script>
${FOLLOW_SCRIPT}
if (location.hash === '#measure') {
  /* 量尺寸：放开高度 → 跟随 → 把 body 的真实高度写进 title，外面 dump-dom 读它 */
  document.documentElement.setAttribute('data-measure', '')
  tfFollow()
  document.title = 'h:' + Math.ceil(document.body.scrollHeight)
} else {
  tfFollow()
}
</script>
</body>
</html>
`
}

/**
 * 量出一页内容需要多高（像素）。用来给图定尺寸，避免大片空白。
 * @param chrome - Chrome 可执行文件。
 * @param page - 页面文件路径。
 * @returns 高度（像素）。
 */
function measureHeight(chrome, page) {
  const dom = execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--virtual-time-budget=4000', '--dump-dom',
    'file://' + page + '#measure',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  const m = /<title>h:(\d+)<\/title>/.exec(dom)
  if (!m) throw new Error('量不到高度（页面里的 #measure 那段没跑到？）')
  return Number(m[1])
}

/** 拍一张图。 */
function shoot(chrome, page, out, width, height) {
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    // 2× 出图：README 在 Retina 上不糊
    '--force-device-scale-factor=2',
    '--virtual-time-budget=4000',
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    'file://' + page,
  ], { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 32 * 1024 * 1024 })
}

async function main() {
  const only = process.argv.slice(2)
  const scenes = (only.length ? SCENES.filter((s) => only.includes(s.key)) : SCENES).filter((s) => s.shot)
  if (!scenes.length) {
    console.error('没有匹配的场景。可出图的 key：' + SCENES.filter((s) => s.shot).map((s) => s.key).join(' / '))
    process.exit(1)
  }

  const chrome = findChrome()
  if (!chrome) {
    console.error('找不到 Chrome。设 DSH_CHROME 指向 Chrome/Chromium 可执行文件。')
    process.exit(1)
  }
  const theme = themePath()
  if (theme === null) {
    console.error('找不到 dsh-client-ui-theme：先 npm i，或设 DSH_CHECKOUT 指向 DSH 安装目录。')
    process.exit(1)
  }
  const themeCss = extractThemeCss(theme)

  // 组件里的秒表用 setInterval；截图是静态的，别让它把进程挂住
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.fetch = () => Promise.resolve({
    ok: true, json: () => Promise.resolve({ reasoning: STEP_STUB, streamGap: false }),
  })

  /**
   * ⚠️ 每个场景都要**重新装一次底座**（`createHarness()` 会重新求值一遍 bundle）。
   *
   * 为什么不能共用一个：组件里"展开了哪几步"是**模块级**的状态（跨会话/跨挂载保留），
   * 共用的话 ④ 展开的第 6 步会一直留在后面每一张图里 —— 第一版就踩了，
   * 「工具失败」那张图上多出一个悬在半空的"载入原文…"，看着像 bug。
   */
  const fresh = () => {
    const h = createHarness()
    const slots = collectSlots(h.mod)
    if (!slots.Body) {
      console.error('没能拿到标签页 body 组件 —— 先 `npm run build`。')
      process.exit(1)
    }
    return { ...h, ...slots }
  }
  const componentCss = fresh().mod.__internals.CSS

  mkdirSync(ASSETS, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'think-flow-shots-'))
  const made = []

  for (const s of scenes) {
    const { renderState, Body, mod } = fresh()
    const panel = await s.html({ renderState, Body, mod })
    const mk = (height) => shotPage({
      themeCss, componentCss, panel, dark: s.shot.theme === 'dark', height,
    })
    // ① 先用一个够大的框量内容高度（量完这趟的高度不影响 ②）
    const probe = join(tmp, s.key + '.measure.html')
    writeFileSync(probe, mk(4000))
    const measured = measureHeight(chrome, probe)
    // ② 按量到的高度拍。上下各 20px 留白已经算在 scrollHeight 里了
    const height = Math.min(measured, s.shot.maxHeight ?? 820)
    const page = join(tmp, s.key + '.html')
    writeFileSync(page, mk(height))
    const out = resolve(ASSETS, s.shot.file)
    shoot(chrome, page, out, s.shot.width, height)
    made.push(s.shot.file)
    console.log('  ✓ ' + s.shot.file + '   ' + s.shot.width + '×' + height + '   ← ' + s.tag)
  }

  // 产物清单：给 CI / 人一个"该有哪些图"的单一来源
  writeFileSync(join(ROOT, 'screenshots.json'), JSON.stringify(made.map((f) => 'assets/' + f), null, 2) + '\n')
  console.log('\n已生成 ' + made.length + ' 张图到 assets/，清单写入 screenshots.json')
  console.log('  主题：' + theme)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
