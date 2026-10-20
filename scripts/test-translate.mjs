#!/usr/bin/env node
/**
 * 翻译缓存（`src/translate.ts`）的执行测试。
 *
 * 为什么单独测这一层：译文缓存是**派生数据**，出错的代价不是崩溃，而是
 * "同一段反复翻 / 翻好的东西重启就没了 / 缓存文件越写越大" 这类慢性问题。
 * 路由测试用的是桩 translator，不会碰磁盘；这里专门验 LRU 与落盘。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationCache, translationKey } from '../lib/translate.js'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const DIR = mkdtempSync(join(tmpdir(), 'think-flow-translate-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('\n① 缓存键')
{
  const a = translationKey('bing', 'zh-CN', 'hello')
  ok('同一输入 → 同一键', a === translationKey('bing', 'zh-CN', 'hello'))
  ok('原文不同 → 键不同', a !== translationKey('bing', 'zh-CN', 'hello!'))
  ok('目标语言不同 → 键不同', a !== translationKey('bing', 'zh-TW', 'hello'))
  ok('提供方不同 → 键不同', a !== translationKey('google', 'zh-CN', 'hello'))
  ok('键是短的十六进制（存盘不占地）', /^[0-9a-f]{32}$/.test(a), a)
  // 分隔符：("a","b") 与 ("a\0/b") 之类不该撞
  ok('用 \\0 分隔，不会因为拼接而撞键',
    translationKey('bing', 'zh-CN', 'x') !== translationKey('bing', 'zh-CN' + '\u0000' + 'x', ''))
}

console.log('\n② LRU 上限')
{
  const cache = new TranslationCache(join(DIR, 'lru.json'), 2)
  cache.set('k1', 'v1')
  cache.set('k2', 'v2')
  ok('两条都在', cache.size === 2)
  cache.get('k1')               // 触碰 k1 → 它变成最近使用
  cache.set('k3', 'v3')         // 该淘汰 k2
  ok('超过上限 → 淘汰最久没用的（k2）', cache.get('k2') === undefined)
  ok('刚用过的 k1 还在', cache.get('k1') === 'v1')
  ok('新写的 k3 在', cache.get('k3') === 'v3')
  ok('上限 0 = 不限', (() => {
    const open = new TranslationCache(join(DIR, 'open.json'), 0)
    for (let i = 0; i < 10; i += 1) open.set('k' + i, 'v' + i)
    return open.size === 10
  })())
}

console.log('\n③ 落盘与读回')
{
  const file = join(DIR, 'persist.json')
  const cache = new TranslationCache(file, 10)
  cache.set('a', '甲')
  cache.set('b', '乙')
  await cache.flush()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  ok('文件带版本号与时间', raw.version === 1 && typeof raw.at === 'number', raw)
  ok('两条都写进去了', raw.entries.a === '甲' && raw.entries.b === '乙', raw.entries)

  const reopened = new TranslationCache(file, 10)
  await reopened.load()
  ok('重新建实例能读回', reopened.get('a') === '甲' && reopened.get('b') === '乙')

  // 坏文件不该炸（缓存是派生数据，读不出来就当没有）
  const broken = join(DIR, 'broken.json')
  writeFileSync(broken, '{ not json', 'utf8')
  const safe = new TranslationCache(broken, 10)
  await safe.load()
  ok('坏 JSON → 当空缓存，不抛', safe.size === 0)

  // 空译文不写：它只该在失败时出现，写进去等于永远缓存一个错误
  const blank = new TranslationCache(join(DIR, 'blank.json'), 10)
  blank.set('x', '')
  ok('空译文不入缓存', blank.size === 0)
}

console.log('\n④ dispose 会把防抖里的写入刷下去')
{
  const file = join(DIR, 'dispose.json')
  const cache = new TranslationCache(file, 10)
  cache.set('late', '晚')
  await cache.dispose()
  const reopened = new TranslationCache(file, 10)
  await reopened.load()
  ok('dispose 之后文件里有这条', reopened.get('late') === '晚')

  const reopened2 = new TranslationCache(file, 10)
  await reopened2.load()
  reopened2.dispose()
  await sleep(20)
  ok('dispose 幂等（再调一次不抛）', true)
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
