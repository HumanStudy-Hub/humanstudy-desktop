// Wraps electron-builder so macOS notarization is decided by the environment:
//   APPLE_API_ISSUER set   -> notarize with the App Store Connect API key
//                             (APPLE_API_KEY defaults to ~/.appstoreconnect/private_keys/AuthKey_<id>.p8,
//                              APPLE_API_KEY_ID defaults to J3H58NSZJV)
//   APPLE_API_ISSUER unset -> skip notarization (logged), and drop half-set APPLE_API_* vars,
//                             which electron-builder would otherwise treat as a config error.
// --unsigned also skips the Developer ID signature (CI without signing secrets).
// Every other argument goes to electron-builder unchanged, e.g.
//   node scripts/dist.mjs --mac --publish never
//   node scripts/dist.mjs --win --x64 --publish never
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const unsigned = args.includes('--unsigned')
const passthrough = args.filter((a) => a !== '--unsigned')
const env = { ...process.env }
const extra = []
const buildsMac = passthrough.some((a) => a === '--mac' || a === '-m') || (!passthrough.some((a) => /^(--win|-w|--linux|-l)$/.test(a)) && process.platform === 'darwin')

if (unsigned) {
  console.log('[dist] --unsigned: skipping macOS code signing and notarization')
  extra.push('-c.mac.identity=null', '-c.mac.notarize=false')
  delete env.CSC_LINK
  delete env.CSC_KEY_PASSWORD
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
} else if (env.APPLE_API_ISSUER) {
  env.APPLE_API_KEY_ID ||= 'J3H58NSZJV'
  env.APPLE_API_KEY ||= join(homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${env.APPLE_API_KEY_ID}.p8`)
  if (buildsMac && !existsSync(env.APPLE_API_KEY)) {
    console.error(`[dist] APPLE_API_ISSUER is set but the API key file is missing: ${env.APPLE_API_KEY}`)
    process.exit(1)
  }
  if (buildsMac) console.log(`[dist] notarizing with App Store Connect API key ${env.APPLE_API_KEY_ID}`)
} else {
  if (buildsMac) console.log('[dist] APPLE_API_ISSUER not set: skipping notarization (the app is signed but not notarized)')
  delete env.APPLE_API_KEY
  delete env.APPLE_API_KEY_ID
  extra.push('-c.mac.notarize=false')
}

const bin = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
const r = spawnSync(bin, [...passthrough, ...extra], { stdio: 'inherit', env, shell: process.platform === 'win32' })
process.exit(r.status ?? 1)
