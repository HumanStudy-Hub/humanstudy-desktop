// Each collaborator signs into their own account. Never discovers the owner's desktop credentials.
import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

export const CONSENT_VERSION = 3
function origin(raw) {
  const u = new URL(raw)
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname)))) throw Error('Use an HTTPS service origin.')
  return u.origin
}
async function save(file, value) {
  await mkdir(dirname(file), { recursive:true, mode:0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode:0o600 }); await rename(tmp, file)
}
async function checked(response) { if (!response.ok) throw Error(`Account service returned ${response.status}.`); return response.json() }
export async function openResearchAccount(file, fetcher=fetch) {
  const info = await stat(file)
  if (process.platform !== 'win32' && info.mode & 0o077) throw Error('Research auth file must be private (chmod 600).')
  let profile = JSON.parse(await readFile(file,'utf8'))
  profile.server = origin(profile.server); profile.supabaseUrl = origin(profile.supabaseUrl)
  if (profile.consentVersion !== CONSENT_VERSION || profile.sources !== true) throw Error('Read the version 3 research agreement and explicitly agree before running the headless worker.')
  const endpoint = profile.supabaseUrl
  const config = await checked(await fetcher(profile.server+'/api/desktop/config', { signal:AbortSignal.timeout(15000) }))
  if (origin(config.supabaseUrl) !== endpoint || config.supabaseKey !== profile.supabaseKey) throw Error('Research profile does not match this HumanStudy service.')
  async function auth() {
    if (profile.expiresAt < Date.now()+60000) {
      const next = await checked(await fetcher(endpoint+'/auth/v1/token?grant_type=refresh_token', { method:'POST', headers:{apikey:profile.supabaseKey,'content-type':'application/json'}, body:JSON.stringify({refresh_token:profile.refreshToken}),signal:AbortSignal.timeout(15000) }))
      if (next.user?.id !== profile.userId) throw Error('Account identity changed during refresh.')
      profile = {...profile,accessToken:next.access_token,refreshToken:next.refresh_token,expiresAt:Date.now()+next.expires_in*1000}
      await save(file, profile)
    }
    return {supabaseUrl:endpoint,supabaseKey:profile.supabaseKey,accessToken:profile.accessToken,userId:profile.userId}
  }
  const credentials = await auth()
  const user = await checked(await fetcher(endpoint+'/auth/v1/user', {headers:{apikey:profile.supabaseKey,Authorization:`Bearer ${credentials.accessToken}`},signal:AbortSignal.timeout(15000)}))
  if (user.id !== profile.userId) throw Error('Research profile owner differs from the verified account.')
  // Hosted model access must also belong to this person, rather than a separately copied key.
  if (profile.desktopKey) {
    const owner = await checked(await fetcher(profile.server+'/api/desktop/identity', {headers:{Authorization:`Bearer ${profile.desktopKey}`},signal:AbortSignal.timeout(15000)}))
    if (owner.userId !== user.id) throw Error('Hosted model key belongs to a different account.')
  }
  return { auth, userId:user.id, server:profile.server, desktopKey:profile.desktopKey, allowed:()=>true }
}

async function main() {
  const { values:o } = parseArgs({options:{file:{type:'string'},server:{type:'string'},'agree-research-v3':{type:'boolean'}}})
  if (!o.file || !o.server || !o['agree-research-v3']) throw Error('Read docs/headless-research.md, then supply --file, --server and --agree-research-v3. Account JSON {email,password,invitationCode?} is read from stdin, never command arguments.')
  const file = resolve(o.file), server = origin(o.server)
  let input=''; for await(const chunk of process.stdin)input+=chunk
  const {email,password,invitationCode} = JSON.parse(input)
  const config = await checked(await fetch(server+'/api/desktop/config',{signal:AbortSignal.timeout(15000)}))
  const sb = origin(config.supabaseUrl), key=config.supabaseKey
  const signed = await checked(await fetch(sb+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:key,'content-type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000)}))
  if (!signed.user?.id || !signed.access_token || !signed.refresh_token) throw Error('Account returned an incomplete session.')
  let desktopKey
  if (invitationCode) desktopKey=(await checked(await fetch(server+'/api/desktop/key',{method:'POST',headers:{Authorization:`Bearer ${signed.access_token}`,'content-type':'application/json'},body:JSON.stringify({code:invitationCode}),signal:AbortSignal.timeout(15000)}))).key
  await save(file,{server,supabaseUrl:sb,supabaseKey:key,userId:signed.user.id,accessToken:signed.access_token,refreshToken:signed.refresh_token,expiresAt:Date.now()+signed.expires_in*1000,desktopKey,consentVersion:CONSENT_VERSION,sources:true})
  console.log(JSON.stringify({status:'signed_in',userId:signed.user.id,consentVersion:CONSENT_VERSION}))
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{console.error('Could not sign in. Check the private input, account confirmation, invitation code and service configuration. No credentials were logged.');process.exitCode=1})
