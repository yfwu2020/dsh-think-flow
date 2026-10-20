/**
 * 思考原文机翻 —— 宿主侧的**缓存 + 去重**，翻译本身交给官方
 * `@deepseek-ai/dsh-experimental-translator`（`ctx.translator`）。
 *
 * 这里只做三件事：
 *   ① 给"一段原文"算一个稳定的缓存键（提供方 + 目标语言 + 原文）
 *   ② 一份有上限的 LRU 缓存，落盘到 `~/.dsh/think-flow/translations.json`
 *   ③ 同一段原文的并发请求合并成一次（面板重渲染会重复问同一段）
 *
 * 为什么不把 `sessionId` 传给 translator：
 *   translator 绑定 session 时会把请求/结果写进**会话日志**，而本插件对会话
 *   是只读的（标题缓存也是自己落盘，不碰会话）。不传 session 的匿名调用
 *   同样走 Bing / Google，也不要求会话处于激活状态 —— 历史回看时正好。
 *
 * ⚠️ 缓存键里**不含**原文本身，只存哈希：一份 4000 字的英文段落不值得在
 *    缓存文件里再存一遍，命不中时原文一定在客户端手里。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * translator 服务里本插件用到的**最小面**。
 *
 * 只声明这两件事，是为了不把 `@deepseek-ai/dsh-experimental-translator` 变成
 * 硬依赖：没装那个 bundle 的 profile 里，插件照样加载，只是「中文」开关禁用。
 */
export interface TranslatorLike {
  /** 单次请求允许的 UTF-16 字符上限（服务自己的配置，可能小于本插件的）。 */
  readonly maxTextChars?: number
  /** 把一次请求补全成完整的翻译规格（提供方 / 源语言默认值）。 */
  resolve(request: {
    text: string
    targetLanguage: string
    sourceLanguage?: string
    provider?: string
  }): unknown
  /** 执行一次翻译；失败会抛（`TranslationError`，带 `code`）。 */
  translate(spec: unknown, signal?: AbortSignal): Promise<string>
}

/** 缓存键：提供方 + 目标语言 + 原文，取 128 位就够（碰撞概率可忽略）。 */
export function translationKey(provider: string, target: string, text: string): string {
  return createHash('sha256')
    .update(`${provider}\u0000${target}\u0000${text}`)
    .digest('hex')
    .slice(0, 32)
}

/** 磁盘缓存的形状（版本号留着以后换格式时识别）。 */
interface CacheFile {
  version: number
  at?: number
  entries?: Record<string, string>
}

/**
 * 有上限的 LRU 翻译缓存（内存 + 落盘）。
 *
 * 落盘**不阻塞翻译**：写入合并到一次 1.5 秒的防抖里，失败只记日志级别地放弃
 * （缓存是派生数据，丢了最多重翻一次）。写入用「临时文件 + rename」，
 * 进程被硬杀时不会留下半截 JSON 把下次启动的缓存读坏。
 */
export class TranslationCache {
  private readonly entries = new Map<string, string>()
  private readonly cap: number
  private readonly file: string
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | undefined
  /** 上次真正写盘的时刻（最短间隔用）。 */
  private lastSaveAt = 0
  private disposed = false

  /**
   * @param file - 缓存文件路径。
   * @param cap - 最多保留多少条（0 = 不限）。按最近使用淘汰。
   */
  constructor(file: string, cap: number) {
    this.file = file
    this.cap = cap
  }

  /** 现在缓存了多少条。 */
  get size(): number {
    return this.entries.size
  }

  /** 读缓存（命中会把它挪到 LRU 的“最近使用”那一端）。 */
  get(key: string): string | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  /** 写缓存。空译文不写 —— 它只该在请求失败时出现，写进去等于永远缓存一个错误。 */
  set(key: string, value: string): void {
    if (this.disposed || value === '') return
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.cap > 0) {
      while (this.entries.size > this.cap) {
        const oldest = this.entries.keys().next().value
        if (oldest === undefined) break
        this.entries.delete(oldest)
      }
    }
    this.dirty = true
    this.schedule()
  }

  /** 从磁盘读回（没有文件 / 文件坏了都当空缓存，不影响翻译）。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as CacheFile | null
      const entries = parsed?.entries
      if (entries === null || typeof entries !== 'object') return
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string' && value !== '') this.entries.set(key, value)
      }
      // 读回来可能比当前上限大（用户调小了 maxTranslationEntries）：裁掉最旧的
      if (this.cap > 0) {
        while (this.entries.size > this.cap) {
          const oldest = this.entries.keys().next().value
          if (oldest === undefined) break
          this.entries.delete(oldest)
        }
      }
    } catch {
      /* 没有缓存文件、JSON 坏了、权限不够：都当作空缓存 */
    }
  }

  /**
   * 到点写盘（防抖 + 最短间隔；`unref` 不拖住进程退出）。
   *
   * 为什么还要**最短间隔**：翻译是跟着流式思考连续发生的，纯防抖在"每 1.5 秒
   * 恰好来一条新译文"时会退化成每 1.5 秒重写整份文件。这里保证两次写盘至少隔
   * 10 秒 —— 缓存是派生数据，最多丢最近 10 秒的命中（下一段会自动补回来）。
   */
  private schedule(): void {
    if (this.saveTimer !== undefined || this.disposed) return
    const wait = Math.max(1500, 10_000 - (Date.now() - this.lastSaveAt))
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush()
    }, wait)
    this.saveTimer.unref?.()
  }

  /** 立刻写盘（写入失败静默；返回的 Promise 只用于卸载时等待）。 */
  async flush(): Promise<void> {
    if (!this.dirty) return
    if (this.saving !== undefined) {
      await this.saving
      return this.flush()
    }
    this.dirty = false
    this.lastSaveAt = Date.now()
    const payload = JSON.stringify({
      version: 1,
      at: Date.now(),
      entries: Object.fromEntries(this.entries),
    } satisfies CacheFile)
    this.saving = (async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, this.file)
      } catch {
        /* 写不进去不影响翻译（下次有改动再试） */
      } finally {
        this.saving = undefined
      }
    })()
    await this.saving
  }

  /** 卸载：停掉定时器、把没写完的刷一遍（之后不再接受写入）。 */
  async dispose(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.flush()
    this.disposed = true
  }
}
