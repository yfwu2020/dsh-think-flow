// ────────────────────────────── 数据 ──────────────────────────────

/**
 * 一份轨迹的客户端副本。
 * 快照只带"当前步"的原文尾部，其余步骤按需走 /step 拉取。
 */
function emptyState() {
  // `state` 来自宿主：live / hydrated / empty / unreadable。
  // 早先只有一个 known 布尔，客户端只能把"读不到"说成"还没开始"（说反了）。
  // `index` = 宿主的**全轮骨架**（比 turns 长得多）：目录"看更早的轮次"读它。
  return { connected: false, sessionId: '', turns: [], index: [], serverTime: 0, state: undefined }
}

/**
 * 把宿主推来的一条 change 应用到本地副本上。
 *
 * 关键约定：**状态照抄宿主**，客户端不推导。
 * 之前这里自己推状态（5 处赋值），和宿主的 stepStatus 形成两个真相源，
 * 结果是每一步跑完仍显示"正在生成…"（真机复现）。
 */
function applyChange(state, c) {
  if (!c || !state.turns) return
  var turn = null
  for (var i = 0;i < state.turns.length;i += 1) if (state.turns[i].turn === c.turn) turn = state.turns[i]
  if (!turn) {
    if (c.k !== 'turn') return
    turn = { turn: c.turn, steps: [], startedAt: Date.now() }
    state.turns.push(turn)
  }
  if (c.k === 'turn') {
    // 收尾事实随改动一起下发，照抄即可
    if (c.endedAt !== undefined) turn.endedAt = c.endedAt
    if (c.interrupted !== undefined) turn.interrupted = c.interrupted
    if (c.endReason !== undefined) turn.endReason = c.endReason
    // 本轮用户说了什么（轮标题的默认素材）—— 实时事件里也会来，不用等下次快照
    if (c.userText !== undefined) turn.userText = c.userText
    return
  }
  var step = null
  for (var j = 0;j < turn.steps.length;j += 1) if (turn.steps[j].step === c.step) step = turn.steps[j]
  if (!step) {
    step = { step: c.step, reasoningTokens: 0, textTokens: 0, tools: [], status: 'thinking', startedAt: Date.now(), reasoningText: '' }
    turn.steps.push(step)
    turn.steps.sort(function (a, b) { return a.step - b.step })
  }
  if (c.k === 'reasoning') {
    step.reasoningText = (step.reasoningText || '') + c.text
    // ⚠️ **覆盖**而不是累加：宿主下发的是这一步**累计的 Token 数**（见 TraceChange 的说明）。
    //    两端各取一次整必然漂（每个 chunk 分别取整会积累误差），所以口径只有一个 —— 宿主的。
    if (c.tokens !== undefined) step.reasoningTokens = c.tokens
  } else if (c.k === 'text') {
    step.textTail = ((step.textTail || '') + c.text).slice(-2000)
    // 开头那一段也留着：**行标题的摘要取的是第一句**，而 textTail 是尾部
    // （正文一超过 2000 字，开头就没了）。见 stepOwnTitle。
    step.textHead = ((step.textHead || '') + c.text).slice(0, 160)
    if (c.tokens !== undefined) step.textTokens = c.tokens
  } else if (c.k === 'tool') {
    step.tools = step.tools || []
    if (!step.tools.some(function (t) { return t.id === c.tool.id })) step.tools.push(c.tool)
  } else if (c.k === 'tool-end') {
    var list = step.tools || []
    for (var k = 0;k < list.length;k += 1) {
      if (list[k].id === c.id) {
        list[k].endedAt = c.endedAt
        list[k].resultTokens = c.resultTokens
        // 失败态照抄宿主（`{ code?, name?, text }`）；成功时 c.failed 是 undefined，
        // **不能**把已有的 failed 抹掉 —— 事件可能比快照晚到/重放。
        if (c.failed !== undefined) list[k].failed = c.failed
      }
    }
  } else if (c.k === 'gap') {
    step.streamGap = true
  }
  // 状态只有一个来源：宿主带下来的权威值
  if (c.status !== undefined) step.status = c.status
  /**
   * 时间事实同理，照抄宿主的 —— 但**时长**是客户端自己算的（`stepDurMs`）：
   * 只有按 `now` 现算，活跃步的秒数才会每 500ms 自己涨。宿主只给事实。
   */
  if (c.timing) {
    step.startedAt = c.timing.startedAt
    step.streamEndedAt = c.timing.streamEndedAt
    step.endedAt = c.timing.endedAt
  }
}

// ────────────────────────────── 主组件 ──────────────────────────────

/**
 * 面板的**交互状态**（视图开关 + 哪步展开、哪个阶段/轮次折叠）放在**模块级**、
 * 按会话存，不放在组件 state 里。
 *
 * ⚠️ 真机踩过两次：
 *   ① 实时生成时"隐藏的历史轮次又冒出来、看原文又变回看结构" —— 外壳是
 *      `key={sessionId}`，一旦重挂载（sessionId 短暂变空、或侧栏把标签内容卸了又挂），
 *      useState 全部回到默认值。
 *   ② 切到别的会话再切回来，刚才展开的组/步骤、选的视图**全没了**。
 * 这些都是**用户在这一个会话里的操作痕迹**，不该跟着组件的挂载周期走。
 */
/**
 * 用户是不是"贴在底部"（决定要不要跟随）。
 *
 * 留 80px 容差：滚动是离散的，差几个像素不该算"滚走了"。
 * 抽成纯函数是为了能测 —— 本地没有 React 的 UMD 构建，跑不了"真组件 + 真 DOM"。
 *
 * @param scrollHeight - 内容总高。
 * @param scrollTop - 当前滚动位置。
 * @param clientHeight - 可视高度。
 * @returns 贴底时 true。
 */
function isPinned(scrollHeight, scrollTop, clientHeight) {
  return scrollHeight - scrollTop - clientHeight < 80
}

/**
 * 要不要跟随（纯函数，便于单测）。
 *
 * 三条规则：
 *   · 没贴底 → 不跟（不抢用户的滚动条）
 *   · 这一轮还在生成 → 跟
 *   · 这一轮**跑完了**，但本次挂载里实时看过它 → 也跟
 *     （收尾小结正是"跑完那一刻"才出现的，用 running 当条件会漏掉它 —— 真机反馈
 *      "最后一步出总结的时候没有跟随"）
 *   · 其余（打开历史会话、本次没实时看过）→ 不跟，停在顶部
 *
 * @param pinned - 用户是否贴底。
 * @param running - 当前轮是否还在生成。
 * @param liveTurn - 本次挂载里实时看过的那一轮号（没看过是 null）。
 * @param curTurn - 当前轮号（没有轮次是 null）。
 * @returns 要跟时 true。
 */
function shouldFollow(pinned, running, liveTurn, curTurn) {
  if (pinned !== true) return false
  if (running === true) return true
  return curTurn !== null && curTurn !== undefined && liveTurn === curTurn
}

export { emptyState, applyChange, isPinned, shouldFollow }
