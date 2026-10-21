import { createPanel } from './panel.js'
import { fmtK, fmtDur, stepDurMs } from './rules/format.js'
import { commandOf, cmdTitle, cmdActivity } from './rules/commands.js'
import { toolArgsTitle, toolTitleRuns, runText, stepTitleLines, cleanProse, excerptOf, DOT, THINK_TITLE, stepHasThinking, noTitleNote, stepOwnTitle } from './rules/titles.js'
import { FAMILY_EXACT, FAMILY_PREFIX, toolFamily, familyOf, CATEGORY_OF, phaseCategory, mergeByLabel, stepRanges, stepSettled, phaseSettled, runningLabel, phaseLabel, groupPhases, PHASE_GAP_MS } from './rules/phases.js'
import { createTranslationController } from './translation.js'
import { createHostNavigation } from './host-navigation.js'
import { createViewState } from './view-state.js'
import { createStyles } from './styles.js'
import { emptyState, applyChange, isPinned, shouldFollow } from './trace-state.js'

/**
 * @yfwu2020/dsh-think-flow —— 浏览器端（右侧栏「思维链」标签页）。
 *
 * 本文件是 DSH 客户端 bundle 的源文件（ModuleLoader 懒加载 CJS 表格式）：
 * 顶层只注册工厂，真正的副作用（React 组件、SSE 连接、样式）都在 factory 被
 * materialize 时执行，且整体挂在 ctx.effect / ctx.slots.inject 下 —— 插件停用
 * 或热重载时可逆清理。
 *
 * 模块入口只组装服务并注册标签页。交互在 panel.js，步骤和历史展示在
 * components/，展示规则在 rules/，样式使用 styles.css 的宿主 token。
 * 状态以宿主下发的事实为准；模块持有的状态都在 factory 内创建，保留热重载隔离。
 *
 * 自检钩子：window.__dshThinkFlow（仅供调试/自动化验证）。
 */
window.__ModuleLoader__.load({
  id: '@yfwu2020/dsh-think-flow',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var API = '/think-flow/api'
    var translation = createTranslationController(API)
    var { loadTranslatePref, tlStore, tlMode, tlLive, tlCycleMode, tlFragments, tlIsMostlyChinese, tlNeedsTranslation, tlCompose, tlTail } = translation
    var navigation = createHostNavigation()
    var { locateStop, mainContent, mainViewOf, chatTurnRow, turnOfMark, railMarkOf, trajTurnRow, trajStepKey, trajStepOf, trajRowByKey, trajRenderedTurns, locateInTrajectory, locateMainTurn, locateMainStep } = navigation
    var viewStateController = createViewState()
    var { VIEW_STORE_KEY, viewStateOf, loadViewStore } = viewStateController
    var styles = createStyles()
    var { CSS, CSS_ID, injectCss, releaseCss, ensureCss } = styles
    var { ThinkFlowTabHost } = createPanel(React, { API, translation, navigation, styles, viewStateController })

    /** 标签页类型标识：注册类型、挂 body、开标签三处必须一致。 */
    var TAB_ID = '@yfwu2020/dsh-think-flow'
    var TAB_KIND = 'think-flow'

    /**
     * 会话头部那个入口的图标：**折线轨迹**。
     *
     * 一条带拐点的折线 + 三个节点 —— 论文里画"推理路径"就是这个形状：
     * 起步、转向、收束。斜向构图也让它与紧邻的两个"圆角方块 + 内条"图标
     * （停靠切换、侧栏展开）在轮廓上完全拉得开。
     *
     * 候选对比见 `docs/icon-options.html`（`npm run icons`）：24 个候选都在
     * 16px / 32px / 64px 三档下评估过 —— 图标必须在实际 16px 下判断。
     * @param size - 边长，默认 16。
     * @param className - 宿主（引导页）会传下来，照转，别吞掉。
     */
    function thinkIcon(size, className) {
      var s2 = size || 16
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: s2, height: s2, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        ...(className ? { className: className } : {}),
        'aria-hidden': 'true', focusable: 'false',
      },
        React.createElement('path', { d: 'M2.7 12.7L6.1 8.5l3 2.5 4.3-6.3', key: 'p' }),
        React.createElement('circle', { cx: 2.7, cy: 12.7, r: 1.5, key: 'c1' }),
        React.createElement('circle', { cx: 9.1, cy: 11, r: 1.5, key: 'c2' }),
        React.createElement('circle', { cx: 13.4, cy: 4.7, r: 1.5, key: 'c3' }),
      )
    }

    /** 供引导页用的图标组件。宿主按 IconProps 契约传 { size, className }。 */
    function ThinkIcon(props) {
      return thinkIcon((props && props.size) || 16, props && props.className)
    }

    // ────────────────────────────── 挂载 ──────────────────────────────

    function apply(ctx) {
      // 诊断探针：在浏览器控制台一眼确认"客户端到底加载了没有"。
      // 排查时最怕分不清"客户端没加载"和"加载了但没注册上"，所以 apply
      // 一进来就留痕，并把注册结果回填。
      var probe = (window.__dshThinkFlow = window.__dshThinkFlow || {})
      probe.applied = true
      probe.internals = exports.__internals
      /**
       * 定位（点轮次号 → 主会话跳过去）要用宿主会话控制器翻历史，所以把 ctx 记下来 ——
       * 点击回调在组件里，拿不到 apply 的参数。
       */
      navigation.bindContext(ctx)
      ctx.effect(function () { return function () { locateStop() } }, 'dsh-think-flow: locate timers')
      /** 头部入口的注册事实：控制台可核对（order 越小越靠左）。 */
      probe.headerEntry = { id: 'dsh-think-flow:open', order: 9, icon: 'spine+steps' }
      probe.open = function () {
        var right = ctx.get ? ctx.get('sidebarRight') : undefined
        if (right && typeof right.openTab === 'function') { right.openTab(TAB_KIND); return true }
        return false
      }

      // 样式注入（一份 + 引用计数，见上面「样式的一生」那段 —— 这里踩过真机的坑）
      var cssHold = injectCss()
      ctx.effect(function () { return function () { releaseCss(cssHold) } }, 'dsh-think-flow: css')

      if (!ctx.slots || typeof ctx.slots.inject !== 'function') {
        probe.error = 'ctx.slots 不可用'
        return
      }

      // ① 注册标签页**类型**（第一阶段：这是什么）
      //
      // 两个坑都在这里，都是真机踩出来的：
      //   ① 服务可能比本插件晚就绪。在 effect 外面做一次 ctx.get 判断是错的 ——
      //      服务没到就永远不注册，而且连重试的 effect 都没装上，标签页死活不出现。
      //   ② 把 sidebarRightTabs 写进 exports.inject 换顺序也不行：那会让插件
      //      硬等这个服务，名字或时机一旦不对就是**整个插件不加载**，比原 bug 更糟。
      // 正确做法是 ctx.inject([...], cb)：嵌套作用域，依赖就绪才物化。
      ctx.effect(function () {
        return ctx.inject(['sidebarRightTabs'], function (scoped) {
          var tabs = scoped.get('sidebarRightTabs')
          if (!tabs || typeof tabs.register !== 'function') { probe.tabType = '服务未就绪'; return }
          probe.tabType = 'registered'
          return tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: function () { return '思维链' },
            guide: [{
              order: 40,
              title: function () { return '思维链' },
              description: function () { return '实时看模型在怎么想：每一步、工具调用、等待' },
              icon: ThinkIcon,
            }],
          })
        })
      }, 'dsh-think-flow: tab type')

      // ② 注册标签页**内容**（第二阶段：它长什么样）
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          probe.tabBody = 'registered'
          return ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            inject: function (sessionId) { return { sessionId: sessionId } },
          }, ThinkFlowTabHost)
        })
      }, 'dsh-think-flow: tab body')

      // ③ 会话头部放一个开标签的按钮。
      // list 类插槽按 id 增量注册 —— 缺 id 等于没注册（真机踩过：按钮不出现）。
      ctx.effect(function () {
        return ctx.slots.inject('conversation.session.header.utilities', function () {
          probe.headerButton = 'registered'
          return ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'dsh-think-flow:open',
            // order 越小越靠左（实测：order 10 的项排在 order 30 的左边 → 升序）。
            // 目标位置是**紧挨 better-sidebar 的停靠切换（order 10）的左侧**：
            //   · 写 30 会排到它右边（夹在它与原生侧栏展开之间）
            //   · 写 -100 会越到"更多菜单（…）"左边（那个也在 utilities 里）
            // 所以取 10 之下、其余项之上的 9。
            // ⚠️ 这是相对另一个插件的 order 定位的，对方改了值就要跟着调。
            order: 9,
            registrant: 'dsh-think-flow',
          }, function OpenButton() {
            return React.createElement('button', {
              className: 'tf-open',
              type: 'button',
              title: '思维链',
              'aria-label': '思维链',
              onClick: function () { probe.open() },
            }, thinkIcon())
          })
        })
      }, 'dsh-think-flow: open button')
    }

    exports.apply = apply
    // 只声明**硬依赖**：slots 是所有客户端插件都有的。
    // sidebarRight / sidebarRightTabs 是可选能力（没装右栏也该能降级），
    // 所以走 ctx.inject 软依赖 —— 硬等的代价是：服务名或时机不对就整个插件不加载。
    exports.inject = ['slots']
    // 纯函数暴露给测试与预览（无副作用，不含可变状态）。
    exports.__internals = {
      groupPhases: groupPhases,
      mergeByLabel: mergeByLabel,
      phaseCategory: phaseCategory,
      stepRanges: stepRanges,
      CATEGORY_OF: CATEGORY_OF,
      toolFamily: toolFamily,
      familyOf: familyOf,
      cmdActivity: cmdActivity,
      cmdTitle: cmdTitle,
      toolArgsTitle: toolArgsTitle,
      toolTitleRuns: toolTitleRuns,
      runText: runText,
      stepTitleLines: stepTitleLines,
      commandOf: commandOf,
      phaseLabel: phaseLabel,
      stepSettled: stepSettled,
      phaseSettled: phaseSettled,
      runningLabel: runningLabel,
      FAMILY_EXACT: FAMILY_EXACT,
      FAMILY_PREFIX: FAMILY_PREFIX,
      applyChange: applyChange,
      emptyState: emptyState,
      fmtK: fmtK,
      fmtDur: fmtDur,
      /** 时长那条公式（纯函数）：活跃步按 `now` 涨、结束的步定格。测试直接喂 now 验。 */
      stepDurMs: stepDurMs,
      /** 无工具步的名字：正文摘要 / 没有正文时给空串（行里改画「思考」或那三个点）。纯函数，测试直接喂文本验。 */
      excerptOf: excerptOf,
      cleanProse: cleanProse,
      stepOwnTitle: stepOwnTitle,
      /** 只有思考、还没正文时行里那句（用户定的）。 */
      THINK_TITLE: THINK_TITLE,
      /** 什么都没有时行里那三个点用的字符（`·` 在中线上；`…` 落在基线上，太低）。 */
      DOT: DOT,
      /** 有没有收到过思考（行里"画「思考」还是画三个点"就按它分）。 */
      stepHasThinking: stepHasThinking,
      /** 没有标题时的悬停说明（0/0/0 与"只有思考"在这里分开）。 */
      noTitleNote: noTitleNote,
      TAB_ID: TAB_ID,
      TAB_KIND: TAB_KIND,
      PHASE_GAP_MS: PHASE_GAP_MS,
      /** 机翻的段落切法（纯函数）：测试直接喂文本验边界 / 超长切分。 */
      fragmentsOf: tlFragments,
      /** 中英判定（纯函数）：本来就是中文的段落不送翻。 */
      isMostlyChinese: tlIsMostlyChinese,
      /** "这段要不要翻"（目标语是中文时才跳过中文段落）。 */
      needsTranslation: tlNeedsTranslation,
      /** 拼显示文本（整段）：已翻的段落换译文、没翻的保留原文。 */
      composeThinking: tlCompose,
      /** 拼显示文本（只要尾部 n 个字符）。 */
      composeTail: tlTail,
      /** 当前三态：`live` / `demand` / `off`（没设置过按 live）。 */
      translateMode: tlMode,
      /** 实时模式才会翻折叠态那条尾巴。 */
      liveTranslates: tlLive,
      /** 点一下换下一个状态：实时 → 按需 → 关 → 实时。 */
      cycleTranslateMode: tlCycleMode,
      /** 机翻状态（只读）：面板与测试都从这里看"服务在不在 / 有没有失败"。 */
      translateState: tlStore,
      /** 清机翻状态（**只给测试用**）：缓存、失败标记、开关一起归零。 */
      resetTranslations: function () {
        tlStore.cache.clear()
        tlStore.failed.clear()
        tlStore.queue.length = 0
        tlStore.queued.clear()
        tlStore.inflight.clear()
        tlStore.listeners.clear()
        tlStore.available = false
        tlStore.checked = false
        tlStore.checking = false
        tlStore.pref = loadTranslatePref()
      },
      CSS: CSS,
      /**
       * 样式的一生（**给测试用**）：见上面「样式的一生」那段。
       * 真机上只有 apply / 面板挂载 / 500ms 自愈三处会碰它们。
       */
      injectCss: injectCss,
      releaseCss: releaseCss,
      ensureCss: ensureCss,
      CSS_ID: CSS_ID,
      /**
       * 清掉模块级视图状态（**只给测试用**）。
       *
       * 视图开关按会话存在模块级、跨重挂载存活（见 viewStateOf），所以测试里
       * "重新挂载"必须连它一起清 —— 否则上一个用例点过的「隐藏历史」会漏到下一个用例。
       */
      resetViewStore: function () {
        viewStateController.store = {}
        try {
          if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(VIEW_STORE_KEY)
        } catch (e) { /* 忽略 */ }
      },
      /** 重新从 localStorage 读一次 —— 用来模拟"模块被重新求值"（刷新/重新 import）。 */
      reloadViewStore: function () { viewStateController.store = loadViewStore() },
      viewStateOf: viewStateOf,
      isPinned: isPinned,
      shouldFollow: shouldFollow,
      /**
       * 主会话定位（点轮次号 → 跳到那一轮）。
       *
       * 这一组是**真的碰宿主 DOM** 的代码，而真机上它出问题的表现是"点了没反应"——
       * 所以拆开暴露：判定（视图/刻度/轨迹行）都是纯读 DOM 的函数，测试喂桩 DOM 直接验；
       * `locateMainTurn` 是总入口，端到端用例喂一棵假的主会话 DOM 走完整条路。
       */
      locateMainTurn: locateMainTurn,
      locateMainStep: locateMainStep,
      locateStop: locateStop,
      trajStepKey: trajStepKey,
      trajStepOf: trajStepOf,
      trajRowByKey: trajRowByKey,
      mainContent: mainContent,
      mainViewOf: mainViewOf,
      chatTurnRow: chatTurnRow,
      railMarkOf: railMarkOf,
      turnOfMark: turnOfMark,
      trajTurnRow: trajTurnRow,
      trajRenderedTurns: trajRenderedTurns,
      locateInTrajectory: locateInTrajectory,
    }
    return module.exports
  },
})
