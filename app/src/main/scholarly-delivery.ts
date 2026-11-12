import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scholarlyProblems } from '../shared/scholarly-program'

export function scholarlyDeliveryHash(dir: string, raw: string): string | undefined {
  const protocol = JSON.parse(raw.replace(/^\uFEFF/, ''))
  let program = ''
  try { program = readFileSync(join(dir, 'program.json'), 'utf8') } catch { /* reported below */ }
  let paired = protocol.meta?.delivery === 'research-program-v1'
  try { paired ||= Object.prototype.hasOwnProperty.call(JSON.parse(program.replace(/^\uFEFF/, '')).extensions ?? {}, 'scholarly') } catch { /* marker remains authoritative */ }
  if (!paired) return undefined
  let preview = ''
  try { preview = readFileSync(join(dir, 'artifacts', 'preview.html'), 'utf8') } catch { /* missing is a distinct stamp */ }
  return createHash('sha256').update(JSON.stringify([program, preview])).digest('hex')
}

/** An explicit paired-delivery marker opts new builds in; legacy protocol-only imports still work. */
export function scholarlyDeliveryProblems(dir: string, raw: string): string[] {
  try {
    const protocol = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!scholarlyDeliveryHash(dir, raw)) return []
    const program = JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8'))
    const hash = createHash('sha256').update(raw).digest('hex')
    const problems = scholarlyProblems(program, protocol, hash)
    const html = readFileSync(join(dir, 'artifacts', 'preview.html'), 'utf8')
    const match = html.match(/<script\b[^>]*\bid=["']hs-protocol["'][^>]*>([\s\S]*?)<\/script>/i)
    const identity = JSON.parse(match?.[1] ?? '')
    if (identity.id !== protocol.id || identity.sha256 !== hash) problems.push('Prepare a preview of the current experiment version.')
    return problems
  } catch { return ['Save the complete research document and current participant preview.'] }
}
