/**
 * 思维链聚合器 —— 纯函数，无 IO、无定时器，可单测。
 *
 * 把两路事件折成「turn → step →（思考原文 + 工具调用）」的结构：
 *
 *   · `agent/assistant-stream`  流式增量。DSH 0.1.5 起，在飞的尝试只发帧、不落盘；
 *                               帧的 `chunk` 里带 `reasoning-delta` / `text-delta`。
 *   · `session/event`           耐久事件。`step/start` / `step/end` / `tool/call`
 *                               / `tool/result` / `turn/start` / `turn/end` 都在这里。
 *
 * 为什么按 step 聚合而不是直接展示 delta：实测 reasoning 每秒几百个事件，
 * 逐事件重绘会把面板刷成幻灯片；而 step 是模型真实的工作单元（一次尝试 =
 * 一段思考 + 若干工具调用），也是用户能读的最小有意义单位。
 */

/** 一步在界面上的呈现状态。 */
export type StepStatus =
  /** 正在生成思考（流未结束）。 */
  | 'thinking'
  /** 思考结束、有工具在跑 —— 最容易看起来像"卡死"的状态。 */
  | 'waiting'
  /** 想完了，等下一步或等收尾。 */
  | 'ready'
  /** 这一步结束。 */
  | 'done'
  /** 被中断（轮次中断时仍在 thinking/waiting 的步）。 */
  | 'cut'

/**
 * 一次失败的事实。
 *
 * 三个字段全部**来自日志的权威字段**，一个都不由面板猜：
 *   · `isError`   → 这条结果是不是失败（`message.isError`，宿主 `toolErrorResult` 写死的）
 *   · `error`     → 宿主给的结构化 `{ name, code }`（只有 HarnessError 才有，见 dsh-tools）
 *   · 正文        → `Error: <一句话>`（给人读的那句）
 *
 * 码是**机读**的（`TOOL_TIMEOUT` / `INVALID_ARGS` / `UNKNOWN_TOOL` / `ABORTED_BEFORE_DISPATCH`…），
 * 面板照抄不改写：它同时是排查时唯一能在日志里 grep 到的东西。
 */
export interface ToolFailure {
  /** 稳定错误码（`error.code`）；不是 HarnessError 时没有。 */
  readonly code?: string
  /** 错误类名（`error.name`，如 `ToolArgsError`）；同上。 */
  readonly name?: string
  /** 那句给人读的话（已去掉 `Error: `、压平空白、截到 {@link ERROR_TEXT_CHARS}）。可能为空串。 */
  readonly text: string
}

/** 一次工具调用。 */
export interface ToolFact {
  readonly id: string
  readonly name: string
  /** 原始参数（截断后），用于等待态显示"在查什么"。 */
  readonly argsRaw: string
  /**
   * 命令自带的**英文说明**（只有 `bash`/`pwsh`/`terminal` 才有，见 `COMMAND_TOOLS`）。
   *
   * 必须在 `tool/call` 那一刻就取出来存好：参数会被截断到 400 字，而 `description`
   * 排在 `command` 后面，长命令一截就没了 —— 实测 337 次 bash 调用里只有 57 次
   * 能从截断后的参数里捞到它。宿主此刻手里有**完整**参数，是唯一能保住它的地方。
   */
  readonly note?: string
  readonly startedAt: number
  endedAt?: number
  /** 结果字符数，用来判断"查回来了多少"。 */
  resultChars?: number
  /**
   * 失败了才有。**没有这个字段 = 成功**（而不是"未知"）—— 宿主对每一次调用都会写一条
   * `tool/result`，带上 `isError`，所以"没标失败"是有依据的成功。
   *
   * ⚠️ 别拿它当"退出码非零"：`bash` 的非零退出**不是**失败（退出码是数据，
   *    见 dsh-tool-bash 的说明），宿主那边的 `isError` 保持 false。
   */
  failed?: ToolFailure
}

/**
 * 错误摘要保留多长。
 *
 * 200 是从**真实失败结果**上量的：8 个会话、11283 次工具调用里有 104 次失败，
 * 正文长度 p50 150 字 / p90 166 字 / 最长 378 字，**只有 2 条超过 200**。
 * 也就是说这个上限基本不截断任何东西（真截了也只是尾部那点"then retry"）。
 *
 * 而沙箱拒绝那种会**再拖一段给模型看的升级指引**（几百字，见 dsh-tools 的
 * `escalationGuidance`）—— 那是给模型决策用的，原样塞进 380px 的侧栏只会把行撑爆。
 */
export const ERROR_TEXT_CHARS = 200

/** 一个 step 的事实。字段存事实，状态由 {@link stepStatus} 推导。 */
export interface StepFact {
  readonly turn: number
  readonly step: number
  /** 同一 (turn, step) 出现过几次尝试；>1 说明模型重试过。 */
  attempts: number
  /** 思考原文（英文，模型真实输出）。 */
  reasoning: string
  /** 这一步的正文（通常是调用工具前的过渡语，或最终回答）。 */
  text: string
  readonly tools: ToolFact[]
  /** 首次收到 attempted 流的时间。 */
  startedAt: number
  /** 收到过多少个 reasoning/text 增量，用于 UI 判断"还在长"。 */
  chunkCount: number
  /** 流结束（assistant-stream 的 end）。 */
  streamEndedAt?: number
  /** step/end。 */
  endedAt?: number
  /** 流出现过序号缺口 —— 文本可能不完整，界面要如实标注。 */
  streamGap?: boolean
  /** 内部：该尝试下一个可接受的稠密序号。 */
  nextIndex?: number
  /** 内部：当前帧归属的 attemptId，换了就是新一轮尝试。 */
  attemptId?: string
}

/** 一个 turn 的事实。 */
export interface TurnFact {
  readonly turn: number
  startedAt: number
  endedAt?: number
  /** 中断/出错的收尾原因（turn/end 的 reason）。 */
  endReason?: string
  /** turn 结束时仍有未收尾的步 → 视为被中断。 */
  interrupted?: boolean
  /**
   * **本轮用户说了什么**（第一条真人消息，裁到 USER_TEXT_CHARS）。
   *
   * 用途：轮标题的**默认素材** —— 还没让模型总结（或这一轮还在跑）时，
   * 轮头第一行直接显示用户这句话。所以它只是**展示**用的，不需要完整原文。
   *
   * 只认 `source.kind === 'user'`：技能目录、运行时上下文、压缩检查点也会以
   * `user/message` 的形式塞进来，那些不是"这一轮要什么"。
   */
  userText?: string
  readonly steps: StepFact[]
}

/** 一个会话的完整轨迹。 */
export interface SessionTrace {
  sessionId: string
  readonly turns: TurnFact[]
  updatedAt: number
  /**
   * 内部：attemptId → 它属于哪一步。
   *
   * **必须有这张表**：宿主的流式帧里只有 `start` 带 `turn`/`step`，
   * `chunk` 只带 `attemptId`/`index`/`chunk`（见 dsh-agent-loop 的
   * AssistantStreamAttempt.start/push）。早先版本在 chunk 分支里直接读
   * `frame.turn`，读不到就丢弃 —— 结果是收到三万个帧、思考仍然是 0 字（真机踩过）。
   */
  readonly attempts: Map<string, { turn: number; step: number }>
  /** 内部：这个会话最近被触碰到的 (turn, step)，用于插件中途加载时的归属回退。 */
  lastStep?: { turn: number; step: number }
}

// ───────────────────────── 建与查 ─────────────────────────

/**
 * 建一个空轨迹。
 * @param sessionId - 会话 id。
 * @returns 空轨迹。
 */
/**
 * 命令类工具 —— **只有它们**的 `description` 是"这条命令在干什么"的人工说明。
 *
 * ⚠️ 别的工具的 `description` 是别的东西：`present` 的是**每个文件的说明**、
 * `ask_user_question` 的是**问题描述**。早先不分工具一律抓第一个 `description`，
 * 于是把"预览页：行里只留派生标题"这种文件说明也当成了命令说明存下来。
 * 宿主路由那边复用同一份集合（别各写一份，会漂）。
 */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh', 'terminal'])

/**
 * 从完整的工具参数里取出自带的英文说明（**只给命令类工具用**）。
 * @param args - 完整参数（JSON 字符串）。
 * @returns 说明文本；没有或解析不了时空串。
 */
function noteOf(args: string): string {
  if (args === '') return ''
  const m = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args)
  if (m === null) return ''
  return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\s+/g, ' ').trim()
}

export function createTrace(sessionId: string): SessionTrace {
  return { sessionId, turns: [], updatedAt: 0, attempts: new Map() }
}

function turnOf(trace: SessionTrace, turn: number, now: number): TurnFact {
  let t = trace.turns.find((x) => x.turn === turn)
  if (t === undefined) {
    t = { turn, startedAt: now, steps: [] }
    trace.turns.push(t)
    // 保持有序：界面是"最新一轮在最上面"，靠的就是轮号顺序。
    // （正常只会往后追加，这里是兜底，见 isStaleTurn 的说明。）
    trace.turns.sort((a, b) => a.turn - b.turn)
  }
  return t
}

/**
 * 这个轮号是不是"晚到的、已经被淘汰的旧轮次"？
 *
 * 工具结果可以**隔几十小时**才回来（后台任务 / 子代理），而事件上带的是**原来那一轮**
 * 的编号。实测：第 24 轮的两个 `tool/result` 在第 51 轮跑到一半时才写进日志，
 * 而第 24 轮早就被淘汰了（只留最近 N 轮）—— 于是聚合器凭空造出一个只有 2 步、
 * 永远不结束的"第 24 轮"，还排在最新一轮**后面**；面板倒序渲染，它就跑到了最上面。
 *
 * 判据：轮号在一次会话里**单调递增**，所以"不认识、编号又比现有最大的还小"
 * 只可能是旧轮次（新轮次一定比现有的都大）。认识的轮次照旧折叠 —— 晚到的结果
 * 该落到它自己那一轮上。
 *
 * @param trace - 轨迹。
 * @param turn - 事件带的轮号。
 * @returns 该丢时 true。
 */
function isStaleTurn(trace: SessionTrace, turn: number): boolean {
  let max = -Infinity
  for (const t of trace.turns) {
    if (t.turn === turn) return false
    if (t.turn > max) max = t.turn
  }
  return turn < max
}

function stepOf(trace: SessionTrace, turn: number, step: number, now: number): StepFact {
  const t = turnOf(trace, turn, now)
  let s = t.steps.find((x) => x.step === step)
  if (s === undefined) {
    s = { turn, step, attempts: 0, reasoning: '', text: '', tools: [], startedAt: now, chunkCount: 0 }
    t.steps.push(s)
    t.steps.sort((a, b) => a.step - b.step)
  }
  trace.lastStep = { turn, step }
  return s
}

/** 该 turn 里最后一步（界面上的"当前步"）。 */
export function lastStep(turn: TurnFact): StepFact | undefined {
  return turn.steps.length ? turn.steps[turn.steps.length - 1] : undefined
}

/** 最新的 turn。 */
export function lastTurn(trace: SessionTrace): TurnFact | undefined {
  return trace.turns.length ? trace.turns[trace.turns.length - 1] : undefined
}

/**
 * 推导一步的呈现状态。存事实、算状态，避免状态字段和事实不一致。
 * @param step - 这一步的事实。
 * @param turn - 它所属的轮次。
 * @returns 呈现状态。
 */
export function stepStatus(step: StepFact, turn: TurnFact | undefined): StepStatus {
  if (step.endedAt !== undefined) return 'done'
  if (turn?.interrupted === true) return 'cut'
  if (step.tools.some((t) => t.endedAt === undefined)) return 'waiting'
  if (step.streamEndedAt !== undefined) return 'ready'
  return 'thinking'
}

/**
 * 一个 step 已持续多少毫秒。结束的步返回真实时长，未结束的返回至今时长。
 * @param step - 这一步。
 * @param now - 当前时间。
 * @returns 毫秒。
 */
export function stepElapsed(step: StepFact, now: number): number {
  const end = step.endedAt ?? step.streamEndedAt ?? now
  return Math.max(0, end - step.startedAt)
}

/**
 * 正在跑的工具里最早开始的那个 —— 等待态用它显示"已等多久"。
 * @param step - 这一步。
 * @returns 该工具，或 undefined。
 */
export function runningTool(step: StepFact): ToolFact | undefined {
  let oldest: ToolFact | undefined
  for (const t of step.tools) {
    if (t.endedAt !== undefined) continue
    if (oldest === undefined || t.startedAt < oldest.startedAt) oldest = t
  }
  return oldest
}

// ───────────────────────── 折事件 ─────────────────────────

/**
 * 一步的**时间事实**（随每条碰了 step 的改动一起下发）。
 *
 * 为什么必须随增量走、而不是只在快照里给一个算好的 `elapsedMs`：
 *   · 面板**打开着**的时候，那些步是增量长出来的 —— 客户端手里没有"时长"，
 *     早先它只照抄快照的 `elapsedMs`，于是面板开着时跑完的步时长是**空的**，
 *     而打开时正在跑的步显示的是**快照那一刻的旧值**（真机反馈："运行的时候
 *     步骤后面的秒数不显示了"）。
 *   · 更要紧的是**活跃步要有实时秒数**：那是"到现在为止"，只有客户端按 `now`
 *     现算才会涨；宿主算好的值只在事件发生时更新，中间那几秒是冻住的。
 * 所以宿主只下发**事实**（起点/流结束/收尾），时长由客户端一条公式现算 ——
 * 和 {@link stepElapsed} 同构，活跃步自己涨、结束的步定格。
 */
export interface StepTiming {
  startedAt: number
  streamEndedAt?: number
  endedAt?: number
}

/**
 * 一次改动，宿主据此决定往 SSE 推什么。
 *
 * 每一种碰了 step 的改动都**必须带上 `status`**。这是踩出来的：
 * 之前 stream start / stream end / step/end 三种含义共用同一个
 * `{k:'step', turn, step}` 载荷，客户端分不清，只好自己推状态 ——
 * 结果每一步跑完后仍判定为 thinking，界面一直挂着"正在生成…"。
 * 状态只能有一个来源：宿主按事实推导出来的这个值。
 *
 * 同理，每一种都带上 `timing`（时间事实）—— 时长也只能有一个来源：事实。
 */
export type TraceChange =
  | { k: 'reasoning'; turn: number; step: number; text: string; status: StepStatus; timing: StepTiming }
  | { k: 'text'; turn: number; step: number; text: string; status: StepStatus; timing: StepTiming }
  | { k: 'tool'; turn: number; step: number; tool: ToolFact; status: StepStatus; timing: StepTiming }
  | { k: 'tool-end'; turn: number; step: number; id: string; endedAt: number; resultChars: number; failed?: ToolFailure; status: StepStatus; timing: StepTiming }
  | { k: 'step'; turn: number; step: number; status: StepStatus; timing: StepTiming }
  | { k: 'gap'; turn: number; step: number; status: StepStatus; timing: StepTiming }
  | { k: 'turn'; turn: number; endedAt?: number; interrupted?: boolean; endReason?: string; userText?: string }

/**
 * 取一步的时间事实。
 *
 * 字段**按需给**（`undefined` 的不出现）：增量里绝大多数改动（流式文本）只有
 * `startedAt`，把 `streamEndedAt: undefined` 也序列化进去是白占带宽 —— 这条
 * 通道每秒几十次。
 * @param step - 这一步。
 * @returns 时间事实。
 */
export function timingOf(step: StepFact): StepTiming {
  return {
    startedAt: step.startedAt,
    ...(step.streamEndedAt !== undefined ? { streamEndedAt: step.streamEndedAt } : {}),
    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
  }
}

/**
 * 轮标题默认素材（用户消息）保留多长。
 *
 * 两个用途：
 *   ① **当标题显示** —— 渲染时再截到 18 字（轮头）/ 30 字（目录行），
 *      所以显示这一层远远用不到这么长；
 *   ② **搜索的正文** —— 面板上的搜索只搜"轮次"，即**用户消息 + 轮次标题**，
 *      搜的就是这一份。裁太短的话，长消息的尾部会**静默搜不到**。
 *
 * 实测（抽 12 个真实会话）：中位 13 字、p90 37 字、p99 858 字，
 * 但**最长 34,863 字**（有人粘了一大段）。所以既不能不限（一轮就能撑爆轨迹），
 * 也不能卡在 160（约 5% 的消息尾部搜不到）。1000 覆盖了观测到的绝大多数。
 */
export const USER_TEXT_CHARS = 1000

/**
 * 开头的**序号**（`1、` `2.` `（3）` `一、` `①` …）。
 *
 * 用户消息常以序号开头（实测 109 条真人消息里 10 条是 `1、…`），拿它当轮标题时
 * 那个序号是纯噪声，先去掉。
 *
 * ⚠️ **必须要求分隔符**（`、.．,，:：)）` 或成对的括号）。不能只看到数字就删 ——
 *    "20轮之前的思维链"开头的数字是内容的一部分。实测：`数字+分隔符` 恰好命中那 10 条，
 *    而 `数字+空格` 一条都没有（有歧义，所以不处理）。
 */
const ENUM_PREFIX = /^\s*(?:[（(]\s*(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*[）)]\s*|(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*[、.．,，:：)）]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*)/

/** 去掉开头的一个序号。只去一个 —— `1、去重 2、多行显示` 里第二个是内容的一部分。 */
export function stripEnumPrefix(text: string): string {
  const cut = text.replace(ENUM_PREFIX, '')
  // 整条就只有个序号（"1、"）→ 别删成空串，原样留着
  return cut.trim() === '' ? text : cut
}

/** `agent/assistant-stream` 的帧（这里只声明用得到的字段）。 */
export interface StreamFrame {
  type?: unknown
  attemptId?: unknown
  turn?: unknown
  step?: unknown
  index?: unknown
  time?: unknown
  chunk?: unknown
}

/** attemptId → 步骤 的映射上限，防止漏收 end 帧时无限增长。 */
const ATTEMPT_CAP = 128

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** 取某个 turn 的事实对象（不新建）。 */
function turnFor(trace: SessionTrace, turn: number): TurnFact | undefined {
  return trace.turns.find((t) => t.turn === turn)
}

/**
 * 折一个流式帧。
 *
 * 序号必须稠密：缺号说明丢过帧（重连、替换尝试），此时**宁可标记文本不完整，
 * 也不拼出一段有洞的思考**——读起来通顺但内容是错的，比明显缺一块更危险。
 * @param trace - 该会话的轨迹（原地修改）。
 * @param frame - `agent/assistant-stream` 的 frame。
 * @param now - 当前时间。
 * @returns 本次产生的改动。
 */
export function applyStreamFrame(trace: SessionTrace, frame: StreamFrame, now: number): TraceChange[] {
  const type = str(frame.type)
  if (type === 'end') {
    const attemptId = str(frame.attemptId)
    if (attemptId !== undefined) trace.attempts.delete(attemptId)
    for (const t of trace.turns) {
      for (const s of t.steps) {
        if (s.attemptId !== undefined && s.attemptId === attemptId && s.streamEndedAt === undefined) {
          s.streamEndedAt = now
          trace.updatedAt = now
          return [{ k: 'step', turn: s.turn, step: s.step, status: stepStatus(s, t), timing: timingOf(s) }]
        }
      }
    }
    return []
  }

  const attemptId = str(frame.attemptId)
  if (attemptId === undefined) return []

  if (type === 'start') {
    // 只有 start 帧带 turn/step —— 记下来，后面的 chunk 要靠它归属
    const turn = finite(frame.turn)
    const step = finite(frame.step)
    if (turn === undefined || step === undefined) return []
    trace.attempts.set(attemptId, { turn, step })
    if (trace.attempts.size > ATTEMPT_CAP) {
      const oldest = trace.attempts.keys().next().value
      if (oldest !== undefined) trace.attempts.delete(oldest)
    }
    const s = stepOf(trace, turn, step, now)
    // 同一 (turn, step) 再来一次 start = 模型重试
    if (s.attemptId !== undefined) s.attempts += 1
    else s.attempts = 1
    s.attemptId = attemptId
    s.nextIndex = 0
    s.startedAt = Math.min(s.startedAt, now)
    trace.updatedAt = now
    return [{ k: 'step', turn, step, status: stepStatus(s, turnFor(trace, turn)), timing: timingOf(s) }]
  }

  if (type !== 'chunk') return []

  // chunk 帧不带 turn/step：先查 start 记下的表；帧里若带了就以帧为准。
  const frameTurn = finite(frame.turn)
  const frameStep = finite(frame.step)
  const owned = frameTurn !== undefined && frameStep !== undefined
    ? { turn: frameTurn, step: frameStep }
    : trace.attempts.get(attemptId) ?? trace.lastStep
  if (owned === undefined) return []
  const turn = owned.turn
  const step = owned.step

  const s = stepOf(trace, turn, step, now)
  // 已经出现过缺口：这一步的文本从此不再接收。
  // 守卫必须在这里单独判 —— 之前是把 nextIndex 置成 undefined 来表示"停"，
  // 结果下一帧的序号校验恰好因为 nextIndex 未定义而被跳过，文本又被拼了上去。
  if (s.streamGap === true) return []
  const index = finite(frame.index)
  if (index === undefined) return []
  if (s.attemptId === undefined) {
    // 插件是在本轮中途加载的：start 帧早就过去了，只收到了 chunk。
    // 这时必须**认领**这个 attemptId，否则每一步的思考都会被"尝试不匹配"挡掉，
    // 表现就是工具调用有、思考正文永远是 0 字（真实踩过）。
    s.attemptId = attemptId
    s.nextIndex = index
  } else if (s.attemptId !== attemptId) {
    return []                                        // 不是当前尝试的帧，丢弃
  }
  if (s.nextIndex !== undefined && index !== s.nextIndex) {
    // 缺口：标记不完整并从此停止接收（避免拼出有洞的内容）
    s.streamGap = true
    s.nextIndex = undefined
    trace.updatedAt = now
    return [{ k: 'gap', turn, step, status: stepStatus(s, turnFor(trace, turn)), timing: timingOf(s) }]
  }
  s.nextIndex = index + 1

  const chunk = frame.chunk as { type?: unknown; text?: unknown } | undefined
  const ctype = str(chunk?.type)
  const text = str(chunk?.text)
  if (text === undefined || text === '') return []
  const out: TraceChange[] = []
  const status = stepStatus(s, turnFor(trace, turn))
  const timing = timingOf(s)
  if (ctype === 'reasoning-delta') {
    s.reasoning += text
    s.chunkCount += 1
    out.push({ k: 'reasoning', turn, step, text, status, timing })
  } else if (ctype === 'text-delta') {
    s.text += text
    s.chunkCount += 1
    out.push({ k: 'text', turn, step, text, status, timing })
  }
  if (out.length) trace.updatedAt = now
  return out
}

/** `session/event` 里我们关心的事件（只声明用得到的字段）。 */
export interface SessionEventLike {
  type?: unknown
  time?: unknown
  data?: unknown
}

/**
 * 从一条组装好的 assistant message 里抽出思考与正文。
 *
 * 这是**落盘路径**：持久化的是组装结果（`data.message.content[]`），不是原始流帧。
 * 所以历史回看不能靠 `agent/assistant-stream`，得走这里。
 * @param content - `data.message.content`。
 * @returns 思考与正文各自的完整文本。
 */
function extractBlocks(content: unknown): { reasoning: string; text: string } {
  let reasoning = ''
  let text = ''
  if (!Array.isArray(content)) return { reasoning, text }
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (typeof b.text !== 'string') continue
    if (b.type === 'reasoning') reasoning += b.text
    else if (b.type === 'text') text += b.text
  }
  return { reasoning, text }
}

/**
 * 从 tool/result 的 message 里数出**文本**字符数。
 *
 * 只数 `text` 字段，不数任意字符串 —— 否则 `tool-result`、`text` 这些类型名
 * 也会被算进去（实测：一段 6 字的结果被算成 21 字）。
 */
function resultChars(message: unknown): number {
  const content = (message as { content?: unknown } | undefined)?.content
  let n = 0
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (typeof o['text'] === 'string') n += o['text'].length
    for (const k of Object.keys(o)) if (k !== 'text') walk(o[k])
  }
  walk(content)
  return n
}

/**
 * 从失败结果里取出"给人读的那句话"。
 *
 * 宿主所有失败路径的正文都是 `Error: <message>`（见 dsh-tools 的 `toolErrorResult`
 * 与审批/沙箱拒绝那条分支），所以：
 *   · 前缀 `Error: ` **必须去掉** —— 面板已经用红标说明这是失败，再印一遍是噪声，
 *     而且那一截会把行宽白白吃掉 7 个字符；
 *   · 空白压平：拒绝理由里可能带换行（升级指引就是多段），一行放不下。
 *
 * 只读 `content[].text`（和 {@link extractBlocks} 同一口径），不做通用 JSON 遍历 ——
 * 失败结果正文的形状是宿主固定的，按形状读比猜结构可靠。
 * @param message - `data.message`。
 * @returns 摘要文本；读不出时是空串（此时面板只显示红标，不编内容）。
 */
function failureTextOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  let s = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const t = (block as { text?: unknown }).text
    if (typeof t === 'string' && t !== '') s += (s === '' ? '' : ' ') + t
  }
  return s.replace(/^\s*Error:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_CHARS)
}

/**
 * 把一条失败结果折成事实。
 *
 * **`isError: true` 是唯一判据**，另外两个字段是"有就给"：
 *   · 走 `toolErrorResult` 的（`ToolArgsError` / `FsError` / `TOOL_TIMEOUT`…）带 `{ name, code }`；
 *   · 审批被拒、派发前被取消那种可能只有一句文本 —— **实测 104 条失败里 7 条没有 `error`**，
 *     所以"读不出码"是常态之一，不是异常，面板要能只印那句话。
 *
 * 所以这里**永远返回对象**（哪怕三个字段全空）：失败这件事本身不能因为"读不出内容"
 * 就丢掉 —— 那正是最需要显示的失败。
 * @param message - `data.message`（带 `isError`）。
 * @param error - `data.error`（宿主的 `{ name, code }`）。
 * @returns 失败事实。
 */
function failureOf(message: unknown, error: unknown): ToolFailure {
  const info = error as { name?: unknown; code?: unknown } | undefined
  const code = str(info?.code)
  const name = str(info?.name)
  return {
    ...(code !== undefined ? { code } : {}),
    ...(name !== undefined ? { name } : {}),
    text: failureTextOf(message),
  }
}

/**
 * 折一个耐久会话事件。
 * @param trace - 该会话的轨迹（原地修改）。
 * @param event - `session/event` 的 event。
 * @param now - 当前时间（事件自带 time 时优先用它）。
 * @returns 本次产生的改动。
 */
export function applySessionEvent(trace: SessionTrace, event: SessionEventLike, now: number): TraceChange[] {
  const type = str(event.type)
  const data = (event.data ?? {}) as Record<string, unknown>
  const at = finite(event.time) ?? now

  /**
   * ⚠️ `user/message` 必须放在**取 turn 之前**：它身上**没有** `turn` 字段
   * （日志里它紧跟 turn/start，靠事件顺序归属），放到下面那道
   * `if (turn === undefined) return []` 之后就会被整条丢掉 —— 真机表现：
   * 轮标题的默认层（本轮用户消息）一条都不出现。
   */
  if (type === 'user/message') {
    // 只认真人说的：注入的技能目录 / 运行时上下文 / 压缩检查点也是 user/message
    const source = data['source'] as { kind?: unknown } | undefined
    if (str(source?.kind) !== 'user') return []
    // 归到**当前这一轮**（日志里 turn/start 在前、user/message 紧随其后）。
    // 还没有任何轮次时（会话刚开）先不记 —— 等 turn/start 到了再说。
    const turnFact = lastTurn(trace)
    if (turnFact === undefined) return []
    // 只记第一条：后面的多半是补充说明/提醒，第一条才是"这一轮要什么"
    if (turnFact.userText !== undefined) return []
    const { text } = extractBlocks(data['content'])
    // 序号开头的先去掉：它是纯噪声，而这段文字的唯一用途就是**当轮标题**
    const clean = stripEnumPrefix(text.replace(/\s+/g, ' ').trim())
    if (clean === '') return []
    turnFact.userText = clean.slice(0, USER_TEXT_CHARS)
    trace.updatedAt = now
    return [{ k: 'turn', turn: turnFact.turn, userText: turnFact.userText }]
  }

  const turn = finite(data['turn'])
  if (turn === undefined) return []
  if (isStaleTurn(trace, turn)) return []

  if (type === 'turn/start') {
    const t = turnOf(trace, turn, at)
    t.startedAt = Math.min(t.startedAt, at)
    trace.updatedAt = now
    return [{ k: 'turn', turn, interrupted: t.interrupted === true }]
  }

  if (type === 'turn/end') {
    const t = turnOf(trace, turn, at)
    t.endedAt = at
    t.endReason = str(data['reason'])
    // 收尾时仍未结束的步 = 被中断；标记出来，界面才能如实显示"停在这里"
    for (const s of t.steps) {
      if (s.endedAt === undefined && (stepStatus(s, t) === 'thinking' || stepStatus(s, t) === 'waiting')) {
        t.interrupted = true
      }
    }
    trace.updatedAt = now
    // 收尾事实必须随改动下发：不带的话客户端只能自己猜，
    // 表现就是 turn 结束后不显示"本轮结束"、被中断了还一直转圈。
    return [{
      k: 'turn',
      turn,
      endedAt: t.endedAt,
      interrupted: t.interrupted === true,
      endReason: t.endReason,
    }]
  }

  if (type === 'assistant/message') {
    const step = finite(data['step'])
    if (step === undefined) return []
    const s = stepOf(trace, turn, step, at)
    const message = data['message'] as { content?: unknown } | undefined
    const { reasoning, text } = extractBlocks(message?.content)
    // **覆盖**而不是追加：同一步重试时会有多条 assistant/message，
    // 流式路径把两次尝试拼在了一起，而落盘只留最终那条 —— 以它为准更正确。
    // 覆盖后缺口标记也不再有意义（内容已经是权威版本）。
    if (reasoning !== '') { s.reasoning = reasoning; s.streamGap = false }
    if (text !== '') s.text = text
    trace.updatedAt = now
    return [{ k: 'step', turn, step, status: stepStatus(s, turnFor(trace, turn)), timing: timingOf(s) }]
  }

  /**
   * 一步的**真实起点**。
   *
   * ⚠️ 这一条曾经漏了，代价是**步骤时长整个是错的**：没有它，一步的 `startedAt`
   *    只能落在"第一条被处理的事件"上，而一步的第一条耐久事件是
   *    `assistant/message` —— 那是模型**已经想完**、工具调用刚落盘的那一刻。
   *    于是"这一步花了多久"退化成**纯工具耗时**，思考时间一个字都不算：
   *    实测第 1 轮 25 步，17 步的时长与"工具耗时之和"逐条吻合（108/106ms、45/43ms、
   *    35/34ms…），而这些步在 `step/start → assistant/message` 之间明明想了
   *    2.6s / 7.4s / 9.7s / 19.8s。
   *
   *    表现就是面板上刺眼的「长条 + 0.1s」：容量条编码的是**思考字数**（那个是真的），
   *    旁边的数字却只数了工具 —— 一个"想了 3.7k 字、工具跑了 0.1s"的步，看起来就像
   *    "0.1 秒想了 3.7k 字"。更要命的是**同一屏两种口径**：收到过实时流帧的步
   *    （`applyStreamFrame` 的 start 会把起点置成真实时刻）时长含思考，回放/漏帧的步
   *    不含 —— 同一个会话里 24s 的步和 0.1s 的步可能干了同样多的事。
   *
   * 取 `Math.min`：起点**只许往前，不许往后**（流帧可能先到，事件也可能被重放）。
   * 顺带把客户端阶段分组的间隔口径也修回它的文档定义（见 `groupPhases`：
   * "间隔用下一步开始 − 这一步开始"）。
   */
  if (type === 'step/start') {
    const step = finite(data['step'])
    if (step === undefined) return []
    const s = stepOf(trace, turn, step, at)
    s.startedAt = Math.min(s.startedAt, at)
    trace.updatedAt = now
    return [{ k: 'step', turn, step, status: stepStatus(s, turnFor(trace, turn)), timing: timingOf(s) }]
  }

  if (type === 'step/end') {
    const step = finite(data['step'])
    if (step === undefined) return []
    const s = stepOf(trace, turn, step, at)
    s.endedAt = at
    if (s.streamEndedAt === undefined) s.streamEndedAt = at
    for (const tool of s.tools) if (tool.endedAt === undefined) tool.endedAt = at
    trace.updatedAt = now
    return [{ k: 'step', turn, step, status: stepStatus(s, turnFor(trace, turn)), timing: timingOf(s) }]
  }

  if (type === 'tool/call') {
    const step = finite(data['step'])
    const id = str(data['callId'])
    if (step === undefined || id === undefined) return []
    const s = stepOf(trace, turn, step, at)
    if (s.startedAt === 0) s.startedAt = at
    if (!s.tools.some((t) => t.id === id)) {
      const tool: ToolFact = {
        id,
        name: str(data['name']) ?? '?',
        argsRaw: (str(data['arguments']) ?? '').slice(0, 400),
        // 说明在这里取（**完整**参数还在手上），见 ToolFact.note 的说明。
        // 只给命令类工具取 —— 别的工具的 description 不是命令说明（见 COMMAND_TOOLS）。
        ...(COMMAND_TOOLS.has(str(data['name']) ?? '')
          ? (() => { const n = noteOf(str(data['arguments']) ?? ''); return n === '' ? {} : { note: n } })()
          : {}),
        startedAt: at,
      }
      s.tools.push(tool)
      trace.updatedAt = now
      return [{ k: 'tool', turn, step, tool, status: stepStatus(s, turnFor(trace, turn)), timing: timingOf(s) }]
    }
    return []
  }

  if (type === 'tool/result') {
    const step = finite(data['step'])
    if (step === undefined) return []
    const s = stepOf(trace, turn, step, at)
    const message = data['message'] as { source?: { callId?: unknown }; isError?: unknown } | undefined
    const callId = str(message?.source?.callId)
    const tool = callId !== undefined ? s.tools.find((t) => t.id === callId) : s.tools.find((t) => t.endedAt === undefined)
    if (tool === undefined) return []
    tool.endedAt = at
    tool.resultChars = resultChars(message)
    /**
     * 失败态**必须在这里落地**（而不是留给客户端从正文认 "Error: " 前缀）。
     *
     * 判据是宿主的 `message.isError` —— 它是 `toolErrorResult` 写死的布尔，
     * 恰好严格为 `true` 才算（脏数据里出现过字符串 `'true'` 之类，不能迁就）。
     *
     * 这一步**从前是漏的**：只记了 `endedAt` 和 `resultChars`，于是面板上
     * 失败的调用和成功的长得一模一样 —— 而它恰恰是用户最需要看见的一类事件
     * （"为什么卡住了 / 这一步白跑了吗"）。
     */
    if (message?.isError === true) tool.failed = failureOf(message, data['error'])
    trace.updatedAt = now
    return [{
      k: 'tool-end', turn, step, id: tool.id, endedAt: at, resultChars: tool.resultChars,
      ...(tool.failed !== undefined ? { failed: tool.failed } : {}),
      status: stepStatus(s, turnFor(trace, turn)),
      timing: timingOf(s),
    }]
  }

  return []
}
