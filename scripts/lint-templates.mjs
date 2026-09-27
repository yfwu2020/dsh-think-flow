/**
 * 生成器模板里的**反引号**检查。
 *
 * 为什么要有它：gen-*.mjs 里的 CSS / 页面 JS 都写成模板字面量，而注释里顺手写一个反引号
 * 就会**提前闭合模板** —— 报出来的是 "Unexpected identifier"，位置还指向注释中间，
 * 很难看出是反引号干的。这一条把"手滑"变成一句明确的话。
 *
 * 同类还有一件：模板字面量里的反斜杠会被吃掉一层（正则里的转义要写双份）——
 * 那条没法用正则可靠地查，只能靠这条提示记着。
 *
 * 用法：node scripts/lint-templates.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
/*
 * ⚠️ 范围是 gen-*.mjs **加 *-shared.mjs**：共享模块里也放着模板字面量（ring-glow-shared.mjs
 *    的 OPTION_CSS 就是），只查 gen-* 的话它拦不住 —— 实测漏过一次（代价是一个 SyntaxError）。
 */
const files = readdirSync(HERE).filter((f) => f.endsWith('.mjs')
  && (f.startsWith('gen-') || f.endsWith('-shared.mjs')))

/** 抽出所有 `const NAME = \` … \`` 的模板体（非贪婪，够用：这些模板里不嵌套模板）。 */
function templates(src) {
  const out = []
  const re = /const ([A-Z_][A-Z0-9_]*) = `\n([\s\S]*?)\n`\n/g
  let m
  while ((m = re.exec(src)) !== null) out.push({ name: m[1], body: m[2], at: m.index })
  return out
}

let bad = 0
let checked = 0
for (const f of files) {
  const src = readFileSync(join(HERE, f), 'utf8')
  for (const t of templates(src)) {
    checked += 1
    /*
     * 只查**模板文本部分**的反引号 —— `${ … }` 里的反引号是合法的（嵌套模板，
     * gen-turn-nav.mjs 就用了）。做法：扫一遍，遇到 `${` 进插值、遇到 `}` 出来
     * （插值里的嵌套模板自带的 `${}` 会配对，深度仍然平衡），深度为 0 时遇到反引号就是手滑。
     */
    const body = t.body
    let depth = 0
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]
      if (ch === '\\') { i += 1; continue }               // 转义（含 \` ）跳过
      if (ch === '$' && body[i + 1] === '{') { depth += 1; i += 1; continue }
      if (ch === '}' && depth > 0) { depth -= 1; continue }
      if (ch === '`' && depth === 0) {
        const line = body.slice(0, i).split('\n').length
        const ctx = body.split('\n')[line - 1].trim().slice(0, 70)
        console.log('✗ ' + f + ' 的 ' + t.name + ' 模板体里第 ' + line + ' 行有反引号：' + ctx)
        bad += 1
      }
    }
  }
}
if (bad) {
  console.log('\n❌ 有 ' + bad + ' 处反引号 —— 它们会提前闭合模板字面量（改成普通引号或去掉）\n')
  process.exit(1)
}
console.log('✅ 模板字面量检查：' + files.length + ' 个文件（生成器 + 共享模块）、' + checked + ' 个模板，没有手滑的反引号\n')
