export function createHostNavigation() {
  // ─────────────────── 主会话定位（点轮次号 → 跳到那一轮） ───────────────────
  //
  // 用户在面板第二行点「第 N 轮」→ **主会话**（对话 / 轨迹）滚到**这一轮的用户消息**。
  //
  // 两个页面各有一套落位机制，所以这里是两条路：
  //   · **对话页**：宿主自己就有「轮次导航」刻度（每轮一枚 `button[data-index]`，
  //     aria-label 是「跳转到第 N 轮」/「加载并跳转到第 N 轮」）—— 点那一枚 = 走宿主的
  //     动作：**没载入的轮次它会自己把历史翻到那儿再落位**，落位点正是这一轮的起点
  //     （用户消息，离视口顶 24px）。所以这一路我们只负责"把刻度找出来点掉"。
  //   · **轨迹页**：宿主没有跳转能力。它还是**分页 + 虚拟滚动**的：屏幕外的行不在 DOM 里、
  //     更早的历史根本没载入，行高又不齐（工具行 30px、消息行更高、折叠摘要 20px），
  //     算不出偏移。只能自己来：**读着走** —— 按渲染出来的轮次边界二分收窄滚动位置，
  //     收不动了就点一次「加载更早的历史」把窗口往前扩一页（见 `locateInTrajectory`）。
  //
  // ⚠️ **不替用户切视图**：用户说的是"主会话如果是在对话页面 / 轨迹页面"，在哪个页面
  //    就在哪个页面里定位；两个都不是（他在看别的视图）时什么都不做 —— 硬切视图会
  //    把他正在看的东西抢走。
  //
  // ⚠️ 两个页面都只在**没有渲染出目标行**时才动用"翻历史"那套：已经渲染出来的行直接滚，
  //    一个字节的历史都不多取（真机上"点一下就翻掉几万像素"是会被察觉的）。

  /**
   * 宿主客户端 ctx（`apply` 时记下来）。
   *
   * 为什么放模块级：定位是**点击回调**触发的，回调在组件里，而组件拿不到 ctx
   * （它是 `apply` 的参数）。只读用，不参与生命周期。
   */
  var ctxRef = null

  /** 定位动作挂着的定时器：重新定位 / 面板卸载时要能全部取消（否则回调落在死节点上）。 */
  var locateTimers = []

  /** 延后一小步跑（可被 `locateStop()` 取消）。 */
  function locateAfter(fn, ms) {
    var id = setTimeout(function () {
      var i = locateTimers.indexOf(id)
      if (i >= 0) locateTimers.splice(i, 1)
      fn()
    }, ms)
    locateTimers.push(id)
    return id
  }

  /** 取消所有在飞的定位动作。 */
  function locateStop() {
    for (var i = 0;i < locateTimers.length;i += 1) clearTimeout(locateTimers[i])
    locateTimers = []
  }

  /** 主会话的内容区（对话 / 轨迹共用的那一个容器）。 */
  function mainContent() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
    return document.querySelector('[data-conversation-content]')
  }

  /**
   * 主会话现在显示的是哪个视图。
   *
   * 靠**视图自己的根节点**判断，不读标签文字：标签是本地化的（「对话」/「轨迹」），
   * 而 `[data-trajectory-scroll]` / `[data-chat-turn]` 是宿主给视图的稳定标记。
   * 两个视图是互斥挂载的（切走就卸载），所以在场的就是当前这个。
   * @param content - `mainContent()` 的结果。
   * @returns 'chat' | 'trajectory' | null（null = 没开会话 / 认不出来）。
   */
  function mainViewOf(content) {
    if (content === null || content === undefined || typeof content.querySelector !== 'function') return null
    if (content.querySelector('[data-trajectory-scroll]') !== null) return 'trajectory'
    if (content.querySelector('[data-chat-turn], [data-chat-flow]') !== null) return 'chat'
    return null
  }

  /** 轮询到一个条件成立为止（超时回 null）。`check()` 返回真值即结束。 */
  function locateWaitFor(check, timeoutMs, done) {
    var deadline = Date.now() + timeoutMs
    function poll() {
      var value = null
      try { value = check() } catch (e) { value = null }
      if (value) { done(value); return }
      if (Date.now() >= deadline) { done(null); return }
      locateAfter(poll, 80)
    }
    poll()
  }

  /** 宿主会话控制器（拿不到返回 null —— 宿主版本不同也不该把定位整条打死）。 */
  function sessionOf(sessionId) {
    if (!ctxRef || typeof ctxRef.get !== 'function' || !sessionId) return null
    var sessions = null
    try { sessions = ctxRef.get('sessions') } catch (e) { sessions = null }
    if (!sessions || typeof sessions.binding !== 'function') return null
    var binding = null
    try { binding = sessions.binding(sessionId) } catch (e) { binding = null }
    return binding && binding.session ? binding.session : null
  }

  // ── 对话页 ──────────────────────────────────────────────────────────

  /**
   * 第 n 轮在对话页里的那一行。
   *
   * 优先**用户消息**那一行（这一轮的起点就是它）；这一轮以别的节点开头
   * （系统发起的轮 / 以上下文开头的轮）时退而取第一条属于它的行。
   * @param content - 主会话内容区。
   * @param n - 轮号。
   * @returns 元素或 null（这一轮还没渲染）。
   */
  function chatTurnRow(content, n) {
    if (!content || typeof content.querySelectorAll !== 'function') return null
    var rows = content.querySelectorAll('[data-chat-turn="' + n + '"]')
    var first = null
    for (var i = 0;i < rows.length;i += 1) {
      if (first === null) first = rows[i]
      if (rows[i].dataset && rows[i].dataset.chatFlowKind === 'user') return rows[i]
    }
    return first
  }

  /** 刻度上的轮号：宿主下发的 aria-label 里唯一的那个数（本地化无关）。 */
  function turnOfMark(mark) {
    if (!mark || typeof mark.getAttribute !== 'function') return null
    var label = mark.getAttribute('aria-label')
    if (typeof label !== 'string') return null
    var m = /(\d+)/.exec(label)
    return m === null ? null : Number(m[1])
  }

  /** 在一组刻度里找代表第 n 轮的那一枚。 */
  function markFor(marks, n) {
    if (!marks) return null
    for (var i = 0;i < marks.length;i += 1) if (turnOfMark(marks[i]) === n) return marks[i]
    return null
  }

  /**
   * 宿主「轮次导航」里代表第 n 轮的那一枚刻度。
   *
   * 刻度是**虚拟滚动**的（固定 10px 间距，只渲染视野里那几十枚），所以长会话里目标
   * 常常不在 DOM 里 —— 那就先把轨道滚到目标附近再取一次。目标下标这么推：刻度按轮号
   * 升序、一轮一枚，用两枚已知刻度线性外推；间距**量出来**（不写死 10px —— 那是宿主的
   * 内部常量，改了不该让这里失效）。
   *
   * ⚠️ 窄容器下宿主的刻度轨道是 `display:none`（容器查询），这时轨道**根本不渲染刻度**
   *    （虚拟滚动的可视高度是 0），量也量不到 —— 直接返回 null，交给"自己翻历史"那条兜底。
   * @param content - 主会话内容区。
   * @param n - 轮号。
   * @returns 刻度元素或 null。
   */
  function railMarkOf(content, n) {
    if (!content || typeof content.querySelectorAll !== 'function') return null
    var marks = content.querySelectorAll('button[data-index]')
    if (marks.length === 0) return null
    var hit = markFor(marks, n)
    if (hit !== null) return hit
    var box = marks[0].parentElement
    var scroller = box ? box.parentElement : null
    if (!scroller || typeof scroller.getBoundingClientRect !== 'function') return null
    var rect = scroller.getBoundingClientRect()
    if (!rect || !rect.height) return null
    var a = marks[0]
    var b = marks[marks.length - 1]
    if (typeof a.getBoundingClientRect !== 'function' || typeof b.getBoundingClientRect !== 'function') return null
    var ia = Number(a.getAttribute('data-index'))
    var ib = Number(b.getAttribute('data-index'))
    var ta = turnOfMark(a)
    var tb = turnOfMark(b)
    if (ia !== ia || ib !== ib || ib === ia || ta === null || tb === null || tb === ta) return null
    var pitch = (b.getBoundingClientRect().top - a.getBoundingClientRect().top) / (ib - ia)
    if (!(pitch > 0)) return null
    var target = ia + (n - ta) * (ib - ia) / (tb - ta)
    scroller.scrollTop = Math.max(0, target * pitch - rect.height / 2)
    // 滚完要等虚拟滚动重渲染一帧，这一帧里取不到就返回 null（调用方会兜底）
    return markFor(scroller.querySelectorAll('button[data-index]'), n)
  }

  /** 把某一行滚进对话页的视口（顶部留 24px —— 和宿主自己刻度落位的位置一致）。 */
  function scrollChatRow(content, row) {
    var scroller = row && row.closest ? row.closest('[data-conversation-scroll]') : null
    if (!scroller && content && typeof content.querySelector === 'function') scroller = content.querySelector('[data-conversation-scroll]')
    if (!scroller || typeof scroller.scrollTop !== 'number' || typeof scroller.getBoundingClientRect !== 'function' ||
      typeof row.getBoundingClientRect !== 'function') {
      if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' })
      return
    }
    var delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 24)
  }

  /**
   * 自己把第 n 轮滚到位。
   *
   * ⚠️ 要**写完再看一眼**：面板贴底跟随时宿主会把滚动位置写回尾部（它自己的跟随循环），
   *    我们那一写可能被它盖掉。所以最多试三次，到位（离顶 0~120px）就收手。
   */
  function scrollChatRowTo(content, n, done) {
    var tries = 0
    function once() {
      var row = chatTurnRow(content, n)
      if (row === null) { done(null); return }
      scrollChatRow(content, row)
      tries += 1
      if (tries >= 3) { done(chatTurnRow(content, n) || row); return }
      locateAfter(function () {
        var again = chatTurnRow(content, n)
        if (again === null) { done(row); return }
        var scroller = again.closest ? again.closest('[data-conversation-scroll]') : null
        if (scroller && typeof again.getBoundingClientRect === 'function' && typeof scroller.getBoundingClientRect === 'function') {
          var top = again.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          if (top >= 0 && top <= 120) { done(again); return }
        }
        once()
      }, 90)
    }
    once()
  }

  /**
   * 用宿主会话控制器往前翻历史，直到 `check()` 成立（或翻不动了）。
   *
   * 这是**最慢**的一条路，只在宿主的刻度够不着时用（窄窗口下刻度轨道不渲染）。
   * 上限两道：次数 + `snapshot.hasMore` —— 会话再大也不能把主线程占住。
   */
  function loadOlderUntil(sessionId, check, done) {
    var session = sessionOf(sessionId)
    if (session === null || typeof session.loadOlder !== 'function') { done(); return }
    var left = 14
    function once() {
      if (check() || left <= 0) { done(); return }
      left -= 1
      var snap = null
      try { snap = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null } catch (e) { snap = null }
      if (snap && snap.hasMore === false) { done(); return }
      var p = null
      try { p = session.loadOlder() } catch (e) { p = null }
      if (!p || typeof p.then !== 'function') { locateAfter(once, 150); return }
      p.then(function () { locateAfter(once, 60) }, function () { done() })
    }
    once()
  }

  /**
   * 对话页的定位。
   *
   * 三条路，**从最轻的开始**：
   *   ① 这一轮已经渲染出来了 → 自己滚（一个字节的历史都不多取）；
   *   ② 没渲染 → 点宿主「轮次导航」里那一枚刻度（宿主自己翻历史 + 精确落位）；
   *   ③ 连刻度都没有（窄窗口下轨道不渲染）→ 自己翻历史再滚。
   */
  /**
   * 对话页的最后一条路：用宿主会话控制器往前翻历史，翻到这一轮渲染出来为止，再自己滚。
   * 只在"刻度够不着"或"刻点点下去没反应"时走 —— 最慢，但点了总得有点用。
   */
  function locateChatByPaging(sessionId, content, n, done) {
    loadOlderUntil(sessionId, function () { return chatTurnRow(content, n) }, function () {
      scrollChatRowTo(content, n, function (row) { done(row !== null) })
    })
  }

  function locateInChat(sessionId, content, n, done) {
    if (chatTurnRow(content, n) !== null) {
      scrollChatRowTo(content, n, function (row) { done(row !== null) })
      return
    }
    var mark = railMarkOf(content, n)
    if (mark !== null && typeof mark.click === 'function') {
      mark.click()
      // 宿主落位是异步的（要翻页、要等提交后的那一帧）——等那一行真的到位再收工
      locateWaitFor(function () { return chatTurnRow(content, n) }, 5000, function (row) {
        if (row !== null) { done(true); return }
        /*
         * ⚠️ 刻度点了**也可能没反应**（实测：`turnOutline` 投影是缓存下来的，刻度"以为"
         *    有更早的轮次，宿主的跳转加载器却翻不动 —— 表现就是点下去什么都不发生）。
         *    所以这一条不是"点了就交差"，它失败了还要走一遍"自己翻历史"。
         */
        locateChatByPaging(sessionId, content, n, done)
      })
      return
    }
    locateChatByPaging(sessionId, content, n, done)
  }

  // ── 轨迹页 ──────────────────────────────────────────────────────────

  /** 轨迹行上的轮号：轮次起点那一行里有宿主给的一枚 `#N`（本地化无关的紧凑标签）。 */
  function turnOfTrajRow(row) {
    if (!row || typeof row.querySelectorAll !== 'function') return null
    var spans = row.querySelectorAll('span')
    for (var i = 0;i < spans.length;i += 1) {
      var t = spans[i].textContent
      if (typeof t === 'string' && /^#\d+$/.test(t)) return Number(t.slice(1))
    }
    return null
  }

  /** 某一个轮次起点行是不是第 n 轮的。 */
  function trajTurnRow(pane, n) {
    var rows = pane.querySelectorAll('tr[data-turn-start="true"]')
    for (var i = 0;i < rows.length;i += 1) if (turnOfTrajRow(rows[i]) === n) return rows[i]
    return null
  }

  /** 第 turn 轮第 step 步的助手行身份（宿主给的就是 `assistant\0轮\0步`）。 */
  function trajStepKey(turn, step) {
    return 'assistant\u0000' + turn + '\u0000' + step
  }

  /** 行上的身份（`data-trajectory-row-key` 是 URI 编码过的，解回来比）。 */
  function trajRowKeyOf(row) {
    var raw = row && row.dataset ? row.dataset.trajectoryRowKey : null
    if (typeof raw !== 'string') return null
    try { return decodeURIComponent(raw) } catch (e) { return raw }
  }

  /**
   * 从一行解出它属于**(哪一轮的第几步)**。
   *
   * 这是宿主**自己写在行身份里**的（`assistant\0<轮>\0<步>`，折叠成摘要行时会再缀
   * `\0summary\0assistant`）—— 所以"第几步"不用猜、也不用数：直接读。
   * 不是助手行的（工具行是按 callId 命名的）返回 null。
   * @returns `{turn, step}` 或 null。
   */
  function trajStepOf(row) {
    var key = trajRowKeyOf(row)
    if (key === null) return null
    var m = /^assistant\u0000(\d+)\u0000(\d+)/.exec(key)
    return m === null ? null : { turn: Number(m[1]), step: Number(m[2]) }
  }

  /** 按身份找那一行（虚拟滚动下可能没渲染 → null）。 */
  function trajRowByKey(pane, key) {
    var rows = pane.querySelectorAll('tr[data-trajectory-row-key]')
    for (var i = 0;i < rows.length;i += 1) {
      var k = trajRowKeyOf(rows[i])
      if (k === key || (k !== null && k.indexOf(key + '\u0000') === 0)) return rows[i]
    }
    return null
  }

  /**
   * 第 n 轮在轨迹里的**用户消息行**（找不到就是 null = 还没载入 / 这一轮没有）。
   *
   * ⚠️ **不能只认"轮次起点行"**：`data-turn-start` 是**视觉边界**，窗口从某一轮中间
   *    开始时，那一段的第一行同样带着它（实测：第 1 轮的"起点行"是一条 `read_image`
   *    工具行，它真正的用户消息还在更早处、根本没载入）。把这个工具行当用户消息落下去，
   *    用户看到的就是"跳到了第 1 轮的工具调用"。
   *
   * 所以按**位置**认：在这一轮的边界行之后、下一轮的边界行之前，第一条 `data-kind=user`
   * 的行；找不到就返回 null —— 调用方据此决定"继续往前翻历史"还是"尽力落在边界行上"。
   * @param pane - 轨迹表格的滚动容器。
   * @param n - 轮号。
   * @returns 用户消息行或 null。
   */
  function trajUserRowFor(pane, n) {
    var rows = pane.querySelectorAll('tr[data-trajectory-row-key]')
    var inside = false
    for (var i = 0;i < rows.length;i += 1) {
      var row = rows[i]
      var atStart = row.dataset && row.dataset.turnStart === 'true'
      if (atStart) {
        var t = turnOfTrajRow(row)
        if (t !== null) {
          if (t === n) inside = true
          else if (inside || t > n) return null
        }
      }
      if (inside && row.dataset && row.dataset.kind === 'user') return row
    }
    return null
  }

  /** 现在渲染出来的轮次边界范围（虚拟滚动下这就是"窗口里看得到的那一段"）。 */
  function trajRenderedTurns(pane) {
    var rows = pane.querySelectorAll('tr[data-turn-start="true"]')
    var min = null
    var max = null
    for (var i = 0;i < rows.length;i += 1) {
      var t = turnOfTrajRow(rows[i])
      if (t === null) continue
      if (min === null || t < min) min = t
      if (max === null || t > max) max = t
    }
    return { min: min, max: max }
  }

  /** 轨迹页现在还有更早的历史没载入吗（那枚「加载更早的历史」还在就还有）。 */
  function trajHasEarlier(pane) {
    if (!pane || typeof pane.querySelector !== 'function') return false
    return pane.querySelector('[data-history-load]') !== null
  }

  /**
   * 目标轮**载入了没有**。
   *
   * 判据是**总览时间轴上那枚轮次边界**（`span[data-turn="n"]`）—— 它是宿主对**已载入
   * 记录**建的模型，出现了就是载到了。比"滚上去看一眼表头"便宜得多，而且不需要动滚动位置。
   *
   * ⚠️ 时间轴整块没渲染出来（被折叠、或宿主版本里没有）时退回到"还有更早的历史吗"：
   *    那样会一直载到会话开头才继续 —— 慢，但不会判错（宁慢不错）。
   */
  function trajTurnLoaded(content, n) {
    if (!content || typeof content.querySelector !== 'function') return false
    var pane = content.querySelector('[data-trajectory-scroll]')
    // ① 表格顶上那枚「加载更早的历史」没了 = **已经载到头** —— 那就一定载入了。
    //    ⚠️ 这一条必须在前面：总览时间轴是按**当前时间域**渲染边界的，用户缩放/拖动过
    //    之后更早那些轮次的边界就**不在 DOM 里**了，只看时间轴会把"其实已经载入"
    //    判成"还没载入"，于是永远停在"接着载"那一步（真机上就是点了没反应）。
    if (pane === null || (pane.querySelector && pane.querySelector('[data-history-load]') === null)) return true
    // ② 还有更早的历史：那看这一轮的边界在不在时间轴上
    return content.querySelector('span[data-turn="' + n + '"]') !== null
  }

  /**
   * 轨迹页的定位（**唯一没有宿主能力可借**的一条路）。
   *
   * 三件事叠在一起：
   *   · **分页**：更早的历史根本没载入（表格顶部那枚「加载更早的历史」是入口）；
   *   · **虚拟滚动**：载入 ≠ 渲染，屏幕外的行不在 DOM 里（一百多行只挂几十行）；
   *   · **行高不齐**（工具行 30px、消息行更高、折叠摘要 20px）—— 算不出"第 N 行在多少像素处"。
   *
   * 所以分两段：
   *   ① **先保证载入** —— `session.loadThrough(seq)`（宿主的跳转加载器，一次到位），
   *      没 seq 或它没管用时连点表格顶部那枚「加载更早的历史」；每次载入之间**不等**
   *      渲染（实测：连点每页 60ms 就绪，16 页 ≈ 1 秒；一页一等渲染要十几秒）。
   *      停的条件看时间轴那枚 `span[data-turn="n"]`（见 `trajTurnLoaded`）。
   *   ② **再滚动落位** —— 读渲染出来的轮次边界二分收窄；视野里一条边界都没有（整段落在
   *      长轮次内部）就往窗口头走（窗口首行永远带轮次标记）。
   *
   * ⚠️ **滚到顶会自己往前载入历史**（实测：把滚动位置写到 0，一帧之后 `scrollHeight`
   *    从 1674 涨到 3174，没人点那枚按钮），而且载入完按"读到的位置"补偿滚动 ——
   *    所以落位要**看两眼**：内容被顶走就重来（见 `land`）。
   *
   * 上限是硬的（步数 + 总时长）：轨迹页再大也不能把主线程占住；超了就**什么都不做**
   *（宁可不动，也不要乱跳一通把人看晕）。
   */
  function locateInTrajectory(sessionId, content, n, stepNo, seq, done) {
    var pane = content && typeof content.querySelector === 'function' ? content.querySelector('[data-trajectory-scroll]') : null
    if (!pane) { done(false); return }
    var started = Date.now()
    var steps = 0
    var lo = 0
    var hi = Math.max(0, pane.scrollHeight - pane.clientHeight)
    /**
     * 目标行：轮的目标 = 这一轮的用户消息行；步的目标 = 那一步的助手行（身份里带轮和步）。
     *
     * ⚠️ 参数**不能叫 `step`** —— 它会和下面那个 `function step()`（机器的主循环）重名，
     *    而函数声明会被提升并**覆盖同名参数**：`step` 于是变成函数对象，`stepNo === null`
     *    永远不成立，整个搜索跑的是"找一步叫 function 的步"（真踩到过：点了没反应）。
     */
    var wantKey = stepNo === null || stepNo === undefined ? null : trajStepKey(n, stepNo)
    /** 宿主的跳转加载器试过了没有（只试一次）。 */
    var jumped = false
    /** "窗口头比目标还晚"连续出现了几次（防在某一个状态上来回打转）。 */
    var stuck = 0

    /** 把某一行滚到视口中间（自己写 scrollTop —— 不用 `scrollIntoView` 的平滑滚动，
        它和"载入之后按位置补偿"那一套会抢滚动位置）。 */
    function centerRow(row) {
      if (!row || typeof row.getBoundingClientRect !== 'function' ||
        typeof pane.getBoundingClientRect !== 'function') return
      var pr = pane.getBoundingClientRect()
      var rr = row.getBoundingClientRect()
      var want = pane.scrollTop + (rr.top - pr.top) - Math.max(0, (pane.clientHeight - rr.height) / 2)
      pane.scrollTop = Math.max(0, want)
    }

    /** 这一行现在是不是整个都在视野里。 */
    function onScreen(row) {
      if (!row || typeof row.getBoundingClientRect !== 'function') return false
      var pr = pane.getBoundingClientRect()
      var rr = row.getBoundingClientRect()
      return rr.top >= pr.top - 4 && rr.bottom <= pr.bottom + 4
    }

    /**
     * **选中**这一行 —— 走宿主自己的选中动作（点它一下）。
     *
     * 这就是轨迹页的"选中一轮"：行变成 `data-selected`、轮次标签高亮、右边检查器打开这一条，
     * 而且宿主的 `activeTurn` 就是从**选中的那条记录**推出来的（时间轴/轮轨跟着高亮这一轮）。
     * 比我们自己加个底色对得多：选中态是**宿主的**，它自己知道怎么画、也不会跟别的状态打架。
     * ⚠️ 用 `click()`（真事件）而不是改 DOM：状态在 React 里，只有走它的事件才算数。
     */
    function selectRow(row) {
      if (!row) return
      if (typeof row.click === 'function') { row.click(); return }
      if (typeof row.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    }

    /**
     * 落位：滚到中间 → 等它稳下来 → 还在视野里才算到，然后**选中它**。
     * 每一轮都**重新按轮号取一次行**：载入历史会把行整体重挂，旧节点会失效。
     *
     * ⚠️ 落位之后**内容可能被顶走**（往前载入 → 补偿滚动）。校正两轮还不稳，就
     *    **整轮搜索重来一次** —— 载入之后窗口变了，不该拿着旧坐标硬凑。
     */
    function targetRow() {
      if (wantKey !== null) return trajRowByKey(pane, wantKey)
      return trajUserRowFor(pane, n)
    }

    function land() {
      var tries = 0
      function settle() {
        var row = targetRow() || trajTurnRow(pane, n)
        centerRow(row)
        tries += 1
        locateAfter(function () {
          var row2 = targetRow() || trajTurnRow(pane, n)
          if (row2 !== null && onScreen(row2)) { selectRow(row2); done(true); return }
          if (tries <= 2) { settle(); return }
          lo = 0
          hi = Math.max(0, pane.scrollHeight - pane.clientHeight)
          locateAfter(step, 150)
        }, 260)
      }
      settle()
    }

    /**
     * 把滚动位置顶到窗口最上面（窗口首行永远带轮次标记，是"知道窗口最早载到哪一轮"的唯一位置）。
     * 滚到顶可能触发一次"往前载入"，载入完会把它推下去一截 —— 等一等再继续。
     */
    function goTop() {
      var height0 = pane.scrollHeight
      pane.scrollTop = 0
      locateAfter(function () {
        lo = 0
        hi = Math.max(0, pane.scrollHeight - pane.clientHeight)
        if (pane.scrollHeight === height0) { step(); return }
        locateAfter(step, 120)
      }, 260)
    }

    /** 连点「加载更早的历史」载下一页（每页 60ms 就绪 —— **不等渲染**）。点不动返回 false。 */
    function pageEarlier() {
      if (!trajHasEarlier(pane)) return false
      var host = pane.querySelector('[data-history-load]')
      var btn = host && (typeof host.querySelector === 'function' ? (host.querySelector('button') || host) : host)
      if (!btn || btn.disabled || typeof btn.click !== 'function') return false
      btn.click()
      return true
    }

    /**
     * 借宿主的**跳转加载器**把历史翻到这一轮（`session.loadThrough(seq)`）。
     *
     * 和「轮次导航」刻度点下去是**同一个调用**：宿主自己按 500 条一页地翻、翻完一起发布。
     * 失败（宿主版本没有 / seq 缺失 / RPC 出错）就退回"一页一页点"那条路。
     */
    function jumpThrough() {
      var session = sessionOf(sessionId)
      if (seq === undefined || seq === null || session === null || typeof session.loadThrough !== 'function') return false
      jumped = true
      var p = null
      try { p = session.loadThrough(seq) } catch (e) { p = null }
      var next = function () {
        locateAfter(function () {
          lo = 0
          hi = Math.max(0, pane.scrollHeight - pane.clientHeight)
          step()
        }, 80)
      }
      if (p && typeof p.then === 'function') { p.then(next, next); return true }
      next()
      return true
    }

    /**
     * 窗口现在是不是**停在这一轮里**。
     *
     * ⚠️ 不能只看"轮次起点行在不在" —— 长轮次里滚到中间时，那一行早就出视野了
     *    （而它恰恰是唯一的轮次路标）。助手行的身份里也带着轮号，所以"看得见这一轮的
     *    任何一行"就算在里面 —— 判据放宽到那一层，步的搜索才不会被拽回顶部重来
     *    （真踩到过：跳下去 → 判不出在里面 → `goTop()` 又拽回 0，来回弹）。
     */
    function insideTurn() {
      if (trajUserRowFor(pane, n) !== null || trajTurnRow(pane, n) !== null) return true
      var rows = pane.querySelectorAll('tr[data-trajectory-row-key]')
      for (var i = 0;i < rows.length;i += 1) {
        var m = trajStepOf(rows[i])
        if (m !== null && m.turn === n) return true
      }
      return false
    }

    /**
     * 兜底扫描的游标（null = 还没开始扫）。
     *
     * 为什么要有这条路：下面那套二分**假设记录按轮号升序**（`trajRenderedTurns`
     * 给出渲染区间、再朝目标二分）。可宿主那份记录在**压缩过的会话**上不一定升序 ——
     * 实测同一个会话里时间轴上的轮次边界是 `3,4,1,5,6`，于是二分一步都走不动
     * （点轮次号没反应）。扫一遍虽然笨，但**与顺序无关**，再拿步数/时间上限兜住。
     */
    var scanAt = null

    /** 该放弃了吗：还有没扫过的地方就从头扫一遍，否则真放手。 */
    function giveUpOrScan() {
      if (scanAt === null) {
        scanAt = 0
        locateAfter(step, 0)
        return
      }
      done(false)
    }

    /** 行顶部相对表格的绝对位置（用来按路标跳）。 */
    function offOf(row) {
      var pr = pane.getBoundingClientRect()
      var rr = row.getBoundingClientRect()
      return pane.scrollTop + (rr.top - pr.top)
    }

    /**
     * 按**(轮, 步) 路标**滚一步 —— 只用在"步"这个目标上。
     *
     * 长轮次里（实测第 1 轮 179 步、三百多行）目标行往往在窗口外，而虚拟滚动只挂视野里
     * 那几十行。助手行的身份里带着步号，所以方向不用猜：把渲染出来的助手行按步号分到
     * 目标两侧，朝有路标的那一侧跳一整屏（两侧都有 = 目标夹在中间，跳到两者中点）。
     * @returns 滚过了返回 true（调用方重来一步）。
     */
    function stepJump() {
      var rows = pane.querySelectorAll('tr[data-trajectory-row-key]')
      var above = null
      var below = null
      for (var i = 0;i < rows.length;i += 1) {
        var m = trajStepOf(rows[i])
        if (m === null || m.turn !== n) continue
        if (m.step < stepNo) { if (above === null || m.step > above.step) above = { step: m.step, row: rows[i] } }
        else if (m.step > stepNo) { if (below === null || m.step < below.step) below = { step: m.step, row: rows[i] } }
      }
      if (above === null && below === null) return false
      var want
      if (above !== null && below !== null) want = (offOf(above.row) + offOf(below.row)) / 2 - pane.clientHeight / 2
      else if (above !== null) want = offOf(above.row)
      else want = offOf(below.row) - pane.clientHeight + 60
      pane.scrollTop = Math.max(0, Math.round(want))
      return true
    }

    function step() {
      steps += 1
      if (steps > 90 || Date.now() - started > 15000) { done(false); return }
      // ① 目标行已经渲染出来了 —— 直接落位（一个字节的历史都不多取）
      if (targetRow() !== null) { land(); return }
      /*
       * ①' 目标是**某一步**、而那一轮已经在视野里了 —— 按 (轮, 步) 路标往里走。
       *
       * 步的搜索要在**轮已经就位**之后做：轮的定位把那一段历史翻出来、把窗口挪过去，
       * 之后"差的步"通常就在附近几十行内（`stepJump` 一跳一屏）。
       * 轮的搜索照旧走下面那套 —— 只是**命中条件换成"那一步的行"**，找到轮不算找到。
       */
      if (wantKey !== null && insideTurn()) {
        if (stepJump()) { locateAfter(step, 100); return }
        giveUpOrScan()
        return
      }
      /*
       * ①'' 兜底扫描：二分那套走不动了 —— 按**位置**从头到尾扫一遍（与顺序无关）。
       * 一旦进入这条路就只扫描：每步挪大半个视口，直到扫到底或超上限。
       */
      if (scanAt !== null) {
        if (scanAt > pane.scrollHeight) { done(false); return }
        pane.scrollTop = scanAt
        scanAt += Math.max(60, Math.round((pane.clientHeight || 240) * 0.8))
        locateAfter(step, 80)
        return
      }
      // ② 还没载入到这一轮 —— 载（先跳转加载器，再一次一页地点）
      if (!trajTurnLoaded(content, n)) {
        if (!jumped && jumpThrough()) return
        if (pageEarlier()) { locateAfter(step, 60); return }
        // 按钮点不动（多半是正在载）→ 等一拍；按钮真没了 → 没得载了，放手
        if (trajHasEarlier(pane)) { locateAfter(step, 120); return }
        done(false)
        return
      }
      // ③ 载入了，但没渲染出来 —— 在已载入窗口里滚动找
      var seen = trajRenderedTurns(pane)
      var top = pane.scrollTop
      /*
       * 视野里**一条轮次边界都没有** —— 整段都落在某一轮内部（实测第 1 轮 179 步、
       * 三百多行）。这时判不了方向，只能往窗口头走：窗口首行永远带轮次标记。
       */
      if (seen.min === null) {
        if (top <= 2) { giveUpOrScan(); return }
        goTop()
        return
      }
      if (seen.max !== null && seen.max < n) {
        // 目标在**更晚**处：往下二分
        if (hi - top <= 2) { giveUpOrScan(); return }
        lo = top
        pane.scrollTop = Math.round(top + (hi - top) / 2)
        locateAfter(step, 90)
        return
      }
      if (seen.min > n) {
        // 目标在**更早**处：直接顶到窗口头（那里才有轮次标记，二分只是白挪）
        if (top > 2) { goTop(); return }
        // 已经在窗口头，头那一轮还比目标晚 —— 要么是 `trajTurnLoaded` 看走眼了
        // （时间轴那枚边界是上一次渲染的），要么宿主没跟上。给它三次机会，然后放手。
        stuck += 1
        if (stuck > 3) { giveUpOrScan(); return }
        locateAfter(step, 150)
        return
      }
      stuck = 0
      /*
       * n 落在渲染区间里，却既取不到用户消息行、有时连**边界行**也取不到。
       *
       * 两种收场，区别在"这一轮的边界行在不在渲染出来的行里"：
       *   · 在 —— 那就是**窗口头截断**（窗口从这一轮中间开始的产物）或者这一轮本来就没有
       *     用户消息行：还有更早的历史就继续载，载不动了就**尽力落在它的边界行上**。
       *   · 不在 —— 幻影一样的情况：区间跨过了它、可虚拟滚动挂出来的那几十行里没有它。
       *     宿主没有跳转能力、表又是按轮次递增排的，**不猜、也不空转** —— 放手。
       */
      var boundary = trajTurnRow(pane, n)
      if (boundary !== null) {
        if (trajHasEarlier(pane)) {
          if (pageEarlier()) { locateAfter(step, 60); return }
          locateAfter(step, 120)
          return
        }
        // 步的目标**不许**把"落在这一轮上"当找到（用户要的是那一步）：
        // 走到这儿说明这一轮的助手行一条都没挂出来，去 ①' 那条路也没路标 —— 兜底扫描。
        if (wantKey !== null) { giveUpOrScan(); return }
        land()
        return
      }
      giveUpOrScan()
    }
    step()
  }

  /**
   * 点轮次号的总入口：按主会话当前所在的页面分派。
   *
   * ⚠️ 一进来就 `locateStop()`：连点两下（或点了这一轮又点那一轮）时，前一次的动作必须
   *    作废 —— 否则两个动作会一起写滚动位置，落点是"最后写的那一个"，看着像乱跳。
   * @param sessionId - 当前会话（翻历史要用）。
   * @param n - 轮号。
   * @param seq - 这一轮 `turn/start` 的事件序号（骨架里有）；给了就能用宿主的
   *              `loadThrough(seq)` 一次翻到位，缺了就退回"一页一页翻"。
   * @returns 是否真的开始定位（false = 主会话不在对话/轨迹页，什么都没做）。
   */
  function locateMainTurn(sessionId, n, seq) {
    locateStop()
    var turn = Number(n)
    if (!Number.isFinite(turn) || turn <= 0) return false
    var content = mainContent()
    var view = mainViewOf(content)
    var at = Number(seq)
    var jumpSeq = Number.isFinite(at) && at >= 0 ? at : undefined
    if (view === 'chat') { locateInChat(sessionId, content, turn, function () { }); return true }
    if (view === 'trajectory') { locateInTrajectory(sessionId, content, turn, null, jumpSeq, function () { }); return true }
    return false
  }

  /**
   * **某一步**的总入口：主会话在轨迹页时，跳到那一步并**选中它**。
   *
   * 为什么只做轨迹页：`步骤`是"一次模型往返"，只有轨迹页把它当**一条记录**摆出来
   * （行身份就是 `assistant\0<轮>\0<步>`，见 {@link trajStepOf}）。对话页那边每一步
   * 都在**折叠住的**过程块里，没有可寻址的锚点 —— 硬做只能在界面上凭空找位置，
   * 不如老实不做。
   *
   * @param sessionId - 当前会话（翻历史要用）。
   * @param n - 轮号。
   * @param step - 这一轮里的第几步（1 起）。
   * @param seq - 这一轮 `turn/start` 的事件序号（骨架里有）；没有就退回"一页一页翻"。
   * @returns 是否真的开始定位（false = 主会话不在轨迹页，什么都没做）。
   */
  function locateMainStep(sessionId, n, step, seq) {
    locateStop()
    var turn = Number(n)
    var s0 = Number(step)
    if (!Number.isFinite(turn) || turn <= 0 || !Number.isFinite(s0) || s0 <= 0) return false
    var content = mainContent()
    if (mainViewOf(content) !== 'trajectory') return false
    var at = Number(seq)
    var jumpSeq = Number.isFinite(at) && at >= 0 ? at : undefined
    locateInTrajectory(sessionId, content, turn, s0, jumpSeq, function () { })
    return true
  }

  // Context is attached by apply, after the host services are available.
  return { bindContext(ctx) { ctxRef = ctx }, chatTurnRow, locateInTrajectory, locateMainStep, locateMainTurn, locateStop, mainContent, mainViewOf, railMarkOf, trajRenderedTurns, trajRowByKey, trajStepKey, trajStepOf, trajTurnRow, turnOfMark }
}
