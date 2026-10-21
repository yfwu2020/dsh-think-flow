export function createViewState() {
  /**
   * 视图开关**落盘**（localStorage）。
   *
   * ⚠️ 真机反馈："主会话运行中、调用工具的时候，隐藏的历史轮次还是会冒出来。"
   * 模块级 store 只挡得住**组件重挂载**，挡不住**模块被重新求值** ——
   * 页面刷新、或客户端 bundle 被重新 import（本插件开发时每次 rebuild 都会触发）
   * 都会让 `viewStore` 回到空对象，于是"隐藏历史"变回显示、"看原文"变回看结构。
   * 这是**用户的设置**，不该因为一次刷新就丢。
   */
  var VIEW_STORE_KEY = 'dsh-think-flow:view'

  /** 只落盘"用户的设置"，**不**落盘每一步的展开状态（临时的，而且会越攒越多）。 */
  function persistedOf(st) {
    return {
      touchedTurn: st.touchedTurn === undefined ? null : st.touchedTurn,
      manual: st.manual === undefined ? 'structure' : st.manual,
      autoTitles: st.autoTitles === true,
    }
  }

  function loadViewStore() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return {}
      var raw = window.localStorage.getItem(VIEW_STORE_KEY)
      if (raw === null) return {}
      var parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch (e) {
      return {}   // 隐私模式 / 配额满 / 内容坏了：当作没有，不影响功能
    }
  }

  function saveViewStore() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      var out = {}
      for (var k in viewStore) {
        if (Object.prototype.hasOwnProperty.call(viewStore, k)) out[k] = persistedOf(viewStore[k])
      }
      window.localStorage.setItem(VIEW_STORE_KEY, JSON.stringify(out))
    } catch (e) { /* 存不下就算了，内存里仍然生效 */ }
  }

  var viewStore = loadViewStore()

  function viewStateOf(sessionId) {
    var k = sessionId || 'no-session'
    var st = viewStore[k]
    if (st === undefined) st = viewStore[k] = {}
    /**
     * ⚠️ 从 localStorage 恢复的条目**只有"用户的设置"**（`persistedOf` 会剥掉临时状态），
     * 所以这里必须把缺的字段逐个补上默认值 —— 少了 `expanded`/`phaseOverride`/`turnOverride`
     * 渲染会**直接抛**（真机表现：刷新后整块面板白掉）。测试抓到的。
     */
    if (st.touchedTurn === undefined) st.touchedTurn = null
    if (st.manual === undefined) st.manual = 'structure'
    /** 自动标题开关。**默认关** —— 它要花模型调用，不该默认替用户花。宿主侧也有一份，以宿主为准。 */
    if (st.autoTitles === undefined) st.autoTitles = false
    if (st.expanded === undefined) st.expanded = {}
    if (st.phaseOverride === undefined) st.phaseOverride = {}
    if (st.turnOverride === undefined) st.turnOverride = {}
    /** 目录（"看更早的轮次"）是否打开。 */
    if (st.dirOpen === undefined) st.dirOpen = false
    /** 正在**单独查看**的那一轮（null = 正常列表）。 */
    if (st.focusTurn === undefined) st.focusTurn = null
    return st
  }

  return {
    VIEW_STORE_KEY, saveViewStore, viewStateOf,
    get store() { return viewStore }, set store(next) { viewStore = next }, loadViewStore,
  }
}
