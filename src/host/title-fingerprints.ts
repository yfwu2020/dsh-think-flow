import type { StepFact, TurnFact } from '../trace.js'

/**
 * 一步的"内容指纹"：够便宜，又能判出内容变没变。
 *
 * 用长度 + 开头一小段就够：思考只会**追加**，长度变了基本就是变了；
 * 开头一段兜住"同长度但内容不同"的极端情况。整段做哈希太贵
 * （一步上万字，而这个检查每 5 秒会跑一次）。
 * @param s - 该步。
 * @returns 指纹串。
 */
export function stepPrint(s: StepFact): string {
  return s.reasoning.length + ':' + s.reasoning.slice(0, 24)
}

/**
 * **本轮最后的 AI 输出** —— 整轮标题的素材（用户定的）。
 *
 * 从最后一步往前找第一条非空的正文：末尾的步常常只有工具调用、没有正文，
 * 直接取最后一步会拿到空串。
 */
export function turnOutputOf(turn: TurnFact): string {
  for (let i = turn.steps.length - 1;i >= 0;i -= 1) {
    const text = turn.steps[i]?.text ?? ''
    if (text.trim() !== '') return text
  }
  return ''
}

/** 整轮标题的指纹（素材 = 本轮最后的输出）。没输出就是空串 —— 那就没什么可总结的。 */
export function turnPrint(turn: TurnFact): string {
  const out = turnOutputOf(turn)
  return out === '' ? '' : out.length + ':' + out.slice(0, 24)
}
