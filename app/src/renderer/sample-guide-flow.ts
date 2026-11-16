import type { Message } from './useSession'

export const guidePrompts = {
  replicate: 'Help me prepare to replicate Study 1 from this paper. Explain the original conditions, procedure, participant materials and measures. Separate what is available from what is missing, and cite the sources. Do not invent missing materials or run an experiment.',
  question: 'Why does the design of Study 1 test the authors’ hypothesis? What alternative explanations remain? Explain using the paper and distinguish the authors’ claims from your interpretation.',
  ai: 'Prepare a small AI-participant trial using the original conditions of Study 1. Show the setup, missing materials and estimated cost before running. Explain how an AI trial differs from replicating the original human experiment. Do not run until I approve.',
  variation: 'Help me explore a variation of Study 1 by changing one condition. Ask what research question I want to investigate, then propose a design and explain how it differs from the original. Keep the original study intact and do not run anything yet.',
  materials: 'Help me prepare research materials from Study 1. Ask whether I want participant instructions, a preregistration draft or an analysis plan. Ground the draft in the paper, cite sources, mark missing information, and keep any suggested additions separate.',
} as const
export type GuidePrompt = keyof typeof guidePrompts
/** What the guide waits for: a message sent after `count` messages existed (ids and counts survive a thread
 *  reload; timestamps may come from another clock). `interrupted` = the last attempt was stopped or rejected. */
export interface GuideWait { ids: number[]; count: number; thread: string | null; startedAt: number; interrupted?: boolean }
const isCommand = (message: Message) => message.parts.some(part => part.kind === 'text' && /^[!/]/.test(part.text.trim()))
/** A turn that ended on a rejected or unanswered question/permission was not a finished reply. */
const unfinished = (message: Message) => message.parts.some(part =>
  (part.kind === 'question' && (part.resolved === 'rejected' || part.expired)) || (part.kind === 'permission' && part.expired))
const isNewUser = (message: Message, index: number, wait: GuideWait) =>
  index >= wait.count && message.role === 'user' && !wait.ids.includes(message.id) && !isCommand(message)
/** The latest message the researcher sent after the guide armed (a retry replaces an earlier attempt). */
export function newUserIndex(messages: Message[], wait: GuideWait) {
  for (let index = messages.length - 1; index >= 0; index--) if (isNewUser(messages[index], index, wait)) return index
  return -1
}
/** A completed response is a navigation signal, never a claim of scientific success. */
export function guideReplyReceived(messages: Message[], wait: GuideWait, thread: string | null, busy: boolean, error: string | null) {
  if (thread !== wait.thread || busy || error) return false
  const user = newUserIndex(messages, wait)
  if (user < 0) return false
  const replies = messages.slice(user + 1).filter(message => message.role === 'assistant' && !wait.ids.includes(message.id))
  if (replies.some(message => message.parts.some(part => part.kind === 'error') || unfinished(message))) return false
  return replies.some(message => message.parts.some(part => part.kind === 'text' && part.text.trim()))
}
/** Re-arm after the conversation moved on without a usable reply: only messages after this point count. */
export function rearm(messages: Message[], thread: string | null, interrupted = false): GuideWait {
  return { ids: messages.map(message => message.id), count: messages.length, thread, startedAt: Date.now(), interrupted }
}
