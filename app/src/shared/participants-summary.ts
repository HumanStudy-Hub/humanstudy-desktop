// Who takes part in a protocol run, as the Simulation tab shows it. The one implementation is the app's own
// pack/skills/run/participants.py (`check <project> --json`, run by the main process: protocol-readiness.ts
// participantsCheck): validation, the paper's per-study sample, condition stripping, the summary line, and the
// SHA-256 of the very files it read. The approval sends exactly those hashes, so Run approves what was shown.

export interface ParticipantsCheck {
  ok: boolean
  mode?: string
  summary?: string
  problem?: string
  participantsSha256: string | null
  programSha256: string | null
  protocolSha256: string | null
}

/** The line under "Who takes part": the summary, or what is wrong with simulation/participants.json. */
export function whoLine(check: ParticipantsCheck | null): { text: string; problem?: string } {
  if (!check) return { text: 'Not checked yet', problem: 'who takes part could not be checked yet; try again in a moment' }
  return check.ok ? { text: check.summary ?? '' } : { text: check.mode ? `${check.mode}` : 'simulation/participants.json', problem: check.problem ?? 'it cannot be used' }
}

/** What the approval carries about who takes part (null hashes: no such file). */
export const approvedHashes = (check: ParticipantsCheck) =>
  ({ participantsSha256: check.participantsSha256, programSha256: check.programSha256, protocolSha256: check.protocolSha256 })
