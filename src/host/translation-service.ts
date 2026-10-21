import { PLUGIN_NAME } from './constants.js'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TranslationCache, translationKey, type TranslatorLike } from '../translate.js'
import type { Config } from './config.js'
import { codedError } from './http.js'

/** Optional translator adapter, in-flight request deduplication and cache lifecycle. */
export function createTranslationService(ctx: Context, config: Config) {
  const translationPath = config.translateCachePath !== ''
    ? config.translateCachePath
    : join(homedir(), '.dsh', 'think-flow', 'translations.json')
  const translations = new TranslationCache(translationPath, config.maxTranslationEntries)

  /** translator 服务（官方 experimental bundle）；没装就是 undefined —— 插件照常工作。 */
  function translatorService(): TranslatorLike | undefined {
    return ctx.get('translator') as TranslatorLike | undefined
  }

  /** 单次请求的字符上限：本插件配置与 translator 自己的上限取较小值。 */
  function translateLimit(service: TranslatorLike | undefined): number {
    const own = config.translateMaxChars > 0 ? config.translateMaxChars : 3600
    const theirs = service?.maxTextChars
    return typeof theirs === 'number' && theirs > 0 ? Math.min(own, theirs) : own
  }

  /** 同一段原文的并发请求合并：客户端重渲染会同时问好几遍同一段。 */
  const translating = new Map<string, Promise<string>>()

  /**
   * 翻一段原文（命中缓存直接返回）。
   *
   * 不传 `sessionId`：绑定会话会让 translator 往**会话日志**里写插件记录，
   * 而本插件对会话只读（历史回看时那些会话往往还没激活，绑定了反而会失败）。
   */
  async function translateOne(text: string): Promise<{ text: string; cached: boolean }> {
    const service = translatorService()
    if (service === undefined) throw codedError('TRANSLATION_UNAVAILABLE', '翻译服务未启用')
    const target = config.translateTarget
    const provider = config.translateProvider
    const key = translationKey(provider, target, text)
    const hit = translations.get(key)
    if (hit !== undefined) return { text: hit, cached: true }
    let running = translating.get(key)
    if (running === undefined) {
      running = (async () => {
        const spec = service.resolve({
          text,
          targetLanguage: target,
          ...(provider !== '' ? { provider } : {}),
        })
        const out = await service.translate(spec, AbortSignal.timeout(config.translateTimeoutMs))
        if (typeof out !== 'string') throw codedError('TRANSLATION_INVALID_RESPONSE', '翻译服务返回了非文本')
        translations.set(key, out)
        return out
      })().finally(() => { translating.delete(key) })
      translating.set(key, running)
    }
    return { text: await running, cached: false }
  }

  // 预热翻译缓存（读失败不影响启动）
  void translations.load().catch(() => { })
  ctx.effect(() => () => { void translations.dispose() }, `${PLUGIN_NAME}: translation cache`)



  return { translatorService, translateLimit, translateOne, get cacheEntries() { return translations.size } }
}

export type TranslationService = ReturnType<typeof createTranslationService>
