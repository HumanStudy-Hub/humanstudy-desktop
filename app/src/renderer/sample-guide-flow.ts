import type { Message } from './useSession'

export const guidePrompts = {
  replicate: 'Help me prepare to replicate Study 1 from this paper. Explain the original conditions, procedure, participant materials and measures. Separate what is available from what is missing, and cite the sources. Do not invent missing materials or run an experiment.',
  question: 'Why does the design of Study 1 test the authors’ hypothesis? What alternative explanations remain? Explain using the paper and distinguish the authors’ claims from your interpretation.',
  ai: 'Prepare a small AI-participant trial using the original conditions of Study 1. Show the setup, missing materials and estimated cost before running. Explain how an AI trial differs from replicating the original human experiment. Do not run until I approve.',
  variation: 'Help me explore a variation of Study 1 by changing one condition. Ask what research question I want to investigate, then propose a design and explain how it differs from the original. Keep the original study intact and do not run anything yet.',
  materials: 'Help me prepare research materials from Study 1. Ask whether I want participant instructions, a preregistration draft or an analysis plan. Ground the draft in the paper, cite sources, mark missing information, and keep any suggested additions separate.',
} as const
export type GuidePrompt = keyof typeof guidePrompts
export interface GuideWait { ids: number[]; thread: string | null; startedAt: number }
/** A completed response is a navigation signal, never a claim of scientific success. */
export function guideReplyReceived(messages: Message[], wait: GuideWait, thread: string | null, busy: boolean, error: string | null) {
  if (thread !== wait.thread || busy || error) return false
  const user = messages.findIndex(message => message.role === 'user' && !wait.ids.includes(message.id) && (message.at ?? 0) >= wait.startedAt)
  if (user < 0) return false
  return messages.slice(user + 1).some(message => message.role === 'assistant' && !wait.ids.includes(message.id)
    && !message.parts.some(part => part.kind === 'error')
    && message.parts.some(part => part.kind === 'text' && part.text.trim()))
}
