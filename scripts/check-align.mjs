#!/usr/bin/env node
/**
 * 布局对齐检查（真浏览器）。
 *
 * 为什么单独有一个脚本：`test-client.mjs` 里的 React 桩**没有布局** ——
 * 它只能验"每行的格子序列一致"这种结构事实，验不了"这些格子真的排在同一条竖线上"。
 * 而这一步的 bug 恰恰全是布局层面的：
 *   · 箭头是条件渲染的 → 少一个 14px 格子 + 一个 9px 间距 → 整条尾巴右移 23px
 *   · 时长格用 min-width → "正在想"（33px）比下限宽 1px → 容量条右边缘漂 1px
 * 所以这里用 headless Chrome 打开 `docs/ui-preview.html`，读真实
 * `getBoundingClientRect()`，断言**所有可见步骤行的尾部都在同一条线上**。
 *
 * 依赖：本机有 Chrome。没有就**跳过（exit 0）**，不让它拖累 `npm test` 的可用性。
 * 用法：`npm run align`（先 `npm run preview` 生成页面）
 *
 * 覆盖边界（写清楚免得误以为它管全部）：
 *   · 管得到：**有箭头的行之间**是否排在同一条竖线上（时长格宽一像素都能抓到）
 *   · 管不到：**整格缺失**（比如"纯工具步没有箭头"）—— 预览用的真实 turn 1
 *     每一步都有思考，没有这种行。那种情况由 `test-client.mjs` 的 ㉔ 按结构验
 *     （断言每行的尾部格子序列一致），两个工具各管一半，缺一不可。
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PAGE = join(ROOT, 'docs', 'ui-preview.html')

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

if (CHROME === undefined) {
  console.log('\n⏭  没找到 Chrome，跳过布局检查（这不是失败）\n')
  process.exit(0)
}
if (!existsSync(PAGE)) {
  console.log('\n✗ 没有 ' + PAGE + '，先跑 `npm run preview`\n')
  process.exit(1)
}

// ───────────────────── 在页面里量，把结果写进 <pre> ─────────────────────

const probe = `
<pre id="align-out"></pre>
<script>
var rows = [], hidden = 0;
document.querySelectorAll('.tf-step-row').forEach(function (row) {
  var vol = row.querySelector('.tf-vol'), dur = row.querySelector('.tf-dur'), chev = row.querySelector('.tf-chev');
  if (!vol || !dur) return;
  var rr = row.getBoundingClientRect();
  if (rr.width === 0) { hidden += 1; return; }      // 折叠阶段块里的行：矩形全是 0，不算
  rows.push({
    chev: chev ? (chev.classList.contains('is-blank') ? 'blank' : 'chev') : 'none',
    vol: +(rr.right - vol.getBoundingClientRect().right).toFixed(2),
    dur: +(rr.right - dur.getBoundingClientRect().right).toFixed(2)
  });
});
var recaps = [];
document.querySelectorAll('.tf-recap-bars').forEach(function (bar) {
  var br = bar.getBoundingClientRect();
  var kids = Array.prototype.map.call(bar.children, function (c) {
    return { w: +c.getBoundingClientRect().width.toFixed(1), op: +getComputedStyle(c).opacity };
  });
  var sum = kids.reduce(function (n, k) { return n + k.w; }, 0);
  recaps.push({
    bar: +br.width.toFixed(1),
    sum: +sum.toFixed(1),
    segs: kids.length,
    minOpacity: kids.length ? Math.min.apply(null, kids.map(function (k) { return k.op; })) : 1
  });
});
// 底部留白：滚到底之后，最后一块内容离滚动区底边有多远（应该 ≈ 150px）
var tails = [];
document.querySelectorAll('.tf-body').forEach(function (b) {
  var spacer = parseFloat(getComputedStyle(b, '::after').height) || 0;
  var items = b.querySelectorAll('.tf-step, .tf-recap');
  if (!items.length) return;
  var before = b.scrollTop;
  b.scrollTop = b.scrollHeight;
  var last = items[items.length - 1].getBoundingClientRect();
  var br = b.getBoundingClientRect();
  tails.push({
    spacer: spacer,
    gap: Math.round(br.bottom - last.bottom),   // 最后内容 → 滚动区底边
    overflow: b.scrollHeight > b.clientHeight,
    moved: Math.round(b.scrollTop - before)     // 真的滚上去了吗
  });
  b.scrollTop = before;
});
document.getElementById('align-out').textContent = JSON.stringify({ visible: rows.length, hidden: hidden, rows: rows, recaps: recaps, tails: tails });
</script>
`

const tmp = join(ROOT, 'docs', '.align-probe.html')
const { writeFileSync, readFileSync, unlinkSync } = await import('node:fs')
writeFileSync(tmp, readFileSync(PAGE, 'utf8').replace('</body>', probe + '</body>'))

let dom = ''
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--virtual-time-budget=3000', '--dump-dom', 'file://' + tmp,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
} finally {
  try { unlinkSync(tmp) } catch { /* 已删 */ }
}

const m = /<pre id="align-out">([\s\S]*?)<\/pre>/.exec(dom)
if (!m) { console.log('\n✗ 没能从页面里读到测量结果\n'); process.exit(1) }
const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))

console.log('\n步骤行尾部对齐（真浏览器，' + data.visible + ' 个可见行 / ' + data.hidden + ' 个折叠行）')

ok('量到了可见行', data.visible > 0, data.visible)

const tally = (key) => {
  const t = {}
  for (const r of data.rows) t[r[key]] = (t[r[key]] ?? 0) + 1
  return t
}
const vol = tally('vol')
const dur = tally('dur')
const chev = tally('chev')

ok('每一行都有箭头格子（含占位）', chev.none === undefined, chev)
ok('容量条右边缘只有一条竖线（取值数 1）', Object.keys(vol).length === 1, vol)
ok('时长右边缘只有一条竖线（取值数 1）', Object.keys(dur).length === 1, dur)
console.log('    容量条偏移 ' + JSON.stringify(vol) + '　时长偏移 ' + JSON.stringify(dur))

// ── 轮次小结那条分段条 ──
// 这里只能真浏览器验：段宽是百分比，`box-sizing` 与边框/间距的相互作用
// 决定了它们到底有没有把容器撑破（早先用 flex gap，32 段就多占 62px，尾部被裁）。
console.log('\n轮次小结的分段条（真浏览器，' + data.recaps.length + ' 条）')
ok('量到了小结条', data.recaps.length > 0, data.recaps.length)
const overflow = data.recaps.filter((r) => Math.abs(r.bar - r.sum) > 1)
ok('每条的段宽合计 = 容器宽（没有被撑破、尾部没被裁）', overflow.length === 0,
  overflow.map((r) => r.bar + ' vs ' + r.sum))
const faded = data.recaps.filter((r) => r.minOpacity < 0.99)
ok('没有任何一段是半透明的（不按序号渐隐）', faded.length === 0,
  faded.map((r) => r.minOpacity))

// ── 底部留白 ──
// 右下角常叠着别的插件挂的悬浮胶囊（实测压住右栏底部 ≈136px），
// 内容末尾要留出高度，滚到底时最后一段才能滑到它们上方。
// ⚠️ 这条只有真浏览器能验：滚动容器的底部 padding 在部分浏览器里**不计入可滚动区域**
// （那样留白等于没留）—— 所以用的是内容末尾的占位块，这里断言它真的可滚。
console.log('\n底部留白：最后一个内容能不能继续往上滑')
{
  const tails = data.tails || []
  ok('量到了面板的滚动区', tails.length > 0, tails.length)
  ok('末尾占位块存在（150px）', tails.every((t) => t.spacer === 150), tails.map((t) => t.spacer))
  const over = tails.filter((t) => t.overflow)
  ok('有内容超出一屏的面板', over.length > 0, over.length)
  // 这条就是"留白真的可滚"的证明：占位块若**没算进**可滚动区域，
  // 滚到底时最后一块内容会贴着底边（gap ≈ 它自己的 margin，个位数），
  // 而不是稳定地 ≥150。实测 gap = 158~238（150 的占位 + 各块自己的 margin）。
  ok('滚到底后最后内容在底边上方 ≥150px（留白真的可滚）',
    over.every((t) => t.gap >= 150 && t.gap <= 400), over.map((t) => t.gap))
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
