import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openResearchAccount} from './research-auth.mjs'
const USER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222'
const root=await mkdtemp(join(tmpdir(),'headless-auth-test-'))
async function profile(over={}){const file=join(root,Math.random()+'.json');await writeFile(file,JSON.stringify({server:'https://hub.test',supabaseUrl:'https://db.test',supabaseKey:'public-test',userId:USER,accessToken:'fixture-token',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000,desktopKey:'fixture-hosted',consentVersion:3,sources:true,...over}),{mode:0o600});return file}
function fake({user=USER,hosted=USER}={}){const calls=[];const fetcher=async(url,init={})=>{calls.push(url);if(url.endsWith('/api/desktop/config'))return Response.json({supabaseUrl:'https://db.test',supabaseKey:'public-test'});if(url.endsWith('/auth/v1/user'))return Response.json({id:user});if(url.endsWith('/api/desktop/identity'))return Response.json({userId:hosted});if(url.includes('grant_type=refresh_token'))return Response.json({user:{id:user},access_token:'rotated-token',refresh_token:'rotated-refresh',expires_in:3600});throw Error('Unexpected endpoint')};return {fetcher,calls}}
test('old agreement stops before any network; a matching personal profile is verified',async()=>{
 const f=fake();await assert.rejects(openResearchAccount(await profile({consentVersion:2}),f.fetcher),/agreement/);assert.equal(f.calls.length,0)
 const a=await openResearchAccount(await profile(),f.fetcher);assert.equal(a.userId,USER);assert.equal((await a.auth()).accessToken,'fixture-token')
})
test('account mismatch or another person’s hosted key stops the worker',async()=>{
 await assert.rejects(openResearchAccount(await profile(),fake({user:OTHER}).fetcher),/owner differs/)
 await assert.rejects(openResearchAccount(await profile(),fake({hosted:OTHER}).fetcher),/different account/)
})
test('refresh stays on the same account, rotates private credentials and never saves a password',async()=>{
 const path=await profile({expiresAt:0}),a=await openResearchAccount(path,fake().fetcher);assert.equal((await a.auth()).accessToken,'rotated-token');const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.refreshToken,'rotated-refresh');assert.ok(!('password' in saved));await assert.rejects(openResearchAccount(await profile({expiresAt:0}),fake({user:OTHER}).fetcher),/identity changed/)
})
test.after(async()=>rm(root,{recursive:true,force:true}))
