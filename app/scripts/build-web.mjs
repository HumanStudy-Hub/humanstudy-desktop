// Builds the web edition into out/web: the desktop main process and renderer exactly as electron-vite built
// them, the desktop preload compiled against web/browser-electron.ts, and the server that joins them.
//   npx electron-vite build && node scripts/build-web.mjs      then: HS_WEB_INSECURE=1 node out/web/server.cjs
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(app, 'out', 'web')
for (const d of ['main', 'renderer']) if (!existsSync(join(app, 'out', d))) throw new Error(`out/${d} is missing: run electron-vite build first`)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(app, 'out', 'main'), join(out, 'main'), { recursive: true })
cpSync(join(app, 'out', 'renderer'), join(out, 'renderer'), { recursive: true })
for (const f of ['server.cjs', 'electron-shim.cjs', 'electron-updater-shim.cjs']) cpSync(join(app, 'web', f), join(out, f))
cpSync(join(app, 'resources', 'sample'), join(out, 'resources', 'sample'), { recursive: true })
// The main bundle's only runtime dependency besides electron/electron-updater (both shimmed).
cpSync(join(app, 'node_modules', 'fflate'), join(out, 'node_modules', 'fflate'), { recursive: true, dereference: true })
await build({
  entryPoints: [join(app, 'src', 'preload', 'index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  alias: { electron: join(app, 'web', 'browser-electron.ts') },
  outfile: join(out, 'renderer', 'web-preload.js'),
  logLevel: 'warning',
})
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'humanstudy-web', version: pkg.version, private: true, main: 'server.cjs' }, null, 2) + '\n')
writeFileSync(join(out, 'VERSION'), pkg.version + '\n')
console.log(`web edition ${pkg.version} -> ${out}`)
