import { fmtK, clip, FALLBACK_TITLE_CHARS } from './rules/format.js'

import { mergeByLabel, stepRanges, groupPhases } from './rules/phases.js'
import { emptyState, applyChange, isPinned, shouldFollow } from './trace-state.js'
import { createStepRenderer } from './components/step.js'
import { createHistoryRenderer } from './components/history.js'

/** Owns panel subscriptions and interactions; renderers consume explicit state/callbacks. */
export function createPanel(React, { API, translation, navigation, styles, viewStateController }) {
  const { tlCheck, tlSubscribe, tlEnabled, tlMode, tlStore, tlCycleMode } = translation
  const { locateMainTurn } = navigation
  const { injectCss, releaseCss, ensureCss } = styles
  const { saveViewStore, viewStateOf } = viewStateController
  /** 把命中片段按查询词切开，命中处包成 <mark>（snippet 要能回答"为什么命中"）。 */
  function snippetNodes(snippet, q) {
    var text = String(snippet === undefined || snippet === null ? '' : snippet)
    var needle = String(q === undefined || q === null ? '' : q)
    if (needle === '') return [text]
    var lower = text.toLowerCase()
    var nl = needle.toLowerCase()
    var out = []
    var at = 0
    var k = 0
    for (;;) {
      var found = lower.indexOf(nl, at)
      if (found < 0) { out.push(text.slice(at)); break }
      if (found > at) out.push(text.slice(at, found))
      k += 1
      out.push(React.createElement('mark', { key: 'm' + k }, text.slice(found, found + needle.length)))
      at = found + needle.length
    }
    return out
  }

  function ThinkFlowTab(props) {
    var sessionId = props && props.sessionId ? String(props.sessionId) : ''
    var stateRef = React.useRef(emptyState())
    var [, forceTick] = React.useReducer(function (n) { return n + 1 }, 0)
    /**
     * 面板的交互状态（视图开关 + 展开/折叠）全在**模块级 store** 里，按会话存 ——
     * 切走再切回来、或组件重挂载，用户的痕迹都还在。见 `viewStateOf` 的说明。
     * 改动后调 `forceTick()` 重渲染。
     */
    var viewState = viewStateOf(sessionId)
    var expanded = viewState.expanded
    var phaseOverride = viewState.phaseOverride
    /** 轮次展开状态：turn → bool。默认只有最新一轮展开。 */
    var turnOverride = viewState.turnOverride
    var [, tick] = React.useState(0)
    /**
     * 在面板里**实时看过**的那一轮（生成过程中出现过 running）。
     *
     * 它不再自动折叠阶段块：一边生成一边只留"当前所在阶段"展开的话，前面那些组会
     * 缩成一行标题、步骤全看不见（用户要求"生成过程中不要把组折叠"）。生成结束后
     * 也不自动收 —— 收起来会把读到一半的位置顶掉；要收手动点组头。
     */
    var liveTurnRef = React.useRef(null)
    var bodyRef = React.useRef(null)
    /**
     * 用户是不是贴在底部。滚离底部就暂停跟随，滚回来恢复 —— **不跟用户抢滚动条**。
     * 初始 true：刚打开面板时就在底部（最新内容在那儿）。
     */
    var pinnedRef = React.useRef(true)

    /** 滚动时更新"贴底"状态。程序自己滚的也会触发，滚到底后自然还是 true。 */
    function onBodyScroll() {
      var body = bodyRef.current
      if (!body) return
      pinnedRef.current = isPinned(body.scrollHeight, body.scrollTop, body.clientHeight)
    }
    var followedRef = React.useRef(-1)
    /**
     * 按需取回的原文缓存：`'sessionId|turn:step'` → { text, gap } / { error } / { loading }。
     *
     * ⚠️ 键必须带 sessionId。标签页 body 是**同一个组件实例**在多个会话之间复用
     * （槽位按类型 id 挂载，不按会话重挂载），而 turn/step 号每个会话都从 1 开始。
     * 只按 `'turn:step'` 做键的话，从会话 A 切到 B 再展开第 1 轮第 2 步会命中 A 的缓存，
     * **显示上一个会话的原文** —— 正文是对的、展开的原文是错的，最难发现的一种错。
     */
    var fetchedRef = React.useRef({})
    /**
     * 中文标题：`'sessionId|turn'` → { step: title }。快照会带上已缓存的，生成后写回这里。
     *
     * 键同样必须带 sessionId，理由同上：两个会话的第 1 轮会互相顶掉。
     */
    /**
     * **整轮标题**（一句话说清这一轮干了什么），按轮号存。
     *
     * 和 `titlesRef`（按步的标题）分开：它是轮级的，来源也不一样 ——
     * 轮结束时由宿主生成（实时开着才生成），随快照 / SSE / 手动生成三条路回来。
     */
    var turnTitleRef = React.useRef({})
    var titlesRef = React.useRef({})
    /**
     * 工具说明的**中文翻译**：工具 id → 中文（模型生成，随快照与 /titles 下发）。
     *
     * 按**工具 id** 存，不按步骤号：一步可能有多个命令，各有各的说明。
     */
    var notesRef = React.useRef({})

    /**
     * 目录里的搜索：查询词 / 结果 / 状态。
     *
     * **不进 localStorage**（和视图开关不一样）：它是一次性的动作，
     * 隔天打开面板还挂着一句上次的搜索，只会让人困惑。
     */
    var searchRef = React.useRef({ q: '' })
    /**
     * 按需取轮的进行中状态：轮号 → `'loading'` | 错误文案。
     *
     * 取回来的那一轮直接塞进 `st.turns`，所以成功之后这里不留东西。
     */
    var coldRef = React.useRef({})

    /**
     * 会话作用域的缓存键。
     *
     * 这是**不依赖宿主行为**的那道保险：外壳 `ThinkFlowTabHost` 的 key 会让整棵
     * 子树按会话重挂载（状态一次性归零），但缓存键自带会话身份以后，即使哪天
     * 换了渲染方式、不再重挂载，也绝不会读到别的会话的数据。
     */
    function skey(rest) { return sessionId + '|' + rest }
    /**
     * 生成标题的状态。
     *
     * ⚠️ 必须带**轮次**：早先 `{busy, error}` 是全局的，按钮文案只看 busy ——
     * 于是点一轮的「生成标题」，**所有轮次的按钮都变成"生成中…"并置灰**，
     * 看起来像"全部一起重新生成"（其实只发了一个请求、只改了那一轮）。
     * 错误同理：全局 error 会挂在面板顶部，看不出是哪一轮失败。
     */
    var [genState, setGenState] = React.useState({ busyTurn: null, error: null })

    /**
     * 跟随：**贴底时连续跟随**（把内容不断向上拉出来），滚离底部就暂停。
     *
     * 为什么是"连续"而不是"只在当前步变了时跳一次"：思考是**流式**长的，
     * 一步里新吐出来的文字会一直往下长 —— 只跟步的变化，那一步的新文字就会滑到
     * 视野外（也就是滑到右下角胶囊后面）。
     *
     * 为什么只在贴底时跟：否则你往上滚想看前面的内容，它每 500ms 把你拽回底部
     * （那是"抢滚动条"，最烦人）。滚回底部自动恢复。
     * 落点是底部（含 `.tf-body::after` 那 150px 留白），所以最新那几行正好落在胶囊上方。
     *
     * ⚠️ 条件不是 `running`，而是"这一轮**在本次挂载里实时看过**"（`liveTurnRef`）：
     * 一轮跑完的那一刻 `running` 立刻变 false，而**收尾小结正是那一刻才出现的** ——
     * 用 running 当条件，小结一出来就没人跟了，它落在视野外（真机反馈
     * "最后一步出总结的时候没有跟随"）。用 liveTurnRef 就自然盖住"跑完 → 出小结"
     * 这一下；而打开历史会话（本次没实时看过）仍然停在顶部，不会自己跳到底部。
     */
    React.useEffect(function () {
      var body = bodyRef.current
      if (!body) return
      if (!shouldFollow(pinnedRef.current, running, liveTurnRef.current, turn ? turn.turn : null)) return
      body.scrollTop = body.scrollHeight
    })

    // 秒表：等待态的"已等 xx"要动，否则与卡死无法区分
    React.useEffect(function () {
      var t = setInterval(function () {
        // 顺手自愈样式：元素被别处摘掉（上一代 dispose、宿主清 head）也能自己长回来。
        // 一次 getElementById / 500ms，代价可以忽略；不做的话表现是**整块面板没样式**。
        ensureCss()
        tick(function (n) { return n + 1 })
      }, 500)
      return function () { clearInterval(t) }
    }, [])

    /*
     * 样式：面板在屏幕上时**自己再拿一份引用**。
     *
     * 为什么 apply 拿了一份还不够：热重载的中间态里，apply 那一代已经被 dispose 了，
     * 而 React 树还没换掉（面板仍在屏幕上）。只靠 apply 那一份引用，样式会跟着
     * 先走一步，面板就**裸奔**一小会儿 —— 真机上如果这一步卡住（那一代没再挂回来），
     * 就是用户看到的"面板变成一堆浏览器默认按钮"。面板自己持一份，两边对齐。
     */
    React.useEffect(function () {
      var hold = injectCss()
      return function () { releaseCss(hold) }
    }, [])

    // 机翻：问一次宿主（translator 服务在不在），并订阅"某段翻好了"的重渲染。
    // 不在这个 effect 里翻译任何东西 —— 翻译的触发点在渲染（看得见的文字才翻）。
    React.useEffect(function () {
      tlCheck()
      return tlSubscribe(function () { forceTick() })
    }, [sessionId])

    // SSE 连接
    React.useEffect(function () {
      if (!sessionId) return undefined
      stateRef.current = emptyState()
      stateRef.current.sessionId = sessionId
      forceTick()

      /**
       * ⚠️ **自己管重连**，不能只把 `connected` 置 false 就等浏览器自己重试。
       *
       * 宿主那边会主动收流（LRU 淘汰会话、插件热重载），而浏览器那套自动重连
       * 在服务端反复关闭之后会放弃 —— 表现是面板**永远停在最后一份数据**上，
       * 偏偏"等工具"的秒表还在自己涨，看着就像任务卡死（实测：那一轮 40 分钟前
       * 就中断了，面板还挂着"已等 59'46""）。
       * 指数退避（1s → 2s → 5s → 10s 封顶），连上就归零。
       */
      var es = null
      var retry = 0
      var retryTimer = null
      var stopped = false
      var RETRY_MS = [1000, 2000, 5000, 10000]
      var connect = function () {
        if (stopped) return
        es = new EventSource(API + '/stream?session=' + encodeURIComponent(sessionId))
        es.onopen = function () { retry = 0; stateRef.current.connected = true; forceTick() }
        es.onerror = function () {
          stateRef.current.connected = false
          forceTick()
          try { es.close() } catch (e) { /* 已经断了 */ }
          if (stopped) return
          var wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]
          retry += 1
          retryTimer = setTimeout(connect, wait)
        }
        es.onmessage = function (ev) {
          var msg
          try { msg = JSON.parse(ev.data) } catch (e) { return }
          var st = stateRef.current
          if (msg.t === 'snapshot') {
            st.turns = (msg.snapshot && msg.snapshot.turns) || []
            st.serverTime = msg.snapshot ? msg.snapshot.serverTime : 0
            st.state = msg.snapshot ? msg.snapshot.state : undefined
            // **全轮骨架**：比 turns 长得多。目录"看更早的轮次"读它，
            // 所以 133 轮的会话不会只剩 20 轮可翻。老宿主不带这个字段 → 空数组，
            // 目录入口自动退回"只有面板里这些轮"（不炸）。
            st.index = Array.isArray(msg.snapshot && msg.snapshot.index) ? msg.snapshot.index : []
            // 快照里的 reasoningTail 作为本地追加的起点
            for (var i = 0;i < st.turns.length;i += 1) {
              var steps = st.turns[i].steps || []
              for (var j = 0;j < steps.length;j += 1) {
                if (steps[j].reasoningTail !== undefined) steps[j].reasoningText = steps[j].reasoningTail
              }
              // 已生成过的标题随快照下发，刷新页面不用重算。
              // 宿主给的是**按步骤号索引的对象**，直接用它，不按下标猜（下标对齐极易错位）。
              var incoming = st.turns[i].titles
              if (incoming !== undefined && incoming !== null && typeof incoming === 'object') {
                titlesRef.current[skey(st.turns[i].turn)] = Object.assign({}, incoming)
              }
              // 空串 = 宿主"试过但没总结出东西" → 当没有，回落到默认素材（本轮用户消息）
              if (st.turns[i].turnTitle !== undefined && st.turns[i].turnTitle !== null && String(st.turns[i].turnTitle) !== '') {
                turnTitleRef.current[skey(st.turns[i].turn)] = String(st.turns[i].turnTitle)
              }
              var incomingNotes = st.turns[i].notes
              if (incomingNotes !== undefined && incomingNotes !== null && typeof incomingNotes === 'object') {
                for (var nk in incomingNotes) if (Object.prototype.hasOwnProperty.call(incomingNotes, nk)) notesRef.current[nk] = incomingNotes[nk]
              }
            }
            st.connected = true
            // 宿主侧是权威：宿主重启过就按它说的来
            if (typeof msg.snapshot.auto === 'boolean') viewState.autoTitles = msg.snapshot.auto
            st.autoBusy = msg.snapshot.autoBusy === true
          } else if (msg.t === 'change') {
            applyChange(st, msg.change)
          } else if (msg.t === 'autoBusy') {
            // 宿主说"这一批正在生成"——只在开了实时的时候才脉冲，别在关着的时候闪
            st.autoBusy = msg.busy === true
          } else if (msg.t === 'titles') {
            // 自动标题是**推**过来的（不是我们请求的）：合并进缓存并重渲染
            if (msg.turn !== undefined && msg.titles) {
              titlesRef.current[skey(msg.turn)] = Object.assign({}, titlesRef.current[skey(msg.turn)] || {}, msg.titles)
            }
            if (msg.turnTitle !== undefined && String(msg.turnTitle) !== '') turnTitleRef.current[skey(msg.turn)] = String(msg.turnTitle)
            if (msg.notes) {
              for (var pk in msg.notes) if (Object.prototype.hasOwnProperty.call(msg.notes, pk)) notesRef.current[pk] = msg.notes[pk]
            }
          }
          forceTick()
        }
      }
      connect()
      return function () {
        stopped = true
        if (retryTimer !== null) clearTimeout(retryTimer)
        try { es.close() } catch (e) { /* 已关 */ }
      }
    }, [sessionId])

    /**
     * 窗口里的一轮 → 骨架行（宿主 `summaryOf` 的客户端版，字段同名同义）。
     *
     * 哪边优先，分两类（两类都各有一个"为什么不反过来"的理由）：
     *   · **身份字段**（`userText` / `startedAt` / `title`）**宿主那份行优先**：
     *     它是宿主从轨迹里算出来的权威值，客户端那份是增量的投影。
     *     （`title` 例外：客户端收到的模型标题更新，比快照里的新。）
     *   · **会长的计数**（步数 / 工具 / Token）与收尾事实（`endedAt` 等）**窗口优先**：
     *     骨架里那一行是**连上那一刻**算的，这一轮还在跑，它已经旧了。
     */
    function skeletonRow(t, prev) {
      var steps = t.steps || []
      var tools = 0
      var tokens = 0
      var text = 0
      for (var i = 0;i < steps.length;i += 1) {
        tools += (steps[i].tools || []).length
        tokens += steps[i].reasoningTokens || 0
        text += steps[i].textTokens || 0
      }
      var mt = turnTitleRef.current[skey(t.turn)]
      return {
        turn: t.turn,
        startedAt: prev && prev.startedAt !== undefined ? prev.startedAt : t.startedAt,
        endedAt: t.endedAt !== undefined ? t.endedAt : (prev ? prev.endedAt : undefined),
        endReason: t.endReason !== undefined ? t.endReason : (prev ? prev.endReason : undefined),
        interrupted: t.interrupted !== undefined ? t.interrupted : (prev ? prev.interrupted : undefined),
        userText: prev && prev.userText !== undefined && prev.userText !== ''
          ? prev.userText
          : t.userText,
        title: (mt !== undefined && mt !== null && String(mt) !== '') ? String(mt) : (prev ? prev.title : undefined),
        steps: steps.length,
        tools: tools,
        reasoningTokens: tokens,
        textTokens: text,
        inMemory: true,
      }
    }

    /**
     * 面板用的**骨架**：宿主那份全轮骨架 ∪ 本地正文窗口（最新在前）。
     *
     * ⚠️ 为什么必须并（用户报的症状）：`st.index` 只在**连上那一刻**的快照里下发，
     *    之后宿主只推增量（`change`）。于是"打开面板时这一轮才刚开始"的会话里，
     *    骨架永远停在当时的长度：
     *      ① 「历史」按钮的门槛是**总轮数** → 它再也不出现（1 轮的会话连入口都没有）；
     *      ② 目录 / 搜索 / 步进器边界都少掉之后长出来的那些轮。
     *    两边字段怎么取舍见 `skeletonRow`（身份字段听宿主的，会长的计数听窗口的）。
     */
    function buildSkeleton() {
      var idx = Array.isArray(st.index) ? st.index : []
      var byTurn = {}
      for (var i = 0;i < idx.length;i += 1) {
        if (idx[i] && idx[i].turn !== undefined) byTurn[idx[i].turn] = idx[i]
      }
      var out = []
      var inWindow = {}
      for (var w = 0;w < turns.length;w += 1) {
        var t = turns[w]
        if (!t || t.turn === undefined) continue
        inWindow[t.turn] = true
        out.push(skeletonRow(t, byTurn[t.turn]))
      }
      for (var k = 0;k < idx.length;k += 1) {
        var r = idx[k]
        if (!r || r.turn === undefined || inWindow[r.turn] === true) continue
        out.push(r)
      }
      // 宿主那份也是"最新在前"，这里显式排一次：窗口里的新轮要落在最上面
      out.sort(function (a, b) { return b.turn - a.turn })
      return out
    }

    var st = stateRef.current
    var turns = st.turns || []
    var skel = buildSkeleton()
    /**
     * 会话**总**轮数 = 骨架长度。
     *
     * 骨架已经含正文窗口（见 `buildSkeleton`），所以老宿主没给 `index` 时它就是窗口长度，
     * 不需要再写一条回落分支。
     */
    var totalTurns = skel.length
    // 最新一轮："跟随"看它（头部状态标签删掉后，这里不再喂徽章）
    var turn = turns.length ? turns[turns.length - 1] : null
    var steps = turn ? turn.steps || [] : []

    /** 一个 turn 的派生量：统计、活跃步、阶段。 */
    function derive(t) {
      var list = t ? t.steps || [] : []
      var tokens = 0
      var tools = 0
      var active = null
      for (var i = 0;i < list.length;i += 1) {
        tokens += list[i].reasoningTokens || 0
        tools += (list[i].tools || []).length
        var s2 = list[i].status
        if (s2 === 'thinking' || s2 === 'waiting') active = list[i]
      }
      // 面板：**按时间顺序**的阶段，不合并（每一步都还在它原来的位置）
      var ps = groupPhases(list)
      var ap = -1
      for (var p2 = 0;p2 < ps.length;p2 += 1) {
        if (active && ps[p2].steps.indexOf(active) >= 0) ap = p2
      }
      if (ap < 0 && ps.length) ap = ps.length - 1
      // 小结：同一类活动合并成一个（只有**最后统计**才合并，见 mergeByLabel 的说明）
      return {
        list: list, tokens: tokens, tools: tools, active: active,
        phases: ps, merged: mergeByLabel(ps), activePhase: ap,
      }
    }

    /*
     * ⚠️ 这里原来算三个**会话合计**（步骤 / 思考 / 工具）喂给统计行。
     *    统计行改成导航行之后它们没有出口了 —— 删掉，不留死代码。
     *    （「共 N 轮」还留着，它喂给目录入口的条件与目录头。）
     */

    var d = derive(turn)
    var activeStep = d.active
    var phases = d.phases
    var activePhase = d.activePhase

    var running = activeStep !== null
    if (running && turn) liveTurnRef.current = turn.turn

    /**
     * 当前视图。
     *
     * **实时生成时默认「看原文」** —— 模型正在流式吐思考，这时候读原文才有意义；
     * 停下来默认「看结构」（步骤 + 工具的整体形状）。用户手动切过**本轮**的话听用户的，
     * 换一轮再回到自动。
     */
    var curTurnNo = turn ? turn.turn : null
    var view = (viewState.touchedTurn !== null && viewState.touchedTurn === curTurnNo)
      ? viewState.manual
      : (running ? 'raw' : 'structure')

    /**
     * 把某一轮的**所有阶段块**统一打开或收起。
     *
     * 两个视图开关是**对称**的：
     *   · 「看原文」→ 打开（每一步的**标题**都露出来；折叠着就只剩一行组标题）
     *   · 「看结构」→ 收起（只看结构本身：几个组、每组多少步/多少字/几次工具）
     * 两个都不碰各步的工具与思考 —— 那是点某一步才看的东西。
     */
    function setPhasesClosed(t, closed) {
      if (!t) return
      var next = Object.assign({}, phaseOverride)
      var ps = groupPhases(t.steps || [])
      for (var i = 0;i < ps.length;i += 1) next[t.turn + ':' + i] = closed
      viewState.phaseOverride = next
    }

    /**
     * 切视图。
     *
     * ⚠️ 只有**用户点击**才连带展开/收起阶段块；自动切换（实时→看原文、停下→看结构）
     * 不碰它们 —— 否则一轮结束时会"啪"地把所有组收起来，把读到一半的位置顶掉。
     */
    function setView(next) {
      viewState.touchedTurn = curTurnNo
      viewState.manual = next
      setPhasesClosed(turn, next === 'structure')
      saveViewStore()
      forceTick()
    }

    /**
     * 开关自动标题。本地立刻改（按钮马上有反应），同时告诉宿主 ——
     * 生成是在宿主侧做的（那边才知道有没有人在看、缓存里缺哪几步）。
     */
    function setAutoTitles(next) {
      viewState.autoTitles = next
      saveViewStore()
      forceTick()
      fetch(API + '/auto?session=' + encodeURIComponent(sessionId) + '&on=' + (next ? '1' : '0'), { method: 'POST' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          // 宿主说了算（比如它没认这个会话）
          if (d && typeof d.auto === 'boolean' && d.auto !== viewState.autoTitles) {
            viewState.autoTitles = d.auto
            forceTick()
          }
        })
        .catch(function () { /* 宿主没接住就保持本地状态，下次快照会纠正 */ })
    }

    /**
     * 头部**不再挂状态标签**（用户点名去掉）。原先那枚胶囊要报八种状态，
     * 现在每一种都有更靠近事情的出口：
     *   · 推理 / 调用 → 块头的次标题（`runningLabel` 的「推理中」「调用中」）
     *     + 那块呼吸的空心环；步骤行的时长格则改成**实时涨的秒数**（`stepDurMs`）
     *   · 完成 / 中断 → 收尾小结（"这一轮想完了" / "这一轮被中断"）+ 轮头的 `is-cut`
     *   · 就绪 / 空闲 → 本来也没什么信息量
     *
     * 但**两个"面板坏了"的信号必须留着**：读不到会话 / 连不上宿主。
     * 静默的话面板看着像"没事，只是没在跑"，而实际是**没数据** —— 这是两种
     * 完全不同的处境。所以徽章系统（`.tf-badge` / `.is-err`）保留，
     * 只在这两种状态下渲染这一枚。
     */
    var errChip = null
    if (st.state === 'unreadable') errChip = { cls: 'is-err', txt: '异常' }
    else if (sessionId && !st.connected) errChip = { cls: 'is-err', txt: '断线' }
    var renderStep = createStepRenderer(React, {
      expanded, indexOfTurn, navigation, sessionId, titlesRef, skey, notesRef,
      fetchedRef, toggleStep, ensureStepText, view, translation,
    })

    /**
     * 按需取某一步的完整原文。
     *
     * 快照只给"当前步"带原文尾部（一个 turn 实测 7 万字，全带要传几 MB），
     * 所以历史步骤得走 `/step`。取回来就缓存，再展开不再请求。
     */
    function ensureStepText(turnNo, stepNo) {
      var key = skey(turnNo + ':' + stepNo)
      var cache = fetchedRef.current
      if (cache[key] !== undefined) return
      cache[key] = { loading: true }
      forceTick()
      fetch(API + '/step?session=' + encodeURIComponent(sessionId) + '&turn=' + turnNo + '&step=' + stepNo)
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)) })
        .then(function (d) {
          // ⚠️ 这一个接口同时给**思考原文**（`reasoning`）和**正文**（`text`）——
          //    早先只取了 reasoning，正文白扔了（展开区因此从来没有正文可看）。
          cache[key] = { text: (d && d.reasoning) || '', body: (d && d.text) || '', gap: !!(d && d.streamGap) }
        })
        .catch(function (err) { cache[key] = { error: String((err && err.message) || err) } })
        .then(function () { forceTick() })
    }

    /**
     * 生成这一轮的中文标题。
     *
     * 本地规则做不出可靠标题（实测 1/3 猜错，详见 src/titles.ts），所以这一步
     * 是**显式动作**：用户点了才花一次模型调用，结果由宿主落盘缓存。
     */
    function generateTitles(turnNo) {
      // 全局锁：一次只跑一个（不该并发调模型），但"谁在忙"要如实记下来
      if (genState.busyTurn !== null) return
      setGenState({ busyTurn: turnNo, error: null })
      // 已经有标题时按钮是"重新生成" → 带 force 让宿主整轮重算
      var force = Object.keys(titlesRef.current[skey(turnNo)] || {}).length > 0 ? '&force=1' : ''
      fetch(API + '/titles?session=' + encodeURIComponent(sessionId) + '&turn=' + turnNo + force, { method: 'POST' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.ok && d.titles) {
            titlesRef.current[skey(turnNo)] = d.titles
            if (d.turnTitle !== undefined && String(d.turnTitle) !== '') turnTitleRef.current[skey(turnNo)] = String(d.turnTitle)
            if (d.notes) for (var nk in d.notes) if (Object.prototype.hasOwnProperty.call(d.notes, nk)) notesRef.current[nk] = d.notes[nk]
            setGenState({ busyTurn: null, error: null })
          } else {
            setGenState({ busyTurn: null, error: { turn: turnNo, message: (d && d.error) || '生成失败' } })
          }
        })
        .catch(function (e) {
          setGenState({ busyTurn: null, error: { turn: turnNo, message: String((e && e.message) || e) } })
        })
    }

    // 交互状态一律带 turn 前缀：多轮同时展示时，不带前缀会互相串台
    function toggleStep(turnNo, no) {
      var key = turnNo + ':' + no
      var nextE = Object.assign({}, expanded)
      if (nextE[key]) delete nextE[key]; else nextE[key] = true
      viewState.expanded = nextE
      forceTick()
    }
    function togglePhase(turnNo, idx, defaultClosed) {
      var key = turnNo + ':' + idx
      var nextP = Object.assign({}, phaseOverride)
      var isClosed = nextP[key] !== undefined ? nextP[key] : defaultClosed
      nextP[key] = !isClosed
      viewState.phaseOverride = nextP
      forceTick()
    }
    function toggleTurn(turnNo, isCurrent) {
      var key = String(turnNo)
      var nextT = Object.assign({}, turnOverride)
      var isOpen = nextT[key] !== undefined ? nextT[key] : isCurrent
      nextT[key] = !isOpen
      viewState.turnOverride = nextT
      forceTick()
    }

    /** 渲染一个 turn：轮次条 + （展开时）阶段块与自己那块小结。 */
    /**
     * 打开目录（"看更早的轮次"）。
     * 入口是统计行里的「共 N 轮」——**信息即入口**，不加新按钮。
     */
    function openDir() {
      viewState.dirOpen = true
      // ⚠️ **不动** focusTurn：从目录回去应当回到刚才看的那一轮，
      //    而不是被顺手弹回最新那轮（"回去"要真的回得去）
      forceTick()
    }

    /** 骨架里找一轮（目录行/命中行都要它的用户消息当标题）。 */
    function indexOfTurn(n) {
      var idx = skel
      for (var i = 0;i < idx.length;i += 1) if (idx[i].turn === n) return idx[i]
      return null
    }

    /**
     * 轮号步进器能走到的两端。
     *
     * 取的是**全轮骨架**（`st.index`）而不是正文窗口（`turns`）—— 两者不是一回事：
     * 骨架里是全部轮次，正文窗口只有最近 20 轮。用正文窗口当边界的话，
     * 站在最新那轮往前翻，翻到第 20 轮就会被判成"到头"，而其实前面还有 113 轮
     * （冷轮走 `/turn` 按需取，正是「历史」那条路已经打通的能力）。
     *
     * 没有骨架（老快照 / 宿主没给 index）时退回正文窗口 —— 至少不假装能翻到不存在的地方。
     */
    function turnRange() {
      var list = skel
      var lo = null
      var hi = null
      for (var i = 0;i < list.length;i += 1) {
        var n = list[i].turn
        if (lo === null || n < lo) lo = n
        if (hi === null || n > hi) hi = n
      }
      return { lo: lo, hi: hi }
    }

    /**
     * 翻到相邻的一轮。
     *
     * ⚠️ 跳到**最新那轮**时走 `closeFocus()` 而不是 `openFocus()`：后者会把 focusTurn
     *    设成最新轮号，于是轮头上挂一条「回到最新一轮」的返回栏 —— 而你已经在最新那轮了。
     *    这一条只有真点到最后才发现（走一遍步进器就能看到）。
     */
    function stepTo(n) {
      var r = turnRange()
      if (r.lo === null || n < r.lo || n > r.hi) return
      /**
       * ⚠️ 这里曾经有一段"历史态按箭头要先离开目录"的守卫 —— **删了**：
       *    历史态里箭头已经换成 `·`（纯装饰、无功能），`stepBtn` 只在"看某一轮"
       *    那个态里渲染，所以那段代码不可达。留着就是死代码。
       */
      if (n === r.hi) { closeFocus(); return }
      openFocus(n)
    }

    /** 会话最新一轮的轮号（骨架优先 —— 正文窗口只有最近 N 轮）。 */
    function latestTurnNo() {
      var idx = skel
      var hi = null
      for (var i = 0;i < idx.length;i += 1) if (hi === null || idx[i].turn > hi) hi = idx[i].turn
      if (hi !== null) return hi
      var bs = turns.slice().sort(function (a, b) { return b.turn - a.turn })
      return bs.length ? bs[0].turn : null
    }

    /**
     * 「»」跳到最新一轮。
     *
     * ⚠️ 焦点条删掉之后，**这是"你不在实时那轮"唯一的信号** ——
     *    所以不在最新那轮时它是点亮的主色，到最新那轮才置灰。
     *    点它走 closeFocus()（回"跟随最新"模式），不是 openFocus(最新轮号)：
     *    后者会让 focusTurn 停在最新那轮，于是新的一轮开始时面板不再跟随。
     */
    function latestBtn(n, inHistory) {
      var hi = latestTurnNo()
      if (hi === null || n === null) return null
      var back = n < hi
      /**
       * 历史态：`»` **恒可点**（用户："保留 » 作为回到最新轮次的按钮"）。
       * 含义变成"回最新一轮 **并离开目录**" —— 只 `closeFocus()` 的话正文还是目录，
       * 按下去像没反应（历史态里"当前聚焦哪一轮"不是看得见的东西）。
       */
      var on = inHistory === true ? true : back
      return React.createElement('button', {
        className: 'tf-latest' + (on ? ' is-back' : ''), key: 'lat', type: 'button',
        disabled: !on,
        title: inHistory === true
          ? '回到最新一轮（第 ' + hi + ' 轮）'
          : (back ? '跳到最新一轮（第 ' + hi + ' 轮）' : '已经在最新一轮'),
        'aria-label': on ? '回到最新一轮，第 ' + hi + ' 轮' : '已经在最新一轮',
        onClick: function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation()
          if (!on) return
          if (inHistory === true) {
            viewState.dirOpen = false
            searchRef.current.q = ''
          }
          closeFocus()
        },
      }, '»')
    }

    /**
     * 「生成标题」按钮。
     *
     * ⚠️ 它原来是**轮头**里的动作，用户要求挪到第二行、占原来「历史」的位置。
     *    于是这一行变成"轮号 + 标题 + 生成标题" —— 标题就在旁边，动作紧挨着它，
     *    比原来"标题在上面一行、按钮在轮头右侧"更顺。
     *
     * 步数用**骨架**兜底：冷轮（正文还没取回来）在本地没有 steps，
     * 但它确实有内容、也能生成标题 —— 不给兜底的话翻到冷轮按钮就消失了。
     */
    function genTitleBtn(n, stepCount) {
      if (!stepCount) return null
      var has = Object.keys(titlesRef.current[skey(n)] || {}).length > 0
      return React.createElement('button', {
        className: 'tf-gen', key: 'gen', type: 'button',
        disabled: genState.busyTurn !== null,
        title: has ? '重新生成第 ' + n + ' 轮的标题' : '让模型给第 ' + n + ' 轮起个标题',
        onClick: function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation()
          generateTitles(n)
        },
      }, genState.busyTurn === n ? '生成中…' : has ? '重新生成' : '生成标题')
    }

    /** 失败提示挂在**出错的那一轮**上，而不是面板顶部（否则看不出是哪一轮）。 */
    function genTitleErr(n) {
      if (genState.error === null || genState.error.turn !== n) return null
      return React.createElement('span', {
        className: 'tf-gen-err', key: 'ge', title: genState.error.message,
      }, '标题失败')
    }

    /** 「历史」= 全部轮次目录的入口（用户要求挪进标题栏、做成按钮）。 */
    /**
     * 第二行要显示的标题：模型标题 → 本轮用户消息 → （实时开着且在跑）待生成 → 骨架里的用户消息。
     *
     * ⚠️ 最后一层是给**冷轮**兜底的：聚焦一个正文还没取回来的轮次时，
     *    正文里没有 `userText`，但**骨架里有** —— 不兜这一层，翻到冷轮标题位就空了
     *    （而那一栏恰恰是这一行存在的理由）。
     */
    function navTitleOf(n, shown) {
      var model = turnTitleRef.current[skey(n)]
      if (model !== undefined) return { text: model, cls: ' is-model' }
      if (shown && shown.userText !== undefined) {
        return { text: clip(shown.userText, FALLBACK_TITLE_CHARS), cls: ' is-fallback' }
      }
      var listLen = shown ? (shown.steps || []).length : 0
      if (shown && viewState.autoTitles && shown.endedAt === undefined && listLen > 0) {
        return { text: '本轮标题待生成', cls: ' is-pending' }
      }
      var meta = indexOfTurn(n)
      if (meta && meta.userText) {
        return { text: clip(meta.userText, FALLBACK_TITLE_CHARS), cls: ' is-fallback' }
      }
      return null
    }

    /**
     * 进 / 出**历史态**。
     *
     * 历史态 = 「第二行的标题变成搜索框」+「正文区显示目录或搜索结果」。
     * 它原来由头部那枚「历史」按钮切换，现在由**双击轮次标题**（或聚焦后回车）进入 ——
     * 出口有三个，都通向同一件事：
     *   · 输入框里按 `Esc`
     *   · 目录头里的「回到第 N 轮」（`renderDir` 里那枚）
     *   · 选中一条结果（`openFocus` 里本来就会 `dirOpen = false`）
     */
    function openHistory() {
      viewState.dirOpen = true
      forceTick()
    }

    function closeHistory() {
      viewState.dirOpen = false
      // 搜索是一次性动作：退出时**清词**（和目录那套一致，见 searchRef 的说明）
      searchRef.current.q = ''
      forceTick()
    }

    /**
     * 第二行 = 轮次即身份：`‹ 第 N 轮 ›  »  这一轮的标题      历史`
     *
     * 为什么轮号和标题都搬到这一行：面板顶上两行于是各管一件事 ——
     * 第一行「怎么读」（思维链 / 看结构·看原文 / 实时；状态标签已删），
     * 第二行「我在哪 + 这是什么 + 去哪」。
     * 原来轮号在轮头、标题也在轮头，而这一行只报四个**会话合计**（读完一次就没用了）。
     *
     * ⚠️ 这一行在**目录态、冷轮加载态、空态**下都要照常渲染 ——
     *    它就是"翻轮"这个动作的常驻落点，不能跟着正文一起消失。
     */
    function navRow() {
      var byNewest = turns.slice().sort(function (a, b) { return b.turn - a.turn })
      var focused = viewState.focusTurn
      var shown = byNewest[0] || null
      if (focused !== null) {
        shown = null
        for (var i = 0;i < byNewest.length;i += 1) {
          if (byNewest[i].turn === focused) shown = byNewest[i]
        }
      }
      var n = focused !== null ? focused : (shown === null ? null : shown.turn)
      var kids = []

      /**
       * **历史态**：第二行整行变成"搜索行" ——
       *   `共 N 轮    [搜消息 / 标题 / 轮次号]    返回`
       *
       * 用户定的两件事（原话）："在进入历史页面的时候，前面的第 11 轮 改为 共 XX 轮，
       * 生成标题 改为 返回"。于是这一行同时接走了目录头那两件事：
       *   · 「共 N 轮」= 原来目录头的"全部 N 轮，最新在上面"（会话多大）
       *   · 「返回」  = 原来目录头的"回到第 N 轮"（出口）
       * 目录头那一行**整条删掉**了（用户："去掉图1这一行"）。
       *
       * ⚠️ 翻轮那两个箭头与「»」在这一态**不渲染**：正文是目录、不是某一轮，
       *    "翻到上一轮/下一轮"在这里没有意义（`‹ 共 11 轮 ›` 会读成"翻轮数"）。
       *    翻轮控件只属于"看某一轮"那个态。
       */
      if (viewState.dirOpen) {
        /*
         * ⚠️ 前面那一格**和平时同一套结构**（`‹ 数字 ›` + `»`），只把数字文字换成
         *    「共 N 轮」。为什么连箭头一起留着：用户要求"搜索框尽量保持在原位，
         *    减少页面切换的跳变" —— 实测（380px 面板）搜索框原来会**左移 59.4px、
         *    变宽 81.4px**，其中 36.9px 就是"少了箭头那一组"造成的。留着同一套元素
         *    + 给数字格一个固定宽度（`.tf-turn-no{min-width}`），跳变归零。
         *    见 `docs/nav-search.html` 顶上那条实测。
         */
        if (n !== null) {
          kids.push(React.createElement('span', { className: 'tf-turn-nav', key: 'nav' },
            navDot(),
            React.createElement('span', { className: 'tf-turn-no is-count' }, '共 ' + totalTurns + ' 轮'),
            navDot(),
          ))
          /*
           * `»` 保留（用户："保留 » 作为回到最新轮次的按钮"）—— 在历史态里它
           * **恒可点**：含义变成"回最新一轮 **并离开目录**"（只 closeFocus 的话
           * 正文还是目录，按了像没反应）。
           */
          kids.push(latestBtn(n, true))
        } else {
          // 极端情况：正文窗口里一轮都没有（会话全是冷轮）→ 没有 cur 画不了箭头，
          // 但那一格照样占住（两个禁用箭头保持几何形状）
          kids.push(React.createElement('span', { className: 'tf-turn-nav', key: 'nav' },
            navDot(),
            React.createElement('span', { className: 'tf-turn-no is-count' }, '共 ' + totalTurns + ' 轮'),
            navDot(),
          ))
          // `»` 照样要有（历史态里它不依赖"当前聚焦哪一轮"）—— 少了它这一格的宽度
          // 会短 22.5px，搜索框跟着左移（"跳变归零"要求两条分支的几何完全一样）
          kids.push(latestBtn(latestTurnNo(), true))
        }
        kids.push(React.createElement('input', {
          className: 'tf-nav-q', key: 'q', type: 'search',
          // 受控：查询词在 `searchRef` 里，靠 forceTick 重渲染（和目录那套同一个状态）
          value: searchRef.current.q,
          // ⚠️ 这一格只有 ~180px，所以占位语要短；术语用面板统一的「轮次号」。
          //    完整说明在 aria-label 里。
          placeholder: '搜消息 / 标题 / 轮次号',
          'aria-label': '搜索历史轮次（用户消息、轮次标题或轮次号）',
          // 自动聚焦：双击之后手就在键盘上，不该还要再点一下输入框
          autoFocus: true,
          onChange: function (ev) { onSearchInput(ev && ev.target ? ev.target.value : '') },
          onKeyDown: function (ev) {
            // Esc = 退出历史态（清词、标题复原）；其余按键交给输入框自己
            if (ev && ev.key === 'Escape') {
              ev.preventDefault()
              closeHistory()
            }
          },
        }))
        // 行尾「返回」：就是原来「生成标题」那一格（`.tf-gen` 的位置与样式）
        kids.push(React.createElement('button', {
          className: 'tf-nav-back', key: 'back', type: 'button',
          title: '回到这一轮（也可以按 Esc）',
          onClick: function () { closeHistory() },
        }, '返回'))
        return React.createElement('div', { className: 'tf-nav', key: 'navrow' }, kids)
      }

      if (n !== null) {
        kids.push(React.createElement('span', { className: 'tf-turn-nav', key: 'nav' },
          stepBtn(n, -1),
          /*
           * **轮次号可点**：点了在主会话（对话 / 轨迹）里定位到这一轮的用户消息。
           *
           * 为什么是 `<button>` 而不是给 `<span>` 挂 onClick：它是个动作，要能 Tab 到、
           * 能回车触发、读屏能念出来（`.tf-turn-nav-b` 那两枚箭头就是这么做的）。
           * ⚠️ 换成按钮后**必须**由 CSS 把按钮默认样式清干净（见 `.tf-turn-no.is-locate`）：
           *    这一格的宽度是"历史态搜索框不跳变"的基准，字号/内边距一变整行都会挪。
           */
          React.createElement('button', {
            className: 'tf-turn-no is-locate', type: 'button',
            title: '在主会话里定位第 ' + n + ' 轮的用户消息',
            'aria-label': '定位到主会话里第 ' + n + ' 轮的用户消息',
            onClick: function (ev) {
              if (ev && ev.stopPropagation) ev.stopPropagation()
              // 骨架里有这一轮的 seq（`turn/start` 的事件序号）就一起给它 ——
              // 轨迹页靠它调宿主的 `loadThrough`（没有就退回一页一页翻）
              var meta0 = indexOfTurn(n)
              locateMainTurn(sessionId, n, meta0 ? meta0.seq : undefined)
            },
          }, '第 ' + n + ' 轮'),
          stepBtn(n, +1),
        ))
        kids.push(latestBtn(n))
        var info = navTitleOf(n, shown)
        /**
         * 标题那一格：**永远渲染**。
         *
         * ⚠️ 「历史」按钮删掉之后，这一格是**历史入口唯一的落点** ——
         *    所以哪怕这一轮没有标题（系统发起的轮 / 老会话缺 userText，
         *    `navTitleOf` 返回 null）也必须给一个可双击、可聚焦的占位。
         *    不给的话：那种会话里**再也进不去目录**（这正是用户以前报过的
         *    "怎么历史按钮消失了"的同一类问题）。
         */
        kids.push(React.createElement('span', {
          className: 'tf-turn-title' + (info === null ? ' is-empty' : info.cls), key: 'ti',
          // 悬停里两件事：这一轮是什么 + 怎么进历史（入口的唯一提示）
          title: (info === null ? '（这一轮没有标题）' : info.text) + '（双击搜索历史轮次）',
          // 可聚焦 + 回车/空格进入：入口从"看得见的按钮"变成手势之后，
          // 键盘用户不能没有路（鼠标是双击，键盘是回车）
          tabIndex: 0, role: 'button',
          onDoubleClick: function () { openHistory() },
          onKeyDown: function (ev) {
            if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
              ev.preventDefault()
              openHistory()
            }
          },
        }, info === null ? '无标题' : info.text))
      }
      /*
       * 行尾 = 「生成标题」（原来「历史」的位置）。
       * ⚠️ 顺序：标题在前（flex:1 吃掉空位），按钮最后 push —— `.tf-gen` 自带
       *    `margin-left:auto`，只有排在最后才推得动行尾。
       */
      if (n !== null) {
        var stepCount = shown ? (shown.steps || []).length : 0
        if (!stepCount) {
          var meta0 = indexOfTurn(n)
          stepCount = meta0 ? meta0.steps : 0
        }
        var gb = genTitleBtn(n, stepCount)
        if (gb) kids.push(gb)
        var ge = genTitleErr(n)
        if (ge) kids.push(ge)
      }
      /*
       * ⚠️ 一行都没有时**整行不渲染**：新会话（一轮都还没有）里
       *    没有轮号、没有标题、也没有目录可进 —— 留一条空行就是一条莫名其妙的横线。
       */
      if (kids.length === 0) return null
      return React.createElement('div', { className: 'tf-nav', key: 'navrow' }, kids)
    }

    /**
     * 历史态里箭头那一格：一颗 `·`，**纯装饰**。
     *
     * 用户："历史中 将 ‹ › 替换为 · ，并且剥离其原本的功能"。所以它不是控件 ——
     * 没有 `onClick`、不可聚焦、`aria-hidden`（读屏不该念"间隔号"）。
     *
     * ⚠️ 但那一格**必须留着**：它是"进历史态搜索框不跳"的一半 ——
     *    实测少了这一组，搜索框会左移 36.9px（见 `docs/nav-search.html` 顶上那条实测）。
     *    所以盒子、内边距、宽度都和箭头一样，只是里面那颗字换成 `·`。
     */
    function navDot() {
      return React.createElement('span', {
        className: 'tf-turn-nav-b is-dot', 'aria-hidden': 'true',
      }, '·')
    }

    /**
     * 步进器上的一个箭头。
     *
     * 两个细节都是必须的：
     *   · `stopPropagation` —— 轮头自己有点击（展开/折叠这一轮），不拦的话
     *     点箭头会顺带把这一轮折起来，翻过去看到的是个折好的壳。
     *   · 邻居标题写进 `title`/`aria-label` —— 只有"第 N 轮"的数字，
     *     翻之前不知道下一轮是什么，等于闭着眼睛翻（设计稿里这条叫"看得见邻居"）。
     */
    function stepBtn(cur, dir) {
      var n = cur + dir
      var r = turnRange()
      var ok = r.lo !== null && n >= r.lo && n <= r.hi
      var meta = ok ? indexOfTurn(n) : null
      var what = ok && meta !== null && meta.userText
        ? '第 ' + n + ' 轮 · ' + clip(String(meta.userText), FALLBACK_TITLE_CHARS)
        : '第 ' + n + ' 轮'
      var why = dir < 0 ? '这是最早的一轮' : '已经是最新的一轮'
      return React.createElement('button', {
        className: 'tf-turn-nav-b', type: 'button', key: dir < 0 ? 'p' : 'x',
        disabled: !ok,
        title: ok ? what : why,
        'aria-label': (dir < 0 ? '上一轮，' : '下一轮，') + (ok ? what : why),
        onClick: function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation()
          if (ok) stepTo(n)
        },
      }, dir < 0 ? '‹' : '›')
    }

    /**
     * 单独查看某一轮：本地（正文窗口）有就用本地的，没有就**按需从日志取**。
     *
     * 这正是"20 轮之前"那条路：`/turn` 只折那一轮，不折整个会话。
     */
    function openFocus(turnNo) {
      viewState.focusTurn = turnNo
      viewState.dirOpen = false
      /**
       * ⚠️ 必须**主动展开**这一轮：`renderTurn` 里 `open` 默认只有"当前轮"才是 true，
       * 所以不设这个的话，聚焦一个历史轮只会显示一条轮头、**一个步骤都不渲染** ——
       * 点进去就是要读它，结果是个空壳。真机端到端量到"步骤行 0"才发现的。
       * 历史轮次一旦展开，阶段块也会全展开（那是 renderTurn 里已有的规则）。
       */
      turnOverride[String(turnNo)] = true
      var local = null
      for (var i = 0;i < st.turns.length;i += 1) if (st.turns[i].turn === turnNo) local = st.turns[i]
      if (local !== null || coldRef.current[turnNo] === 'loading') { forceTick(); return }
      coldRef.current[turnNo] = 'loading'
      forceTick()
      fetch(API + '/turn?session=' + encodeURIComponent(sessionId) + '&turn=' + turnNo)
        .then(function (r) { return r.json() })
        .then(function (body) {
          if (body && body.ok === true && body.turn) {
            // 形状和快照里的 turns[] 一致（宿主共用同一个序列化），直接塞进去
            st.turns.push(body.turn)
            st.turns.sort(function (a, b) { return b.turn - a.turn })
            delete coldRef.current[turnNo]
          } else {
            coldRef.current[turnNo] = (body && body.error) || '取不到这一轮'
          }
          forceTick()
        })
        .catch(function (e) {
          coldRef.current[turnNo] = String((e && e.message) || e)
          forceTick()
        })
    }

    /** 返回正常列表。 */
    function closeFocus() {
      viewState.focusTurn = null
      forceTick()
    }

    /**
     * 搜索输入：**防抖**（一次击键一个请求太浪费）。
     *
     * ⚠️ 但**立刻**要把视图切到搜索态并置 loading —— 否则防抖那 180ms 里
     *    面板还停在目录上，打了字一点反馈都没有；而且"查询是个轮号"时
     *    那条直达行本来是**本地**就能算出来的，不该等防抖。
     */
    /**
     * 搜索输入。
     *
     * **没有防抖、没有请求**：搜索范围只有"用户消息 + 轮次标题"两样，
     * 而它们都在本地骨架 `st.index` 里 —— 打一个字就能算完（百来行字符串比较）。
     */
    function onSearchInput(v) {
      searchRef.current.q = String(v === undefined || v === null ? '' : v)
      forceTick()
    }

    /**
     * 搜轮次：只搜**用户消息**和**轮次标题**，结果也是轮次。
     *
     * 为什么全在本地算：
     *   ① 这两样都在 `st.index`（全轮骨架）里 → 打一个字就出结果，
     *      不用防抖、不用往返、也不用管宿主装没装检索服务；
     *   ② **轮次标题只能在本地搜** —— 它是这个插件生成的，**不是会话事件**，
     *      任何会话检索服务都索引不到它。
     *
     * @returns 命中项数组；查询为空时 null。
     */
    function matchTurns(q) {
      var needle = String(q).trim().toLowerCase()
      if (needle === '') return null
      var idx = skel
      var out = []
      for (var i = 0;i < idx.length;i += 1) {
        var r = idx[i]
        var user = String(r.userText || '')
        var title = String(r.title || '')
        var inTitle = title.toLowerCase().indexOf(needle)
        var inUser = user.toLowerCase().indexOf(needle)
        if (inTitle < 0 && inUser < 0) continue
        // 哪边命中就用哪边的上下文 —— 标题优先（它是"这一轮干了什么"）
        var src = inTitle >= 0 ? title : user
        var at = inTitle >= 0 ? inTitle : inUser
        out.push({ row: r, inTitle: inTitle >= 0, snippet: snippetOf(src, at, needle.length) })
      }
      return out
    }

    /** 命中点前后各取一段（给 snippet 用）。 */
    function snippetOf(text, at, len) {
      var from = Math.max(0, at - 24)
      var to = Math.min(text.length, at + len + 60)
      return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '')
    }
    var renderDir = createHistoryRenderer(React, {
      searchRef, matchTurns, indexOfTurn, skel, turns, openFocus, snippetNodes,
    })

    /**
     * 面板**一次只显示一轮**：默认最新那轮；`focusTurn` 有值时显示那一轮。
     *
     * 为什么不再"列出最近 20 轮"：那和「历史」是同一件事的两种做法 ——
     * 面板里那 20 行轮头既占地方，又**带你去不了 20 轮之外**。
     * 现在：面板 = 一轮；要找别的轮次走「历史」→ 目录（全部轮次）。
     */
    function renderOneTurn() {
      // 按轮号**降序**取最新（用 sort 不用 reverse：宿主万一乱序，reverse 只会原样翻过来）
      var byNewest = turns.slice().sort(function (a, b) { return b.turn - a.turn })
      var focused = viewState.focusTurn
      var shown = byNewest[0]
      if (focused !== null) {
        shown = null
        for (var i = 0;i < byNewest.length;i += 1) {
          if (byNewest[i].turn === focused) shown = byNewest[i]
        }
      }
      var kids = []
      /*
       * ⚠️ 这里原来还有一条「焦点条」（第 N 轮（时间，步数）回到最新一轮）—— **删掉了**。
       *    它报的轮号轮头/导航行里都有，时间与步数目录里有；"回到最新"挪到导航行的「»」。
       *    删它的收益是正文顶上少一整行（约 30px），而这一行**每一轮都在**。
       */
      if (shown !== null && shown !== undefined) {
        kids.push(renderTurn(shown, shown === byNewest[0]))
      } else if (focused !== null) {
        // 聚焦的那一轮还没到本地（冷轮正在按需取）—— 别偷偷显示最新那轮
        var cold = coldRef.current[focused]
        var msg = cold === 'loading' ? '正在从日志读第 ' + focused + ' 轮…'
          : (typeof cold === 'string' ? '取不到第 ' + focused + ' 轮：' + cold : '这一轮还没有取回来。')
        /*
         * 冷轮在取的这段时间里步进器**不会消失** —— 它现在常驻在第二行（`navRow()`），
         * 不跟正文一起走。所以这里只报状态，不用再自己补一份控件。
         */
        kids.push(React.createElement('div', { className: 'tf-empty', key: 'e' }, msg))
      }
      return kids
    }

    function renderTurn(t, isCurrent) {
      var dd = isCurrent ? d : derive(t)
      var list = dd.list
      var key = String(t.turn)
      var open = turnOverride[key] !== undefined ? turnOverride[key] : isCurrent
      var tokens = dd.tokens
      var tools = dd.tools
      var titleMapOfTurn = titlesRef.current[skey(t.turn)] || {}
      var hasTitlesOfTurn = Object.keys(titleMapOfTurn).length > 0
      var tInterrupted = t.interrupted === true
      var tFinished = t.endedAt !== undefined

      /*
       * ⚠️ 标题那一段逻辑（模型标题 → 用户消息降级 → 待生成）**搬到了 `navTitleOf()`** ——
       *    标题现在长在第二行（轮次即身份），轮头不再需要它。
       */
      /*
       * ⚠️ 轮号（`.tf-turn-nav`）与标题（`.tf-turn-title`）**都不在这里** ——
       *    它们搬到了第二行的 `navRow()`。轮头从此恒为一行：
       *    步数 / Token / 工具 + 生成标题 + 折叠箭头。
       */
      var headKids = [
        React.createElement('span', { className: 'tf-turn-meta', key: 'm' },
          React.createElement('span', null, list.length + ' 步'),
          React.createElement('span', null, fmtK(tokens) + ' tok'),
          tools ? React.createElement('span', null, tools + ' 次工具') : null,
        ),
      ]
      /*
       * ⚠️ 「生成标题」与它的失败提示**都搬到了第二行**（占原来「历史」的位置）——
       *    轮头从此只剩：步数 / Token / 工具 + 折叠箭头。
       */
      headKids.push(React.createElement('span', { className: 'tf-chev', key: 'c' }, open ? '▾' : '▸'))

      var kids = [
        React.createElement('div', {
          className: 'tf-turn-h' + (isCurrent ? ' is-current' : '') + (tInterrupted ? ' is-cut' : ''),
          key: 'h',
          onClick: function () { toggleTurn(t.turn, isCurrent) },
        }, headKids),
      ]

      if (open) {
        var blocks = dd.phases.map(function (phase, idx) {
          // 默认：最新一轮只展开"当前所在阶段"；历史轮次既然被主动展开，就全部展开给读。
          // ⚠️ 例外：**实时看过的那一轮不折叠**（生成中 + 生成结束后都不收），
          // 见 liveTurnRef 的说明。
          var defaultClosed = isCurrent && liveTurnRef.current !== t.turn ? idx !== dd.activePhase : false
          var pkey = t.turn + ':' + idx
          var closed = phaseOverride[pkey] !== undefined ? phaseOverride[pkey] : defaultClosed
          var ptokens = 0
          var ptools = 0
          for (var q = 0;q < phase.steps.length;q += 1) {
            ptokens += phase.steps[q].reasoningTokens || 0
            ptools += (phase.steps[q].tools || []).length
          }
          var ranges = stepRanges(phase.steps)
          var s0 = phase.steps[0].step
          var s1 = phase.steps[phase.steps.length - 1].step
          // 连续的块给区间（能看出在这一轮的哪一段）；**合并过的块**步骤号有洞，
          // 列出来是一长串（实测有 70 字的），改成给步数，完整清单放 title
          var spanText = s1 - s0 === phase.steps.length - 1
            ? '#' + (s0 === s1 ? s0 : s0 + '–' + s1)
            : phase.steps.length + ' 步'
          /*
           * 这一块**还在跑**吗？判据是"活跃步就在这一块里" ——
           * ⚠️ 不能用 `is-on`：`activePhase` 在没有活跃步时取最后一块（那是"你在这"），
           *    拿它当"进行中"会把**已完成的轮次**也染上状态色。见 CSS 里那段说明。
           * 等待态（工具还没回来）再挂 `is-wait`：颜色走宿主的等待语义（琥珀）。
           */
          var phaseRunning = running && activeStep !== null && phase.steps.indexOf(activeStep) >= 0
          var phaseWaiting = phaseRunning && activeStep.status === 'waiting'
          /*
           * 进行中的块：**主标题是"第 N 步"（步骤号）**，把"状态词"（推理中 / 调用中）降成**次标题**。
           *
           * 为什么：块头那一行是面板上最显眼的一行。已经完成的块用分类名词占它（读代码 / 跑命令），
           * 那是在回答"这一块干了什么"；进行中的块如果只写「推理中」，这一行就只回答了"它还在动"。
           * 换成步骤号之后，这一行回答的是**"现在跑到哪一步了"** —— 和右侧导航行的
           * 「第 N 轮」是同一套读法（轮号 + 步号），只是粒度小一级。
           *
           * ⚠️ 用"第 N 步"而不是"#N"：`#N` 是**行内**的紧凑记法（步骤行、块头的元信息里在用），
           *    块头这一行有空间，用「第 N 步」和导航行的「第 N 轮」读起来是一家人。
           * ⚠️ 和步骤标题的区别：步骤标题（读 index.js / 搜 xxx）已经在**步骤行**上了，
           *    块头再写一遍就是同一句话说两遍（用户看过这一版后改成了步骤号）。
           */
          var runStepNo = phaseRunning ? activeStep.step : 0
          return React.createElement('div', {
            className: 'tf-phase cat-' + phase.cat + (closed ? ' is-closed' : '') + (!closed && idx === dd.activePhase && isCurrent ? ' is-on' : '')
              + (phaseRunning ? ' is-running' + (phaseWaiting ? ' is-wait' : '') : ''),
            key: idx,
          },
            React.createElement('div', { className: 'tf-phase-h', onClick: function () { togglePhase(t.turn, idx, defaultClosed) } },
              React.createElement('span', { className: 'tf-bar' }),
              // 进行中的块：主标题是「第 N 步」，状态词退到它后面当次标题
              phaseRunning
                ? [
                  React.createElement('span', { className: 'tf-phase-name', key: 'n' }, '第 ' + runStepNo + ' 步'),
                  React.createElement('span', { className: 'tf-phase-sub', key: 's' }, phase.label || phase.family),
                ]
                : React.createElement('span', { className: 'tf-phase-name' }, phase.label || phase.family),
              React.createElement('span', { className: 'tf-phase-meta' },
                /*
                 * 区间（`#17–19`）**进行中的块不报**（用户："仅保留标题的步骤号"）。
                 * 进行中的块只有一个步骤（见 groupPhases），区间就是那一步的号 ——
                 * 和块头的「第 N 步」一字不差，报两遍。落地之后块头改说分类名，
                 * 身份才轮到区间来报，那时它自己会回来。
                 */
                phaseRunning ? null : React.createElement('span', { className: 'tf-span', title: '#' + ranges }, spanText),
                React.createElement('span', null, fmtK(ptokens) + ' tok'),
                ptools ? React.createElement('span', null, ptools + ' 工具') : null,
              ),
            ),
            React.createElement('div', { className: 'tf-phase-b' },
              // 行内是否要显示步骤号：**进行中的块不显示**（标题补位前移），见 renderStep
              phase.steps.map(function (x) { return renderStep(x, t.turn, t.endedAt, phaseRunning) })),
          )
        })

        // 收尾小结：回答"思考花在哪了"
        if (tFinished || tInterrupted) {
          var barTotal = 0
          for (var bi = 0;bi < dd.merged.length;bi += 1) {
            for (var bj = 0;bj < dd.merged[bi].steps.length;bj += 1) barTotal += dd.merged[bi].steps[bj].reasoningTokens || 0
          }
          blocks.push(React.createElement('div', { className: 'tf-recap', key: 'recap' },
            React.createElement('div', { className: 'tf-recap-t' }, tInterrupted ? '这一轮被中断' : '这一轮想完了'),
            React.createElement('div', { className: 'tf-recap-s' },
              list.length + ' 步，思考 ' + fmtK(tokens) + ' tok，调用工具 ' + tools + ' 次'),
            React.createElement('div', { className: 'tf-recap-bars' },
              dd.merged.map(function (ph, pi) {
                var c = 0
                for (var q = 0;q < ph.steps.length;q += 1) c += ph.steps[q].reasoningTokens || 0
                var w = barTotal ? (c / barTotal) * 100 : 0
                // 颜色 = 活动分类（与块、图例同一套），宽度 = 该类的思考 Token。
                // 不按序号调透明度（那会让后面的段直接看不见，见 CSS 里的说明）
                return React.createElement('i', { key: pi, className: 'cat-' + ph.cat, style: { width: w + '%' } })
              }),
            ),
            React.createElement('div', { className: 'tf-recap-lg' },
              dd.merged.map(function (ph, pi) {
                var c = 0
                for (var q = 0;q < ph.steps.length;q += 1) c += ph.steps[q].reasoningTokens || 0
                // 图例是**小结**：只给"哪类活动 + 多少 Token"（条的宽度就是这个数）。
                // 步骤区间在块头里（那里才有地方放），塞进来会把图例撑成一堵墙。
                // 0 Token 的块改报**步数**：报"0"看着像坏了，报"4 步"才说清
                // "这类活干了 4 步、但没产出思考"。
                return React.createElement('span', { key: pi, className: 'cat-' + ph.cat },
                  React.createElement('b', null),
                  (ph.label || ph.family) + ' ' + (c > 0 ? fmtK(c) : ph.steps.length + ' 步'))
              }),
            ),
          ))
        }
        kids.push(React.createElement('div', { className: 'tf-turn-b', key: 'b' }, blocks))
      }

      return React.createElement('div', { className: 'tf-turn', key: t.turn }, kids)
    }

    var body
    // 目录是"**页**"：接管面板
    if (viewState.dirOpen) {
      body = renderDir()
    } else if (!sessionId) {
      body = React.createElement('div', { className: 'tf-empty' },
        '当前没有绑定会话。', React.createElement('br'), '打开一个会话后，这里会实时显示它的思考过程。')
    } else if (turns.length === 0) {
      if (st.state === 'unreadable') {
        // 与"新会话还没有步骤"区分开：这两种情况的下一步动作完全不同
        body = React.createElement('div', { className: 'tf-empty' },
          '读不到这个会话的思考记录。',
          React.createElement('br'),
          React.createElement('span', null, '会话可能已被删除，或正被另一个进程占用（同一会话同时只能有一个写入者）。'))
      } else if (st.state === 'empty') {
        body = React.createElement('div', { className: 'tf-empty' },
          '这个会话还没有开始推理。',
          React.createElement('br'),
          React.createElement('span', null, '模型一旦开始想，第一步会立刻出现在这里。'))
      } else {
        body = React.createElement('div', { className: 'tf-empty' },
          st.connected ? '已连上宿主，等待这一轮开始推理。' : '正在连接宿主…',
          React.createElement('br'),
          React.createElement('span', null, '模型一旦开始想，第一步会立刻出现在这里。'))
      }
    } else {
      body = renderOneTurn()
    }

    return React.createElement('div', { className: 'tf-root' },
      React.createElement('div', { className: 'tf-head' },
        React.createElement('span', { className: 'tf-title' }, '思维链'),
        React.createElement('span', { className: 'tf-toggle' },
          React.createElement('button', {
            className: view === 'structure' ? 'is-on' : '',
            onClick: function () { setView('structure') },
          }, '看结构'),
          React.createElement('button', {
            className: view === 'raw' ? 'is-on' : '',
            onClick: function () { setView('raw') },
          }, '看原文'),
        ),
        /**
         * 「中文」三态按钮：标签永远是两个字「中文」，只靠**亮 / 呼吸**表达状态。
         *
         * · 不亮                 = 关
         * · 常亮（淡蓝）          = 开：只在展开某一步时翻译
         * · 常亮（实心蓝）+ 呼吸  = 实时：流式输出时边写边翻
         *
         * 悬停 title 说明"现在是什么状态 + 点一下会发生什么"。
         * 实时用实心蓝而不是同一档淡蓝：`prefers-reduced-motion` 下没有呼吸，
         * 仍要靠填充深浅和"开"分开。宿主没装 translator 时禁用并说明原因。
         */
        React.createElement('button', {
          className: 'tf-zh' + (tlEnabled() ? ' is-on' : '')
            + (tlMode() === 'live' ? ' is-live' : ''),
          key: 'zh',
          'aria-label': '中文翻译：' + (tlMode() === 'live' ? '实时' : tlMode() === 'demand' ? '开，按需' : '关'),
          'aria-pressed': tlEnabled() ? 'true' : 'false',
          disabled: !tlStore.available,
          title: !tlStore.available
            ? '中文翻译：不可用 —— 需要官方 translator 插件（@deepseek-ai/dsh-experimental-translator），装好后刷新页面'
            : tlMode() === 'live'
              ? '中文翻译：实时 —— 流式输出时边写边翻。点一下关闭'
              : tlMode() === 'demand'
                ? '中文翻译：开（按需）—— 只在展开某一步时翻译。点一下切到实时'
                : '中文翻译：关。点一下开启（只在展开某一步时翻译）',
          onClick: function () {
            if (!tlStore.available) return
            tlCycleMode()
          },
        }, '中文'),
        /**
         * 「实时」开关：位置不变（视图分段控件之后）。
         *
         * ⚠️ 它原来夹在「看原文」和**状态徽章**之间，注释里写着"圆点让给状态徽章独占
         *    （有圆点 = 状态，无圆点 = 控件）"。状态徽章删掉之后，那个圆点的约定
         *    只在**异常 / 断线**兜底那一枚上还成立（见 `errChip`）。
         *
         * 形态取自设计稿 `docs/realtime-toggle-2.html` 的 **A 方案（去点胶囊）**：
         * 开关状态靠**填充**区分，用的是分段控件选中态那套色。
         * 默认**关** —— 它花的是模型调用，不该默认替用户花。
         */
        React.createElement('button', {
          // 开着就**呼吸**（只要主会话在跑）；宿主正在生成一批时也呼吸 ——
          // 它是"这件事正在发生"的常驻提示，不是一个只在点击瞬间闪一下的反馈。
          className: 'tf-live' + (viewState.autoTitles ? ' is-on' : '')
            + (viewState.autoTitles && (running || st.autoBusy) ? ' is-busy' : ''),
          key: 'live',
          'aria-pressed': viewState.autoTitles ? 'true' : 'false',
          title: viewState.autoTitles
            ? (st.autoBusy ? '实时标题：正在生成这一批…' : '实时标题：开 —— 边跑边自动生成，会花模型调用；点一下关掉')
            : '实时标题：关 —— 只有点「生成标题」才调用模型；点一下打开',
          onClick: function () { setAutoTitles(!viewState.autoTitles) },
        }, '实时'),
        // 状态标签已删；只留"面板坏了"这一枚（异常 / 断线），其余时候这里是空的
        errChip === null ? null : React.createElement('span', { className: 'tf-badge ' + errChip.cls },
          React.createElement('span', { className: 'tf-dot' }), errChip.txt),
        /*
         * ⚠️ 这一行原来最右是「历史」按钮 —— 用户把它**删掉**了：
         *    "不要浮层，我想用它来代替真正的历史的入口"
         * 入口搬到了**第二行的轮次标题上：双击（或聚焦后回车）就地变搜索框**，
         * 目录 / 搜索结果照旧渲染在正文区（`renderDir()`），不是浮层。
         *
         * ⚠️ 可发现性因此从"一个看得见的按钮"变成"一个手势"，所以补了两样：
         *    · 标题的 `title`（悬停能看到"双击搜索历史轮次"）
         *    · 标题可聚焦（`tabIndex=0`）+ 回车/空格进入 —— 键盘用户还有路
         * 零轮会话第二行整行不渲染 → 天然没有这个入口（也没有目录可进）。
         */
      ),
      navRow(),
      React.createElement('div', {
        className: 'tf-body' + (viewState.dirOpen ? ' is-dir' : ''),
        ref: bodyRef, onScroll: onBodyScroll,
      }, body),
    )
  }

  /**
   * 标签页外壳：按 sessionId 强制重挂载内层。
   *
   * 为什么需要：`sidebar.right.pane.tab` 是按**类型 id** 挂载的，会话切换时
   * 拿到的是**同一个组件实例换了 props**，不是新实例。于是所有交互状态都会
   * 跨会话留下来 —— 上一个会话展开的步骤、展开的轮次、阶段覆盖、跟随位置，
   * 切过去以后照样生效（表现是"新会话一打开就自己展开了几步"）。
   *
   * 用 `key` 把实例按会话切开，React 整体重挂载，状态一次性归零。
   * 不放在 `useEffect` 里逐个 reset：effect 在渲染**之后**跑，
   * 会先渲染一帧上一个会话的形态（可见的闪一下），key 没有这个问题。
   */
  function ThinkFlowTabHost(props) {
    var raw = props && props.sessionId ? String(props.sessionId) : ''
    /**
     * ⚠️ 只在**真的换了会话**时才换 key。
     *
     * sessionId 短暂变空（框架重跑 inject 的瞬间、或侧栏重挂）不能换 —— 一换就整体
     * 重挂载，用户在这一轮里的视图选择全丢（真机表现：隐藏的历史轮次又冒出来、
     * 看原文又变回看结构）。用 ref 记住最近一次**非空**的会话 id。
     * （视图开关本身也已经挪到模块级，这里再加一道。）
     */
    var lastRef = React.useRef(raw)
    if (raw !== '') lastRef.current = raw
    var id = lastRef.current
    return React.createElement(ThinkFlowTab, { key: id || 'no-session', sessionId: id })
  }
  return { ThinkFlowTab, ThinkFlowTabHost, snippetNodes }
}
