#!/usr/bin/env node
/**
 * 中文标题的纯逻辑测试（提示词构造 + 响应解析）。
 *
 * 断言都来自真实会翻车的地方：模型加围栏、多加一句话、条数对不上、
 * 原文过长把一次调用撑爆、步骤多到必须按比例压缩而不是丢步骤。
 */
import {
  allocateChars,
  buildTitleUser,
  clipReasoning,
  contentFingerprint,
  TURN_OUTPUT_CHARS,
  TITLE_SYSTEM,
  DEFAULT_BUDGET,
  parseTitles,
} from '../lib/titles.js'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const step = (n, reasoning, tools = []) => ({ step: n, reasoning, tools })

// ───────────────────── ① 压缩 ─────────────────────

console.log('\n① 原文压缩：留头也留尾')
{
  ok('短文本原样返回', clipReasoning('  hello   world ', 100) === 'hello world')
  const long = 'A'.repeat(500) + 'TAIL'
  const out = clipReasoning(long, 100)
  ok('超长被压到上限附近', out.length <= 110, out.length)
  ok('保留开头', out.startsWith('AAAA'))
  ok('保留结尾（结尾常是结论）', out.endsWith('TAIL'), out.slice(-20))
  ok('中间有省略标记', out.includes('…'))
}

// ───────────────────── ② 预算分配 ─────────────────────

console.log('\n② 预算：步骤多时按比例压，不丢步骤')
{
  const few = [step(1, 'x'), step(2, 'y')]
  ok('步骤少时用满单步上限', allocateChars(few, DEFAULT_BUDGET) === DEFAULT_BUDGET.perStepChars)

  const many = Array.from({ length: 200 }, (_, i) => step(i + 1, 'z'.repeat(3000)))
  const per = allocateChars(many, DEFAULT_BUDGET)
  ok('步骤多时下调单步额度', per < DEFAULT_BUDGET.perStepChars, per)
  ok('不低于下限（否则模型看不出在干嘛）', per >= 80, per)
  ok('总额不超预算', per * many.length <= DEFAULT_BUDGET.totalChars, per * many.length)

  const user = buildTitleUser(many, DEFAULT_BUDGET)
  ok('所有步骤都还在提示词里（不丢步骤）', user.includes('#1｜') && user.includes('#200｜'))
  ok('提示词总长受控', user.length < DEFAULT_BUDGET.totalChars * 1.6, user.length)
}

// ───────────────────── ③ 提示词内容 ─────────────────────

console.log('\n③ 提示词：带上工具名与期望条数')
{
  const steps = [step(1, 'The user wants a plugin', ['bash']), step(2, 'Key slot found', ['cordis_inspect_query'])]
  const user = buildTitleUser(steps)
  ok('说明了总步数', user.includes('共 2 步'))
  ok('带步骤编号', user.includes('#1｜') && user.includes('#2｜'))
  ok('带工具名', user.includes('bash') && user.includes('cordis_inspect_query'))
  ok('没调工具的步骤有明确标注', buildTitleUser([step(1, 'x')]).includes('未调用工具'))
}

// ───────────────────── ④ 解析：正常与容错 ─────────────────────

console.log('\n④ 解析：模型的各种写法')
{
  const good = parseTitles('{"titles":["读懂需求","确认装配方式"]}', 2)
  ok('标准 JSON', good && good.titles.length === 2 && good.titles[0] === '读懂需求')

  const fenced = parseTitles('```json\n{"titles":["读懂需求","确认装配方式"]}\n```', 2)
  ok('带 ```json 围栏', fenced && fenced.titles.length === 2)

  const chatty = parseTitles('好的，结果如下：\n{"titles":["读懂需求","确认装配方式"]}\n希望有帮助。', 2)
  ok('前后多说了话也能取出来', chatty && chatty.titles.length === 2)

  const numbered = parseTitles('{"titles":["1. 读懂需求","2、确认装配方式"]}', 2)
  ok('清洗掉模型自带的编号', numbered && numbered.titles[0] === '读懂需求' && numbered.titles[1] === '确认装配方式',
    numbered && numbered.titles)

  const dotted = parseTitles('{"titles":["读懂需求。","确认装配方式；"]}', 2)
  ok('清洗掉句尾标点', dotted && dotted.titles[0] === '读懂需求' && dotted.titles[1] === '确认装配方式',
    dotted && dotted.titles)
}

// ───────────────────── ⑤ 解析：必须拒绝的情况 ─────────────────────

console.log('\n⑤ 解析：宁可报错，也不能让标题错位')
{
  ok('条数少一条 → 拒绝', parseTitles('{"titles":["只有一条"]}', 2) === undefined)
  ok('条数多一条 → 拒绝', parseTitles('{"titles":["a","b","c"]}', 2) === undefined)
  ok('不是 JSON → 拒绝', parseTitles('这一步是读需求。', 2) === undefined)
  ok('JSON 但字段不对 → 拒绝', parseTitles('{"items":["a","b"]}', 2) === undefined)
  ok('空输出 → 拒绝', parseTitles('', 2) === undefined)
  ok('空标题 → 拒绝', parseTitles('{"titles":["a",""]}', 2) === undefined)
  ok('元素不是字符串 → 拒绝', parseTitles('{"titles":["a",3]}', 2) === undefined)
  ok('零步请求 → 拒绝任意输出', parseTitles('{"titles":[]}', 1) === undefined)
}

// ───────────────────── ⑥ 缓存指纹 ─────────────────────

console.log('\n⑥ 缓存指纹：内容变了要重新生成')
{
  const a = [step(1, 'AAA', ['bash']), step(2, 'BBB', [])]
  const same = [step(1, 'AAA', ['bash']), step(2, 'BBB', [])]
  ok('相同内容指纹一致', contentFingerprint(a) === contentFingerprint(same))
  ok('多了步骤 → 变', contentFingerprint(a) !== contentFingerprint([...a, step(3, 'CCC')]))
  ok('某步原文变长 → 变', contentFingerprint(a) !== contentFingerprint([step(1, 'AAAA', ['bash']), step(2, 'BBB', [])]))
  ok('工具变了 → 变', contentFingerprint(a) !== contentFingerprint([step(1, 'AAA', ['read']), step(2, 'BBB', [])]))
  ok('指纹短而稳定', contentFingerprint(a).length <= 8)
}

console.log('\n⑨ 整轮标题（素材 = 本轮最后的 AI 输出）')
{
  const steps = [step(1, 'AAA', ['bash']), step(2, 'BBB', [])]
  // 提示词里带上素材
  const withOut = buildTitleUser(steps, undefined, [], '这是本轮最后的输出')
  ok('给了输出 → 提示词里有素材块', withOut.includes('本轮最后的输出') && withOut.includes('这是本轮最后的输出'))
  ok('提示词里要了 turnTitle 字段', withOut.includes('turnTitle'))
  // 长度要和步骤标题**同一档**（8~18）：原来写 12~24，生成出来 18~19 字，在 380px 轮头里显得太长
  ok('整轮标题的长度要求和步骤标题同档（8~18）',
    TITLE_SYSTEM.includes('8~18 个汉字，一句话说清这一轮') && !TITLE_SYSTEM.includes('12~24'),
    TITLE_SYSTEM.split('\n').filter((l) => l.includes('8~18') || l.includes('12~24')))
  ok('user 里的长度提示也是 8~18', withOut.includes('8~18 个汉字'))
  ok('没给输出 → 不出现素材块', !buildTitleUser(steps, undefined, [], '').includes('本轮最后的输出'))
  // 素材要裁，别把整篇塞进去
  const huge = buildTitleUser(steps, undefined, [], 'x'.repeat(5000))
  ok('素材被裁到 TURN_OUTPUT_CHARS', huge.includes('x'.repeat(TURN_OUTPUT_CHARS)) && !huge.includes('x'.repeat(TURN_OUTPUT_CHARS + 1)))

  // 解析
  const r1 = parseTitles('{"titles":["一","二"],"notes":{},"turnTitle":"修好隐藏历史的状态丢失"}', 2)
  ok('解析出 turnTitle', r1 !== undefined && r1.turnTitle === '修好隐藏历史的状态丢失', r1)
  const r2 = parseTitles('{"titles":["一","二"],"notes":{}}', 2)
  ok('模型没给 turnTitle → 空串（可选字段，不因此报错）', r2 !== undefined && r2.turnTitle === '', r2)
  const r3 = parseTitles('{"titles":["一","二"],"notes":{},"turnTitle":"  带  空格  "}', 2)
  ok('turnTitle 洗掉多余空白', r3 !== undefined && r3.turnTitle === '带 空格', r3)
  const r4 = parseTitles('{"titles":["一","二"],"notes":{},"turnTitle":"结尾句号。"}', 2)
  ok('turnTitle 去掉结尾句号', r4 !== undefined && r4.turnTitle === '结尾句号', r4)
  const r5 = parseTitles('{"titles":["一","二"],"notes":{},"turnTitle":123}', 2)
  ok('turnTitle 不是字符串 → 空串', r5 !== undefined && r5.turnTitle === '', r5)
  // 条数不对时整条失败（turnTitle 也救不回来）
  ok('titles 条数不对 → 整条 undefined（哪怕 turnTitle 是好的）',
    parseTitles('{"titles":["一"],"notes":{},"turnTitle":"好标题"}', 2) === undefined)
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
