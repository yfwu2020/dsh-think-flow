import CSS from './styles.css'

export function createStyles() {
  // ────────────────────────────── 小工具 ──────────────────────────────

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  // ────────────────────────── 样式的一生（一份 + 引用计数） ──────────────────────────
  //
  // 这里踩过一个"看着像样式丢了"的坑，值得写清楚（2026-09-28 真机截图）：
  //
  // 原来的写法是每次 apply「先摘掉同 id 的旧元素，再挂一个新的」，dispose 时
  // `style.remove()`。单代实例下没问题 —— 可**同一页面里经常同时存在两代实例**：
  // 热重载是"新实例先 apply、旧实例稍后 dispose"，中间那段时间两代都在。
  // 于是谁 dispose 谁摘掉**文档里那一个**，而那个元素是**最后 apply 的实例**挂的：
  // 幸存实例就变成"有 DOM、没样式"——整块面板退回浏览器默认样式：
  // 按钮带边框与灰底（`#N`、`▸` 都变成小方块）、分组块没有底色、
  // 容量条整条消失、`.tf-phase-meta` 不再被 `margin-left:auto` 推到行尾。
  // 用户截图里就是这一套（而他看到的"问题"就是它）。
  //
  // 所以改成：**全页面只维护一个样式元素 + 引用计数**（计数挂在 window 上，跨模块实例共享）。
  //   · apply / 面板挂载 → `injectCss()`：元素在就**改写内容**（永远最新一份赢），不在就补挂；
  //   · dispose / 面板卸载 → `releaseCss()`：计数归零才真的摘掉；
  //   · 面板在屏幕上时周期性 `ensureCss()`：元素被别处摘掉也能自愈。

  /** 样式元素的 id：全页面唯一，跨代实例靠它认出同一个元素。 */
  var CSS_ID = 'dsh-think-flow-css'

  /**
   * 引用计数器（挂在 window 上）。
   *
   * ⚠️ **不能**放模块级：bundle 被重新求值后是新模块作用域，旧实例 dispose 时
   * 得和新实例对话 —— 两代之间只有 window 是共享的。
   * @returns 计数器对象。
   */
  function cssRef() {
    var w = window
    var ref = w.__dshThinkFlowCss
    if (!ref || typeof ref !== 'object') { ref = { count: 0 }; w.__dshThinkFlowCss = ref }
    return ref
  }

  /** 文档里那一个样式元素（不在文档里返回 null）。 */
  function cssElInDoc() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null
    return document.getElementById(CSS_ID) || null
  }

  /**
   * 取一份样式引用：保证文档里有这个元素、内容是当前 CSS，计数 +1。
   * @returns 这个样式元素（dispose 时交回 {@link releaseCss}）。
   */
  function injectCss() {
    var ref = cssRef()
    var style = cssElInDoc()
    if (style === null) {
      style = el('style')
      style.id = CSS_ID
      document.head.appendChild(style)
    }
    // 后 apply 的实例就是**当前在跑的那份代码**，所以永远让它赢（改写，不另挂一个）
    style.textContent = CSS
    ref.count += 1
    return style
  }

  /**
   * 交回一份样式引用：只有最后一个用的人真的摘掉。
   * @param style - {@link injectCss} 返回的那个元素。
   */
  function releaseCss(style) {
    var ref = cssRef()
    ref.count = Math.max(0, ref.count - 1)
    if (ref.count > 0) return
    // 只摘自己挂的那个；它可能早被新一代接管（那它已在文档外，摘是空操作）
    if (style && typeof style.remove === 'function') style.remove()
    else if (style && style.parentNode && typeof style.parentNode.removeChild === 'function') style.parentNode.removeChild(style)
  }

  /** 自愈：元素不在文档里就补挂（**不计引用** —— 补挂的还是当前这份 CSS）。 */
  function ensureCss() {
    if (cssElInDoc() !== null) return
    var style = el('style')
    style.id = CSS_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }

  return { CSS, CSS_ID, injectCss, releaseCss, ensureCss }
}
