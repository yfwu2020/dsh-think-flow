import { fmtK, fmtDur, stepDurMs } from '../rules/format.js'

import { toolTitleRuns, runText, stepTitleLines, cleanProse, DOT, THINK_TITLE, stepHasThinking, noTitleNote, stepOwnTitle } from '../rules/titles.js'

/** Render one step from current view state and explicit interaction callbacks. */
export function createStepRenderer(React, { expanded, indexOfTurn, navigation, sessionId, titlesRef, skey, notesRef, fetchedRef, toggleStep, ensureStepText, view, translation }) {
  const { locateMainStep } = navigation
  const { tlTail, tlCompose, tlEnabled } = translation
  /** 工具 chip 的 tooltip：把行内放不下的信息放这儿。 */
  function toolTitle(x) {
    // 工具名不放进悬停：chip 上已经写着它了
    var bits = []
    if (x.argsRaw) bits.push('参数：' + String(x.argsRaw).slice(0, 160))
    if (x.resultTokens !== undefined) bits.push('返回 ' + fmtK(x.resultTokens) + ' tok')
    if (x.startedAt && x.endedAt) bits.push('耗时 ' + fmtDur(Math.max(0, x.endedAt - x.startedAt)))
    else if (x.endedAt === undefined) bits.push('执行')
    // 失败也进悬停：行里只有一枚红标（说"失败了"），**为什么**失败在这儿看
    if (x.failed) bits.push(failLine(x))
    return bits.join('\n')
  }

  /**
     * 失败的一句话（工具名 + 错误码 + 摘要）—— 悬停与展开区共用同一份文案。
     *
     * 错误码是**机读**的那个（`TOOL_TIMEOUT` / `INVALID_ARGS`…），照抄不改写：
     * 它是排查时唯一能在宿主日志里 grep 到的东西，翻译成中文反而断了这条线。
     * @param x - 一次工具调用（带 `failed`）。
     * @returns 例如 `bash 失败 · TOOL_TIMEOUT · tool call timed out after 30000ms`。
     */
  function failLine(x) {
    var f = x.failed || {}
    var bits = []
    if (f.code) bits.push(String(f.code))
    if (f.text) bits.push(String(f.text))
    return String(x.name || '?') + ' 失败' + (bits.length ? ' · ' + bits.join(' · ') : '')
  }

  /** 展开区那一行红字：码在前（等宽、机读），摘要在后（给人读）。 */
  function failBits(x) {
    var f = x.failed || {}
    return {
      code: f.code ? String(f.code) : '',
      // 摘要可能读不出来（宿主只给了空正文）—— 那时**不编内容**，只留红标。
      text: f.text ? String(f.text) : '',
    }
  }

  /** 这一步里失败的工具（行内红标与展开区都按它算）。 */
  function failedTools(tools) {
    return (tools || []).filter(function (x) { return !!x.failed })
  }

  /**
     * 容量条比例：把"这一步想了多少"直接长进图形里。
     *
     * 映射区间取 log10(Token) 的 **1.0 → 3.2**，即约 **10 ~ 1600 Token**，
     * 映射到条宽的 8%~100%。
     * ⚠️ 区间按真实分布定：统计口径从字数换成 Token 之后，同一个 step 的数会**缩小**
     *    （英文 0.3/字符、中文 0.6/字符），把原来的 1.3→4.2 直接套上去，条宽会全挤在
     *    左下角（换口径第一版就是这样）。实测前 22 步的思考换算过来约 20~770 Token，
     *    落在现在这个区间的 21%~87% —— 一行行看得出长短差别。
     * ⚠️ 早先版本用节点直径表达，写成 `min(5, log10(n) * 2.2)` —— 换算前 190 字就顶到上限，
     *    实测 900 字和 1362 字的节点直径完全一样，这个编码等于没生效；而且圆点太弱，
     *    用户反馈"脊线与圆点太弱、步骤行像日志"。改成横向容量条后两个问题一起解决。
     */
  function volRatio(tokens) {
    var n = Math.max(10, tokens || 10)
    var t = Math.max(0, Math.min(1, (Math.log10(n) - 1.0) / 2.2))
    return Math.round(8 + t * 92)
  }

  function renderStep(step, turnNo, turnEndedAt, runningPhase) {
    var s = step.status || 'thinking'
    var tools = step.tools || []
    var runningTool = null
    for (var t = 0;t < tools.length;t += 1) if (!tools[t].endedAt) runningTool = tools[t]
    var open = !!expanded[turnNo + ':' + step.step]
    var cls = 'tf-step is-' + (s === 'thinking' ? 'live' : s === 'waiting' ? 'wait' : s === 'ready' ? 'ready' : s === 'cut' ? 'cut' : 'done')
    // 字形本身是一列状态指示：扫一眼就知道哪几步完成了、哪一步在跑
    var glyph = s === 'done' ? '✓'
      : s === 'waiting' ? '◐'
        : s === 'cut' ? '■'
          : s === 'ready' ? '·'
            : '▸'

    var rowKids = [
      React.createElement('span', { className: 'tf-glyph', key: 'g' }, glyph),
    ]
    /*
     * 步骤号这一格：**进行中的块不画**（用户："去掉步骤号，步骤的标题补位前移"）。
     *
     * 为什么敢去掉：进行中的块只有一个步骤（见 `groupPhases` 的 `live`），
     * 而块头主标题已经写着「第 N 步」—— 同一个号在块里出现两遍是纯重复。
     *
     * ⚠️ 是**不画**，不是"留位藏起来"（`visibility:hidden`）—— 用户要的就是
     *    标题补位前移。代价：这一行的标题比别的块的行**左移 28px**（11px 字形 +
     *    9px 间距 + 19px 号 + 9px 间距）。这是有意的取舍：进行中的块本来就
     *    靠圆环 / 虚线底边 / 状态色和别的块分开，不必再靠列对齐。
     *    （对比：README 坑 19 讲的是**同一个列表里**条件渲染格子会挤歪整行，
     *     那条仍然成立 —— 这里变的是"哪一块"，不是"哪一行"。）
     */
    if (!runningPhase) {
      /*
       * **步骤号可点**：主会话在轨迹页时，跳过去并**选中这一步**（用户："在轨迹页面
       * 点击步骤号可直接跳转并选中这一步"）。
       *
       * 为什么是 `<button>`：它是个动作，要能 Tab 到、回车触发、读屏念出来（和轮次号同一套）。
       * ⚠️ 换成按钮后必须由 CSS 把按钮默认样式清干净（见 `.tf-no.is-locate`）——
       *    这一格是行首的定宽格，内边距/字号一变整行都会挪。
       * ⚠️ 必须 `stopPropagation`：这一行自己也点得动（展开/收起），不拦就会顺带展开。
       */
      rowKids.push(React.createElement('button', {
        className: 'tf-no is-locate', key: 'no', type: 'button',
        title: '在轨迹页里定位并选中第 ' + turnNo + ' 轮第 ' + step.step + ' 步',
        'aria-label': '定位到轨迹页里第 ' + turnNo + ' 轮第 ' + step.step + ' 步',
        onClick: function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation()
          // 这一轮的 seq 一起给它（轨迹页翻历史要用；没有就退回"一页一页翻"）
          var meta1 = indexOfTurn(turnNo)
          locateMainStep(sessionId, turnNo, step.step, meta1 ? meta1.seq : undefined)
        },
      }, '#' + step.step))
    }
    // 标题与工具名在 380px 里放不下两样：有标题时让工具名让位
    // （挤出来的 "ba…" 比不给还差），工具名移到 tooltip 与展开区。
    var titleOfStep = (titlesRef.current[skey(turnNo)] || {})[step.step]
    /**
     * 派生标题（按工具参数算，实时、零调用）。
     *
     * 它是**模型标题的替补**，不是"只给没思考的步"：
     *   · 还没点过「生成标题」→ **每一步都用它**当这一行的标题
     *   · 点过之后 → 有模型标题的步，模型标题占这一行，派生标题**退到展开区**
     *     当次级标题（和工具原文一样，点开才看）；没有模型标题的步（比如没有思考的
     *     纯工具步）仍然在行里用它
     */
    var titleLines = stepTitleLines(tools, notesRef.current)
    var derivedOfStep = titleLines.join(' · ')
    if (titleOfStep) {
      rowKids.push(React.createElement('span', {
        className: 'tf-step-title', key: 'ti',
        // 悬停里**不带工具名**了：工具名只在展开后的工具行里出现
        title: titleOfStep,
      }, titleOfStep))
    } else if (titleLines.length > 0) {
      // **按参数生成的标题**：一步有多个命令就**多行显示**（每行一条，相邻同名合并）。
      // 前面不挂工具名 —— 工具名只在展开后的工具行里出现；也不给悬停。
      rowKids.push(React.createElement('span', { className: 'tf-titles', key: 'ti' },
        titleLines.map(function (line, i) {
          return React.createElement('span', { className: 'tf-step-title is-cmd', key: i }, line)
        })))
    } else if (tools.length === 0) {
      /**
       * **无工具步**：前面两条路都够不着它（派生标题要工具参数、模型标题要思考），
       * 所以名字从**这一步自己的产出**里取（`stepOwnTitle`）：有正文 → 摘要。
       *
       * 取不出名字时看它**有没有在思考**分两种（用户定的）：
       *   · 有思考（思考在涨，只是还没有正文）→ **「思考」**：它确实产出了东西，
       *     不画"空"的点；
       *   · 什么都没有（0 思考 0 正文 0 工具）→ **三个点**，进行中时它们
       *     一个接一个亮（`.tf-none-dot` 的 stagger，见 CSS）—— 那读作"在等"。
       * 两种都不写「无输出」那种看着像标题的占位词，也不写「思考中」那种状态词
       * （块头已经写着「第 N 步 · 推理中」，行里那句是"产出"不是"状态"）。
       * 悬停里说清"为什么没有"（`noTitleNote`）。
       */
      var ownTitle = stepOwnTitle(step)
      if (ownTitle !== '') {
        rowKids.push(React.createElement('span', {
          className: 'tf-step-title is-own', key: 'ti',
          // 悬停给全句（行里只有摘要）—— 摘要是截过的，原文要能看见
          title: cleanProse(step.textHead !== undefined ? step.textHead : (step.textTail || '')) || ownTitle,
        }, ownTitle))
      } else if (stepHasThinking(step)) {
        rowKids.push(React.createElement('span', {
          className: 'tf-step-title is-none', key: 'ti',
          title: noTitleNote(step),
        }, THINK_TITLE))
      } else {
        // 三个点分三个节点：错开亮的那套动画只能这么写（一个字符串做不到）
        // ⚠️ `.is-dots` 是给进行中块那道**微光扫过**留的排除标记（CSS 里 `:not(.is-dots)`）：
        //    微光会把字形填充掀给渐变，三个点会一起闪、错开的亮就废了。
        rowKids.push(React.createElement('span', {
          className: 'tf-step-title is-none is-dots', key: 'ti',
          title: noTitleNote(step),
        }, [0, 1, 2].map(function (i) {
          return React.createElement('span', { className: 'tf-none-dot', key: i }, DOT)
        })))
      }
    } else {
      tools.forEach(function (x) {
        rowKids.push(React.createElement('span', {
          className: 'tf-tool', key: x.id, title: toolTitle(x),
        }, x.name + (x.endedAt ? '' : ' …')))
      })
    }
    if (step.streamGap) rowKids.push(React.createElement('span', { className: 'tf-flag', key: 'gap' }, '不完整'))
    if (step.attempts > 1) rowKids.push(React.createElement('span', { className: 'tf-flag', key: 'retry' }, '重试×' + step.attempts))
    /**
     * 失败标：**行里只说"有几个失败了"，不说错在哪**。
     *
     * 为什么不把错误摘要放到行里：一步可能两三次调用、行的右半边已经被容量条
     * 和时长占着（`margin-left:auto`），塞一段 200 字的英文错误进去会把行挤垮 ——
     * 而这一步"有没有白跑"才是扫一眼要回答的问题。**错在哪**在展开区，
     * 紧跟它自己那条工具行（见下面的 `.tf-tool-err`），还能悬停看全。
     *
     * 常不常见：实测 11283 次工具调用里 104 次失败（**0.9%**）—— 少到红标是
     * 有效信号，不至于把面板染红（要是常见，那就得换个更弱的形态）。
     */
    var failed = failedTools(tools)
    if (failed.length) {
      rowKids.push(React.createElement('span', {
        className: 'tf-flag is-err', key: 'err',
        // 悬停：逐条列出失败的工具与原因（和展开区同一份文案）
        title: failed.map(failLine).join('\n'),
      }, failed.length > 1 ? '工具失败×' + failed.length : '工具失败'))
    }
    // 容量条：宽 = 这一步思考了多少。它同时替代了"脊线"和"每行印 Token 数"
    rowKids.push(React.createElement('span', { className: 'tf-vol', key: 'vol', title: fmtK(step.reasoningTokens) + ' tok' },
      React.createElement('i', { style: { width: volRatio(step.reasoningTokens) + '%' } })))
    /**
     * 时长格：**只说时间，不说状态**。
     *
     * 状态词（推理中 / 调用中）归块头的次标题（`runningLabel`）和那块呼吸的圆环；
     * 头部那枚状态标签删掉之后，同一件事在全面板只说一遍。
     * 活跃步的数字每 500ms 自己涨（见 `stepDurMs`）—— "还在跑"由"数字在动"
     * 回答，比一个静态的词更直接，而且和跑完后的数字是同一个数（不会跳）。
     */
    rowKids.push(React.createElement('span', { className: 'tf-dur', key: 'dur' },
      step.startedAt ? fmtDur(stepDurMs(step, Date.now(), turnEndedAt)) : ''))

    // 原文来源：当前步直接有实时文本；历史步骤走 /step 按需取（那一个接口同时给思考与正文）
    var cacheKey = skey(turnNo + ':' + step.step)
    var cached = fetchedRef.current[cacheKey]
    var fullText = step.reasoningText || (cached && cached.text)
    /** 正文：取回来的优先，其次是本地累积的实时尾部（活跃步正在写的时候）。 */
    var bodyText = cached && cached.body !== undefined
      ? cached.body
      : (step.textTail === undefined || step.textTail === '' ? undefined : step.textTail)
    /**
     * 能不能展开。
     *
     * ⚠️ 不能只看"有没有思考原文"：**工具详情也只在展开时才给**（行内放不下）。
     * 早先漏了 `tools.length`，于是纯工具步（形如 `#2 bash`、思考 0 Token）没有箭头、
     * 点不开 —— 明明有参数、返回大小、耗时可以看（用户反馈"怎么有的点不开"）。
     * ⚠️ 后来补了 `hasBody`：**回答步**（无工具、无思考、只有正文）原来也点不开，
     *    而正文恰恰是那一步唯一的产出（用户："展开区加正文"）。
     */
    var hasReasoning = fullText !== undefined || (step.reasoningTokens || 0) > 0
    var hasBody = (step.textTokens || 0) > 0
    var canExpand = hasReasoning || tools.length > 0 || hasBody
    /** 展开时是否需要去取（纯工具步不需要，省一次请求、也免得给个空块）。 */
    var needFetch = (hasReasoning || hasBody) && fullText === undefined && bodyText === undefined

    if (canExpand) {
      // 行内小箭头，不占额外一行
      rowKids.push(React.createElement('button', {
        className: 'tf-chev', key: 'chev',
        title: (open ? '收起' : '展开') + (hasReasoning ? '原文' : '工具详情'),
        onClick: function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation()
          var willOpen = !expanded[turnNo + ':' + step.step]
          toggleStep(turnNo, step.step)
          if (willOpen && needFetch) ensureStepText(turnNo, step.step)
        },
      }, cached && cached.loading ? '…' : open ? '▾' : '▸'))
    } else {
      // 占位：少一个 14px 的格子，这一行的尾巴就会右移 23px（见 CSS 里的说明）
      rowKids.push(React.createElement('span', { className: 'tf-chev is-blank', key: 'chev' }))
    }

    var kids = [React.createElement('div', {
      // 标题是多行时加个修饰类：标号/状态/尾部信息要**对齐第一行**，
      // 不能在两行之间垂直居中（居中的话 `#8` 浮在两行中间，看着像掉了）
      className: 'tf-step-row' + (!titleOfStep && titleLines.length > 1 ? ' is-multi' : ''), key: 'r',
      onClick: canExpand ? function () {
        var willOpen = !expanded[turnNo + ':' + step.step]
        toggleStep(turnNo, step.step)
        if (willOpen && needFetch) ensureStepText(turnNo, step.step)
      } : undefined,
    }, rowKids)]

    if (s === 'waiting' && runningTool) {
      var waitMs = Math.max(0, Date.now() - runningTool.startedAt)
      kids.push(React.createElement('div', { className: 'tf-wait', key: 'w' },
        React.createElement('div', { className: 'tf-wait-row' },
          React.createElement('span', { className: 'tf-spin' }),
          React.createElement('span', { className: 'tf-wait-name' }, runningTool.name + ' 执行'),
          React.createElement('span', { className: 'tf-wait-el' }, '已等 ' + fmtDur(waitMs)),
        ),
        React.createElement('div', { className: 'tf-wait-note' },
          runningTool.argsRaw ? String(runningTool.argsRaw).slice(0, 130) : '尚无输出'),
      ))
    }
    if (s === 'cut') {
      kids.push(React.createElement('div', { className: 'tf-cut', key: 'c' }, '停在这里，这一步没写完；已经想到的内容保留在上面。'))
    }
    // 实时文本：只在**没展开**时给（展开后下面会显示完整原文，否则同一段出现两遍）
    if (s === 'thinking' && view === 'raw' && step.reasoningText && !open) {
      // 机翻只拼尾部（约 760 字）：折叠态本来也只露这么多，
      // 段落边界从尾部往前凑，避免从半句话开始切。
      var liveShown = tlTail(step.reasoningText, true, 760)
      kids.push(React.createElement('div', { className: 'tf-stream', key: 'st' },
        liveShown.text,
        React.createElement('span', { className: 'tf-caret' }),
      ))
    }
    if (open) {
      // 工具区：**每个工具的派生标题各占一行，紧跟它自己的工具行** ——
      // 这样"哪条标题对应哪次调用"一眼看得出来（行里那几行只是摘要，没法配对）。
      // 相邻同名的标题同样合并成一条带计数：连着 6 次 `edit` 只印一行标题、6 行工具。
      if (tools.length) {
        var toolKids = []
        var runsOfStep = toolTitleRuns(tools, notesRef.current)
        for (var ri = 0;ri < runsOfStep.length;ri += 1) {
          var run = runsOfStep[ri]
          if (run.text !== '') {
            toolKids.push(React.createElement('div', { className: 'tf-sub', key: 'sub' + ri }, runText(run)))
          }
          for (var tj = 0;tj < run.tools.length;tj += 1) {
            var xt = run.tools[tj]
            // 工具行 = **工具名 + 参数原文**同一行。返回大小与耗时那行去掉了 ——
            // 它占一行却几乎没有信息量（实测一半以上的调用耗时不到 50ms，一律显示成 0.0s）。
            // 只有"还在跑"这个**状态**留着，因为那是此刻才有的信息。
            toolKids.push(React.createElement('div', { className: 'tf-tool-row', key: xt.id },
              React.createElement('span', { className: 'tf-tool-name' }, xt.name),
              xt.endedAt === undefined
                ? React.createElement('span', { className: 'tf-tool-note' }, '执行…')
                : null,
              xt.argsRaw
                ? React.createElement('span', { className: 'tf-tool-args', title: xt.argsRaw }, String(xt.argsRaw).slice(0, 160))
                : null,
            ))
            /**
             * 失败详情：**紧跟它自己那条工具行**（和派生标题同一套配对方式 ——
             * 一步里连着两次 `edit`，红字落在哪一行必须一眼看得出）。
             *
             * 一行显示：`✗ 错误码  摘要`。摘要是英文原文（宿主给的），不翻译 ——
             * 它是模型看到的那句话，翻成中文就没法跟日志对上了。
             * 悬停给全（工具名 + 码 + 最多 200 字的摘要）。
             *
             * **红只给这一行，工具名保持次要灰**：宿主自己就是这么分的
             * （`.o3BgMG_errorSummary` 红、`_title` 仍是 label-secondary）——
             * 名字红了不但跟着它一起喊，长列表里还会把"哪一行是名字"搅乱。
             * 想找是哪一次调用失败，看红字**上面那一行**就是。
             */
            if (xt.failed) {
              var fb = failBits(xt)
              toolKids.push(React.createElement('div', {
                className: 'tf-tool-err', key: xt.id + '-err', title: failLine(xt),
              },
                React.createElement('span', { className: 'tf-tool-err-mark' }, '✗'),
                fb.code !== '' ? React.createElement('span', { className: 'tf-tool-err-code' }, fb.code) : null,
                // 摘要读不出来时**不编内容**（宿主只给了空正文）—— 只留那枚 ✗，不写"失败了"三个字占位
                fb.text !== '' ? React.createElement('span', { className: 'tf-tool-err-text' }, fb.text) : null,
              ))
            }
          }
        }
        kids.push(React.createElement('div', { className: 'tf-tools', key: 'rt' }, toolKids))
      }
      if (hasReasoning) {
        if (fullText !== undefined) {
          /*
           * 机翻：整段原文 → 已翻好的段落用译文，没翻好的保留原文。
           * `running` 只在 thinking 时为真 —— 末段还在长的时候不送翻（半句翻出来没意义），
           * 它一停（waiting / done / cut）就补翻。
           */
          var rawShown = tlCompose(fullText, s === 'thinking')
          kids.push(React.createElement('div', {
            className: 'tf-raw',
            key: 'raw',
            title: tlEnabled() ? '中文机翻；点顶部「中文」可切回原文' : undefined,
          }, rawShown.text))
        } else if (cached && cached.error) {
          kids.push(React.createElement('div', { className: 'tf-raw', key: 'raw' }, '取原文失败：' + cached.error))
        } else {
          kids.push(React.createElement('div', { className: 'tf-raw', key: 'raw' }, '载入原文…'))
        }
      }
      /*
       * **正文**（这一步写给用户的那段话）。
       *
       * 用户："展开区加正文。" 在此之前面板**从不显示正文** —— `/step` 接口一直
       * 把 `text` 也返回了，客户端只取 `reasoning`（`ensureStepText` 那一行），
       * 于是"这一步产出了什么"在面板上无处可看（`textTail` 一直在累积却没人渲染）。
       *
       * 和思考原文**分开呈现**：思考走 `.tf-raw`（等宽字体，读作"原文/草稿"），
       * 正文走 `.tf-reply`（正文字体，读作"结论"）。两条都有时各带一枚小标。
       */
      if (hasBody) {
        kids.push(React.createElement('div', { className: 'tf-cap', key: 'capb' }, '回答正文'))
        if (bodyText !== undefined) {
          kids.push(React.createElement('div', { className: 'tf-reply', key: 'reply' }, bodyText))
        } else if (cached && cached.error) {
          kids.push(React.createElement('div', { className: 'tf-reply', key: 'reply' }, '取正文失败：' + cached.error))
        } else {
          kids.push(React.createElement('div', { className: 'tf-reply', key: 'reply' }, '载入正文…'))
        }
      }
    }
    return React.createElement('div', { className: cls + (canExpand ? ' can-open' : ''), key: step.step }, kids)
  }

  return renderStep
}
