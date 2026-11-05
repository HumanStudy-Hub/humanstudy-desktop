// The model-access limits of one approved simulation run (macOS relay). Computed from the plan the
// researcher approved (participants = conditions x per condition), by the main process for the relay
// and by the Simulation tab for the run confirmation, so the two always state the same figures.

/** Token reservation per AI participant. The relay reserves request bytes + 256 per message + the output
 *  limit (default 512) for every call: about 4,000 for a 3 KB prompt, so this covers five such calls, or
 *  a five-turn conversation whose history grows, plus a trial run. Reservations overstate real use. */
export const TOKENS_PER_PARTICIPANT = 40_000
export const MIN_RUN_TOKENS = 200_000
/** Hard ceiling, whatever the plan says (400 participants at the allowance above). */
export const MAX_RUN_TOKENS = 16_000_000
/** Minutes per participant: 5 calls at about 3 s with 8 in flight is under 2 s; this leaves room for
 *  retries, a trial run and a restart after a fix within the same approval. */
export const MINUTES_PER_PARTICIPANT = 0.2
export const MIN_RUN_MINUTES = 30
export const MAX_RUN_MINUTES = 120

/** The most participants per condition the Simulation tab offers; the main process rejects more. */
export const MAX_PER_CONDITION = 60

export interface RunLimits { participants: number; tokens: number; minutes: number }

/** Limits for an approved plan. Anything unreadable counts as one participant (the floor limits). */
export function runLimits(plan: { conditions?: unknown; perCondition?: unknown } | null | undefined): RunLimits {
  const per = Number.isSafeInteger(plan?.perCondition) && (plan!.perCondition as number) > 0 ? Math.min(plan!.perCondition as number, 10_000) : 1
  const groups = Array.isArray(plan?.conditions) ? Math.min(Math.max(1, plan!.conditions.length), 100) : 1
  const participants = per * groups
  const tokens = Math.min(MAX_RUN_TOKENS, Math.max(MIN_RUN_TOKENS, participants * TOKENS_PER_PARTICIPANT))
  const minutes = Math.min(MAX_RUN_MINUTES, Math.max(MIN_RUN_MINUTES, Math.ceil(participants * MINUTES_PER_PARTICIPANT)))
  return { participants, tokens, minutes }
}

/** "1,500,000" in either language (the confirmation wording quotes it). */
export const formatTokens = (n: number): string => n.toLocaleString('en-US')
