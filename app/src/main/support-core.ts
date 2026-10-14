// Explicit, user-submitted support requests. Separate from research telemetry and its consent.
import type { SupportRequest, SupportStatus } from '../preload/types'
import type { RestAuth } from './account-core'

interface Deps {
  auth(): Promise<RestAuth | null>
  fetch: typeof fetch
  diagnostics: { version: string; platform: string; arch: string }
  contactEmail?: string
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function createSupport(deps: Deps) {
  const contactEmail = deps.contactEmail && email.test(deps.contactEmail) ? deps.contactEmail : undefined
  async function call(auth: RestAuth, suffix: string, init: RequestInit = {}) {
    try {
      return await deps.fetch(`${auth.supabaseUrl}/rest/v1/support_requests${suffix}`, {
        ...init, signal: AbortSignal.timeout(15000),
        headers: { apikey: auth.supabaseKey, authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json', ...init.headers },
      })
    } catch { throw new Error('Could not reach support. Your draft is still here; please try again.') }
  }
  async function status(): Promise<SupportStatus> {
    try {
      const auth = await deps.auth()
      if (!auth) return { available: false, contactEmail }
      const response = await call(auth, '?select=id&limit=0')
      return { available: response.ok, contactEmail }
    } catch { return { available: false, contactEmail } }
  }
  async function submit(input: SupportRequest): Promise<{ id: string }> {
    if (!input || !uuid.test(input.id) || !['help', 'problem', 'suggestion'].includes(input.kind)) throw new Error('Please choose a request type.')
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 12000) throw new Error('Write a message of up to 12,000 characters. Nothing has been sent.')
    if (input.replyEmail !== undefined && (typeof input.replyEmail !== 'string' || input.replyEmail.length > 254 || (input.replyEmail.trim() && !email.test(input.replyEmail.trim())))) throw new Error('Please enter a valid reply email or leave it empty.')
    if (typeof input.includeDiagnostics !== 'boolean') throw new Error('Please review the diagnostic information choice.')
    const auth = await deps.auth()
    if (!auth) throw new Error('Sign in to send your request. Your draft is still here.')
    const row = {
      id: input.id, owner_id: auth.userId, kind: input.kind, message: input.message,
      reply_email: input.replyEmail?.trim() || null,
      diagnostics: input.includeDiagnostics ? { version: deps.diagnostics.version, platform: deps.diagnostics.platform, arch: deps.diagnostics.arch } : {},
    }
    const response = await call(auth, '?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(row) })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Please sign in again before sending. Your draft is still here.')
      throw new Error('Your request could not be confirmed. Keep this draft and try again.')
    }
    // A dropped response after a committed insert can be retried without sending a second request.
    // Never overwrite an existing request when the researcher has changed the draft after a timeout.
    const check = await call(auth, `?id=eq.${input.id}&select=id,kind,message,reply_email,diagnostics`)
    if (!check.ok) throw new Error('Your request could not be confirmed. Keep this draft and try again.')
    const records = await check.json() as Array<Record<string, unknown>>
    const saved = records[0]
    const d = saved?.diagnostics as Record<string, unknown> | undefined
    const sameDiagnostics = d && Object.keys(d).length === Object.keys(row.diagnostics).length && Object.entries(row.diagnostics).every(([k, v]) => d[k] === v)
    if (!saved || saved.id !== row.id || saved.kind !== row.kind || saved.message !== row.message || saved.reply_email !== row.reply_email || !sameDiagnostics)
      throw new Error(`Request ${input.id} may already have been received with different content. Keep this reference and contact the team before sending a new request.`)
    return { id: input.id }
  }
  return { status, submit }
}
