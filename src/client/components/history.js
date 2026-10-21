import { dayLabel, hhmm, parseTurnQuery, turnLabel } from '../rules/format.js'

/** Render the local turn directory and search results. */
export function createHistoryRenderer(React, { searchRef, matchTurns, indexOfTurn, skel, turns, openFocus, snippetNodes }) {
  /** 目录里的一行：轮号（悬挂页边）/ 时间 / 标题 / 步数。 */
  function renderDirRow(r, inWindow) {
    var title = turnLabel(r)
    return React.createElement('button', {
      className: 'tf-dir-row', key: 'r' + r.turn, type: 'button',
      title: '第 ' + r.turn + ' 轮（' + r.steps + ' 步'
        + (inWindow ? '' : '，打开时从日志读') + '）',
      onClick: function () { openFocus(r.turn) },
    },
      React.createElement('span', { className: 'tf-dir-no' }, String(r.turn)),
      React.createElement('span', { className: 'tf-dir-time' }, hhmm(r.startedAt)),
      React.createElement('span', { className: 'tf-dir-title' + (title.thin ? ' is-thin' : '') }, title.text),
      React.createElement('span', { className: 'tf-dir-steps' }, r.steps + ' 步'))
  }

  /**
     * 搜索结果。
     *
     * 两件事：
     *   · **查询是个轮号**时（`49` / `第49轮` / `#49`），最上面一条「跳到这一轮」；
     *   · 其余是**文本命中**：用户消息或轮次标题里含这个词的轮次。
     * 两者都是轮次，所以直达行命中的那一轮**不会**在下面再出现一次。
     */
  function renderSearch() {
    var s2 = searchRef.current
    var kids = []
    var turnQ = parseTurnQuery(s2.q)
    var hits = matchTurns(s2.q) || []
    /**
     * 查询本身是个轮次号时，把那一轮也当**一条普通结果**加进来。
     *
     * ⚠️ 它原来是一条**特制的行**（带底色、带「跳到这一轮」标签、固定排在最前面）——
     *    用户要求去掉："结果不要加上跳到这一轮，处理应该和搜索其他一样"。
     *    现在它走**同一套行**（renderHit）、排**同一套顺序**（骨架顺序，最新在前），
     *    只是没有命中上下文可印（数字不是从正文里搜出来的），所以不带 snippet 那一行。
     */
    var jumpMeta = turnQ === null ? null : indexOfTurn(turnQ)
    if (jumpMeta !== null) {
      /*
       * ⚠️ 两条用户定的规则，别改回去：
       *   ① **优先显示轮次** —— 打数字时那一轮排最前，不混在文本命中里按顺序排；
       *   ② **不重复** —— 它要是也文本命中了，就**用文本那条**（带真 snippet）
       *      挪到最前，而不是另造一条。
       */
      var numHit = null
      var rest = []
      for (var d2 = 0;d2 < hits.length;d2 += 1) {
        if (hits[d2].row.turn === jumpMeta.turn) numHit = hits[d2]
        else rest.push(hits[d2])
      }
      if (numHit === null) numHit = { row: jumpMeta, inTitle: false, snippet: '', noSnip: true }
      hits = [numHit].concat(rest)
    }
    var total = hits.length
    kids.push(React.createElement('div', { className: 'tf-dir-count', key: 'c' },
      total === 0 ? '没有匹配' : '找到 ' + total + ' 轮'))
    if (total === 0) {
      // 空态是指路，不是情绪：说清搜的是哪两样，再给下一步
      /*
       * ⚠️ 这里原来写的是 `'搜的是**用户消息**和**轮次标题**。'` —— 那两个星号是
       *    **markdown 语法**，而这里是纯文本节点，渲染出来就是四个字面星号。
       *    空态是指路，指路的话里不该混进排版符号。
       */
      kids.push(React.createElement('div', { className: 'tf-dir-none', key: 'n' },
        '搜的是用户消息和轮次标题。换个词，或用轮次号（比如 49）。'))
    }
    var list = []
    for (var i = 0;i < hits.length;i += 1) list.push(renderHit(hits[i], i))
    kids.push(React.createElement('div', { className: 'tf-dir-list', key: 'l' }, list))
    return kids
  }

  /**
     * 一条命中行。
     *
     * ⚠️ 必须写成**函数**（命中项当参数传），不能在 for 里直接建元素：
     *    `var h = hits[i]` 是函数作用域，所有 onClick 捕获的是**同一个** `h`，
     *    循环结束后它指向最后一条 —— 点第 1 条会跳到第 50 条那一轮。
     *    这个 bug 渲染出来完全看不出来（行是对的），只有点下去才暴露。
     *    真机端到端抓到的。
     */
  function renderHit(hit, i) {
    var r = hit.row
    var label = turnLabel(r)
    var q = searchRef.current.q
    // 标签显示的是哪一段原文（模型标题优先，回落用户消息 —— 和 turnLabel 一致）
    var title = String(r.title || '')
    var labelSrc = title !== '' ? title : String(r.userText || '')
    var matchedSrc = hit.inTitle ? title : String(r.userText || '')
    /**
     * 命中的那段**就是标签本身**时，直接把标签里的命中词高亮，**不再多印一行 snippet**。
     *
     * 不加这条的话，短消息 + 回落标题的场景会把同一句话印两遍
     * （真机截图里一眼就看出来了：上行是它、下行还是它）。
     * 高亮不能丢 —— 它是"为什么命中"的唯一线索，所以挪到标签里。
     */
    var inlineHit = labelSrc === matchedSrc && labelSrc.length <= 30
    var labelKids = inlineHit ? snippetNodes(label.text, q) : label.text
    /*
     * 查询本身是个轮次号、且正好是这一轮 → **轮次号也加底色**（和正文命中同一个 mark）。
     * 用户定的："匹配的轮次号上也要加上底色" —— 否则那一行是"凭空出现"的，
     * 看不出它为什么在结果里（数字不是从正文里搜出来的，没有 snippet 可高亮）。
     */
    var turnQ = parseTurnQuery(q)
    var numHit = turnQ !== null && Number(r.turn) === turnQ
    var kids = [
      // 上行和目录行**同一套信息**（轮号/时间/标题/步数）—— 结果就是轮次
      React.createElement('div', { className: 'tf-hit-h', key: 'h' },
        React.createElement('span', { className: 'tf-dir-no' + (numHit ? ' is-num-hit' : '') },
          numHit ? React.createElement('mark', null, String(r.turn)) : String(r.turn)),
        React.createElement('span', { className: 'tf-dir-time' }, hhmm(r.startedAt)),
        React.createElement('span', { className: 'tf-dir-title' + (label.thin ? ' is-thin' : '') }, labelKids),
        React.createElement('span', { className: 'tf-dir-steps' }, r.steps + ' 步')),
    ]
    // 标签没盖住命中那一段（长消息 / 标题与消息不同）→ 才需要下面这行上下文
    // ⚠️ noSnip：轮次号那条没有命中上下文（数字不是从正文里搜出来的），
    //    印一行空 snippet 只会多出一条空白。
    if (!inlineHit && hit.noSnip !== true) {
      kids.push(React.createElement('div', { className: 'tf-hit-snip', key: 's' }, snippetNodes(hit.snippet, q)))
    }
    return React.createElement('button', {
      className: 'tf-hit', key: 'h' + i, type: 'button',
      onClick: function () { openFocus(r.turn) },
    }, kids)
  }

  /**
     * 目录："看更早的轮次"。
     *
     * 数据是 `st.index`（**全轮骨架**），不是 `turns`（正文窗口）——
     * 面板渲染得动 20 轮，目录里有全部轮次。这就是这次改动的全部意义。
     */
  function renderDir() {
    var idx = skel
    var s2 = searchRef.current
    var kids = []
    /*
     * ⚠️ 这里原来有两样东西，现在**都搬走了**（用户："去掉图1这一行"）：
     *    · **目录头那一行**（`全部 N 轮，最新在上面` + `回到第 N 轮`）——
     *      信息变成第二行的「共 N 轮」，出口变成第二行的「返回」
     *    · 目录自己的搜索框（`.tf-dir-s` / `.tf-dir-q`）—— 搬进第二行的标题那一格
     * 所以目录正文现在**直接从日期分节开始**，顶上不再有一条横线。 */
    // 只要**有查询**就进搜索视图（本地算，没有"等结果"这回事）
    if (String(s2.q).trim() !== '') {
      kids.push(renderSearch())
      return kids
    }
    // 正文窗口里有哪些轮（其余的打开时才从日志读）
    var inWindow = {}
    for (var w = 0;w < turns.length;w += 1) inWindow[turns[w].turn] = true
    var cold = 0
    for (var c = 0;c < idx.length;c += 1) if (!inWindow[idx[c].turn]) cold += 1
    var rows = []
    var lastDay = ''
    var seenEdge = false
    for (var i = 0;i < idx.length;i += 1) {
      var r = idx[i]
      var day = dayLabel(r.startedAt)
      if (day !== lastDay) {
        lastDay = day
        var n = 0
        for (var q2 = 0;q2 < idx.length;q2 += 1) if (dayLabel(idx[q2].startedAt) === day) n += 1
        rows.push(React.createElement('div', { className: 'tf-dir-day', key: 'd' + day },
          React.createElement('b', null, day),
          React.createElement('span', null, n + ' 轮')))
      }
      // 边界：正文窗口里的轮在上，要靠日志读的在下面
      if (!seenEdge && i > 0 && inWindow[idx[i - 1].turn] && !inWindow[r.turn]) {
        seenEdge = true
        rows.push(React.createElement('div', { className: 'tf-dir-edge', key: 'edge' },
          React.createElement('span', null, '以下 ' + cold + ' 轮更早（打开时才从日志读）')))
      }
      rows.push(renderDirRow(r, inWindow[r.turn] === true))
    }
    kids.push(React.createElement('div', { className: 'tf-dir-list', key: 'l' }, rows))
    return kids
  }

  return renderDir
}
