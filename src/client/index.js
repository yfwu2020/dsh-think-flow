/**
 * @yfwu2020/dsh-think-flow —— 浏览器端（右侧栏「思维链」标签页）。
 *
 * 本文件是 DSH 客户端 bundle 的源文件（ModuleLoader 懒加载 CJS 表格式）：
 * 顶层只注册工厂，真正的副作用（React 组件、SSE 连接、样式）都在 factory 被
 * materialize 时执行，且整体挂在 ctx.effect / ctx.slots.inject 下 —— 插件停用
 * 或热重载时可逆清理。
 *
 * ── 视觉设计 ──────────────────────────────────────────────────────────
 * 规范来自 `web-design` skill（窄容器、单列、反"AI 味"）+ 宿主自己的设计系统：
 *   · 只用 `--dsw-*` token，不硬编码颜色/字号 —— 这是"看着不像原生"的根因。
 *   · 排版走宿主的 font 简写 token，与周围对话界面完全同源。
 *   · **一个主色 + 中性灰阶**：品牌色只标"当前这一步"，其余靠字重与灰阶分层。
 *     之前给 5 个阶段各配一个色相，正是规范点名要避免的"每个元素不同颜色"。
 *   · **不把每步包成卡片**。之前每步一个圆角边框 + 填充底，是规范点名的
 *     "SaaS 卡片套件"。现在是一条脊线（`.tf-rail`），步骤是线上的节点。
 *   · **阶段分组块**：一层 surface 把内容分组（分组，不是每步套卡）。
 *   · **当前步高亮**：整块淡蓝底 + 左侧蓝条 —— 唯一"响亮"的地方。
 *   · **每行一条容量条**（宽 = 那一步思考的字数）：它同时解决三件事 ——
 *     步骤行不再千篇一律、替代了打印字数、也替代了那条太弱的脊线。
 *   · ⚠️ 重点色不能用 `--dsw-alias-brand-primary`：它浅色下是近黑（#0f1115）、
 *     深色下是近白（#f9fafb），**不是色相而是高对比前景色**。用错了就是"一片灰"。
 *     真正的产品蓝是 `--dsw-alias-state-business-primary`，淡底是 `-business-tertiary`。
 *   · 动效只留两处（当前节点呼吸、等待转圈），并尊重 prefers-reduced-motion。
 *
 * ── 状态 ──────────────────────────────────────────────────────────────
 * 状态**只有一个来源**：宿主在每个 change 里带下来的 `status`，客户端照抄。
 * 绝不自己推 —— 之前客户端自己推，导致每一步跑完仍判定为 thinking，界面一直挂着
 * "正在生成…"（真机复现过）。
 *
 * 时长同理只有一个来源：宿主下发**时间事实**（`change.timing`），客户端按一条公式
 * 现算（`stepDurMs`）—— 活跃步按 `now` 涨、结束的步定格。宿主算好的值不能用在
 * 活跃步上（只在事件发生时更新，中间那几秒是冻住的）。
 *
 * 头部**没有状态标签**（已删）：推理/调用归块头次标题，完成/中断归收尾小结，
 * 只有"面板坏了"两种（异常/断线）还渲染那一枚胶囊。见 `errChip`。
 *
 * 自检钩子：window.__dshThinkFlow（仅供调试/自动化验证）。
 */
window.__ModuleLoader__.load({
  id: '@yfwu2020/dsh-think-flow',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    /** 宿主路由。 */
    var API = '/think-flow/api'
    /** 标签页类型标识：注册类型、挂 body、开标签三处必须一致。 */
    var TAB_ID = '@yfwu2020/dsh-think-flow'
    var TAB_KIND = 'think-flow'
    /**
     * 空档超过这么久就当作阶段边界。
     *
     * 定标是量出来的，不是拍的：真实 turn 里相邻步的间隔常态是 3~47 秒
     * （思考 + 工具往返），所以阈值取 20 秒会把 22 步切成 9 个阶段、其中 4 个只有一步，
     * 分组等于失效。取 90 秒后只剩"工具族换向"在切分，22 步收敛成 4 个阶段。
     */
    var PHASE_GAP_MS = 90000

    // ────────────────────────────── 小工具 ──────────────────────────────

    function el(tag, cls, text) {
      var node = document.createElement(tag)
      if (cls) node.className = cls
      if (text !== undefined && text !== null) node.textContent = text
      return node
    }

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

    /**
     * 工具名 → 中文动词族。
     *
     * 这是阶段标签的**唯一**依据：工具名是确定性的，不需要猜。
     * 认不出来的工具如实显示原名，而不是硬套一个动词。
     */
    /**
     * 工具族 → 阶段名。
     *
     * 这是**本地规则**，不花模型调用 —— 阶段名只是"这一段大概在干嘛"的粗分类，
     * 精确的"这一步在干嘛"由模型生成的步骤标题负责（见 README 的中文标题一节）。
     *
     * 匹配顺序：先查 `FAMILY_EXACT`（精确名），再按 `FAMILY_PREFIX` 的顺序试前缀，
     * 都不中就**原样显示工具名**。如实显示比编一个中文名好：`read_image` 一眼就懂，
     * 硬编成"图片处理"反而离事实更远。所以这条兜底是有意的，不是漏了。
     */
    var FAMILY_EXACT = {
      // 命令行（**族名只用于分组**，显示名由 phaseLabel 按块内实际内容算，见下）
      bash: '命令行', pwsh: '命令行', terminal: '命令行',
      // 读与改
      read: '读代码', grep: '读代码', glob: '读代码',
      write: '改文件', edit: '改文件',
      read_image: '看图',
      // 交付
      present: '交付产出',
      // 外部
      find_dsh_plugin: '外部检索', web_search: '外部检索',
      advanced_search: '外部检索', platform_search: '外部检索',
      web_fetch: '抓网页',
      // 与用户交互
      ask_user_question: '问用户', todo_write: '列计划', exit_plan_mode: '收尾',
      // 编排与委派
      skill: '加载技能',
      subagent: '派子代理', subagent_fork: '派子代理', send_message: '派子代理',
      interrupt_agent: '派子代理', list_agents: '派子代理',
      workflow: '编排', ralph: '编排',
      // 后台任务
      job_output: '后台任务', job_kill: '后台任务', job_list: '后台任务',
      // 目标
      create_goal: '目标管理', get_goal: '目标管理', update_goal: '目标管理',
    }
    /**
     * 前缀规则。**按长度降序**排 —— 这样顺序天然安全：更具体的长前缀先匹配，
     * 短前缀抢不走它（比如以后要加 `dev_stage_`，它一定排在 `dev_` 前面）。
     * 这条有断言（test:client 的 ⑨），加规则时不会踩。
     */
    var FAMILY_PREFIX = [
      ['cordis_inspect', '宿主 API 查询'],
      ['openpencil_', '画设计稿'],
      ['oh_story_', '短剧制作'],
      ['dev_', '插件工程'],
    ]

    /**
     * 工具名 → 族名。
     * @param tool - 工具事实（只用到 `name`）。
     * @returns 族名；没有名字时给"纯推理"。
     */
    function toolFamily(tool) {
      var n = tool && tool.name ? String(tool.name) : ''
      if (!n) return '纯推理'
      if (FAMILY_EXACT[n] !== undefined) return FAMILY_EXACT[n]
      for (var i = 0; i < FAMILY_PREFIX.length; i += 1) {
        if (n.indexOf(FAMILY_PREFIX[i][0]) === 0) return FAMILY_PREFIX[i][1]
      }
      return n
    }

    /** 该步的工具族（没调工具 = 纯推理）。 */
    /**
     * 该步的工具族（没调工具 = 纯推理）。
     *
     * 命令行**再按命令内容细分**：只读 → 读代码、有副作用 → 跑命令、认不出 → 命令行。
     *
     * ① 为什么要细分：一段连续的命令行里常常混着 `sed` 和 `npm test`，只按"命令行"
     *    一族分组的话它们会被并成一块、再按多数派命名 —— 那一步就被**错标**了。
     * ② 为什么只读命令叫"读代码"而不是另起一个名字：它和 `read`/`grep`/`glob`
     *    这些工具是**同一件事**（把代码读出来看），分成两种块名只会让面板上出现
     *    "蓝色、蓝色、绿色、蓝色…"这样同色异名的交替。合成一种之后块更少、也更好读。
     */
    function familyOf(step) {
      var tools = step.tools || []
      if (!tools.length) return '纯推理'
      // 多个工具时取最后一个：它代表这一步"最终在干什么"
      var last = tools[tools.length - 1]
      var name = last && last.name ? String(last.name) : ''
      if (name === 'bash' || name === 'pwsh' || name === 'terminal') {
        var act = cmdActivity(last.argsRaw)
        return act === 'inspect' ? '读代码' : act === 'run' ? '跑命令' : '命令行'
      }
      return toolFamily(last)
    }

    // ── 命令行的两种活：查 vs 跑 ──
    //
    // 分界不是"哪个命令"，而是**这条命令在干嘛**：
    //   · 查 = 只读、没有副作用（sed/grep/cat/ls/wc…）
    //   · 跑 = 会做事（跑测试/构建/脚本/提交/联网，以及改文件系统的 cp/mkdir/rm）
    // 为什么值得分：实测一个真实会话的 89 条命令，70% 是"把这段读出来看看"，
    // 28% 是"跑测试/构建/提交"。混在一起叫什么都别扭 —— 叫"排查"过窄
    // （它专指查故障，而多数只是读代码），也漏掉那 28%。
    // 但**分组不能跟着拆**：分组用的是定标过的 90s 阈值，夹在两次 grep 之间的
    // 一个 `npm test` 会单独成块，把列表切碎（20s 阈值那次就被切碎成 9 块）。
    // 所以：分组仍按"命令行"一族，**显示名按块内实际内容算**。
    var CMD_INSPECT = {
      sed: 1, grep: 1, rg: 1, cat: 1, head: 1, tail: 1, wc: 1, find: 1, ls: 1,
      stat: 1, du: 1, tree: 1, lsof: 1, ps: 1, pgrep: 1, file: 1, which: 1,
      env: 1, awk: 1, cut: 1, sort: 1, uniq: 1, diff: 1, echo: 1, basename: 1, dirname: 1,
    }
    var CMD_RUN = {
      npm: 1, npx: 1, pnpm: 1, yarn: 1, node: 1, python: 1, python3: 1, bash: 1, sh: 1,
      make: 1, git: 1, curl: 1, gh: 1, zstd: 1, sips: 1, open: 1,
      // 改文件系统也算"做事"（有副作用），不算"查看"
      mkdir: 1, cp: 1, mv: 1, rm: 1, ln: 1, touch: 1, chmod: 1,
    }

    /**
     * 一条 bash 命令在干嘛。
     *
     * 只看**第一个动词**：`cd X && sed -n …` 要先剥掉 `cd X &&`，
     * 因为所有命令都以前缀的 cd 开头（实测 89 条里几乎全部如此）。
     *
     * ⚠️ 这里必须能处理**被截断的参数**：宿主只留 `arguments` 的前 400 字，
     * 而长命令（heredoc、多行脚本）一截就**不是合法 JSON 了** —— 实测一个真实会话里
     * 207 次 bash 调用有 **118 次**（57%）解析失败。解析不了就返回 null 的话，
     * 大半个命令行块都会退化成中性的"命令行"，这个功能就等于没做。
     * 好在我们只要命令的**第一个词**，它必定在最前面，所以再从原始串里捞一次就够了。
     * @param argsRaw - 工具参数原文（JSON 字符串，可能被截断）。
     * @returns `'inspect'` / `'run'` / `null`（认不出来）。
     */
    /**
     * 从工具参数里取出命令原文。
     *
     * ⚠️ 必须容忍**被截断的参数**：宿主只留 `arguments` 的前 400 字，长命令
     * （heredoc、多行脚本）一截就不是合法 JSON 了 —— 实测一个真实会话里
     * 337 次 bash 调用有相当一部分如此。解析不了就从原始串里捞 command 的开头，
     * 反正标题只需要命令的**开头几个词**。
     * @param argsRaw - 工具参数原文（JSON 字符串，可能被截断）。
     * @returns 命令原文；取不到时空串。
     */
    function commandOf(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return ''
      try {
        var parsed = JSON.parse(argsRaw)
        return parsed && typeof parsed.command === 'string' ? parsed.command : ''
      } catch (e) {
        var m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argsRaw)
        if (m === null) return ''
        return m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    }

    /**
     * 把整条命令切成"段"（`&&` / `;` / `|` / `||`），**但要跳过引号里的**。
     *
     * 踩过：`sed -n "$(grep -n 'x' f | cut -d: -f1),+8p" f` 这种命令里，
     * 引号内的 `|` 是命令替换的一部分，按裸 `|` 切会把一段劈成两半，
     * 于是"最后一个参数"变成半截字符串（起出过 `读 index.js ` 这种带尾巴的标题）。
     */
    function splitSegments(cmd) {
      var out = []
      var cur = ''
      var quote = ''
      for (var i = 0; i < cmd.length; i += 1) {
        var ch = cmd[i]
        if (quote !== '') {
          cur += ch
          if (ch === quote) quote = ''
          continue
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
        if (ch === '&' && cmd[i + 1] === '&') { out.push(cur); cur = ''; i += 1; continue }
        if (ch === '|') {
          if (cmd[i + 1] === '|') i += 1
          out.push(cur); cur = ''
          continue
        }
        if (ch === ';') { out.push(cur); cur = ''; continue }
        cur += ch
      }
      out.push(cur)
      return out
    }

    /** 把一段命令切成 token（粗略处理单双引号）。 */
    function shellTokens(text) {
      var out = []
      var cur = ''
      var quote = ''
      for (var i = 0; i < text.length; i += 1) {
        var ch = text[i]
        if (quote !== '') {
          if (ch === quote) quote = ''
          else cur += ch
          continue
        }
        if (ch === '"' || ch === "'") { quote = ch; continue }
        if (ch === ' ' || ch === '\t' || ch === '\n') {
          if (cur !== '') { out.push(cur); cur = '' }
          continue
        }
        cur += ch
      }
      if (cur !== '') out.push(cur)
      return out
    }

    /** 去掉开头的 cd / VAR=值 / sudo 这类"导航前缀"。 */
    function stripNav(text) {
      var t = text.replace(/^\s+/, '')
      for (var i = 0; i < 6; i += 1) {
        var before = t
        t = t.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
        t = t.replace(/^(?:sudo|command|time)\s+/, '')
        t = t.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:&&|;)?\s*/, '')
        t = t.replace(/^(?:&&|;|\|\|)\s*/, '')
        if (t === before) break
      }
      return t
    }

    /** 取最后一个看起来像路径的 token 的文件名部分。 */
    function baseName(tok) {
      if (tok === undefined) return ''
      var t = String(tok).replace(/\/+$/, '')
      var i = t.lastIndexOf('/')
      return i >= 0 ? t.slice(i + 1) : t
    }

    /**
     * 从参数里挑出"那个文件"。
     *
     * ⚠️ 不能简单取"第二个实参"：命令替换里**嵌了同类引号**时，分词器会被里面的引号
     * 带偏，把一整段 shell 片段当成一个 token —— 真机起出过
     * 「读 test-client.mjs | cut -d: -f1),+26p」这种标题（`sed -n "$(grep -n "x" f | cut -d: -f1),+26p" f`）。
     * 改成**从后往前找第一个"看起来像路径"的 token**：只含 `[\w.~/@-]`，
     * 不含空格 / 引号 / `|` / `,` 这些 shell 元字符，也不是 sed 的 `s/a/b/` 脚本。
     * @param toks - 该段的 token。
     * @returns 文件 token；挑不出时 undefined。
     */
    function pickPath(toks) {
      // 从 `length-1` 扫到 **1**：第 0 个是动词本身（`sed`/`cat`/`ls` 都长得像路径），
      // 扫到它就会起出「改 sed」这种标题（`sed -i '' 's/x/y/'` 没有文件名时踩到过）
      for (var i = toks.length - 1; i >= 1; i -= 1) {
        var t = toks[i]
        if (t.charAt(0) === '-') continue
        if (!/^[A-Za-z0-9_.~\/@-]+$/.test(t)) continue
        if (/^[sy]\//.test(t)) continue          // sed 的 s/a/b/ 脚本，不是文件
        return t
      }
      return undefined
    }

    /** 非 - 开头的 token（也就是参数里的"实参"）。 */
    function nonFlags(toks) {
      var out = []
      for (var i = 0; i < toks.length; i += 1) {
        if (toks[i].charAt(0) !== '-') out.push(toks[i])
      }
      return out
    }

    /**
     * 命令里每一段的"信息量"权重 —— 复合命令取最重的那段来起标题。
     *
     * 为什么需要：真实命令大量是 `cd X && …`，也常见 `rm -f a && 跑Chrome截图`。
     * 只取第一段会把后者说成"删文件"。按权重挑，才挑得到真正在干的那件事。
     */
    var CMD_WEIGHT = {
      python3: 5, python: 5, node: 5, npm: 5, npx: 5, pnpm: 5, yarn: 5, git: 5, curl: 5, gh: 5,
      sed: 4, grep: 4, rg: 4, awk: 4, cat: 4, find: 4, openpencil: 4,
      ls: 3, tree: 3, wc: 3, du: 3, stat: 3, file: 3, head: 3, tail: 3, diff: 3, sort: 3, uniq: 3,
      zstd: 3, sips: 3, lsof: 3, ps: 3, pgrep: 3, kill: 3, env: 3, printenv: 3, which: 3,
      mkdir: 2, cp: 2, mv: 2, rm: 2, ln: 2, touch: 2, chmod: 2, tar: 2,
      echo: 1, printf: 1, cd: 0, true: 0, export: 0, set: 0,
    }

    /** 一个动词的权重；不认识的给 3（别被 echo/cp 抢走）。 */
    function weightOf(verb) {
      return CMD_WEIGHT[verb] === undefined ? 3 : CMD_WEIGHT[verb]
    }

    /**
     * 把一条命令压成短标题（**纯本地规则**，不花模型调用）。
     *
     * 为什么这里可以用本地规则：命令是**确定的** —— 动词、参数、文件名都在那儿，
     * 没有"这句话在论证什么"那种需要理解的东西。这和当初否掉"用本地规则总结思考"
     * 是两回事（那个 1/3 会猜错，因为它在猜意图；这个只是在**读**命令）。
     *
     * 认不出来就返回 undefined（界面回落到原来的工具名），**不猜**。
     * @param argsRaw - 工具参数原文。
     * @returns 短标题；认不出时空。
     */
    function cmdTitle(argsRaw) {
      var cmd = commandOf(argsRaw)
      if (cmd === '') return ''
      // 复合命令：切成段，挑信息量最大的那段
      var segs = splitSegments(cmd)
      var cands = []
      for (var i = 0; i < segs.length; i += 1) {
        var seg = stripNav(segs[i])
        var toks = shellTokens(seg)
        if (toks.length === 0) continue
        // 子 shell 的 `(` 不算动词的一部分：`(npx … ) || node_modules/.bin/dsh …`
        var w = weightOf(toks[0].replace(/^\(+/, ''))
        if (w > 0) cands.push({ seg: seg, w: w })
      }
      // **按权重降序逐个试，取第一个起得出标题的** —— 只看最重那段的话，
      // 万一那段认不出（比如以 `(` 开头的子 shell），整条就没标题了
      cands.sort(function (a, b) { return b.w - a.w })
      for (var k = 0; k < cands.length; k += 1) {
        var t = titleOfCommand(cands[k].seg)
        if (t !== '') return t
      }
      return ''
    }

    /** 从（可能被截断的）参数里抠一个字符串字段。 */
    function argString(argsRaw, field) {
      if (typeof argsRaw !== 'string') return ''
      var m = new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(argsRaw)
      if (m === null) return ''
      return m[1].replace(/\\\\n/g, ' ').replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\').replace(/\\s+/g, ' ').trim()
    }

    /**
     * 数一个数组字段有几项。
     * @param field - 数组字段名（`files` / `todos` / `questions`）。
     * @param itemKey - 每项里**唯一**的那个键（`path` / `content` / `question`）。
     *   不能用"任意键"来数：`present` 的每一项都有 `path` **和** `description`，
     *   按任意键数会把 1 个文件数成 2 个。
     */
    function argCount(argsRaw, field, itemKey) {
      if (typeof argsRaw !== 'string') return 0
      var at = argsRaw.indexOf('"' + field + '"')
      if (at < 0) return 0
      var m = argsRaw.slice(at).match(new RegExp('"' + itemKey + '"\\s*:', 'g'))
      return m === null ? 0 : m.length
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

    /**
     * 回落层标题（本轮用户消息）按多少字截。
     *
     * 和步骤标题、整轮标题的提示词同一档（8~18 汉字）—— 取上界 18，末尾补 `…`。
     */
    var FALLBACK_TITLE_CHARS = 18

    /**
     * **按工具参数**起标题 —— 处理那些没有 `command` 的工具。
     *
     * 为什么需要：实测一个会话里 221 个纯工具步，只认 `command` 的话只有 **52%** 有标题；
     * 剩下 48% 是 `edit`(54) / `read`(19) / `read_image`(17) / `present`(10) / `write`(4) /
     * `find_dsh_plugin`(1) —— 它们的参数里没有命令，但**有文件路径 / 查询词 / 条目数**，
     * 足够起一个准确的短标题。
     *
     * ⚠️ 一律用**正则从原始串里抠**，不走 `JSON.parse`：宿主只留参数前 400 字，
     * `edit`（59 次里 44 次）和 `write`（3 次全截断）经常是不合法 JSON。
     * @param name - 工具名。
     * @param argsRaw - 参数原文。
     * @returns 短标题；认不出时空串。
     */
    function toolArgsTitle(name, argsRaw) {
      var n = name === undefined || name === null ? '' : String(name)
      if (n === 'bash' || n === 'pwsh' || n === 'terminal') return cmdTitle(argsRaw)
      var file = argString(argsRaw, 'file_path') || argString(argsRaw, 'path')
      var base = file === '' ? '' : baseName(file)
      if (n === 'read') return base === '' ? '' : '读 ' + base
      if (n === 'edit') return base === '' ? '' : '改 ' + base
      if (n === 'write') return base === '' ? '写文件' : '写 ' + base
      if (n === 'read_image') return base === '' ? '' : '看图 ' + base
      if (n === 'present') {
        var count = argCount(argsRaw, 'files', 'path')
        if (count > 1) return '交付 ' + count + ' 个文件'
        return base === '' ? '交付产出' : '交付 ' + base
      }
      if (n === 'grep' || n === 'rg') {
        var pat = argString(argsRaw, 'pattern')
        return pat === '' ? '' : '搜 ' + clip(pat, 15)
      }
      if (n === 'glob') {
        var g = argString(argsRaw, 'pattern')
        // 模式不是路径：只去掉开头的 `**/`，别走 baseName（`**/*.test.js` 会被切成 `.test.js`）
        return g === '' ? '' : '找 ' + clip(g.replace(/^\*\*\//, ''), 15)
      }
      if (n === 'web_fetch') {
        var url = argString(argsRaw, 'url')
        if (url === '') return ''
        var host = url.replace(/^https?:\/\//, '').split('/')[0]
        return '抓 ' + host
      }
      if (n === 'web_search' || n === 'advanced_search' || n === 'platform_search' || n === 'find_dsh_plugin') {
        var q = argString(argsRaw, 'query') || argString(argsRaw, 'queries')
        if (q === '') {
          // `queries` 是**数组**（`["a","b"]`），argString 只认字符串值，单独捞一次
          var mq = /"queries"\s*:\s*\[\s*"((?:[^"\\]|\\.)*)"/.exec(argsRaw || '')
          if (mq !== null) q = mq[1]
        }
        return q === '' ? '' : '搜 ' + clip(q, 15)
      }
      // 宿主 API 查询（`cordis_inspect_*`）：参数里是服务名或查询词
      if (n === 'cordis_inspect_list') {
        var svc = argString(argsRaw, 'service')
        return svc === '' ? '列服务' : '列 ' + clip(svc, 18)
      }
      if (n === 'cordis_inspect_query') {
        var qq = argString(argsRaw, 'service') || argString(argsRaw, 'query')
        return qq === '' ? '查宿主 API' : '查 ' + clip(qq, 18)
      }
      if (n === 'skill') {
        var sk = argString(argsRaw, 'name') || argString(argsRaw, 'skill')
        return sk === '' ? '加载技能' : '加载 ' + sk
      }
      if (n === 'todo_write') {
        var td = argCount(argsRaw, 'todos', 'content')
        return td === 0 ? '列计划' : '列 ' + td + ' 项计划'
      }
      if (n === 'ask_user_question') {
        var qs = argCount(argsRaw, 'questions', 'question')
        return qs > 1 ? '问 ' + qs + ' 个问题' : '问用户'
      }
      // 这些工具的参数里**本来就有一个短描述**（是给人看的），直接用它
      if (n === 'subagent' || n === 'subagent_fork' || n === 'workflow' || n === 'ralph') {
        var d = argString(argsRaw, 'description')
        if (d !== '') return clip(d, 22)
        return n === 'workflow' || n === 'ralph' ? '编排' : '派子代理'
      }
      if (n === 'create_goal' || n === 'update_goal') {
        var obj = argString(argsRaw, 'objective')
        return obj === '' ? '定目标' : '定目标：' + clip(obj, 16)
      }
      return ''
    }

    /**
     * 一步的派生标题：**每个工具各起一条**，用 ` · ` 连起来。
     *
     * 早先只取"最后一个起得出标题的工具" —— 多工具步（`bash + edit`）里另一个工具
     * 在行里完全看不出来。现在每个命令都有自己的一条。
     *
     * 命令自带的英文说明（`bash` 的 `description`）由模型翻成中文后，**跟在它自己那条
     * 标题后面**，用 ` · ` 隔开（`读 client.js · 改动后重跑测试`）。
     * @param tools - 该步的工具数组。
     * @param notes - 工具 id → 中文说明（模型生成，可能没有）。
     * @returns 短标题；都起不出时空串。
     */
    function toolTitleRuns(tools, notes) {
      var runs = []
      for (var i = 0; i < tools.length; i += 1) {
        var t = toolArgsTitle(tools[i].name, tools[i].argsRaw)
        var note = notes === undefined ? undefined : notes[tools[i].id]
        var text = t === ''
          ? (note === undefined ? '' : note)
          : (note === undefined || note === '' ? t : t + ' · ' + note)
        var last = runs[runs.length - 1]
        // **相邻同名合并**：一步里连着调 6 次 `edit`，标题就是 6 个「改 index.js」——
        // 合并成一条带计数（`改 index.js ×6`），既杀掉重复又保住"调了几次"。
        // 空标题（认不出）不合并：每个工具各占一行，好跟工具行对上。
        if (text !== '' && last !== undefined && last.text === text) {
          last.count += 1
          last.tools.push(tools[i])
          continue
        }
        runs.push({ text: text, count: 1, tools: [tools[i]] })
      }
      return runs
    }

    /** 一条 run → 显示文字（重复的带 `×N`）。 */
    function runText(run) {
      return run.count > 1 ? run.text + ' ×' + run.count : run.text
    }

    /** 行里要显示的标题行（去掉认不出的那些）。 */
    function stepTitleLines(tools, notes) {
      return toolTitleRuns(tools, notes)
        .filter(function (r) { return r.text !== '' })
        .map(runText)
    }

    // ── 无工具步的名字：从它自己的产出里取（本地规则，零模型调用） ──
    //
    // 面板上有两条起名路，各有过滤条件：**派生标题**要工具参数、**模型标题**要思考。
    // 于是"无工具 + 无思考 + 有正文"的步（就是每一轮最后那一步）**两条都漏** ——
    // 扫全部会话 14,030 步，这种有 **487 步**（无工具步 913 里的一半）。
    // 用户："为哪些没有标题的步骤起名字" → 走第三条路：**本地摘要**。

    /** 自然停顿：摘要在这里断句（不切在句子中间）。 */
    var PROSE_CUT = '。！？；，、'

    /**
     * 正文 → 一行能读的纯文本（去 Markdown 噪声）。
     *
     * 摘要要的是"第一句说的是什么"，所以代码块、图片、链接地址、强调符都得先清掉 ——
     * 否则标题会变成 ```` ```js ```` 或 `http://…`（真数据里正文常以代码块开头）。
     * @param text - 正文原文。
     * @returns 清干净的文本（可能为空串）。
     */
    function cleanProse(text) {
      return String(text === undefined || text === null ? '' : text)
        .replace(/```[\s\S]*?```/g, ' ')                     // 代码块
        .replace(/^[#>\s*`+\-]+/, '')                        // 开头的标题/引用/列表标记
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')               // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')             // 链接 → 只留文字
        .replace(/[*_`~]/g, '')                              // 强调符
        .replace(/\s+/g, ' ')
        .trim()
    }

    /**
     * 正文 → 行标题用的摘要。
     *
     * 规则（拿真数据调出来的，见 README 里那三条真实例子）：
     *   ① 累到第一个**自然停顿**且长度 ≥ 12 字就断（再短就只有半句、再长读起来像正文）
     *   ② 上限 20 字（标题格子就那么大，和模型标题的 8~18 字同一档）
     *   ③ 截断了就收尾：**不闭合的括号不带进去**、**不把英文单词切一半**、
     *      去掉结尾的标点，最后补 `…`
     * @param text - 正文原文。
     * @returns 摘要；正文为空时返回空串。
     */
    function excerptOf(text) {
      var c = cleanProse(text)
      if (c === '') return ''
      var out = ''
      for (var i = 0; i < c.length; i += 1) {
        out += c[i]
        if (PROSE_CUT.indexOf(c[i]) >= 0 && out.length >= 12) break
        if (out.length >= 20) break
      }
      out = out.trim()
      if (out.length >= c.length) return out
      var pairs = [['（', '）'], ['(', ')'], ['【', '】'], ['[', ']']]
      for (var p = 0; p < pairs.length; p += 1) {
        var a = out.lastIndexOf(pairs[p][0])
        if (a >= 0 && out.indexOf(pairs[p][1], a) < 0) out = out.slice(0, a)
      }
      var tail = out.match(/[A-Za-z0-9_]+$/)
      if (tail !== null && out.length > 12) out = out.slice(0, out.length - tail[0].length)
      out = out.trim().replace(/[。！？；，、：—-]+$/, '')
      return out === '' ? c.slice(0, 20) + '…' : out + '…'
    }

    /**
     * 一个**无工具**的步，行标题写什么。
     *
     *   有正文 → 正文摘要（`excerptOf`）
     *   什么都没有（0 思考 0 正文 0 工具）→ 「无输出」
     *   只有思考（还没开始写正文）→ 空串（不硬起名 —— 思考是英文 CoT，
     *     本地取不出中文名；开了「生成标题」时模型标题会顶上）
     * @param step - 步骤。
     * @returns 标题文字（可能为空串）。
     */
    function stepOwnTitle(step) {
      if (step === undefined || step === null) return ''
      if ((step.textChars || 0) > 0) {
        var head = step.textHead !== undefined ? step.textHead : step.textTail
        return excerptOf(head === undefined ? '' : head)
      }
      var noReasoning = (step.reasoningChars || 0) === 0 && (step.reasoningText === undefined || step.reasoningText === '')
      var noTools = (step.tools || []).length === 0
      return noReasoning && noTools ? '无输出' : ''
    }

    /** 单个命令段 → 标题。认不出来返回空串。 */
    function titleOfCommand(seg) {
      var toks = shellTokens(seg)
      if (toks.length === 0) return ''
      var verb = toks[0].replace(/^\(+/, '')      // 子 shell：`(npx …)`
      var args = nonFlags(toks.slice(1))
      var first = args[0]
      var redirect = /(^|\s)>{1,2}\s*\S/.test(seg)      // `cat > f` / `echo x > f`

      // 读 / 搜 / 看
      if (verb === 'sed') {
        var target = pickPath(toks)
        if (target === undefined) return ''
        if (/-i(\s|$)/.test(seg)) return '改 ' + baseName(target)
        return '读 ' + baseName(target)
      }
      if (verb === 'grep' || verb === 'rg') {
        var pat = (first === undefined ? '' : first).replace(/[\\'"]+$/, '')
        pat = pat.replace(/\\([|\[\](){}.*+?^$])/g, '$1')      // `\|` → `|`，读起来才是人写的
        if (pat.length > 14) pat = pat.slice(0, 13) + '…'
        return pat === '' ? '搜内容' : '搜 ' + pat
      }
      if (verb === 'cat') {
        if (!redirect) return '读 ' + baseName(pickPath(toks))
        // `cat > f` / `cat >> f`：目标在 `>` 之后，别把 `>` 本身当文件名
        var mt = />>?\s*(\S+)/.exec(seg)
        return mt === null ? '写文件' : '写 ' + baseName(mt[1])
      }
      if (verb === 'head' || verb === 'tail') return '读 ' + baseName(pickPath(toks))
      if (verb === 'awk') return '筛 ' + baseName(pickPath(toks))
      if (verb === 'wc') return '数行数'
      if (verb === 'ls') {
        var dir = pickPath(toks)
        return '看目录' + (dir === undefined ? '' : ' ' + baseName(dir))
      }
      if (verb === 'tree') return '看目录树'
      if (verb === 'find') {
        var mn = /-name\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(seg)
        var target = mn === null ? '' : (mn[1] || mn[2] || mn[3] || '')
        return target === '' ? '找文件' : '找 ' + baseName(target).replace(/[*?]/g, '')
      }
      if (verb === 'du' || verb === 'stat' || verb === 'file') {
        var p2 = pickPath(toks)
        return p2 === undefined ? '' : '看 ' + baseName(p2)
      }
      if (verb === 'diff') return '比差异'
      if (verb === 'sort' || verb === 'uniq') return '排序'
      if (verb === 'echo' || verb === 'printf') return '打印一行'
      if (verb === 'for' || verb === 'while' || verb === 'until') return '循环处理'

      // 跑
      if (verb === 'npm' || verb === 'pnpm' || verb === 'yarn') {
        if (first === 'test') return '跑测试'
        if (first === 'run') {
          var script = args[1]
          if (script === undefined) return '跑脚本'
          var NPM_SCRIPT = { build: '跑构建', test: '跑测试', preview: '跑预览', align: '跑布局检查',
            icons: '生成图标', probe: '跑探针', typecheck: '跑类型检查' }
          return NPM_SCRIPT[script] === undefined ? '跑 ' + script : NPM_SCRIPT[script]
        }
        if (first === 'pack') return '试打包'
        if (first === 'publish') return '发布'
        if (first === 'i' || first === 'install' || first === 'ci') return '装依赖'
        if (first === 'add') return args[1] === undefined ? '装依赖' : '装 ' + args[1]
        return first === undefined ? '跑 npm' : '跑 npm ' + first
      }
      if (verb === 'npx') return first === undefined ? '跑 npx' : '跑 ' + baseName(first)
      if (verb === 'node' || verb === 'python' || verb === 'python3') {
        // `python3 - <<'PY'`（heredoc）、`node -e "…"`、`python3 -c "…"` 都是临时脚本。
        // ⚠️ 要看**原始 token**：`-c` / `-` 被 nonFlags 滤掉了，只能在这里认。
        var inline = false
        for (var ti = 1; ti < toks.length; ti += 1) {
          if (toks[ti] === '-c' || toks[ti] === '-e' || toks[ti] === '-') { inline = true; break }
        }
        if (inline || /<<-?\s*['"]?[A-Za-z_]/.test(seg)) return '跑临时脚本'
        if (first === undefined) return '跑临时脚本'
        return '跑 ' + baseName(first)
      }
      if (verb === 'git') {
        var sub = first
        if (sub === 'add' || sub === 'commit') return '提交改动'
        if (sub === 'diff' || sub === 'status' || sub === 'show') return '看改动'
        if (sub === 'log') return '看提交历史'
        if (sub === 'remote') return '看远端'
        if (sub === 'init') return '建仓库'
        if (sub === 'tag') return '打标签'
        if (sub === 'push') return '推送'
        if (sub === 'clone') return '克隆仓库'
        return sub === undefined ? 'git' : 'git ' + sub
      }
      if (verb === 'bash' || verb === 'sh' || verb === 'zsh') {
        return first === undefined ? '跑脚本' : '跑 ' + baseName(first)
      }
      if (verb === 'curl') return '请求接口'
      if (verb === 'gh') return '用 gh'
      if (verb === 'zstd') return '解压'
      if (verb === 'sips') return '转图片'
      if (verb === 'open') return '打开'

      // 动文件系统
      if (verb === 'mkdir') return '建目录' + (first === undefined ? '' : ' ' + baseName(first))
      if (verb === 'cp') return '复制文件'
      if (verb === 'mv') return '移动文件'
      if (verb === 'rm') return '删文件'
      if (verb === 'ln') return '建链接'
      if (verb === 'touch') return '新建文件'
      if (verb === 'chmod') return '改权限'

      // 看系统
      if (verb === 'lsof' || verb === 'ps' || verb === 'pgrep' || verb === 'kill') return '查进程'
      if (verb === 'env' || verb === 'printenv') return '看环境变量'
      if (verb === 'which') return '找可执行文件'

      // 直接跑一个**带路径的可执行文件**（真机里常见：Chrome 无头截图、node_modules/.bin/dsh）
      if (verb.indexOf('/') >= 0) {
        if (/--screenshot|--headless/.test(seg)) return '跑浏览器截图'
        return '跑 ' + baseName(verb)
      }
      return ''
    }

    function cmdActivity(argsRaw) {
      var cmd = commandOf(argsRaw)
      if (cmd === '') return null
      var text = cmd.replace(/^\s+/, '')
      // 剥掉开头的"无害前缀"，直到剥不动：
      //   `cd X && …`（几乎所有命令都带）、`VAR=值 …`（`CH="/path with space" python3 …`）、
      //   落单的 `&&`（前一步剥完剩下的）
      for (var i = 0; i < 6; i += 1) {
        var before = text
        text = text.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
        text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:&&|;)?\s*/, '')
        text = text.replace(/^(?:&&|;)\s*/, '')
        if (text === before) break
      }
      var m = /^([A-Za-z0-9_./-]+)/.exec(text)
      if (m === null) return null
      var head = m[1]
      if (CMD_INSPECT[head] === 1) return 'inspect'
      if (CMD_RUN[head] === 1) return 'run'
      return null
    }

    /**
     * 阶段块的**颜色分类**。
     *
     * 为什么是"分类"而不是"每个块名一个颜色"：宿主的设计系统里**只有 4 个色相**
     * （business 蓝 / success 绿 / warn 琥珀 / error 红）+ 中性灰阶，没有紫/青/品红。
     * 二十多个块名各配一色只能自己编颜色 —— 那会同时破坏两件事：脱离设计系统、
     * 深色主题下没有对应的值。所以按**语义**归成 5 类，每类一个宿主色相：
     *
     *   读（蓝）  获取信息          读代码 / 看图 / 外部检索 / 抓网页 / 宿主 API 查询
     *   写（绿）  产出与改动        改文件 / 交付产出 / 画设计稿 / 短剧制作
     *   跑（琥珀）执行与委派        跑命令 / 插件工程 / 派子代理 / 编排 / 后台任务 / 目标管理 / 加载技能
     *   问（红）  需要人            问用户
     *   想（灰）  只在脑子里         纯推理 / 推理中 / 调用中 / 列计划 / 收尾 / 回答 / 命令行（认不出）/ 未知块名
     *
     * 同类共享颜色是**有意的**：颜色回答的是"这一段属于哪种活动"，
     * 具体是什么由块名文字回答。二十多种颜色没人能记住，5 种能。
     */
    var CATEGORY_OF = {
      读代码: 'read', 看图: 'read', 外部检索: 'read', 抓网页: 'read', '宿主 API 查询': 'read',
      改文件: 'write', 交付产出: 'write', 画设计稿: 'write', 短剧制作: 'write',
      跑命令: 'run', 插件工程: 'run', 派子代理: 'run', 编排: 'run', 后台任务: 'run', 目标管理: 'run', 加载技能: 'run',
      问用户: 'ask',
      纯推理: 'think', 推理中: 'think', 调用中: 'think', 列计划: 'think', 收尾: 'think', 回答: 'think', 命令行: 'think',
    }
    /** 认不出的块名一律归"想"（中性灰），不猜。 */
    function phaseCategory(label) {
      return CATEGORY_OF[label] || 'think'
    }

    /**
     * 把**同一种**阶段块合并成一个。
     *
     * 为什么需要：分组是按"相邻 + 同族 + 间隔 < 90s"切的，一个 turn 里
     * 读代码 / 改文件 / 读代码 / 改文件 这样交替，就会切出一串单步小块
     * （实测 turn 31：63 步切出 **32 个块**，图例成了 8 行的一堵墙）。
     * 合并之后只剩"这一轮做了哪几类事"，每类一块 —— 才是小结该有的样子。
     *
     * 块内步骤**保持步骤号升序**（相邻块本来就是升序，按类追加后仍是升序），
     * 所以合并块里的步骤号会有洞（`#1–2, 6, 11–22`），块头如实列出来。
     * @param phases - `groupPhases` 的结果（按时间序）。
     * @returns 按**首次出现顺序**排列的合并块。
     */
    function mergeByLabel(phases) {
      var order = []
      var byKey = {}
      for (var i = 0; i < phases.length; i += 1) {
        var ph = phases[i]
        var key = ph.label || ph.family
        if (byKey[key] === undefined) {
          byKey[key] = { family: ph.family, label: key, cat: phaseCategory(key), steps: [] }
          order.push(byKey[key])
        }
        for (var j = 0; j < ph.steps.length; j += 1) byKey[key].steps.push(ph.steps[j])
      }
      return order
    }

    /**
     * 把步骤号压成可读的区间串：`1–2, 6, 11–22`。
     * @param steps - 升序的步骤数组。
     * @returns 区间串。
     */
    function stepRanges(steps) {
      var out = []
      var i = 0
      while (i < steps.length) {
        var a = steps[i].step
        var b = a
        while (i + 1 < steps.length && steps[i + 1].step === b + 1) {
          i += 1
          b = steps[i].step
        }
        out.push(a === b ? String(a) : a + '–' + b)
        i += 1
      }
      return out.join(', ')
    }

    /**
     * 这一步是否**已经落地** —— 也就是"它的输出吐完了没有"。
     *
     * 只有 `thinking` / `waiting` 是"还在跑"：前者在流式吐字、后者在等工具回来，
     * 两种情况下**都可能再冒出一次工具调用**，所以这一刻还不能断言"没调工具"。
     *
     * ⚠️ `ready`（流已结束、工具都已回收、只差收尾事件）算**已落地**：
     *    工具调用属于 assistant 消息本身，消息的流一结束，"有没有工具"就已经定了。
     *    这也让它和 `derive` 里的 `active`（thinking / waiting）**天然互补** ——
     *    面板上"进行中的块"和"时长格在涨的那一步"永远是同一件事，不会各说各话。
     * @param step - 步骤事实。
     * @returns 是否已落地。
     */
    function stepSettled(step) {
      return step.status !== 'thinking' && step.status !== 'waiting'
    }

    /** 块里是否**还有没落地的步** —— 也就是"这一块还在跑"。 */
    function phaseSettled(phase) {
      for (var i = 0; i < phase.steps.length; i += 1) {
        if (!stepSettled(phase.steps[i])) return false
      }
      return true
    }

    /**
     * 进行中的块叫什么：**等工具 → 调用中，自己在想 → 推理中**。
     *
     * 两个词都是"进程词"，不是分类名词 —— 进行中的块还没定性，不该冒充分类。
     * 它在干什么由**步骤行**回答（工具名 + 等待块里的参数），块头只回答"它还在动"。
     * @param phase - `groupPhases` 产出的阶段。
     * @returns 显示名。
     */
    function runningLabel(phase) {
      for (var i = 0; i < phase.steps.length; i += 1) {
        if (phase.steps[i].status === 'waiting') return '调用中'
      }
      return '推理中'
    }

    /**
     * 阶段显示名。
     *
     * 细分（读代码 / 跑命令 / 命令行）已经在 `familyOf` 里做掉了，
     * 所以块内的步**天然同族**，显示名就是族名 —— 不需要再按多数派猜一次。
     *
     * ⚠️ **没落地的块不许用分类语法**。`familyOf` 判"纯推理/读代码"的依据是
     *    "这一步调了什么工具"，而那是个**事后**才成立的事实：模型正在流式吐字时
     *    工具还没到，块就先挂上「纯推理」，等工具一到又当场改名成「读代码」——
     *    读者看到的是"它刚说自己在纯推理，转头就去读文件了"。
     *    所以：**没落地 → 推理中 / 调用中**（只断言此刻看得见的事实），
     *    **落地之后 → 分类名词**（那时"没调工具/在读代码"才是真的）。
     *    （用词跟步骤行右侧时长格原先那套「推理」「调用」一致 —— 头部状态标签删掉后，
     *      「推理中 / 调用中」就只剩这一处出口了：同一件事只有一种叫法。）
     * @param phase - `groupPhases` 产出的阶段。
     * @returns 显示名。
     */
    function phaseLabel(phase) {
      if (!phaseSettled(phase)) return runningLabel(phase)
      return phase.family
    }

    /**
     * 这一块是不是**给用户的答复**（用户反馈："每个轮次的最后一步不应该叫纯推理"）。
     *
     * 判据三条，缺一不可（真实数据：913 轮里 **819 轮**的最后一步正是这种）：
     *   ① 它是**这一轮的最后一步** —— 中间步骤的正文只是"调用工具前的过渡语"，
     *      那确实是推理的一部分；只有最后一步的正文是**写给用户看的**；
     *   ② 没有工具调用（有工具的话它就是那件事，按工具族叫）；
     *   ③ 真的产出了正文（`textChars > 0`）—— 只有思考没有正文的 11 轮不算，
     *      完全空的 79 轮（多为命令轮 / 空转轮）也不算。
     * 另外要求它**已落地**：还在流式吐字时块头该说「推理中」——
     * 没落地的块不许用分类语法（见 `phaseLabel` 的说明）。
     *
     * ⚠️ 只改**显示名**，不动分组：819 轮里只有 **1 轮**的最后一步会和前一步并成一块，
     *    为它去改分组不划算，反而会让"块名"和"分组"两个概念重新搅在一起。
     * @param phase - 一个阶段块。
     * @param lastStep - 这一轮的最后一步（没有就 undefined）。
     * @returns 是答复时 true。
     */
    function isAnswerPhase(phase, lastStep) {
      if (lastStep === undefined || lastStep === null) return false
      if ((lastStep.tools || []).length > 0) return false
      if (!stepSettled(lastStep)) return false
      if (phase.steps.indexOf(lastStep) < 0) return false
      var chars = lastStep.textChars !== undefined ? lastStep.textChars
        : (typeof lastStep.text === 'string' ? lastStep.text.length : 0)
      return chars > 0
    }

    /**
     * 本地规则分组：相邻步属于同一阶段当且仅当
     *   ① 工具族相同，且 ② 间隔没超过 PHASE_GAP_MS。
     * 间隔用"下一步开始 − 这一步开始"的差，长间隔说明中间在等外部（联网/工具）。
     * @param steps - 一个 turn 的步骤数组（按 step 升序）。
     * @param gapMs - 覆盖默认阈值（仅测试用）。
     * @returns 阶段数组。
     */
    function groupPhases(steps, gapMs) {
      var limit = gapMs === undefined ? PHASE_GAP_MS : gapMs
      var phases = []
      var cur = null
      for (var i = 0; i < steps.length; i += 1) {
        var s = steps[i]
        var fam = familyOf(s)
        var prev = steps[i - 1]
        var gap = prev ? s.startedAt - prev.startedAt : 0
        /**
         * **进行中的那一步自己一块**（用户："进行中的块只能有一个步骤"）。
         *
         * 判据是"它是最后一步、而且还没落地"—— 活跃步永远是最新的那一步，
         * 所以这条规则等价于"进行中的块里只有一个步骤"。不这么做的话，
         * 连续几步同族（实测：连着 3 条 bash）会并成一块，于是块头写「第 19 步」、
         * 块内还挂着 #17 #18 #19 三行 —— 用户报的"步骤号太多、重复"就是这么来的。
         *
         * ⚠️ 只在**最后一步且未落地**时断开，所以：
         *   · 它前面那几步照常按同族/间隔并块（信息一点没丢）
         *   · 它落地之后**会并回上面那一块**（那时它已经不是"进行中"了）——
         *     这是有意的：过程说完了，就该归进它所属的那一类里。
         */
        var live = i === steps.length - 1 && !stepSettled(s)
        if (!cur || cur.family !== fam || gap > limit || live) {
          cur = { family: fam, steps: [], label: fam, cat: phaseCategory(fam) }
          phases.push(cur)
        }
        cur.steps.push(s)
      }
      // 分组完成后才定显示名：`label` 要看**整块**的内容，边分边算拿不到全局。
      // 注意它只影响显示，不参与上面的分组判断 —— 这是刻意的（见 phaseLabel 的说明）。
      // `cat` 在上面建块时已经给了（面板用不合并的 phases，也要颜色）。
      var lastStep = steps.length ? steps[steps.length - 1] : null
      for (var k = 0; k < phases.length; k += 1) {
        phases[k].label = phaseLabel(phases[k])
        // 「回答」：这一轮的**最后一步**、没有工具、有正文 —— 它是给用户看的答复，
        // 不是"只在脑子里"的推理。只覆盖显示名与颜色，分组照旧（见 isAnswerPhase）。
        if (isAnswerPhase(phases[k], lastStep)) {
          phases[k].label = '回答'
          phases[k].cat = phaseCategory('回答')
        }
      }
      return phases
    }

    // ────────────────────────────── 样式 ──────────────────────────────
    // 全部走宿主 token，没有一个字面量颜色 —— 深浅色主题自动跟随。

    var CSS = [
      '.tf-root{display:flex;flex-direction:column;height:100%;min-height:0;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}',
      /* ── 头部 ── */
      // 头部形态：一行「标题 · 视图切换 · 状态胶囊」+ 一行独立统计。这是最早那版的样子。
      /*
       * 表头几何**照抄宿主自带面板头**，不是自己挑一个好看的 padding。
       *
       * 宿主右栏里那些自带面板的头全是同一套（源码逐个对过）：
       *   files       `.k-1LKG_header`
       *   browser     `.SB_kFW_toolbar`
       *   documentpreview `.dhJKeW_header`
       *   deliverables    `.IP6KhG_header`
       *   都是 `box-sizing:border-box; height:38px; border-bottom:.5px solid border-l3`。
       *
       * 为什么必须一样：dockkit 允许一个右栏并排放两列（第 0 列 + 第 1 列），
       * 相邻两列的表头线**必须接成一条** —— 高度差 1px、线宽差 0.5px，
       * 交界处就是一级看得见的台阶（用户截图里那条线比左边低了约 2.5px）。
       *
       * 旧写法 `padding:9px 11px` + 标题 22px 行高 = **40px**（真机上按行高还会
       * 落到 40.5px 这种半像素上，border 因此跨在两行设备像素之间，线看着发虚）。
       * 换成定高 38px 之后，行高再怎么变都动不了表头高度 —— 对齐这件事不再依赖字体。
       *
       * border 也一起换成宿主那一档：`.5px` + `border-l3`（l3 = #0000001f，
       * 比原来 1px 的 l2 更细、略深）—— 只把高度对上、线还是粗细不同，
       * 接起来仍然是一条"半截的线"。
       */
      '.tf-head{flex:0 0 auto;box-sizing:border-box;display:flex;align-items:center;gap:9px;height:38px;padding:0 11px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.tf-title{font:var(--dsw-font-s-strong-14);flex:1;min-width:0}',
      '.tf-toggle{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden;flex:0 0 auto}',
      '.tf-toggle button{border:0;background:none;padding:2px 8px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.tf-toggle button:hover{color:var(--dsw-alias-label-secondary)}',
      '.tf-toggle button.is-on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.tf-badge{display:inline-flex;align-items:center;gap:5px;font:var(--dsw-font-xxxs-11);border-radius:999px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:0 0 auto}',
      '.tf-badge .tf-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 auto}',
      /* ⚠️ `.is-on` / `.is-wait` 两档跟着头部状态标签一起删了（推理 / 调用 / 完成…）。
         徽章**系统**留着 —— 现在只有"面板坏了"这一枚用它（见 errChip）。 */
      '.tf-badge.is-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',
      /*
       * 第二行 = 轮次即身份（设计稿 docs/panel-nav.html 的 ③，用户选定）：
       *   ‹ 第 N 轮 ›  »   这一轮的标题                        历史
       *
       * 它就是原来那一行统计行（同样的位置、同样的 padding 与下边框），
       * 只是把四个会话合计（共 N 轮 / 步骤 / 思考 / 工具）换成了"我在哪 + 这是什么 + 去哪"。
       * 轮号与标题都是从轮头**搬上来**的 —— 所以轮头只剩步数/字数/工具 + 生成标题。
       */
      '.tf-nav{flex:0 0 auto;display:flex;flex-wrap:nowrap;align-items:center;gap:8px;padding:6px 11px;border-bottom:1px solid var(--dsw-alias-border-l2);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);min-width:0}',
      '.tf-nav b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}',
      /* 标题占满中间那段空位；窄了先牺牲它（轮号与按钮都是 flex:0 0 auto，不会被压） */
      '.tf-nav .tf-turn-title{flex:1 1 auto;min-width:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tf-nav .tf-turn-title.is-pending{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.tf-nav .tf-turn-title.is-model{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary)}',
      '.tf-nav .tf-turn-title.is-fallback{color:var(--dsw-alias-label-tertiary)}',
      /* 没有标题的轮：占位也**必须看得见**（它是历史入口的落点，见 navRow） */
      '.tf-nav .tf-turn-title.is-empty{color:var(--dsw-alias-label-tertiary)}',
      /*
       * 「历史」挪进标题栏、做成按钮（用户要求）。
       * 几何抄的是旁边那个「实时」胶囊：同样的 padding / 圆角 / 描边，
       * 这样标题栏里三个胶囊（实时 / 状态 / 历史）读作一排，而不是"两个胶囊 + 一个文字链"。
       * 颜色用 link —— 它是**去别处**的动作，不是开关，所以不像「实时」那样用填充表示开合。
       */
      /* 「生成标题」挪到第二行、占原来「历史」的位置（行尾）—— 它自带的 margin-left:auto 正好干这件事 */
      '.tf-nav .tf-gen{flex:0 0 auto}',
      /* 「»」跳到最新一轮：不在最新时点亮 —— 焦点条删掉之后，它是"你不在实时那轮"唯一的信号 */
      '.tf-latest{border:0;background:none;padding:0 3px;margin:0;cursor:pointer;border-radius:4px;font:var(--dsw-font-xs-13);line-height:1;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.tf-latest.is-back{color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.tf-latest:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.tf-latest.is-back:hover:not(:disabled){color:var(--dsw-alias-state-business-primary)}',
      '.tf-latest:disabled{opacity:.26;cursor:default}',
      '.tf-latest:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.tf-gen{margin-left:auto;border:0;background:none;padding:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-link);cursor:pointer;white-space:nowrap}',
      '.tf-gen:hover{text-decoration:underline}',
      '.tf-gen[disabled]{color:var(--dsw-alias-label-tertiary);cursor:default;text-decoration:none}',
      '.tf-gen-err{margin-left:8px;color:var(--dsw-alias-state-error-primary)}',
      /* 「历史」：统计行末尾那唯一的目录入口（链接色 + 下划线 hover）。
         它得在统计行的**最后**才被 margin-left:auto 推到右边。 */
      /* 自动标题开关：默认关（不花 token），开着时用链接色提示"它在自动花钱" */
      /*
       * 「实时」开关（设计稿 realtime-toggle-2.html 的 A 方案：去点胶囊）。
       * ⚠️ 它**没有圆点** —— 圆点留给徽章独占（那一版解决"两个胶囊互相冒充"的办法：
       *    有圆点 = 状态，无圆点 = 控件）。头部状态标签删掉之后，全面板只有
       *    **异常 / 断线**兜底那一枚还带圆点。
       * 开/关靠**填充**区分（复用分段控件选中态的同一套色），生成中整枚轻微脉冲。
       */
      '.tf-live{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:none;padding:2px 9px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:0 0 auto}',
      '.tf-live:hover{color:var(--dsw-alias-label-secondary)}',
      // 开 = **绿色**（宿主 state-success 那套；用户定的）—— 和徽章的红色（异常/断线）分开
      '.tf-live.is-on{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);font-weight:600}',
      // 呼吸：1.8s 一个来回（比"闪"慢），最低到 .6（再低就像"禁用"而不是"在干活"）
      '.tf-live.is-busy{animation:tf-live-pulse 1.8s ease-in-out infinite}',
      '@keyframes tf-live-pulse{0%,100%{opacity:1}50%{opacity:.6}}',
      '@media (prefers-reduced-motion: reduce){.tf-live.is-busy{animation:none}}',
      /* ⚠️ 「历史」按钮（头部那枚 + 统计行这条老样式）**已删** —— 用户把它换成了
         "双击轮次标题就地变搜索框"（见 navRow 的 onDoubleClick）。第一行现在靠
         `.tf-title` 的 `flex:1` 把右侧那几件（看结构/看原文、实时）顶到行尾。 */
      /* 会话头部那个「开标签」按钮（注册进 conversation.session.header.utilities） */
      // 图标按钮：与相邻的宿主图标同尺寸同悬停，避免看起来像异类
      '.tf-open{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.tf-open:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.tf-open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.tf-open svg{display:block}',
      /* ── 主体 ── */
      '.tf-body{flex:1;min-height:0;overflow:auto;padding:11px 13px 0;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}',
      /*
       * 目录是**页**，不继承轮次列表的顶部内边距。
       *
       * ⚠️ 这 11px 不是审美问题：`position:sticky;top:0` 在带 padding 的滚动容器里
       *    会停在**内边距下面**（实测偏移正好 11px），于是搜索条上方留出一条 11px 的缝，
       *    下面的行从缝里滚过去。把内边距去掉，`top:0` 才真的是 0（实测偏移 0）。
       */
      '.tf-body.is-dir{padding-top:0}',
      /**
       * **内容末尾的留白**：让最后一个内容还能继续往上滑。
       *
       * 右下角常叠着别的插件挂的悬浮胶囊（`dsh-spend` 的花费 + `dsh-selection-explain`
       * 的"划词解读"），实测加起来压住右栏底部 ≈ 136px。留 150px，滚到底时最后一段
       * 内容正好落在它们**上方**（多出 14px 余量）。
       *
       * ⚠️ 用伪元素当占位块，**不用** `.tf-body` 的 `padding-bottom` ——
       * 滚动容器的底部 padding 在部分浏览器里**不计入可滚动区域**，那样留白等于没留。
       * 块级伪元素的高度一定算进内容里，滚到底就是真的能滑上来。
       */
      '.tf-body::after{content:"";display:block;height:150px}',
      '.tf-body::-webkit-scrollbar{width:8px}',
      '.tf-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:8px}',
      '.tf-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}',
      '.tf-body::-webkit-scrollbar-track{background:transparent}',
      '.tf-empty{padding:30px 4px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.9}',
      /* ── 阶段：一层 surface 把内容分组（分组，不是每步套卡） ── */
      /*
       * 每个阶段块按**活动分类**上色：一根实色竖条 + 一层极淡的同色底 + 同色描边。
       *
       * 色相只有 5 个，全部取自宿主的语义色（见 CATEGORY_OF 的说明 ——
       * 宿主设计系统里就 4 个色相 + 中性灰，二十多个块名各配一色只能自己编）。
       * 底色用 `color-mix` 从同一个色相调出来，不写死色值：
       * 深色主题下自动跟着变（`--dsw-static-*` 是主题无关的，不能用来铺底）。
       * 7% 是很轻的一层：块要能一眼分辨，但整屏不能变成调色盘。
       */
      '.tf-phase{--tf-hue:var(--dsw-alias-label-tertiary);background:color-mix(in srgb, var(--tf-hue) 7%, var(--dsw-alias-markdown-code-block));border-radius:8px;margin:0 0 10px;overflow:hidden;border:1px solid color-mix(in srgb, var(--tf-hue) 24%, var(--dsw-alias-border-l2))}',
      '.tf-phase.cat-read{--tf-hue:var(--dsw-alias-state-business-primary)}',
      '.tf-phase.cat-write{--tf-hue:var(--dsw-alias-state-success-primary)}',
      '.tf-phase.cat-run{--tf-hue:var(--dsw-alias-state-warn-primary)}',
      '.tf-phase.cat-ask{--tf-hue:var(--dsw-alias-state-error-primary)}',
      '.tf-phase.cat-think{--tf-hue:var(--dsw-alias-label-tertiary)}',
      '.tf-phase-h{display:flex;align-items:center;gap:9px;padding:8px 10px;cursor:pointer}',
      '.tf-phase-h:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tf-bar{width:3px;height:14px;border-radius:2px;background:var(--tf-hue);flex:0 0 auto}',
      // 当前所在阶段：不再改竖条颜色（那会盖掉分类色），改用更实的描边 + 名字加深
      '.tf-phase.is-on{border-color:color-mix(in srgb, var(--tf-hue) 55%, transparent)}',
      '.tf-phase-name{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tf-phase.is-on .tf-phase-name{color:var(--dsw-alias-label-primary)}',
      /* 次标题：进行中的块把"状态词"（推理中 / 调用中）放在主标题后面 ——
         比主标题小一档、用三级标签色，读作"这是它的状态"，而不是又一个标题。 */
      '.tf-phase-sub{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.tf-phase-meta{margin-left:auto;display:flex;gap:9px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto}',
      '.tf-phase.is-closed .tf-phase-b{display:none}',
      '.tf-phase-b{padding:0 8px 7px}',
      /* ── 进行中的块：说"状态语言"，不穿分类的衣服（用户选定的方案：B + A 的空心环） ──
       *
       * 已完成的块说"分类"（读代码 / 改文件 / 跑命令 + 分类色）—— 那是**事后成立的事实**；
       * 进行中的块说"状态"（推理中 / 调用中 + 状态色），因为分类它还没挣到
       * （工具可能还在路上）。三个变化：
       *   ① 颜色换成宿主的"活跃/等待"语义色 —— 和步骤行的 `.is-live`/`.is-wait`、
       *      光标用的是同一套 token，于是"哪一块在跑"在整块面板上是同一种颜色；
       *   ② 左条换成**空心圆环**（空心 = 还没填上东西 = 还没定性）+ 呼吸 + 发光；
       *   ③ **底边不封口**（虚线）—— "还在长"这件事，形态比颜色更快被读到。
       * ⚠️ 开关是 `is-running`，**不是 `is-on`**：`activePhase` 在跑完之后仍取最后一块
       *    （那是"你在这"），拿它当"进行中"会把已完成的轮次也染上。
       *    这条有回归：test:client 的 ㊵ 断言"跑完之后 is-running 为 0、而 is-on 仍在"。
       * ⚠️ 灰不能用来表达"未定性"：灰**已经**是 cat-think 的颜色，会和已完成的纯推理块撞车，
       *    所以区分落在圆环与虚线上（见探索稿 docs/running-options.html 的 ②）。
       */
      '.tf-phase.is-running{--tf-hue:var(--dsw-alias-state-business-primary);border-bottom:1px dashed color-mix(in srgb, var(--tf-hue) 68%, transparent)}',
      '.tf-phase.is-running.is-wait{--tf-hue:var(--dsw-alias-state-warn-primary)}',
      /*
       * 空心环**发光** = **贴边光晕**（单层 box-shadow，跟着环一起呼吸）。
       *
       * 这条路走过三轮，别把前两轮的结论丢了：
       *   ① 第一版：`0 0 6px/45%` 的光晕 + `scale(.7)`。用户说"不太好看" ——
       *      实测病灶是**模糊半径（6px）比环（9px）还大**，浅色底上读作"环旁边一团脏蓝灰"，
       *      指认不出光是从这个环发出来的。
       *   ② 中间试过六套并排（`docs/ring-glow-options.html` / `-prototype.html`），
       *      一度选定 ④ 流光（一道高光绕着环跑）。用户看完原型改主意：
       *      **"去掉流光，还是改回第一版①贴边光晕，但是光晕要小一些，光强可以大一些"**。
       *   ③ 现在这一版 = ① 的机制 + 两个参数按用户的话调：
       *      · **光晕小一些**：模糊半径 6px → 3px（亮相位 8px → 3.5px），
       *        加 0.5px spread 让近场有一点点硬边 —— 光贴着环，不再糊成一片；
       *      · **光强大一些**：透明度 45/58/20% → 72/88/45%，
       *        暗相位的 `opacity` .34 → .55（原来那一下几乎把环熄掉，"光强"就无从谈起）。
       *      呼吸仍然是**三个量一起动**（透明度 / 尺寸 / 光晕）—— 那是第一版的形态，保留。
       *   ④ 用户接着又说"**呼吸的频率低一些**"：周期 1.7s → **2.4s**（+41%，频率降约三成）。
       *   ⑤ 然后是"**呼吸的幅度小一些**"：三个量的暗相位一起往亮相位靠（约收一半）——
       *      opacity .55 → **.78**、scale .7 → **.88**、光晕 1.5px/45% → **2.6px/70%**。
       *      亮相位（1 / 1 / 3.5px 88%）一个都不动：那是"光强"那一轮定下来的，
       *      收幅度收的是**暗的那一头**，不是把灯调暗。
       *
       * ⚠️ 色值必须走 `--tf-hue` + `color-mix`：等待态把 `--tf-hue` 换成琥珀之后，
       *    光晕得跟着变琥珀（写死蓝色的话，卡在工具上的那块会"蓝环发琥珀光"）。
       *
       * ⚠️ 基础规则里那条 `box-shadow` **不能省**：降级（reduced-motion）时动画被关掉，
       *    静态的强光晕就是"这块是活的"最后一点提示 —— 和虚线底边同一个道理（形态，不是动画）。
       */
      '.tf-phase.is-running .tf-bar{width:9px;height:9px;border-radius:50%;background:none;border:2px solid var(--tf-hue);box-shadow:0 0 3px 0 color-mix(in srgb, var(--tf-hue) 72%, transparent);animation:tf-ring 2.4s ease-in-out infinite}',
      // 呼吸：透明度 + 尺寸 + 光晕。周期 2.4s（"频率低一些"）；
      // 幅度收了一半（"幅度小一些"）—— 暗相位从 .55/.7/1.5px 收到 .78/.88/2.6px
      '@keyframes tf-ring{0%,100%{opacity:1;transform:scale(1);box-shadow:0 0 3.5px .5px color-mix(in srgb, var(--tf-hue) 88%, transparent)}50%{opacity:.78;transform:scale(.88);box-shadow:0 0 2.6px 0 color-mix(in srgb, var(--tf-hue) 70%, transparent)}}',
      // 降级之后**仍然看得见**：环只是不再呼吸，那层强光晕还在（虚线底边也是形态）
      '@media (prefers-reduced-motion:reduce){.tf-phase.is-running .tf-bar{animation:none}}',
      /* ── 进行中的块：只说"过程"，不说"身份"（用户定的两条） ──
       * ① 块里只有**一个步骤**（见 groupPhases 的 live）：不这样，连续几步同族会并成
       *    一块，块头写「第 19 步」、块内还挂着 #17 #18 #19 —— 就是"步骤号太多、重复"。
       * ② 那一步的**行号不画**（renderStep），标题补位前移；块头元信息的**区间也不报**
       *    （块头已经写着「第 N 步」，区间和它一字不差）。
       *    落地之后两者都回来：块头改说分类名，身份就轮到区间与行号来报。
       *
       * ⚠️ 行号格子去掉之后，行内标题的左边缘从 57px 变成 29px（7px padding + 2px border
       *    + 11px 字形 + 9px 间距）。所以**展开区 / 等待行 / 中断说明的缩进要跟着收**
       *    （27px → 20px），否则它们会反超标题、戳到标题右边去。
       */
      '.tf-phase.is-running .tf-wait,.tf-phase.is-running .tf-cut,.tf-phase.is-running .tf-sub,.tf-phase.is-running .tf-raw,.tf-phase.is-running .tf-cap,.tf-phase.is-running .tf-reply{margin-left:20px}',
      /* ── 步骤行：状态字形 + 编号 + 工具 + 容量条 + 耗时 ── */
      '.tf-step{padding:3px 7px;border-radius:6px;border-left:2px solid transparent}',
      '.tf-step+.tf-step{margin-top:1px}',
      '.tf-step-row{display:flex;align-items:center;gap:9px;min-width:0}',
      '.tf-glyph{width:11px;flex:0 0 auto;text-align:center;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tf-step.is-done .tf-glyph{color:var(--dsw-alias-state-success-primary)}',
      '.tf-step.is-live .tf-glyph{color:var(--dsw-alias-state-business-primary)}',
      '.tf-step.is-wait .tf-glyph{color:var(--dsw-alias-state-warn-primary)}',
      '.tf-step.is-cut .tf-glyph{color:var(--dsw-alias-state-warn-primary)}',
      '.tf-no{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:0 0 auto;min-width:19px;text-align:right}',
      '.tf-step.is-live .tf-no,.tf-step.is-wait .tf-no{color:var(--dsw-alias-label-secondary)}',
      // 中文标题：填进行内的空白处（原来那段是空的），长了就省略号
      '.tf-step-title{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tf-step.is-live .tf-step-title,.tf-step.is-wait .tf-step-title{color:var(--dsw-alias-label-primary);font-weight:600}',
      /* 命令标题（`$ 跑测试`）：位置和模型标题一样，但**淡一档** + `$` 前缀标来源。
         两种标题会在同一轮里并排出现，不区分就等于把"模型写的"和"规则读出来的"混为一谈。 */
      /* 一步多个命令 = 标题多行：整行的所有格子都对齐**第一行**。
         默认的 `align-items:center` 会让 `#8`、容量条、时长浮在几行中间。 */
      '.tf-step-row.is-multi{align-items:baseline}',
      /* 一步有多个命令时，行里**多行显示**：容器纵向排列，每行一条标题 */
      '.tf-titles{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}',
      '.tf-titles .tf-step-title{flex:0 0 auto}',
      '.tf-step-title.is-cmd{color:var(--dsw-alias-label-tertiary)}',
      '.tf-step.is-live .tf-step-title.is-cmd,.tf-step.is-wait .tf-step-title.is-cmd{color:var(--dsw-alias-label-secondary);font-weight:400}',
      /* 本地摘要（无工具步）：和 `.is-cmd` 同一档灰 —— 读作"本地规则给的"，不冒充模型标题 */
      '.tf-step-title.is-own{color:var(--dsw-alias-label-tertiary)}',
      '.tf-step.is-live .tf-step-title.is-own,.tf-step.is-wait .tf-step-title.is-own{color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.tf-tool{font:var(--dsw-font-xxxs-11);font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);color:var(--dsw-alias-label-tertiary);flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}',
      '.tf-step.is-done .tf-tool{color:var(--dsw-alias-label-tertiary)}',
      '.tf-flag{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-warn-label);flex:0 0 auto}',
      /*
       * 失败标（行里那枚）。用 error 红，和 warn 琥珀的「不完整 / 重试」**分开** ——
       * 三种标挤在同一行，颜色是唯一能一眼分开它们的维度：
       *   · 不完整 / 重试 = 琥珀（状态未知或重来过，**不是错**）
       *   · 工具失败     = 红（宿主明确写了 `isError: true`）
       *
       * 这个"琥珀 / 红"的分工**照抄宿主**：它自己的工具行就是
       *   `.o3BgMG_errorSummary{color:--dsw-alias-state-error-primary}`
       *   `.o3BgMG_stoppedSummary{color:--dsw-alias-state-warn-label}`
       * —— 失败归红、停住归琥珀，同一个判据。
       */
      '.tf-flag.is-err{color:var(--dsw-alias-state-error-primary)}',
      /* 容量条：宽 = 这一步思考的字数。它同时承担"脊线"和"去重复"两个职责 */
      '.tf-vol{margin-left:auto;width:52px;height:5px;border-radius:3px;background:var(--dsw-alias-border-l2);flex:0 0 auto;overflow:hidden}',
      /*
       * 填充色**不能**用 --dsw-alias-label-dimmed（#e1e5ee）：它和轨道
       * （--dsw-alias-border-l2 = #0000001a，白底上 ≈ #e5e5e5）亮度只差 1.2%，
       * 只有蓝通道差 13 个色阶 —— 整条看上去是一坨均匀浅灰，**比例根本读不出来**，
       * 等于白做（真机截图量出来的：对比度 1.00，肉眼分辨不出）。
       * 名字里的 "dimmed" 是"弱化的标签文字"，不是"浅色填充" —— 挑色要看亮度，别看名字。
       * label-tertiary（浅色 #81858c / 深色 #adb2b8）两个主题下都够看（对比度 2.9 / 5.0）。
       * 这条不变式有回归：test:client 的 ㉓ 会解析真 token 算对比度。
       */
      '.tf-vol>i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-label-tertiary)}',
      '.tf-step.is-live .tf-vol>i,.tf-step.is-wait .tf-vol>i{background:var(--dsw-alias-state-business-primary)}',
      '.tf-step.is-cut .tf-vol>i{background:var(--dsw-alias-state-warn-primary)}',
      /*
       * 时长格必须是**固定宽**，不能用 min-width：尾部这一串（容量条 / 时长 / 箭头）
       * 是右对齐的一整块，格子一宽整块就跟着变宽 —— 容量条的右边缘就会左右漂。
       * 实测：`min-width:32px` 下"正在想"（33px）那两行把容量条挤偏 1px。
       * 38px 是量出来的：最宽的是"12′05″" 约 35px（状态词改成两个字后更短了，
       * 现在最宽的是时长格式 —— 格子宽度保持不变，尾部对齐断言依赖它）。
       */
      /* 时长格。宽度按**最长那种串**留：fmtDur 到分钟档是 6 个字符（`120′0″`），
         11px + tabular-nums 约 40px —— 活跃步的数字是**实时涨**的，留窄了会被顶出格。 */
      '.tf-dur{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:0 0 auto;width:44px;text-align:right}',
      // 展开按钮做成行内小箭头：早先它是独立一行，结果每一步都多占一行，
      // 列表被撑长一倍、也更单调（用户反馈的正是这个）。
      '.tf-chev{border:0;background:none;padding:0;width:14px;flex:0 0 auto;text-align:center;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);cursor:pointer;line-height:1}',
      '.tf-chev:hover{color:var(--dsw-alias-label-primary)}',
      /*
       * 不可展开的行走这个占位：**保住列对齐**。
       * 箭头是条件渲染的，而 `.tf-step-row` 是 flex + gap:9px —— 少一个 14px 的箭头
       * 就少一个 9px 的间距，那行的容量条和时长会整体右移 23px，跟上下行对不齐
       * （真机截图量出来的：条右边缘差 22px、时长右边缘差 23px）。
       * 用 visibility 而不是 display:none —— 前者保留盒子，后者不保留。
       */
      '.tf-chev.is-blank{visibility:hidden}',
      '.tf-step.can-open:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tf-step.can-open{cursor:pointer}',
      /* ── 当前步：重点色高亮（整块淡蓝底 + 左侧蓝条） ── */
      '.tf-step.is-live,.tf-step.is-wait{background:var(--dsw-alias-state-business-tertiary);border-left-color:var(--dsw-alias-state-business-primary)}',
      '.tf-step.is-wait{background:var(--dsw-alias-state-warn-tertiary);border-left-color:var(--dsw-alias-state-warn-primary)}',
      '.tf-step.is-cut{background:var(--dsw-alias-state-warn-tertiary);border-left-color:var(--dsw-alias-state-warn-primary)}',
      '.tf-stream{margin:4px 0 1px 27px;font:var(--dsw-font-markdown-code);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:72px;overflow:hidden}',
      '.tf-caret{display:inline-block;width:5px;height:11px;background:var(--dsw-alias-state-business-primary);vertical-align:-1px;animation:tf-blink 1s steps(2) infinite}',
      '@keyframes tf-blink{0%,100%{opacity:1}50%{opacity:0}}',
      '@media (prefers-reduced-motion:reduce){.tf-caret{animation:none}}',
      /* 等待块 */
      '.tf-wait{margin:5px 0 1px 27px;padding:6px 9px;border-left:2px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-base);border-radius:0 6px 6px 0}',
      '.tf-wait-row{display:flex;align-items:center;gap:7px}',
      '.tf-wait-name{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-state-warn-label);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tf-wait-el{margin-left:auto;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-state-warn-label);font-variant-numeric:tabular-nums;flex:0 0 auto}',
      '.tf-wait-note{margin-top:3px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:1.6;word-break:break-word}',
      '.tf-spin{display:inline-block;width:9px;height:9px;border:1.5px solid var(--dsw-alias-state-warn-primary);border-top-color:transparent;border-radius:50%;animation:tf-spin .9s linear infinite;flex:0 0 auto}',
      '@keyframes tf-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.tf-spin{animation:none;border-top-color:var(--dsw-alias-state-warn-primary)}}',
      '.tf-cut{margin:5px 0 1px 27px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-warn-label);line-height:1.6}',
      /* ── 轮次：历史轮次默认折叠成一行，点开才展开阶段 ── */
      '.tf-turn{margin-bottom:8px}',
      '.tf-turn-h{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px;background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l2);cursor:pointer}',
      '.tf-turn-h:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tf-turn-h.is-current{border-color:var(--dsw-alias-state-business-primary)}',
      '.tf-turn-h.is-cut{border-color:var(--dsw-alias-state-warn-primary)}',
      /* ⚠️ `min-width` 是"进/出历史态搜索框不跳"的关键：数字格从 `第 133 轮`（55.7px）
         换成 `共 20 轮`（约 46px）时，不固定宽度的话前面那一组会缩 12px、搜索框跟着左移。
         56px 覆盖到三位数轮号；居中让 1~2 位数的轮号看起来也齐。 */
      '.tf-turn-no{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);flex:0 0 auto;min-width:56px;text-align:center}',
      '.tf-turn-h.is-current .tf-turn-no{color:var(--dsw-alias-label-primary)}',
      /*
       * 相邻轮次步进器（设计稿 docs/turn-adjacent-2.html 的 ②）：
       * 轮号两侧各一个 12px 小箭头 —— **翻的就是这个数字本身**。不新增行、不新增条、
       * 不新增文字，也不和「历史」挤在一起。数字走等宽数字，翻轮时轮头一个像素都不抖。
       */
      '.tf-turn-nav{display:inline-flex;align-items:center;gap:0;flex:0 0 auto}',
      '.tf-turn-nav .tf-turn-no{padding:0 1px;font-variant-numeric:tabular-nums}',
      /* ⚠️ `min-width` + 居中 + **border-box**：箭头（`‹`/`›`）与历史态那颗 `·`
         的字宽不同，不锁宽度那一组就会缩几像素、搜索框跟着动（跳变归零的前提）。
         `box-sizing` 不能省：`<button>` 在 Chrome 里默认 border-box，而历史态那颗
         `·` 是 `<span>`（content-box）—— 不写的话同一句 `min-width:12px` 会量出
         12px 与 18px 两个宽度（真踩过，实测那一组差了 12px）。 */
      '.tf-turn-nav-b{box-sizing:border-box;border:0;background:none;padding:0 3px;margin:0;cursor:pointer;border-radius:4px;font:var(--dsw-font-xs-13);line-height:1;color:var(--dsw-alias-label-tertiary);min-width:12px;text-align:center}',
      '.tf-turn-nav-b:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.tf-turn-nav-b:disabled{opacity:.26;cursor:default}',
      /* 历史态那颗 `·`：**纯装饰** —— 没有手型、悬停不亮（用户："剥离其原本的功能"） */
      '.tf-turn-nav-b.is-dot{cursor:default}',
      '.tf-turn-nav-b.is-dot:hover{color:var(--dsw-alias-label-tertiary)}',
      '.tf-turn-nav-b:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.tf-turn-meta{display:flex;gap:9px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:1 1 auto;min-width:0;overflow:hidden}',
      /*
       * 有轮标题时的轮头（设计稿 docs/turn-title.html 的**平铺第二行**）：
       * 第一行保持原样（编号 + 元信息 + 生成标题 + 箭头），标题独占第二行。
       *
       * ⚠️ `order:9` + `flex:1 0 100%`：轮头是允许换行的 flex，靠这两条让标题独占一行。
       *    只靠 DOM 顺序不行 —— 标题是最后追加的，不加 order 会被排进第一行（第一版预览就这么错过）。
       * ⚠️ 标题**一行到底 + 省略号**：不换行、不撑高，超出容器宽度就在末尾截停。
       *    轮头是列表项（显示历史时 20 轮同时在列），高度必须稳定 —— 宁可截断也不换行。
       */
      /* 轮头的标题那一行**搬到第二行**去了（见 .tf-nav .tf-turn-title），
         轮头从此恒为一行：步数 / 字数 / 工具 + 生成标题 + 折叠箭头。 */
      /*
       * 两种来源的对比（用户定的方向：AI 总结那条加黑，并要求"再明显一点"）。
       *
       * 两头一起拉：
       *   AI 总结   → label-primary（#0f1115，白底 ~19:1）+ 字重 600
       *   用户消息  → label-tertiary（#81858c，~3.7:1）+ 字重 400
       *
       * 字重用**设计系统的 token**（`--dsw-font-xxs-strong-12` = 500），不硬写 600：
       * 一来它就在系统的字级表里，二来颜色那一档（primary vs tertiary）已经拉开了主要差距。
       * （早先试过 600：那是回落态还停在 secondary 的时候，光靠 500 不够；现在不需要了。
       *   600 本身不算自创 —— 宿主的分段控件选中态、本插件的 `.tf-toggle button.is-on` 都用它。）
       * ⚠️ 回落态降到 tertiary 是**为对比让了一步可读性**（3.7:1，低于正文 AA 的 4.5:1）——
       *    它是个"还没总结"的占位态，且宿主自己的元信息文字也用 tertiary。
       *    要是觉得太浅，把它退回 secondary 即可（对比靠 AI 那头的加粗仍够）。
       */

      '.tf-turn-b{padding:7px 0 0 2px}',
      '.tf-tools{margin:5px 0 0 27px;display:flex;flex-direction:column;gap:3px}',
      '.tf-tool-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:7px;font:var(--dsw-font-xxxs-11)}',
      '.tf-tool-name{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.tf-tool-note{color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      /* 参数和工具名**同一行**：`flex-basis` 必须是 0，不能是 auto ——
         `flex:1 1 auto` 的"假想尺寸"等于整串参数（几百字），永远塞不进当前行，
         `flex-wrap:wrap` 就会把它换到下一行（试出来的：`bash` 单独一行、参数在下面一行）。 */
      '.tf-tool-args{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);opacity:.85;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 0}',
      /*
       * 失败详情行：紧跟在**它自己那条工具行**下面（同 `.tf-tools` 这一列，gap 3px 会
       * 把它推得像"下一条工具"，所以负 1px 收一下，读作"上一行的注脚"）。
       *
       * 码在前、摘要在后，两者都是红：码是等宽（机读，能在日志里 grep），
       * 摘要是正文那句话（宿主给的原话，不翻译 —— 翻了就跟日志对不上）。
       * 摘要是单行省略号，全文在悬停里（最多 200 字，宿主已经截过）。
       */
      '.tf-tool-err{display:flex;align-items:baseline;gap:6px;min-width:0;margin-top:-1px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary)}',
      '.tf-tool-err-mark{flex:0 0 auto}',
      '.tf-tool-err-code{flex:0 0 auto;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}',
      '.tf-tool-err-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}',
      /* 展开区里的次级标题（派生标题）：比工具详情大一号、读起来像副标题 */
      /* 展开区里的派生标题：它本身就在 `.tf-tools`（已缩进 27px）里，
         自己再缩进一次就成了 54px —— 比它下面的工具行、思考原文都深一截。
         去掉，跟它们对齐到同一条线。 */
      '.tf-sub{margin:5px 0 0 27px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}',
      '.tf-tools .tf-sub{margin-left:0}',
      '.tf-raw{margin:4px 0 2px 27px;padding:8px 9px;background:var(--dsw-alias-bg-base);border-radius:6px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l1)}',
      /* 小标：展开区里区分"思考原文"和"回答正文"（两块都在时才有必要，但一直给最省心） */
      '.tf-cap{margin:7px 0 0 27px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      /* 正文：**正文字体**（不是等宽）—— 它是"结论"，不是"草稿"。
         和 .tf-raw 同一套几何（缩进 / 圆角 / 滚动上限），只是字体与底色不同：
         思考原文用 bg-base（读作"原文"），正文用 bg-layer-2 更亮一档（读作"成品"）。 */
      '.tf-reply{margin:3px 0 2px 27px;padding:8px 9px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;font:var(--dsw-font-xxs-12);line-height:1.75;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l1)}',
      /* ── 收尾小结：填掉底部留白，并给出"思考花在哪了" ── */
      '.tf-recap{margin-top:14px;padding:10px 11px;border-radius:8px;background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l1)}',
      '.tf-recap-t{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}',
      '.tf-recap-s{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);margin-top:3px;font-variant-numeric:tabular-nums}',
      /*
       * 这一轮的小结：一条按字数分段的条 + 一份图例。
       *
       * ⚠️ 条**不按序号调透明度**。早先每段写 `opacity: 1 - 序号*0.14`，看着像
       * "越往后越淡"的设计，实际是：**第 8 段起就全是 0**（32 个阶段时 24 段不可见），
       * 整条只剩第一段可见 —— 看上去像"这一轮只在开头想过"，而后面那些段才是大头
       * （实测 turn 31：第 11/23/28/29 段合计占 50% 的思考量，全被藏掉了）。
       * 现在所有段**同色**：条只负责用**宽度**表达"思考花在哪"，颜色不携带信息，
       * 于是也不可能携带错的信息。段与段之间用 1px 背景色发丝线分隔
       * （用 border 而不是 flex gap —— gap 会额外占位，32 段就是 62px，尾部被裁掉）。
       */
      '.tf-recap-bars{display:flex;height:6px;margin-top:8px;border-radius:3px;overflow:hidden}',
      '.tf-recap-bars i{display:block;height:100%;box-sizing:border-box;background:var(--tf-hue,var(--dsw-alias-label-tertiary));border-right:1px solid var(--dsw-alias-markdown-code-block)}',
      '.tf-recap-bars i:last-child{border-right:0}',
      '.tf-recap-lg{display:flex;flex-wrap:wrap;gap:3px 11px;margin-top:7px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tf-recap-lg span{display:inline-flex;align-items:center;gap:4px}',
      // 图例方块与阶段块**同一个色相**（同一套 cat-* 类），一眼能对上
      '.tf-recap-lg b{width:7px;height:7px;border-radius:2px;background:var(--tf-hue,var(--dsw-alias-label-tertiary));display:inline-block}',
      '.cat-read{--tf-hue:var(--dsw-alias-state-business-primary)}',
      '.cat-write{--tf-hue:var(--dsw-alias-state-success-primary)}',
      '.cat-run{--tf-hue:var(--dsw-alias-state-warn-primary)}',
      '.cat-ask{--tf-hue:var(--dsw-alias-state-error-primary)}',
      '.cat-think{--tf-hue:var(--dsw-alias-label-tertiary)}',
      /* ── 目录「看更早的轮次」+ 搜索 ──
         它是**页**：接管面板，不和 20 轮列表叠在一起。数据是快照里的 index（全轮骨架），
         不是 turns（正文窗口）—— 面板渲染得动 20 轮，目录里有全部轮次。 */
      /* ⚠️ 目录头（`.tf-dir-h`）与它的「回到第 N 轮」（`.tf-dir-back`）**已删** ——
         两件事都搬进了第二行：「共 N 轮」（数字那一格 `.tf-turn-no.is-count`）+「返回」
         （`.tf-nav-back`，与「生成标题」同宽 —— 见 navRow 里"跳变归零"那段）。 */
      /*
       * 搜索：**一条底线**，不是圆角药丸 + 放大镜；而且**钉在顶上**。
       *
       * 为什么要钉：目录是 133 行，滚到第 80 行想改个词，原来得先滚回顶上。
       * ⚠️ 负 margin 是为了**通栏**：`.tf-body` 自带 `padding:11px 13px 0`，
       *    不抵消的话这条粘住的条只有 354px 宽，左右各露 13px 的缝，
       *    下面的行滚过去会在缝里露出来（hover 底色尤其明显）。
       *    左右 padding 用 24 = body 的 13 + 原来那 11，输入框才和目录行**对齐在同一竖线上**。
       */
      /* ⚠️ 目录里那一行搜索框（`.tf-dir-s` / `.tf-dir-q`，连它的 sticky / 通栏 /
         focus 底色一起）**全删了** —— 搜索框现在长在**第二行**（`.tf-nav-q`，
         就是原来轮次标题那一格）。这里留个记号：别再把搜索框加回目录里。 */
      /* 第二行的搜索框：**就是原来标题那一格**（`flex:1` 吃空位、同字号同色）。
         无边框 + 透明底 —— 读起来是"标题变成了可编辑的"，不是"弹出了一个控件"。 */
      '.tf-nav-q{flex:1 1 auto;min-width:0;border:0;background:none;outline:none;padding:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}',
      '.tf-nav-q::placeholder{color:var(--dsw-alias-label-tertiary)}',
      /* 历史态第二行的两头：`共 N 轮`（原来目录头那半句）+ `返回`（原来目录头的出口） */
      /* 「返回」占的就是「生成标题」那一格：**同宽**（44px = 生成标题的实测宽度），
         否则行尾那一格会缩 22px、搜索框右边界跟着动（跳变的另一半）。 */
      '.tf-nav-back{margin-left:auto;flex:0 0 auto;border:0;background:none;padding:0;min-width:44px;text-align:right;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-link);cursor:pointer;white-space:nowrap}',
      '.tf-nav-back:hover{text-decoration:underline}',
      '.tf-nav-back:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:3px}',
      /* 可聚焦的标题：入口从"看得见的按钮"变成"双击"，键盘用户回车进得去 —— 得让人看见焦点 */
      '.tf-nav .tf-turn-title:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:3px}',
      '.tf-dir-count{padding:7px 11px 3px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tf-dir-none{padding:4px 11px 12px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);line-height:1.75}',
      '.tf-dir-day{display:flex;align-items:baseline;gap:8px;padding:10px 11px 3px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tf-dir-day b{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      /* 面板里那 20 轮 / 要靠日志读的更早轮次：一条边界说清这件事 */
      '.tf-dir-edge{display:flex;align-items:center;gap:9px;padding:8px 11px 7px}',
      '.tf-dir-edge::before,.tf-dir-edge::after{content:"";height:1px;flex:1 1 auto;background:var(--dsw-alias-border-l2)}',
      '.tf-dir-edge span{flex:0 0 auto;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tf-dir-row{display:flex;align-items:baseline;gap:9px;width:100%;border:0;background:none;padding:5px 11px;text-align:left;cursor:pointer;font:inherit}',
      '.tf-dir-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tf-dir-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.tf-dir-no{flex:0 0 auto;min-width:24px;text-align:right;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tf-dir-time{flex:0 0 auto;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tf-dir-title{flex:1 1 auto;min-width:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      /* 实测 23% 的轮次用户消息不可读（图片占位 / 「可以」「改」）→ 降级，不假装它是标题 */
      '.tf-dir-title.is-thin{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.tf-dir-row:hover .tf-dir-title{color:var(--dsw-alias-label-primary)}',
      '.tf-dir-steps{flex:0 0 auto;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      /* 搜索结果：snippet 是主角 —— 它回答"为什么命中" */
      '.tf-hit{display:block;width:100%;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:none;padding:8px 11px;text-align:left;cursor:pointer;font:inherit}',
      '.tf-hit:last-child{border-bottom:0}',
      '.tf-hit:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tf-hit:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.tf-hit-h{display:flex;align-items:baseline;gap:9px}',
      '.tf-hit-snip{margin-top:4px;font:var(--dsw-font-xxs-12);line-height:1.75;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      /*
       * 命中高亮：**一处定义，两种位置共用**。
       *
       * ⚠️ 原来只写了 `.tf-hit-snip mark` —— 而命中词**内联进标题**时（短消息 + 回落标题，
       *    最常见的那种），mark 落在 `.tf-dir-title` 里，那条规则匹配不到，
       *    浏览器就用 `<mark>` 的 UA 默认样式：**黄底黑字**。
       *    真机截图里一眼能看到同一个界面里两种高亮色（一次搜轮次号、一次搜词就露出来）。
       */
      '.tf-hit mark{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary);border-radius:2px;padding:0 1px}',
      /* 匹配到的**轮次号**：同一套底色（用户要求"也要加上底色"），只是数字要宽一点、加粗才看得清 */
      '.tf-dir-no mark{padding:0 3px;border-radius:3px;font-weight:600}',
      /*
       * 焦点条（"第 N 轮（时间，步数）回到最新一轮"）**整条删掉了**（用户点名）。
       * 它原来干两件事：报"我在哪"（轮号 + 时间 + 步数）、给一条"回到最新"的路。
       * 前者轮头/导航行里都有（时间与步数目录里有），后者挪到第二行的「»」。
       */
    ].join('')

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
      for (var i = 0; i < state.turns.length; i += 1) if (state.turns[i].turn === c.turn) turn = state.turns[i]
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
      for (var j = 0; j < turn.steps.length; j += 1) if (turn.steps[j].step === c.step) step = turn.steps[j]
      if (!step) {
        step = { step: c.step, reasoningChars: 0, textChars: 0, tools: [], status: 'thinking', startedAt: Date.now(), reasoningText: '' }
        turn.steps.push(step)
        turn.steps.sort(function (a, b) { return a.step - b.step })
      }
      if (c.k === 'reasoning') {
        step.reasoningText = (step.reasoningText || '') + c.text
        step.reasoningChars = (step.reasoningChars || 0) + c.text.length
      } else if (c.k === 'text') {
        step.textTail = ((step.textTail || '') + c.text).slice(-2000)
        // 开头那一段也留着：**行标题的摘要取的是第一句**，而 textTail 是尾部
        // （正文一超过 2000 字，开头就没了）。见 stepOwnTitle。
        step.textHead = ((step.textHead || '') + c.text).slice(0, 160)
        step.textChars = (step.textChars || 0) + c.text.length
      } else if (c.k === 'tool') {
        step.tools = step.tools || []
        if (!step.tools.some(function (t) { return t.id === c.tool.id })) step.tools.push(c.tool)
      } else if (c.k === 'tool-end') {
        var list = step.tools || []
        for (var k = 0; k < list.length; k += 1) {
          if (list[k].id === c.id) {
            list[k].endedAt = c.endedAt
            list[k].resultChars = c.resultChars
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
        var t = setInterval(function () { tick(function (n) { return n + 1 }) }, 500)
        return function () { clearInterval(t) }
      }, [])

      // SSE 连接
      React.useEffect(function () {
        if (!sessionId) return undefined
        stateRef.current = emptyState()
        stateRef.current.sessionId = sessionId
        forceTick()

        var es = new EventSource(API + '/stream?session=' + encodeURIComponent(sessionId))
        es.onopen = function () { stateRef.current.connected = true; forceTick() }
        es.onerror = function () { stateRef.current.connected = false; forceTick() }
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
            for (var i = 0; i < st.turns.length; i += 1) {
              var steps = st.turns[i].steps || []
              for (var j = 0; j < steps.length; j += 1) {
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
        return function () { try { es.close() } catch (e) { /* 已关 */ } }
      }, [sessionId])

      /**
       * 窗口里的一轮 → 骨架行（宿主 `summaryOf` 的客户端版，字段同名同义）。
       *
       * 哪边优先，分两类（两类都各有一个"为什么不反过来"的理由）：
       *   · **身份字段**（`userText` / `startedAt` / `title`）**宿主那份行优先**：
       *     它是宿主从轨迹里算出来的权威值，客户端那份是增量的投影。
       *     （`title` 例外：客户端收到的模型标题更新，比快照里的新。）
       *   · **会长的计数**（步数 / 工具 / 字数）与收尾事实（`endedAt` 等）**窗口优先**：
       *     骨架里那一行是**连上那一刻**算的，这一轮还在跑，它已经旧了。
       */
      function skeletonRow(t, prev) {
        var steps = t.steps || []
        var tools = 0
        var chars = 0
        var text = 0
        for (var i = 0; i < steps.length; i += 1) {
          tools += (steps[i].tools || []).length
          chars += steps[i].reasoningChars || 0
          text += steps[i].textChars || 0
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
          reasoningChars: chars,
          textChars: text,
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
        for (var i = 0; i < idx.length; i += 1) {
          if (idx[i] && idx[i].turn !== undefined) byTurn[idx[i].turn] = idx[i]
        }
        var out = []
        var inWindow = {}
        for (var w = 0; w < turns.length; w += 1) {
          var t = turns[w]
          if (!t || t.turn === undefined) continue
          inWindow[t.turn] = true
          out.push(skeletonRow(t, byTurn[t.turn]))
        }
        for (var k = 0; k < idx.length; k += 1) {
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
        var chars = 0
        var tools = 0
        var active = null
        for (var i = 0; i < list.length; i += 1) {
          chars += list[i].reasoningChars || 0
          tools += (list[i].tools || []).length
          var s2 = list[i].status
          if (s2 === 'thinking' || s2 === 'waiting') active = list[i]
        }
        // 面板：**按时间顺序**的阶段，不合并（每一步都还在它原来的位置）
        var ps = groupPhases(list)
        var ap = -1
        for (var p2 = 0; p2 < ps.length; p2 += 1) {
          if (active && ps[p2].steps.indexOf(active) >= 0) ap = p2
        }
        if (ap < 0 && ps.length) ap = ps.length - 1
        // 小结：同一类活动合并成一个（只有**最后统计**才合并，见 mergeByLabel 的说明）
        return {
          list: list, chars: chars, tools: tools, active: active,
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
        for (var i = 0; i < ps.length; i += 1) next[t.turn + ':' + i] = closed
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


      /** 工具 chip 的 tooltip：把行内放不下的信息放这儿。 */
      function toolTitle(x) {
        // 工具名不放进悬停：chip 上已经写着它了
        var bits = []
        if (x.argsRaw) bits.push('参数：' + String(x.argsRaw).slice(0, 160))
        if (x.resultChars !== undefined) bits.push('返回 ' + fmtK(x.resultChars) + ' 字')
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

      /**
       * 容量条比例：把"这一步想了多少"直接长进图形里。
       *
       * 映射区间取 log10(字数) 的 1.3 → 4.2，即约 **20 字 ~ 1.6 万字**，映射到条宽的 8%~100%。
       * ⚠️ 区间要按真实分布定：前 22 步的字数集中在 69~2564，若上限取 1 万字，
       * 则条宽全挤在 55%~85%，一行行看着还是一样长（第一版就是这样）。
       * ⚠️ 早先版本用节点直径表达，写成 `min(5, log10(chars) * 2.2)` —— 190 字就顶到上限，
       * 实测 900 字和 1362 字的节点直径完全一样，这个编码等于没生效；而且圆点太弱，
       * 用户反馈"脊线与圆点太弱、步骤行像日志"。改成横向容量条后两个问题一起解决。
       */
      function volRatio(chars) {
        var c = Math.max(10, chars || 10)
        var t = Math.max(0, Math.min(1, (Math.log10(c) - 1.3) / 2.9))
        return Math.round(8 + t * 92)
      }

      function renderStep(step, turnNo, turnEndedAt, runningPhase) {
        var s = step.status || 'thinking'
        var tools = step.tools || []
        var runningTool = null
        for (var t = 0; t < tools.length; t += 1) if (!tools[t].endedAt) runningTool = tools[t]
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
        if (!runningPhase) rowKids.push(React.createElement('span', { className: 'tf-no', key: 'no' }, '#' + step.step))
        // 标题与工具名在 380px 里放不下两样：有标题时让工具名让位
        // （挤出来的 "ba…" 比不给还差），工具名移到 tooltip 与展开区。
        var titleOfStep = (titlesRef.current[skey(turnNo)] || {})[step.step]
        /**
         * 派生标题（按工具参数算，实时、零调用）。
         *
         * 它是**模型标题的替补**，不是"只给没思考的步"：
         *   · 还没点过「生成标题」→ **每一步都用它**当这一行的标题
         *   · 点过之后 → 有模型标题的步，模型标题占这一行，派生标题**退到展开区**
         *     当次级标题（和工具原文一样，点开才看）；没有模型标题的步（比如 0 字的
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
           * 所以名字从**这一步自己的产出**里取（`stepOwnTitle`）：有正文 → 摘要，
           * 什么都没有 → 「无输出」，只有思考（还没写正文）→ 不填。
           *
           * ⚠️ 这里是"不填"而不是"填个状态词"：块头已经写着「第 N 步 · 推理中」，
           *    行里再写「思考中」就是同一件事说两遍（面板一贯的做法）。
           */
          var ownTitle = stepOwnTitle(step)
          if (ownTitle !== '') {
            rowKids.push(React.createElement('span', {
              className: 'tf-step-title is-own', key: 'ti',
              // 悬停给全句（行里只有摘要）—— 摘要是截过的，原文要能看见
              title: cleanProse(step.textHead !== undefined ? step.textHead : (step.textTail || '')) || ownTitle,
            }, ownTitle))
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
        // 容量条：宽 = 这一步思考了多少。它同时替代了"脊线"和"每行印字数"
        rowKids.push(React.createElement('span', { className: 'tf-vol', key: 'vol', title: fmtK(step.reasoningChars) + ' 字' },
          React.createElement('i', { style: { width: volRatio(step.reasoningChars) + '%' } })))
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
         * 早先漏了 `tools.length`，于是纯工具步（形如 `#2 bash`、思考 0 字）没有箭头、
         * 点不开 —— 明明有参数、返回大小、耗时可以看（用户反馈"怎么有的点不开"）。
         * ⚠️ 后来补了 `hasBody`：**回答步**（无工具、无思考、只有正文）原来也点不开，
         *    而正文恰恰是那一步唯一的产出（用户："展开区加正文"）。
         */
        var hasReasoning = fullText !== undefined || (step.reasoningChars || 0) > 0
        var hasBody = (step.textChars || 0) > 0
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
          kids.push(React.createElement('div', { className: 'tf-stream', key: 'st' },
            step.reasoningText.slice(-760),
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
            for (var ri = 0; ri < runsOfStep.length; ri += 1) {
              var run = runsOfStep[ri]
              if (run.text !== '') {
                toolKids.push(React.createElement('div', { className: 'tf-sub', key: 'sub' + ri }, runText(run)))
              }
              for (var tj = 0; tj < run.tools.length; tj += 1) {
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
              kids.push(React.createElement('div', { className: 'tf-raw', key: 'raw' }, fullText))
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
        for (var i = 0; i < idx.length; i += 1) if (idx[i].turn === n) return idx[i]
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
        for (var i = 0; i < list.length; i += 1) {
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
        for (var i = 0; i < idx.length; i += 1) if (hi === null || idx[i].turn > hi) hi = idx[i].turn
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
          for (var i = 0; i < byNewest.length; i += 1) {
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
            React.createElement('span', { className: 'tf-turn-no' }, '第 ' + n + ' 轮'),
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
        for (var i = 0; i < st.turns.length; i += 1) if (st.turns[i].turn === turnNo) local = st.turns[i]
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
        for (var i = 0; i < idx.length; i += 1) {
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
          for (var d2 = 0; d2 < hits.length; d2 += 1) {
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
        for (var i = 0; i < hits.length; i += 1) list.push(renderHit(hits[i], i))
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
        for (var w = 0; w < turns.length; w += 1) inWindow[turns[w].turn] = true
        var cold = 0
        for (var c = 0; c < idx.length; c += 1) if (!inWindow[idx[c].turn]) cold += 1
        var rows = []
        var lastDay = ''
        var seenEdge = false
        for (var i = 0; i < idx.length; i += 1) {
          var r = idx[i]
          var day = dayLabel(r.startedAt)
          if (day !== lastDay) {
            lastDay = day
            var n = 0
            for (var q2 = 0; q2 < idx.length; q2 += 1) if (dayLabel(idx[q2].startedAt) === day) n += 1
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
          for (var i = 0; i < byNewest.length; i += 1) {
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
        var chars = dd.chars
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
         *    步数 / 字数 / 工具 + 生成标题 + 折叠箭头。
         */
        var headKids = [
          React.createElement('span', { className: 'tf-turn-meta', key: 'm' },
            React.createElement('span', null, list.length + ' 步'),
            React.createElement('span', null, fmtK(chars) + ' 字'),
            tools ? React.createElement('span', null, tools + ' 次工具') : null,
          ),
        ]
        /*
         * ⚠️ 「生成标题」与它的失败提示**都搬到了第二行**（占原来「历史」的位置）——
         *    轮头从此只剩：步数 / 字数 / 工具 + 折叠箭头。
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
            var pchars = 0
            var ptools = 0
            for (var q = 0; q < phase.steps.length; q += 1) {
              pchars += phase.steps[q].reasoningChars || 0
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
                  React.createElement('span', null, fmtK(pchars) + ' 字'),
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
            for (var bi = 0; bi < dd.merged.length; bi += 1) {
              for (var bj = 0; bj < dd.merged[bi].steps.length; bj += 1) barTotal += dd.merged[bi].steps[bj].reasoningChars || 0
            }
            blocks.push(React.createElement('div', { className: 'tf-recap', key: 'recap' },
              React.createElement('div', { className: 'tf-recap-t' }, tInterrupted ? '这一轮被中断' : '这一轮想完了'),
              React.createElement('div', { className: 'tf-recap-s' },
                list.length + ' 步，思考 ' + fmtK(chars) + ' 字，调用工具 ' + tools + ' 次'),
              React.createElement('div', { className: 'tf-recap-bars' },
                dd.merged.map(function (ph, pi) {
                  var c = 0
                  for (var q = 0; q < ph.steps.length; q += 1) c += ph.steps[q].reasoningChars || 0
                  var w = barTotal ? (c / barTotal) * 100 : 0
                  // 颜色 = 活动分类（与块、图例同一套），宽度 = 字数。
                  // 不按序号调透明度（那会让后面的段直接看不见，见 CSS 里的说明）
                  return React.createElement('i', { key: pi, className: 'cat-' + ph.cat, style: { width: w + '%' } })
                }),
              ),
              React.createElement('div', { className: 'tf-recap-lg' },
                dd.merged.map(function (ph, pi) {
                  var c = 0
                  for (var q = 0; q < ph.steps.length; q += 1) c += ph.steps[q].reasoningChars || 0
                  // 图例是**小结**：只给"哪类活动 + 多少字"（条的宽度就是这个数）。
                  // 步骤区间在块头里（那里才有地方放），塞进来会把图例撑成一堵墙。
                  // 0 字的块改报**步数**：报"0"看着像坏了，报"4 步"才说清
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

    // ────────────────────────────── 挂载 ──────────────────────────────

    function apply(ctx) {
      // 诊断探针：在浏览器控制台一眼确认"客户端到底加载了没有"。
      // 排查时最怕分不清"客户端没加载"和"加载了但没注册上"，所以 apply
      // 一进来就留痕，并把注册结果回填。
      var probe = (window.__dshThinkFlow = window.__dshThinkFlow || {})
      probe.applied = true
      probe.internals = exports.__internals
      /** 头部入口的注册事实：控制台可核对（order 越小越靠左）。 */
      probe.headerEntry = { id: 'dsh-think-flow:open', order: 9, icon: 'spine+steps' }
      probe.open = function () {
        var right = ctx.get ? ctx.get('sidebarRight') : undefined
        if (right && typeof right.openTab === 'function') { right.openTab(TAB_KIND); return true }
        return false
      }

      // 样式注入。
      // ⚠️ 不能写 `if (!getElementById(...))` —— 热重载时若旧实例还没 dispose，
      // 守卫会成立、新 CSS **永远注入不进去**，表现就是"改了样式却没变化"（本轮踩到）。
      // 所以无条件替换：先摘掉同 id 的旧元素，再挂新的。
      var previous = document.getElementById('dsh-think-flow-css')
      if (previous && previous.remove) previous.remove()
      var style = el('style')
      style.id = 'dsh-think-flow-css'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(function () { return function () { style.remove() } }, 'dsh-think-flow: css')

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
      /** 无工具步的名字：正文摘要 / 「无输出」/ 不填（纯函数，测试直接喂文本验）。 */
      excerptOf: excerptOf,
      cleanProse: cleanProse,
      stepOwnTitle: stepOwnTitle,
      TAB_ID: TAB_ID,
      TAB_KIND: TAB_KIND,
      PHASE_GAP_MS: PHASE_GAP_MS,
      CSS: CSS,
      /**
       * 清掉模块级视图状态（**只给测试用**）。
       *
       * 视图开关按会话存在模块级、跨重挂载存活（见 viewStateOf），所以测试里
       * "重新挂载"必须连它一起清 —— 否则上一个用例点过的「隐藏历史」会漏到下一个用例。
       */
      resetViewStore: function () {
        viewStore = {}
        try {
          if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(VIEW_STORE_KEY)
        } catch (e) { /* 忽略 */ }
      },
      /** 重新从 localStorage 读一次 —— 用来模拟"模块被重新求值"（刷新/重新 import）。 */
      reloadViewStore: function () { viewStore = loadViewStore() },
      viewStateOf: viewStateOf,
      isPinned: isPinned,
      shouldFollow: shouldFollow,
    }
    return module.exports
  },
})
