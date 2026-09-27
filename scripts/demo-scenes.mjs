/**
 * **演示场景** —— 预览页（`docs/ui-preview.html`）与 README 截图（`assets/*.png`）
 * 共用的一组面板状态。
 *
 * 为什么要抽出来：这两处必须看到**同一个面板**。各写一份的话，README 里的图和
 * 预览页迟早长得不一样，而"图和实物不一样"正是这类截图最容易骗人的地方。
 *
 * 每个场景只声明三件事：
 *   · `key`   —— 文件名与命令行筛选用的短名
 *   · `tag`   —— 图上那句话（预览页的标题、截图的说明）
 *   · `html()` —— 拿真组件渲染出这一段 HTML（数据来自 `demo-data.mjs`）
 *
 * 数据**全部是合成的**（见 demo-data.mjs 顶部说明）：这里出的图会进公开仓库。
 */
import { demoSnapshot, FEATURED_TURN, STEP_TEXT } from './demo-data.mjs'

/**
 * 场景清单。
 *
 * `shot` 只给需要出 README 图的场景：`file` 是产物名，`theme` 决定深/浅。
 * 顺序 = 预览页上的顺序 = README 里的顺序。
 */
export const SCENES = [
  {
    key: 'running',
    tag: '① 正在思考',
    note: '模型正在写第 14 步。面板自动跟随到当前步；每行右侧容量条 = 那一步的思考字数；'
      + '行里的中文标题是点「生成标题」后由模型一次调用生成的（结果由宿主落盘缓存）。',
    shot: { file: 'panel-running.png', theme: 'light', width: 420, maxHeight: 600 },
    html: ({ renderState, Body }) => renderState(Body, demoSnapshot({ upto: 14, lastStatus: 'thinking' })),
  },
  {
    key: 'waiting',
    tag: '② 正在等工具',
    note: '第 8 步调了联网检索，正在等外部接口。这是整个面板唯一的高亮块 —— 不做它，'
      + '真实数据里那几十秒模型零输出与"卡死"无法区分。',
    shot: { file: 'panel-waiting.png', theme: 'light', width: 420, maxHeight: 600 },
    html: ({ renderState, Body }) => {
      const s = demoSnapshot({ upto: 8, lastStatus: 'waiting', toolsRunning: true })
      const last = s.turns[s.turns.length - 1].steps.slice(-1)[0]
      const running = last.tools[last.tools.length - 1]
      // 等了一会儿的某一刻：开始时间往前挪，好让"已等多久"有内容
      running.startedAt = Date.now() - 23400
      return renderState(Body, s)
    },
  },
  {
    key: 'done',
    tag: '③ 本轮完成（深色）',
    note: '本轮结束，底部补一块「思考花在哪了」的小结：阶段分布用同一色相只变深浅，'
      + '不重新引入"每个阶段一个颜色"。深色下同一套 token 自动换档。',
    shot: { file: 'panel-done.png', theme: 'dark', width: 420, maxHeight: 660 },
    html: ({ renderState, Body }) => renderState(Body, demoSnapshot({ upto: 14, lastStatus: 'done' })),
  },
  {
    key: 'expanded',
    tag: '④ 展开某一步',
    note: '这一轮**已经生成过标题**，所以展开的是有模型标题的那一步：行里是模型标题，'
      + '展开后依次是**次级标题**（按工具参数算出来的派生标题）、工具详情、'
      + '以及按需取回的思考原文（快照只给当前步带原文，其余走 `/step`，之后走缓存）。',
    shot: { file: 'panel-expanded.png', theme: 'light', width: 420, maxHeight: 760 },
    // 先展开「读代码」（第 6 步所在的阶段块 —— `.tf-phase-h` 挂的是 onClick 的 div，
    // 不是 button），再点那一步的展开箭头。两步都走组件真实的 onClick。
    //
    // ⚠️ `.tf-chev` 的序号是 **步号 − 1**：面板顶部那条小结（`14 步 22k 字 17 次工具 ▾`）
    //    也带 `.tf-chev`，但它是个没有 onClick 的 `<span>`，被筛掉之后第 1 步就排到了 0。
    html: ({ renderState, Body }) => renderState(Body, demoSnapshot({ upto: 14, lastStatus: 'done' }), [],
      { clicks: [{ cls: 'tf-phase-h', index: 2 }, { cls: 'tf-chev', index: 5 }] }),
  },
  {
    key: 'failure',
    tag: '⑤ 工具失败',
    note: '宿主把失败折成一条结果（`isError` + `error.code`），面板照着显示：'
      + '行里一枚红标，**为什么**失败在展开区紧跟它自己那条工具行，悬停看全'
      + '（工具名 + 机读码 + 摘要）。红只给错误文本，工具名不动。',
    shot: { file: 'panel-failure.png', theme: 'light', width: 420, maxHeight: 760 },
    // 失败的那一步在第 12 步（「问用户」块）：同样先把那块展开，再点开那一步
    // （`.tf-chev` 序号 = 步号 − 1，见 ④ 的说明）
    html: ({ renderState, Body }) => renderState(Body, demoSnapshot({ upto: 14, lastStatus: 'done' }), [],
      { clicks: [{ cls: 'tf-phase-h', index: 8 }, { cls: 'tf-chev', index: 11 }] }),
  },
  {
    key: 'directory',
    tag: '⑥ 全轮目录（双击第二行标题进入）',
    note: '面板一次只显示一轮，更早的轮次走目录：第二行标题**双击**就地变成搜索框，'
      + '下面列出全部轮次的骨架（轮号 / 标题 / 步数 / 字数）。搜索**全在本地算**，'
      + '一个请求都不发 —— 搜的是每轮的用户原话与标题。',
    shot: { file: 'panel-directory.png', theme: 'light', width: 420, maxHeight: 760 },
    html: ({ renderState, Body }) => renderState(Body, demoSnapshot({ upto: 14, lastStatus: 'done' }), [], { dblClick: 'tf-turn-title' }),
  },
]

/**
 * 面板里的 `/step` 桩要返回的原文。
 * 展开历史步骤时组件会真的发这个请求，预览环境里没有宿主 —— 不给桩就会在页面上
 * 冒出"取原文失败"（那是预览环境的问题，不是组件的，但看图的人分不出来）。
 */
export const STEP_STUB = STEP_TEXT

/** 被演示的那一轮的轮号（预览页文案里要引用）。 */
export { FEATURED_TURN }
