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

/** A protocol run's model budget, measured by skills/run/budget.py when protocol.json passes its checks: per
 *  runnable arm, members per group, model calls and reserved tokens per member (one call per page; each prompt
 *  carries the earlier pages and answers, so it grows). */
export interface ProtocolBudget { arms: Record<string, { group_size: number; calls: number; tokens_per_member: number }>; output_tokens: number }

/** Seconds per model call with 8 in flight, and the margin, for a protocol run's lifetime. */
export const SECONDS_PER_CALL = 3
const IN_FLIGHT = 8

/** Limits of a protocol run (review 2, M3): sized from the protocol, not from the package allowance.
 *  participants = AI members (per arm x group size); tokens = their measured reservation plus a one-per-arm
 *  trial, at least MIN_RUN_TOKENS. `fits` is false above MAX_RUN_TOKENS (the hard ceiling): such a plan is never
 *  approved, whatever the text says; `tokens` is then the ceiling and `needed` the true figure. */
export function protocolRunLimits(budget: ProtocolBudget | null | undefined, perCondition: unknown): RunLimits & { needed: number; fits: boolean } {
  const per = Number.isSafeInteger(perCondition) && (perCondition as number) > 0 ? Math.min(perCondition as number, MAX_PER_CONDITION) : 1
  const arms = Object.values(budget?.arms ?? {})
  if (!arms.length) return { participants: 0, tokens: MIN_RUN_TOKENS, minutes: MIN_RUN_MINUTES, needed: Infinity, fits: false }
  const members = arms.reduce((n, a) => n + per * a.group_size, 0)
  const trial = arms.reduce((n, a) => n + a.group_size * a.tokens_per_member, 0)
  const needed = arms.reduce((n, a) => n + per * a.group_size * a.tokens_per_member, 0) + trial
  const calls = arms.reduce((n, a) => n + (per + 1) * a.group_size * a.calls, 0)
  const minutes = Math.min(MAX_RUN_MINUTES, Math.max(MIN_RUN_MINUTES, Math.ceil(calls * SECONDS_PER_CALL / IN_FLIGHT / 60 * 1.5)))
  return { participants: members, tokens: Math.min(MAX_RUN_TOKENS, Math.max(MIN_RUN_TOKENS, needed)), minutes, needed, fits: needed <= MAX_RUN_TOKENS }
}
