#!/usr/bin/env node
/**
 * 生成 UI 预览页（`docs/ui-preview.html`）—— 看长相。
 *
 * 底座在 `scripts/preview-harness.mjs`（跑构建产物里的**真组件** + 宿主真主题 token），
 * 场景在 `scripts/demo-scenes.mjs`（与 README 截图**同一份**），
 * 数据在 `scripts/demo-data.mjs`（**合成的**）。
 *
 * 这个脚本自己只负责：拼页面、生成前自检。
 *
 * ⚠️ 依赖构建产物：先 `npm run build`，否则读的是上一次的 `lib/client.js`。
 *
 * 用法：
 *   node scripts/gen-ui-preview.mjs            # 全部场景
 *   node scripts/gen-ui-preview.mjs running    # 指定场景（key 见 demo-scenes.mjs）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT, themePath, extractThemeCss, createHarness, collectSlots, serialize, FOLLOW_SCRIPT,
} from './preview-harness.mjs'
import { SCENES, STEP_STUB } from './demo-scenes.mjs'

/** 面板展开历史步骤时组件会真的发 `/step`；预览里给它一个桩。 */
function stubStepFetch() {
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ reasoning: STEP_STUB, streamGap: false }),
  })
}

async function main() {
  // 组件里的秒表用 setInterval；预览是静态的，不能让它把进程挂住
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  const only = process.argv.slice(2)
  const scenes = only.length ? SCENES.filter((s) => only.includes(s.key)) : SCENES
  if (!scenes.length) {
    console.error('没有匹配的场景。可用的 key：' + SCENES.map((s) => s.key).join(' / '))
    process.exit(1)
  }

  const theme = themePath()
  if (theme === null) {
    console.error('找不到 dsh-client-ui-theme。')
    console.error('  · 先 npm i（装上 devDependencies），或')
    console.error('  · 设 DSH_CHECKOUT 指向 DSH 安装目录')
    process.exit(1)
  }
  const themeCss = extractThemeCss(theme)

  stubStepFetch()
  /**
   * ⚠️ 每个场景都重新装一次底座（`createHarness()` 会重新求值一遍 bundle）：
   * 组件里"展开了哪几步"是模块级状态，共用会让上一个场景的展开态漏到下一个场景里
   * （与 `gen-readme-shots.mjs` 同一条注意）。
   */
  const fresh = () => {
    const h = createHarness()
    const slots = collectSlots(h.mod)
    if (!slots.Body) {
      console.error('没能拿到标签页 body 组件（lib/client.js 是最新的吗？先 npm run build）')
      process.exit(1)
    }
    return { ...h, ...slots }
  }
  const first = fresh()
  const componentCss = first.mod.__internals.CSS
  // 头部图标走**真实注册路径**拿到的组件渲染
  const headerIcon = first.HeaderButton ? serialize(first.HeaderButton({})) : ''

  const panels = []
  for (const s of scenes) {
    const { renderState, Body, mod } = fresh()
    panels.push({ tag: s.tag, note: s.note, html: await s.html({ renderState, Body, mod }) })
  }

  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>思维链面板 · UI 预览（真实组件 + 宿主真实主题变量）</title>
<style>
/* ═══════ 这一段是从 dsh-client-ui-theme 整段抓出来的宿主主题 ═══════ */
${themeCss}
</style>
<style>
/* ═══════ 这一段是插件自己的 CSS（来自构建产物） ═══════ */
${componentCss}
</style>
<style>
/* ═══════ 预览页自己的外壳，不参与被评估的样式 ═══════ */
*{box-sizing:border-box}
body{margin:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:var(--dsw-font-base-16);padding:22px 24px 60px}
h1{font:var(--dsw-font-l-20);margin:0 0 6px}
.lead{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);max-width:1000px;margin-bottom:6px;line-height:1.8}
.lead code{font:var(--dsw-font-markdown-code);background:var(--dsw-alias-markdown-code-block);border-radius:4px;padding:1px 5px}
.row{display:flex;gap:18px;flex-wrap:wrap;margin-top:18px;align-items:flex-start}
.cell{width:380px;flex:0 0 auto}
.cell .cap{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.cell .why{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:1.75;margin-bottom:8px;min-height:64px}
/* 右侧栏真实外框：与 DSH 的右栏一致（380px 是右栏实际宽度） */
.sb{width:380px;height:560px;display:flex;flex-direction:column;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);
  box-shadow:var(--dsw-elevation-panel)}
.sb>.tf-root{flex:1;min-height:0}
.toknote{margin-top:26px;max-width:1060px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);line-height:1.85}
.toknote b{color:var(--dsw-alias-label-secondary)}
</style>
</head>
<body>
<h1>思维链面板 · UI 预览</h1>
<p class="lead">
  这一页上的面板<code>不是手写的替身</code>：结构来自构建产物 <code>lib/client.js</code> 里真正的组件，
  样式是组件自己那份 CSS，配色字号全部来自宿主 <code>dsh-client-ui-theme</code> 里整段抓出来的 token。
  宽度就是右侧栏真实宽度 <b>380px</b>。数据是 <code>scripts/demo-data.mjs</code> 里
  <b>合成的</b>一段会话（不含任何真实对话内容）。
</p>
<div class="row">
${panels.map((p) => `  <div class="cell">
    <div class="cap">${p.tag}</div>
    <div class="why">${p.note}</div>
    <div class="sb">${p.html}</div>
  </div>`).join('\n')}
</div>

<h2 style="font:var(--dsw-font-m-18);margin:26px 0 4px">会话头部入口</h2>
<p class="lead" style="max-width:760px">
  图标是<b>折线轨迹</b>（一条带拐点的路径 + 三个节点）。它挂在会话头部的工具区，
  点一下打开右侧栏的「思维链」标签页。
</p>
<div class="row" style="margin-top:10px">
  <div class="cell" style="width:auto">
    <div class="cap">实际大小（16px 图标 / 24px 命中区）</div>
    <div style="display:flex;align-items:center;gap:14px;margin-top:8px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;width:max-content">
      <span style="color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)">头部工具区 →</span>
      <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover)">${headerIcon}</span>
      <span style="color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)">（悬停态）</span>
      <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px">${headerIcon}</span>
    </div>
  </div>
  <div class="cell" style="width:auto">
    <div class="cap">放大 3×（看笔画）</div>
    <div style="margin-top:8px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;width:max-content">
      <svg viewBox="0 0 16 16" width="48" height="48" fill="none" stroke="var(--dsw-alias-label-primary)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.7 12.7L6.1 8.5l3 2.5 4.3-6.3"></path>
        <circle cx="2.7" cy="12.7" r="1.5"></circle>
        <circle cx="9.1" cy="11" r="1.5"></circle>
        <circle cx="13.4" cy="4.7" r="1.5"></circle>
      </svg>
    </div>
  </div>
</div>
<script>
${FOLLOW_SCRIPT}
tfFollow()
</script>
</body>
</html>
`
  // docs/ 是**本地生成**目录（不进公开仓库），新克隆的仓库里没有它 —— 得自己建
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  writeFileSync(join(ROOT, 'docs', 'ui-preview.html'), page)
  console.log('已生成 docs/ui-preview.html')
  console.log('  主题 CSS：' + themeCss.length + ' 字符（来自 ' + theme + '）')
  console.log('  面板数：' + panels.length + '（' + scenes.map((s) => s.key).join(', ') + '）')

  // ── 自检：这一页的价值全在"样式真的生效"上，所以在这里把住 ──
  // 早先 serialize() 跳过了 className / style，页面是一坨无样式纯文本，
  // 却照样"生成成功"（连我自己都照着它误判过）。宁可生成失败，也不要一张假图。
  const checks = [
    ['面板带了 class', /<[a-z]+[^>]*\sclass="tf-/.test(page)],
    ['容量条带了宽度', /style="width:\d+%"/.test(page)],
    ['没有 [object Object] 属性', !/="\[object Object\]"/.test(page)],
    // 目录那一屏是双击出来的：这条守住"双击真的生效了"
    ['目录进得去（有 tf-dir-row）', /tf-dir-row/.test(page)],
  ]
  const bad = checks.filter(([, pass]) => !pass).map(([what]) => what)
  if (bad.length) {
    console.error('✗ 预览页自检失败：' + bad.join('、'))
    console.error('  （页面会是一张没有样式的假图，别拿它做判断）')
    process.exit(1)
  }
  console.log('  自检：' + checks.map(([what]) => what).join(' ✓ ') + ' ✓')

  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
