/**
 * **合成演示数据** —— 预览页与 README 截图共用的一份假会话。
 *
 * 为什么要单独一个模块：`gen-ui-preview.mjs`（看长相）和 `gen-readme-shots.mjs`
 * （出 README 的图）必须喂**同一份数据**，否则"预览里是这样、README 里是那样"。
 *
 * ⚠️ 这里的数据**全部是编的**，而且必须是编的：
 *   公开仓库里的截图与预览页会跟着这份文件走，一旦掺进真实会话的片段
 *   （本机路径、真人说过的话），就等于把个人数据随 README 一起发出去。
 *   真机轨迹只留在本地 `scripts/fixtures/`（已 gitignore），供开发期的对照用。
 *
 * 编的不是随手编：形状照宿主 `/trace` 快照的**真实契约**（见 `src/index.ts` 的
 * `snapshot()`），工具参数照各工具**真实形状**（`bash` 是 `{command,description}`、
 * `read` 是 `{file_path,limit,offset}`…）—— 面板的派生标题靠读这些参数起名，
 * 参数形状不对，预览里就只剩工具名，看不出真实行为。
 *
 * 场景：一个普通的后台项目 `shop-admin` 里，给订单列表页加 CSV 导出。
 * 这一轮刻意混进五类活动、一次多工具调用、一次重复调用、一次工具失败，
 * 好让一张图就能覆盖面板的全部形态。
 */

/** 演示用的项目根（编的路径，任何机器上都不存在）。 */
export const PROJECT = '/Users/dev/projects/shop-admin'

/** 本轮会话 id（编的）。 */
export const SESSION = 'demo'

/** 基准时刻：往回挪一点，让面板上的秒表/时长看起来是"刚刚在跑"。 */
export const T0 = Date.now() - 350000

/** 被演示的那一轮的轮号。前面还有 11 轮，用来展示目录与搜索。 */
export const FEATURED_TURN = 12

/** 本轮用户说的话（轮标题的默认素材）。 */
export const USER_TEXT = '订单列表页要能导出 CSV，字段跟表格列一致；另外日期格式几个页面里不一致，一起统一一下'

/**
 * 模型生成的**整轮标题**（点"生成标题"后才有；没有就显示上面的原话）。
 * 演示里给上，好让"标题态"和"原话态"的差别看得出来。
 */
export const TURN_TITLE = '加 CSV 导出并统一日期格式'

/**
 * 步骤事实：[步号, 思考字数, 起始秒, 工具名数组]。
 *
 * 第 6 步两个 `read`（展示"相邻同名合并成 ×2"）、第 7 步三个 `edit`（×3）、
 * 第 12 步那次 `ask_user_question` 是**失败**的（展示失败态）。
 */
const STEPS = [
  [1, 1860, 0, ['bash']],
  [2, 420, 6, ['read']],
  [3, 1290, 11, ['bash']],
  [4, 880, 18, ['grep']],
  [5, 2140, 24, ['bash']],
  [6, 660, 41, ['read', 'read']],
  [7, 3010, 52, ['edit', 'edit', 'edit']],
  [8, 1520, 79, ['web_search']],
  [9, 2380, 96, ['write']],
  [10, 940, 112, ['bash']],
  [11, 1750, 121, ['edit']],
  [12, 610, 133, ['ask_user_question']],
  [13, 1980, 139, ['bash']],
  [14, 2620, 158, ['bash']],
]

/** 模型生成的**步骤标题**（键 = 步号）。第 8、12 步故意不给：没有模型标题的步显示派生标题。 */
const TITLES = {
  1: '找订单页在哪',
  2: '读订单列表组件',
  3: '看表格列定义',
  4: '搜现成的导出工具',
  5: '跑订单页测试',
  6: '读列定义与日期工具',
  7: '改页面、列定义与日期工具',
  9: '写 csv 工具',
  10: '跑构建查类型',
  11: '统一日期格式',
  13: '重跑全量测试',
  14: '看改动统计',
}

/**
 * 工具自带的英文 `description` → 模型翻成中文（**按工具 id** 下发，贴在各自的派生标题后面）。
 * 这是"点一次生成标题、整轮一起翻"的产物。
 */
const NOTES = {
  c1_0: '找订单页在哪',
  c3_0: '读表格列的配置',
  c5_0: '跑订单页的测试',
  c10_0: '跑构建查类型错误',
  c13_0: '重跑全量测试',
}

/** 每个工具**真实形状**的参数（派生标题就是从这里读出来的）。 */
function argsOf(name, step, i) {
  const FILES = [
    'src/pages/orders/OrderList.tsx',
    'src/pages/orders/columns.ts',
    'src/utils/format.ts',
    'src/pages/orders/OrderFilter.tsx',
  ]
  const DESCRIPTIONS = [
    'Locate the orders page',
    'Read the table column config',
    'Run the orders tests',
    'Build to catch type errors',
    'Re-run the full test suite',
  ]
  const f = FILES[step % FILES.length]
  if (name === 'bash') {
    // 三种命令轮换：只读（→ 读代码）、跑东西（→ 跑命令），好让分组配色看得出来
    if (step === 1) return JSON.stringify({ command: `grep -rn "OrderList" ${PROJECT}/src --include=*.tsx`, description: DESCRIPTIONS[0] })
    if (step === 3) return JSON.stringify({ command: `sed -n '1,90p' src/pages/orders/columns.ts`, description: DESCRIPTIONS[1] })
    if (step === 5) return JSON.stringify({ command: 'npm test -- --run src/pages/orders', description: DESCRIPTIONS[2] })
    if (step === 10) return JSON.stringify({ command: 'npm run build', description: DESCRIPTIONS[3] })
    if (step === 13) return JSON.stringify({ command: 'npm test', description: DESCRIPTIONS[4] })
    return JSON.stringify({ command: 'git diff --stat' })
  }
  if (name === 'read') return JSON.stringify({ file_path: `${PROJECT}/${f}`, limit: 80, offset: step === 6 ? 0 : 40 })
  if (name === 'grep') return JSON.stringify({ pattern: 'exportCsv|toCsv|download', path: `${PROJECT}/src` })
  if (name === 'edit') return JSON.stringify({ file_path: `${PROJECT}/${f}`, old_string: 'formatDate(d)', new_string: 'formatDate(d, "yyyy-MM-dd")' })
  if (name === 'write') return JSON.stringify({ file_path: `${PROJECT}/src/utils/csv.ts`, content: 'export function toCsv(rows, columns) { … }' })
  if (name === 'web_search') return JSON.stringify({ query: 'papaparse csv export browser blob download' })
  if (name === 'ask_user_question') return JSON.stringify({ question: '导出范围要跟当前筛选走，还是导全量？' })
  return JSON.stringify({ step, i })
}

/**
 * 造一份快照：截止到 `upto` 步，最后一步的状态由 `lastStatus` 决定。
 *
 * @param o - 选项。
 * @param o.upto - 只渲染到第几步（含）。
 * @param o.lastStatus - 最后一步的状态（`thinking` / `waiting` / `ready` / `done` / `cut`）。
 * @param o.toolsRunning - 最后一步的最后一个工具是否还在跑。
 * @param o.withTitles - 是否带上模型标题与说明翻译。
 * @param o.withIndex - 是否带上全轮骨架（目录用）。
 * @param o.failedStep - 哪一步的工具是失败的（默认第 12 步）。
 * @returns 一份 `/trace` 快照。
 */
export function demoSnapshot(o = {}) {
  const upto = o.upto ?? STEPS.length
  const lastStatus = o.lastStatus ?? 'done'
  const toolsRunning = o.toolsRunning === true
  const withTitles = o.withTitles !== false
  const withIndex = o.withIndex !== false
  const failedStep = o.failedStep === undefined ? 12 : o.failedStep

  const steps = []
  for (const [step, len, at, tools] of STEPS) {
    if (step > upto) break
    const isLast = step === upto
    const startedAt = T0 + at * 1000
    const toolsOfStep = tools.map((n, i) => {
      const running = isLast && toolsRunning && i === tools.length - 1
      const tool = {
        id: 'c' + step + '_' + i,
        name: n,
        argsRaw: argsOf(n, step, i),
        startedAt: startedAt + 900,
        endedAt: running ? undefined : startedAt + 3800 + i * 600,
        resultChars: 420 + ((step * 977 + i * 311) % 2600),
      }
      // 失败态：宿主折出来的是 `{ code, name, text }`，面板照抄
      if (step === failedStep && !isLast) {
        tool.failed = { code: 'INVALID_ARGS', name: 'ToolInputError', text: 'question: must be a string (got undefined)' }
      }
      return tool
    })
    const endedAt = isLast && lastStatus !== 'done' ? undefined : startedAt + 4200 + ((step * 617) % 5200)
    steps.push({
      step,
      status: isLast ? lastStatus : 'done',
      attempts: 1,
      reasoningChars: len,
      textChars: step === 14 ? 380 : 0,
      startedAt,
      elapsedMs: endedAt === undefined ? undefined : endedAt - startedAt,
      endedAt,
      streamEndedAt: endedAt,
      tools: toolsOfStep,
      // 快照只给"当前步"带原文尾巴，其余按需走 /step
      reasoningTail: isLast ? REASONING_TAIL : undefined,
      streamGap: false,
      chunkCount: 40 + step,
    })
  }

  const turn = {
    turn: FEATURED_TURN,
    startedAt: T0,
    endedAt: lastStatus === 'done' ? T0 + 178000 : undefined,
    interrupted: lastStatus === 'cut',
    userText: USER_TEXT,
    steps,
    ...(withTitles ? {
      // ⚠️ 整轮标题的字段名是 `turnTitle`（不是 `title` —— `title` 是**骨架** TurnSummary 里的那个）。
      // 名字写错的表现很隐蔽：面板不报错，只是把模型标题那一档整个跳过、继续显示用户原话。
      turnTitle: TURN_TITLE,
      // 宿主下发的是"按步号索引的对象"
      titles: steps.reduce((acc, x) => { if (TITLES[x.step]) acc[x.step] = TITLES[x.step]; return acc }, {}),
      titlesFrom: 'deepseek-chat',
      notes: NOTES,
    } : {}),
  }

  return {
    sessionId: SESSION,
    serverTime: T0 + 178000,
    known: true,
    state: 'live',
    auto: false,
    autoBusy: false,
    ...(withIndex ? { index: demoTurnIndex() } : {}),
    turns: [...demoOlderTurns(), turn],
  }
}

/**
 * 更早的 11 轮（只有骨架 + 少量步），用来展示"面板一次一轮 + 目录 + 搜索"。
 * @returns 轮次数组（最新的在前，与被演示的那一轮分开）。
 */
export function demoOlderTurns() {
  const older = [
    [11, '分页跳号修一下，第 2 页开始重复第一页的数据', '修分页跳号', 7, 9, 9120],
    [10, '把日期格式统一成 yyyy-MM-dd', '统一日期格式', 5, 4, 6180],
    [9, '订单筛选加个"仅看已付款"', '加已付款筛选', 9, 12, 14200],
    [8, '列表加载慢，看看能不能加个骨架屏', '加列表骨架屏', 6, 5, 7340],
    [7, '导出按钮的图标换成下载箭头', '换导出图标', 3, 2, 2260],
    [6, '这页的表格列宽在窄屏下挤在一起', '修窄屏列宽', 8, 6, 10480],
    [5, '给订单接口加个超时重试', '加超时重试', 11, 14, 18760],
    [4, '把 mock 数据挪到 fixtures 目录', '挪 mock 数据', 4, 6, 4980],
    [3, '跑一遍 lint 看看有多少告警', '跑 lint', 2, 3, 1640],
    [2, '帮我看看这个项目用什么测试框架', '看测试框架', 3, 4, 3120],
    [1, '这个后台的订单页在哪', '找订单页', 2, 2, 1180],
  ]
  return older.map(([turn, userText, title, stepCount, toolCount, chars]) => ({
    turn,
    startedAt: T0 - (FEATURED_TURN - turn) * 900000,
    endedAt: T0 - (FEATURED_TURN - turn) * 900000 + 240000,
    userText,
    title,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      step: i + 1,
      status: 'done',
      attempts: 1,
      reasoningChars: Math.round(chars / stepCount),
      textChars: 0,
      startedAt: T0 - (FEATURED_TURN - turn) * 900000 + i * 12000,
      elapsedMs: 3200 + ((i * 617) % 4100),
      tools: i % 3 === 0
        ? [{ id: `h${turn}_${i}`, name: 'bash', argsRaw: JSON.stringify({ command: 'npm test' }), startedAt: T0, endedAt: T0 + 1200, resultChars: 900 }]
        : [],
    })),
  }))
}

/**
 * 全轮骨架（目录读它；最新在前）。它比 `turns` 长得多 —— 正文窗口只有 20 轮。
 * @returns `TurnSummary` 数组。
 */
export function demoTurnIndex() {
  const rows = [
    [FEATURED_TURN, USER_TEXT, TURN_TITLE, 14, 15, 24980, 380, true],
  ]
  for (const t of demoOlderTurns()) {
    const chars = t.steps.reduce((n, s) => n + s.reasoningChars, 0)
    rows.push([t.turn, t.userText, t.title, t.steps.length, t.steps.filter((s) => s.tools.length).length, chars, 0, true])
  }
  return rows.map(([turn, userText, title, steps, tools, reasoningChars, textChars, inMemory]) => ({
    turn, startedAt: T0 - (FEATURED_TURN - turn) * 900000,
    endedAt: T0 - (FEATURED_TURN - turn) * 900000 + 240000,
    userText, title, steps, tools, reasoningChars, textChars, inMemory,
  }))
}

/**
 * 某一步的思考原文（`/step` 的桩）。
 *
 * 面板展开历史步骤时会真的发这个请求 —— 预览里若不给桩，页面上会冒出
 * "取原文失败"（预览环境的问题，不是组件的）。所以这里备一段像样的原文。
 */
export const STEP_TEXT = `先把这页的结构看清楚。

订单列表页在 src/pages/orders/OrderList.tsx，表格列是 columns.ts 里的一份配置数组，
日期格式化走 src/utils/format.ts 的 formatDate。三处各改各的，难怪格式不一致。

导出这件事有两个选择：
  ① 自己拼 CSV 字符串 —— 没有依赖，但要处理引号、逗号、换行和 BOM（Excel 中文乱码就是缺 BOM）；
  ② 引 papaparse —— 省事，但为了一个导出功能多一个运行时依赖，不划算。

这页的字段都是平铺的标量（订单号、金额、状态、时间），没有嵌套对象，
所以 ① 的转义逻辑很短：包一层双引号、把内部的双引号翻倍即可。

字段顺序直接读 columns.ts，**不再手写一遍** —— 手写的那份迟早和表格列对不上，
这正是"字段跟表格列一致"这条要求最容易出问题的地方。`

/** 当前步的原文尾巴（快照只带这个；其余走 `/step`）。 */
const REASONING_TAIL = STEP_TEXT.slice(-400)
