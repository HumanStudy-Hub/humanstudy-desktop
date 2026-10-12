// Dependency-free core of the managed research runtime (no electron import), tested by
// runtime.test.mjs. The runtime is what the pack's skills run on: a private CPython from
// python-build-standalone, a hash-pinned wheel set (pack/runtime/requirements.lock), and shims for the
// poppler tools. It lives in userData/runtime/<version>/ and is put first on the kernel's PATH.
//
//   <dir>/python/            CPython (python-build-standalone, install_only_stripped)
//   <dir>/bin/               python, python3, pip, pip3, pdftotext, pdfinfo, hs-pdf (sh / .cmd shims)
//   <dir>/python/**/site-packages/{humanstudy_llm,hs_pdf_tools}.py   from pack/runtime/lib
//   <dir>/.ok                runtimeVersion(lock), written last
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { InstallCancelled, downloadVerified, percent } from './opencode-install-core'

const run = promisify(execFile)

export const PBS_TAG = '20261009'
export const PYTHON_VERSION = '3.12.15'
export const PBS_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}`

export interface PythonAsset {
  name: string
  sha256: string
  size: number
}

/** Pinned python-build-standalone assets (digests from the release's SHA256SUMS, sizes in bytes). */
export const PYTHON_ASSETS: Record<string, PythonAsset> = {
  'darwin-arm64': {
    name: `cpython-${PYTHON_VERSION}+${PBS_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: '233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f',
    size: 25030095,
  },
  'darwin-x64': {
    name: `cpython-${PYTHON_VERSION}+${PBS_TAG}-x86_64-apple-darwin-install_only_stripped.tar.gz`,
    sha256: 'fb3187d95334813b88940db0f1ca57b84cedfd552739c3a5771c3ea0e49988c9',
    size: 24751118,
  },
  'win32-x64': {
    name: `cpython-${PYTHON_VERSION}+${PBS_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
    sha256: '11ed9f8a6ac64fb1b5a55e40e305a6744a3f77a70863c8f8197a6e4349abc64a',
    size: 22011208,
  },
}

/** The Python build for this machine, or null (Windows ARM and Linux are not targets). */
export const pickPython = (platform: string, arch: string): PythonAsset | null => PYTHON_ASSETS[`${platform}-${arch}`] ?? null
export const pythonUrl = (a: PythonAsset, base: string = PBS_BASE): string => `${base}/${a.name.replace('+', '%2B')}`

/** Wheel set + interpreter identity. A new lock file means a new directory (and a fresh install). */
export const runtimeVersion = (lock: string): string =>
  `py${PYTHON_VERSION}-${PBS_TAG}-${createHash('sha256').update(lock).digest('hex').slice(0, 10)}`

export interface RuntimePaths {
  root: string
  bin: string
  python: string // the interpreter itself
  sitePackages: string
  ok: string
}

export function runtimePaths(root: string, platform: string): RuntimePaths {
  const win = platform === 'win32'
  return {
    root,
    bin: join(root, 'bin'),
    python: win ? join(root, 'python', 'python.exe') : join(root, 'python', 'bin', 'python3'),
    sitePackages: win ? join(root, 'python', 'Lib', 'site-packages') : join(root, 'python', 'lib', 'python3.12', 'site-packages'),
    ok: join(root, '.ok'),
  }
}

// ---- shims -------------------------------------------------------------------------------------

/** shim name -> python arguments after the interpreter. */
const SHIMS: Record<string, string[]> = {
  python: [],
  python3: [],
  pip: ['-m', 'pip'],
  pip3: ['-m', 'pip'],
  pdftotext: ['-E', '-s', '-m', 'hs_pdf_tools', 'pdftotext'],
  pdfinfo: ['-E', '-s', '-m', 'hs_pdf_tools', 'pdfinfo'],
  'hs-pdf': ['-E', '-s', '-m', 'hs_pdf_tools', 'hs-pdf'],
}
export const SHIM_NAMES = Object.keys(SHIMS)

export interface SupportFile {
  rel: string // relative to the runtime root
  content: string
  exec?: boolean
}

/** The bin/ wrappers. Unix: sh scripts that find the runtime relative to themselves (so the folder can be
 *  moved). Windows: .cmd files, which cmd.exe and PowerShell both resolve through PATHEXT. */
export function shimFiles(platform: string): SupportFile[] {
  if (platform === 'win32') {
    return Object.entries(SHIMS).map(([name, args]) => ({
      rel: `bin/${name}.cmd`,
      content: `@echo off\r\n"%~dp0..\\python\\python.exe" ${args.join(' ')}${args.length ? ' ' : ''}%*\r\n`,
    }))
  }
  return Object.entries(SHIMS).map(([name, args]) => ({
    rel: `bin/${name}`,
    exec: true,
    content: `#!/bin/sh\nd=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 127\nexec "$d/../python/bin/python3" ${args.join(' ')}${args.length ? ' ' : ''}"$@"\n`,
  }))
}

const STUB_MESSAGE =
  'The HumanStudy research runtime (Python and PDF tools) is not installed yet. Tell the researcher it is still being set up or failed to install, and to reopen the app or press Retry. Do not try another Python.'

/** Shims for when the runtime is missing: fail loudly instead of falling through to the system Python
 *  (on a clean Mac /usr/bin/python3 opens the Xcode command line tools installer). */
export function stubFiles(platform: string): SupportFile[] {
  return SHIM_NAMES.map((name) =>
    platform === 'win32'
      ? { rel: `${name}.cmd`, content: `@echo off\r\necho ${STUB_MESSAGE} 1>&2\r\nexit /b 127\r\n` }
      : { rel: name, exec: true, content: `#!/bin/sh\necho '${STUB_MESSAGE}' >&2\nexit 127\n` }
  )
}

export async function writeFiles(root: string, files: SupportFile[]): Promise<void> {
  for (const f of files) {
    const p = join(root, f.rel)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, f.content)
    if (f.exec) await chmod(p, 0o755)
  }
}

/** `files` maps module file name -> source (pack/runtime/lib/*.py). */
export const libFiles = (rt: RuntimePaths, files: Record<string, string>): SupportFile[] =>
  Object.entries(files).map(([name, content]) => ({ rel: relative(rt.root, join(rt.sitePackages, name)), content }))

// ---- environment for the kernel ---------------------------------------------------------------

/** Env for processes the kernel starts. `binDir` is the runtime's bin (or the stub bin when the runtime
 *  is not installed); it goes first on PATH. Pure: returns a new object. */
export function runtimeEnv(env: NodeJS.ProcessEnv, binDir: string, platform: string = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  const sep = platform === 'win32' ? ';' : delimiter
  // Windows env keys are case-insensitive but a copied object is not: reuse whatever spelling is there.
  const key = Object.keys(out).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const rest = (out[key] ?? '').split(sep).filter((p) => p && p !== binDir)
  out[key] = [binDir, ...rest].join(sep)
  for (const k of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PIP_REQUIRE_VIRTUALENV', 'PIP_USER']) delete out[k]
  out.PYTHONNOUSERSITE = '1'
  out.MPLBACKEND = 'Agg'
  out.PIP_DISABLE_PIP_VERSION_CHECK = '1'
  out.PIP_NO_INPUT = '1'
  out.PYTHONUTF8 = '1'
  out.PYTHONIOENCODING = 'utf-8'
  return out
}

/** What the kernel factory uses: HUMANSTUDY_RUNTIME_BIN is set by the app (the runtime's bin once installed,
 *  else the stub bin). Unset (tests, mock kernel): the environment is returned unchanged. */
export function kernelRuntimeEnv(env: NodeJS.ProcessEnv, platform: string = process.platform): NodeJS.ProcessEnv {
  const bin = env.HUMANSTUDY_RUNTIME_BIN?.trim()
  return bin ? runtimeEnv(env, bin, platform) : env
}

// ---- install ----------------------------------------------------------------------------------

export type RuntimePhase = 'python' | 'extract' | 'packages' | 'verify'
export interface RuntimeProgress {
  phase: RuntimePhase
  /** 0-100 over the whole runtime install. */
  percent: number
}

/** Share of the runtime's progress bar per phase (the wheels are ~80% of the bytes but pip is slower). */
export const PHASE_RANGE: Record<RuntimePhase, [number, number]> = {
  python: [0, 22],
  extract: [22, 28],
  packages: [28, 96],
  verify: [96, 99],
}
const within = (phase: RuntimePhase, frac: number): number => {
  const [a, b] = PHASE_RANGE[phase]
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, frac)))
}

export interface RuntimeDeps {
  extract(tarball: string, into: string): Promise<void>
  /** Runs `python <args>`; every stdout line goes to onLine. Rejects on a non-zero exit. */
  python(python: string, args: string[], env: NodeJS.ProcessEnv, onLine: (l: string) => void, signal?: AbortSignal): Promise<void>
}

export const defaultDeps: RuntimeDeps = {
  // bsdtar ships with macOS and with Windows 10+ (System32\tar.exe).
  extract: async (tarball, into) => {
    await run('tar', ['-xzf', tarball, '-C', into], { windowsHide: true, maxBuffer: 1 << 20 })
  },
  python: (python, args, env, onLine, signal) =>
    new Promise((resolve, reject) => {
      const p = spawn(python, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
      let tail = ''
      const feed = (chunk: Buffer): void => {
        const s = chunk.toString('utf8')
        tail = (tail + s).slice(-4000)
        for (const l of s.split(/\r?\n/)) if (l) onLine(l)
      }
      p.stdout.on('data', feed)
      p.stderr.on('data', feed)
      p.on('error', (e) => reject(signal?.aborted ? new InstallCancelled() : e))
      p.on('close', (code) => (code === 0 ? resolve() : reject(signal?.aborted ? new InstallCancelled() : new Error(`python ${args.slice(0, 3).join(' ')} exited ${code}: ${tail.trim().split('\n').slice(-6).join(' | ')}`))))
    }),
}

/** Count of pinned requirements in a lock file (for pip progress). */
export const lockSize = (lock: string): number => lock.split(/\r?\n/).filter((l) => /^[A-Za-z0-9][A-Za-z0-9._-]*==/.test(l)).length

export const IMPORT_CHECK =
  'import numpy, scipy, pandas, statsmodels, matplotlib, pingouin, pypdf, pdfplumber, openpyxl, docx, pyreadstat, jinja2, jsonschema, humanstudy_llm, hs_pdf_tools; print("runtime-ok")'

export interface InstallOptions {
  root: string
  platform: string
  arch: string
  lock: string
  /** pack/runtime/lib/*.py by file name. */
  lib: Record<string, string>
  /** Defaults to the pinned asset for platform/arch. */
  asset?: PythonAsset | null
  baseUrl?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onProgress?: (p: RuntimeProgress) => void
  deps?: RuntimeDeps
  /** Extra args for pip, e.g. a local --index-url in tests. */
  pipArgs?: string[]
}

/** True when `root` holds a finished install of exactly this lock. */
export async function isInstalled(root: string, platform: string, lock: string): Promise<boolean> {
  try {
    return (await readFile(runtimePaths(root, platform).ok, 'utf8')).trim() === runtimeVersion(lock)
  } catch {
    return false
  }
}

/** Installs the runtime into `root`: python download (checksum-pinned, resumable) -> extract -> shims ->
 *  pip install --require-hashes --only-binary :all: -> import check -> `.ok`. Anything but the `.ok`
 *  marker means "not installed", so an interrupted install is simply redone (the download resumes, pip
 *  reuses its cache). */
export async function installRuntime(o: InstallOptions): Promise<RuntimePaths> {
  try {
    return await installSteps(o)
  } catch (e) {
    throw o.signal?.aborted && !(e instanceof InstallCancelled) ? new InstallCancelled() : e // fetch rejects with AbortError
  }
}

async function installSteps(o: InstallOptions): Promise<RuntimePaths> {
  const rt = runtimePaths(o.root, o.platform)
  const deps = o.deps ?? defaultDeps
  let top = 0 // never move the bar backwards (a pip retry restarts its package count)
  const emit = (phase: RuntimePhase, frac: number): void => {
    top = Math.max(top, within(phase, frac))
    o.onProgress?.({ phase, percent: top })
  }
  const support = [...shimFiles(o.platform), ...libFiles(rt, o.lib)]
  if (await isInstalled(o.root, o.platform, o.lock)) {
    await writeFiles(o.root, support) // shims / client may have changed without a new lock
    return rt
  }
  const asset = o.asset === undefined ? pickPython(o.platform, o.arch) : o.asset
  if (!asset) throw new Error(`no research runtime build for ${o.platform}-${o.arch}`)
  await mkdir(o.root, { recursive: true })
  await rm(rt.ok, { force: true })
  const dl = join(o.root, 'download')
  await mkdir(dl, { recursive: true })
  const tarball = join(dl, asset.name)

  emit('python', 0)
  let last = -1
  await downloadVerified({
    url: pythonUrl(asset, o.baseUrl),
    dest: tarball,
    size: asset.size,
    sha256: asset.sha256,
    signal: o.signal,
    fetchImpl: o.fetchImpl,
    onProgress: (r, t) => {
      const p = percent(r, t)
      if (p !== last) {
        last = p
        emit('python', p / 100)
      }
    },
  })

  emit('extract', 0)
  const tmp = join(o.root, 'extract')
  await rm(tmp, { recursive: true, force: true })
  await rm(join(o.root, 'python'), { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  await deps.extract(tarball, tmp)
  if (!(await readdir(tmp)).includes('python')) throw new Error(`no python/ folder in ${asset.name}`)
  await rename(join(tmp, 'python'), join(o.root, 'python'))
  await rm(tmp, { recursive: true, force: true })
  await writeFiles(o.root, support)
  emit('extract', 1)

  const lockPath = join(o.root, 'requirements.lock')
  await writeFile(lockPath, o.lock)
  const total = Math.max(1, lockSize(o.lock))
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnv(process.env, rt.bin, o.platform),
    PIP_CACHE_DIR: join(o.root, 'pip-cache'),
    PIP_NO_COLOR: '1',
  }
  const pipArgs = [
    '-m', 'pip', 'install', '--require-hashes', '--only-binary', ':all:', '--no-deps',
    '--disable-pip-version-check', '--no-input', '--progress-bar', 'off', '--retries', '5', '--timeout', '30',
    ...(o.pipArgs ?? []), '-r', lockPath,
  ]
  let seen = 0
  emit('packages', 0)
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.python(rt.python, pipArgs, env, (l) => {
        if (/^Collecting /.test(l)) emit('packages', Math.min(0.97, ++seen / total))
      }, o.signal)
      break
    } catch (e) {
      if (e instanceof InstallCancelled || o.signal?.aborted || attempt >= 1) throw e
      seen = 0
    }
  }

  emit('verify', 0)
  const out: string[] = []
  await deps.python(rt.python, ['-I', '-c', IMPORT_CHECK], env, (l) => out.push(l), o.signal)
  if (!out.includes('runtime-ok')) throw new Error('the research runtime did not pass its import check')
  await rm(join(o.root, 'pip-cache'), { recursive: true, force: true })
  await rm(dl, { recursive: true, force: true })
  await writeFile(rt.ok, runtimeVersion(o.lock))
  emit('verify', 1)
  return rt
}

// ---- one progress stream for kernel + runtime ---------------------------------------------------

export interface PartStatus {
  state: 'checking' | 'downloading' | 'ready' | 'error'
  percent?: number
  error?: string
}
/** Share of the combined bar: the kernel zip is ~46 MB, the runtime ~140 MB but mostly pip. */
export const KERNEL_WEIGHT = 0.25

/** Merges the two parts into the one status the KernelBar shows: downloading until both are ready,
 *  an error if either failed (Retry redoes only what is missing). */
export function combineInstall(kernel: PartStatus, runtime: PartStatus): { state: PartStatus['state']; percent?: number; error?: string; phase?: 'kernel' | 'runtime' } {
  const err = kernel.state === 'error' ? kernel.error : runtime.state === 'error' ? runtime.error : undefined
  if (kernel.state === 'error' || runtime.state === 'error') return { state: 'error', error: err }
  const pct = (p: PartStatus): number => (p.state === 'ready' ? 100 : (p.percent ?? 0))
  if (kernel.state === 'ready' && runtime.state === 'ready') return { state: 'ready', percent: 100 }
  const active = kernel.state === 'downloading' || runtime.state === 'downloading'
  if (!active) return { state: 'checking' }
  const percent = Math.min(99, Math.round(KERNEL_WEIGHT * pct(kernel) + (1 - KERNEL_WEIGHT) * pct(runtime)))
  return { state: 'downloading', percent, phase: kernel.state !== 'ready' && pct(kernel) < 100 ? 'kernel' : 'runtime' }
}
