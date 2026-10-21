function fmtK(n) {
  if (n === undefined || n === null) return '0'
  if (n >= 10000) return Math.round(n / 1000) + 'k'
  if (n >= 1000) {
    // 去掉尾随的 .0：3000 显示 3k 而不是 3.0k
    var v = (n / 1000).toFixed(1)
    return (v.slice(-2) === '.0' ? v.slice(0, -2) : v) + 'k'
  }
  return String(n)
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '0s'
  var s = ms / 1000
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's'
  var m = Math.floor(s / 60)
  return m + '′' + Math.round(s - m * 60) + '″'
}

/**
 * 一步花了多久（毫秒）。**一个算法，活跃与已结束共用。**
 *
 * 三个来源，按"离这一步有多近"排序：
 *   ① 这一步自己的收尾事实（`endedAt`）→ 真实时长，定格
 *   ② 状态是 thinking / waiting（**还在跑**）→ 到此刻为止，**每 500ms 自己涨**
 *   ③ 已落地但还没收到自己的收尾（`ready` / `cut`）→ 先用流结束那一刻；
 *      没有就退到快照给的 `elapsedMs`（老数据 / 原型页夹具：值停在快照那一刻）；
 *      再没有就用**这一轮的收尾时刻**（被中断的步正是这样：自己没收尾，轮收了）
 *
 * ⚠️ 活跃那一支必须用 `now`，**不能**照抄宿主 `stepElapsed` 的 `streamEndedAt`：
 *    等工具的时候流早就结束了，用 streamEndedAt 的话等待期间数字会**冻住** ——
 *    而"活跃步要有实时秒数"正是这次要的。
 * ⚠️ ①② 两条主路径**不再读快照的 `elapsedMs`**：面板开着时它要么是空的
 *    （增量长出来的步根本没有这个字段），要么是"连上那一刻"的旧值
 *    （真机反馈："运行的时候步骤后面的秒数不显示了"）。它只留在 ③ 当兜底。
 * @param step - 步骤（客户端本地对象，字段与快照一致）。
 * @param now - 当前时间。
 * @param turnEndedAt - 它所属轮次的收尾时间（没有就 undefined）。
 * @returns 毫秒。
 */
function stepDurMs(step, now, turnEndedAt) {
  if (!step || !step.startedAt) return 0
  if (step.endedAt !== undefined) return Math.max(0, step.endedAt - step.startedAt)
  if (step.status === 'thinking' || step.status === 'waiting') return Math.max(0, now - step.startedAt)
  var end = step.streamEndedAt !== undefined ? step.streamEndedAt
    : step.elapsedMs ? step.startedAt + step.elapsedMs
      : turnEndedAt !== undefined ? turnEndedAt
        : now
  return Math.max(0, end - step.startedAt)
}

/** 截断到 n 个字符（标题要短）。 */
function clip(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/** 目录分节用的日期（本地时区，YYYY-MM-DD）。 */
function dayLabel(ts) {
  var d = new Date(ts || 0)
  var p2 = function (n) { return (n < 10 ? '0' : '') + n }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

/** 目录行上的时间 HH:MM。 */
function hhmm(ts) {
  var d = new Date(ts || 0)
  var p2 = function (n) { return (n < 10 ? '0' : '') + n }
  return p2(d.getHours()) + ':' + p2(d.getMinutes())
}

/**
 * 目录行的标题素材。
 *
 * ⚠️ 实测有 **23%** 的轮次用户消息**不能当标题**：16 轮是「[图片已删除：截屏…]」，
 *    14 轮是「可以」「改」「A」「继续」。在 20 行的尺度上没问题（你记得上下文），
 *    到 133 行"读标题找轮次"这个交互本身就不成立 —— 所以那些**降级**（thin），
 *    不假装它是个标题。
 */
function dirTitle(userText) {
  var t = String(userText === undefined || userText === null ? '' : userText)
  if (t === '') return { text: '（没有用户消息）', thin: true }
  if (t.indexOf('[图片已删除') === 0) return { text: '（图片）', thin: true }
  if (t.length <= 4) return { text: t, thin: true }
  return { text: clip(t, 30), thin: false }
}

/**
 * 查询是不是一个**轮号**（`114` / `第114轮` / `#114` / `114轮`）。
 *
 * 只认"整条查询就是一个轮号"。混了别的字（`reload 114`）就当内容搜索 ——
 * 否则你搜 `2026` 这种年份会被莫名其妙地跳走。
 *
 * @returns 轮号；不是纯轮号时 null。
 */
function parseTurnQuery(q) {
  var s = String(q === undefined || q === null ? '' : q).trim()
  if (s === '') return null
  // 去掉数字和那几个"轮号专用字"之后还剩东西 → 它不是轮号
  if (s.replace(/[0-9]/g, '').replace(/[第轮#\s]/g, '') !== '') return null
  var n = Number(s.replace(/[^0-9]/g, ''))
  return isFinite(n) && n > 0 ? n : null
}

/**
 * 轮次的**展示标签**：模型标题优先，没有就回落到用户消息。
 *
 * 和轮头那两层是同一套规则（README「整轮标题：轮头第二行」）。
 * 目录行、搜索结果行都用它 —— 同一个东西在三个地方不该长得不一样。
 */
function turnLabel(r) {
  var t = String((r && r.title) || '')
  if (t !== '') return { text: clip(t, 30), thin: false }
  return dirTitle(r && r.userText)
}

/**
 * 回落层标题（本轮用户消息）按多少字截。
 *
 * 和步骤标题、整轮标题的提示词同一档（8~18 汉字）—— 取上界 18，末尾补 `…`。
 */
var FALLBACK_TITLE_CHARS = 18

export { fmtK, fmtDur, stepDurMs, clip, dayLabel, hhmm, dirTitle, parseTurnQuery, turnLabel, FALLBACK_TITLE_CHARS }
