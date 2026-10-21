export function createTranslationController(API) {
  // ───────────────────── 中文机翻（思考原文） ─────────────────────
  /**
   * 思考原文 → 中文，**按段落**翻，翻好一段显示一段。
   *
   * 翻译动作在**宿主**（`POST /translate`），宿主再交给官方
   * `@deepseek-ai/dsh-experimental-translator`（Bing / Google 匿名端点，
   * 不需要 key，也不花模型调用）。客户端只管三件事：
   *   ① 把原文按**空行分段** —— 只有定型的段落才送翻，正在长的那段先显示原文；
   *   ② 渲染时用译文替换已翻好的段落（没翻好的保留原文，不整块等）；
   *   ③ 同一段原文只请求一次（跨轮次、跨会话复用）。
   *
   * 为什么不在宿主把整份思考翻好再推：一次 turn 实测 7 万字，全翻是上百次
   * 网络请求，而用户常常只展开其中一步 —— 翻译量应该跟着**看得见的文字**走。
   *
   * 段落切法与官方 CoT 翻译插件同一套（空行分段 + 超长段落退到空白处切），
   * 这样两边翻出来的边界一致，用户不会在这个面板里看到另一种切法。
   */
  var TRANSLATE_KEY = 'dsh-think-flow:translate'

  var TL_MAX_DEFAULT = 3600

  /** 同时在飞的翻译请求数：太大只会被提供方限流，太小则长段落读起来一顿一顿。 */
  var TL_CONCURRENCY = 2

  /** 译文缓存上限（条 = 段）。面板只活一次页面，内存里够用。 */
  var TL_CACHE_MAX = 3000

  /**
   * 失败标记的上限（条）。
   *
   * 它不是缓存，只是"这段别再自动重试了"的便签；但提供方挂掉时，用户一直
   * 往下读就会一直往里加。给个上限（FIFO 淘汰最旧的），内存别被一张便签拖爆。
   */
  var TL_FAILED_MAX = 600

  /**
   * 「中文」的**三态**（点一下换一个）：
   *   · `'live'`   —— 实时：折叠态那条实时流也翻，翻好一段显示一段
   *   · `'demand'` —— 按需：流式输出时不翻；只有**展开某一步**时才翻这一步
   *   · `'off'`    —— 不翻
   *
   * 旧版本只有布尔（`'on'` / `'off'`），读到 `'on'` 迁移成 `'live'`，
   * 别让用户升级一次就把设置丢了。没设置过 = 默认 `'live'`（服务可用时）。
   */
  function loadTranslatePref() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null
      var raw = window.localStorage.getItem(TRANSLATE_KEY)
      if (raw === 'on') return 'live'          // 旧版布尔：开 → 实时
      if (raw === 'off') return 'off'
      if (raw === 'live' || raw === 'demand') return raw
    } catch (e) { /* 隐私模式 / 配额满：当作没设置过 */ }
    return null
  }

  function saveTranslatePref(mode) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      window.localStorage.setItem(TRANSLATE_KEY, mode)
    } catch (e) { /* 存不下就算了，内存里仍然生效 */ }
  }

  /**
   * 翻译状态（模块级：跨面板重挂载、跨会话共用一份缓存）。
   *
   * `available` 由 `/ping` 的 `translate.available` 决定 —— 它说的是宿主那边
   * 有没有 translator 服务。没有就**禁用**开关，而不是让用户点了没反应。
   */
  var tlStore = {
    pref: loadTranslatePref(),
    available: false,
    checked: false,
    checking: false,
    target: 'zh-CN',
    maxChars: TL_MAX_DEFAULT,
    /** 原文 → 译文（Map 的插入序当 LRU 用）。 */
    cache: new Map(),
    /** 翻译失败过的段落：不自动重试（避免对着一个挂掉的端点反复打）。 */
    failed: new Set(),
    queue: [],
    queued: new Set(),
    inflight: new Set(),
    listeners: new Set(),
  }

  /** 当前模式（没选过 = 实时；可用性另由 {@link tlEnabled} 判）。 */
  function tlMode() {
    var pref = tlStore.pref
    return pref === 'off' || pref === 'demand' || pref === 'live' ? pref : 'live'
  }

  function tlEnabled() {
    return tlStore.available === true && tlMode() !== 'off'
  }

  /** 实时模式：折叠态那条实时流也翻。按需模式只翻展开的那一步。 */
  function tlLive() {
    return tlStore.available === true && tlMode() === 'live'
  }

  function tlNotify() {
    tlStore.listeners.forEach(function (fn) {
      try { fn() } catch (e) { /* 某个订阅者坏了不该拖垮别人 */ }
    })
  }

  function tlSubscribe(fn) {
    tlStore.listeners.add(fn)
    return function () { tlStore.listeners.delete(fn) }
  }

  /**
   * 点一下换下一个状态：关 → 开（按需）→ 实时 → 关。
   *
   * 视觉约定（用户定的）：
   *   · 不亮 = 关
   *   · 常亮 = 开（只在展开某一步时翻译）
   *   · 常亮 + 呼吸 = 实时（流式输出时边写边翻）
   *
   * 从「关」或者「开」进入开着的一档时清掉失败标记 —— 那是用户给的
   * "再试一次"信号。
   */
  function tlCycleMode() {
    var next = tlMode() === 'live' ? 'off' : tlMode() === 'demand' ? 'live' : 'demand'
    tlStore.pref = next
    saveTranslatePref(next)
    if (next !== 'off') tlStore.failed.clear()
    tlNotify()
  }

  /** 问一次宿主：翻译服务在不在、目标语言与单段上限。 */
  function tlCheck() {
    if (tlStore.checked || tlStore.checking) return
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
    tlStore.checking = true
    window.fetch(API + '/ping')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) {
        var t = d && d.translate
        tlStore.checked = true
        tlStore.checking = false
        tlStore.available = !!(t && t.available === true)
        if (t) {
          if (typeof t.target === 'string' && t.target !== '') tlStore.target = t.target
          if (typeof t.maxChars === 'number' && t.maxChars >= 200) {
            tlStore.maxChars = Math.min(t.maxChars, TL_MAX_DEFAULT)
          }
        }
        tlNotify()
      })
      .catch(function () {
        // 问不到（宿主没起 / 断网）：当作不可用，开关保持禁用
        tlStore.checked = true
        tlStore.checking = false
        tlNotify()
      })
  }

  /**
   * 把原文切成**可翻译的片段**（与官方 CoT 翻译插件同一套规则）。
   *
   * · 空行是硬边界：已经定型的段落，翻错也只影响自己；
   * · 超过单次上限的段落退到最近的空白处切（避免把单词劈开），
   *   代理对（emoji）不切一半；
   * · `running` 为真时，最后一段算"还在长"，不送翻 —— 翻一个半句只会得到半句。
   *
   * @param text - 思考原文（保留它原本的空白）。
   * @param running - 末段是否还在流式增长。
   * @param maxChars - 单次请求的字符上限。
   * @returns 片段数组：`text` 原文、`suffix` 片段后的分隔空白、`complete` 能否送翻。
   */
  function tlFragments(text, running, maxChars) {
    var result = []
    var separator = /\r?\n(?:[\t ]*\r?\n)+/g
    var start = 0
    var limit = maxChars > 0 ? maxChars : TL_MAX_DEFAULT
    while (true) {
      var match = separator.exec(text)
      var remaining = text.slice(start, match === null ? text.length : match.index)
      while (remaining.length > limit) {
        var cut = limit
        if (/[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1))) cut -= 1
        var whitespace = remaining.slice(0, cut).search(/\s+\S*$/)
        if (whitespace > 0) cut = whitespace
        var source = remaining.slice(0, cut)
        remaining = remaining.slice(cut)
        var lead = remaining.match(/^\s+/)
        var suffix = lead === null ? '' : lead[0]
        remaining = remaining.slice(suffix.length)
        result.push({ text: source, suffix: suffix, complete: true })
      }
      result.push({
        text: remaining,
        suffix: match === null ? '' : match[0],
        complete: match !== null || !running,
      })
      if (match === null) return result
      start = match.index + match[0].length
    }
  }

  /**
   * 这段文字是不是**本来就说中文**（是就不送翻）。
   *
   * 模型偶尔会用中文思考（尤其被中文提示之后），把中文再送去 zh-CN 只会
   * 白花一次请求、还可能被"改写"一遍。判据故意简单：CJK 字数不少于拉丁字母数，
   * 且至少有一个 CJK —— 英文里夹中文术语的段落仍然送翻。
   */
  function tlIsMostlyChinese(text) {
    var cjk = 0
    var latin = 0
    for (var i = 0;i < text.length;i += 1) {
      var code = text.charCodeAt(i)
      if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk += 1
      else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin += 1
    }
    return cjk > 0 && cjk >= latin
  }

  /**
   * 这段原文还需不需要翻。
   *
   * 「本来就是中文就不翻」只在**目标是中文**时成立：目标语是英文/日文时，
   * 中文原文恰恰是要翻的那一种。
   */
  function tlNeedsTranslation(text) {
    if (/^zh/i.test(String(tlStore.target))) return !tlIsMostlyChinese(text)
    return true
  }

  /** 读译文缓存；命中就把它挪到 LRU 的"最近使用"那一端。 */
  function tlCached(text) {
    var hit = tlStore.cache.get(text)
    if (hit === undefined) return undefined
    tlStore.cache.delete(text)
    tlStore.cache.set(text, hit)
    return hit
  }

  function tlPut(text, translated) {
    if (translated === '') return
    tlStore.cache.delete(text)
    tlStore.cache.set(text, translated)
    while (tlStore.cache.size > TL_CACHE_MAX) {
      var oldest = tlStore.cache.keys().next().value
      if (oldest === undefined) break
      tlStore.cache.delete(oldest)
    }
  }

  /** 记一笔"这段翻失败了"（有上限，FIFO 淘汰最旧的）。 */
  function tlFail(text) {
    tlStore.failed.delete(text)
    tlStore.failed.add(text)
    while (tlStore.failed.size > TL_FAILED_MAX) {
      var oldest = tlStore.failed.values().next().value
      if (oldest === undefined) break
      tlStore.failed.delete(oldest)
    }
  }

  /** 排队翻一段（去重：同一段在队列里 / 在飞 / 已翻好 / 已失败都不再排）。 */
  function tlEnqueue(text) {
    if (text === '' || text.trim() === '') return
    if (tlStore.cache.has(text) || tlStore.failed.has(text)) return
    if (tlStore.queued.has(text) || tlStore.inflight.has(text)) return
    tlStore.queued.add(text)
    tlStore.queue.push(text)
    tlPump()
  }

  function tlPump() {
    while (tlStore.inflight.size < TL_CONCURRENCY && tlStore.queue.length > 0) {
      var text = tlStore.queue.shift()
      tlStore.queued.delete(text)
      if (tlStore.cache.has(text) || tlStore.failed.has(text) || tlStore.inflight.has(text)) continue
      tlStore.inflight.add(text)
      void tlRequest(text)
    }
  }

  function tlRequest(text) {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
      tlStore.inflight.delete(text)
      tlFail(text)
      return Promise.resolve()
    }
    return window.fetch(API + '/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) {
        if (d && d.ok === true && typeof d.text === 'string' && d.text !== '') tlPut(text, d.text)
        else tlFail(text)
      })
      .catch(function () { tlFail(text) })
      .then(function () {
        tlStore.inflight.delete(text)
        tlPump()
        tlNotify()
      })
  }

  /** 把一组片段拼成显示文本：`from` 之前的不翻（只用于"只看尾巴"的场景）。 */
  function tlJoin(fragments, from) {
    var out = ''
    var pending = 0
    for (var i = from;i < fragments.length;i += 1) {
      var f = fragments[i]
      if (f.complete !== true || f.text.trim() === '') {
        out += f.text + f.suffix
        continue
      }
      // 本来就是中文的段落不送翻（见 tlIsMostlyChinese / tlNeedsTranslation）
      if (!tlNeedsTranslation(f.text)) {
        out += f.text + f.suffix
        continue
      }
      var hit = tlCached(f.text)
      if (hit === undefined) {
        pending += 1
        tlEnqueue(f.text)
        out += f.text + f.suffix
      } else {
        out += hit + f.suffix
      }
    }
    return { text: out, pending: pending }
  }

  /**
   * 整段原文 → 可显示文本（已翻的段落用译文，没翻好的保留原文）。
   *
   * @param text - 思考原文。
   * @param running - 末段是否还在增长（在长的那段不送翻）。
   * @returns `text` 显示文本、`pending` 还有几段没翻好。
   */
  function tlCompose(text, running) {
    if (text === undefined || text === null) return { text: '', pending: 0 }
    var plain = String(text)
    if (!tlEnabled() || plain === '') return { text: plain, pending: 0 }
    return tlJoin(tlFragments(plain, running === true, tlStore.maxChars), 0)
  }

  /**
   * 只拼**尾部**约 n 个字符（折叠态那行实时流用）。
   *
   * 为什么不直接 `slice(-n)` 再翻：那会从半句话开始切，翻出来前言不搭后语。
   * 这里从尾部往前凑整段，边界落在段落上。
   */
  function tlTail(text, running, n) {
    var plain = String(text === undefined || text === null ? '' : text)
    var size = n > 0 ? n : 760
    /*
     * 只有**实时**模式才翻折叠态这条尾巴。按需模式（demand）在这里直接返回
     * 原文 —— 流式输出时不发请求，等用户展开某一步，走的是 `tlCompose`。
     */
    if (!tlLive() || plain === '') {
      return { text: plain.length > size ? plain.slice(plain.length - size) : plain, pending: 0 }
    }
    var fragments = tlFragments(plain, running === true, tlStore.maxChars)
    var from = fragments.length
    var total = 0
    while (from > 0) {
      var f = fragments[from - 1]
      total += f.text.length + f.suffix.length
      from -= 1
      if (total >= size) break
    }
    return tlJoin(fragments, from)
  }

  return { loadTranslatePref, tlCheck, tlCompose, tlCycleMode, tlEnabled, tlFragments, tlIsMostlyChinese, tlLive, tlMode, tlNeedsTranslation, tlStore, tlSubscribe, tlTail }
}
