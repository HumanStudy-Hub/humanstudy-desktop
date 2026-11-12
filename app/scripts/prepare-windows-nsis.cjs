// Backport electron-builder #9769 until the pinned builder ships the bounded copy.
// Stage the templates so concurrent builds sharing node_modules are unaffected.
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const nsis = require('app-builder-lib/out/targets/nsis/nsisUtil')

const template = 'multiUser.nsh'
const original = readFileSync(join(nsis.nsisTemplatesDir, template), 'utf8').replace(/\r\n/g, '\n')
if (!original.includes('KERNEL32::lstrcpynW')) {
  const old = /^      System::Store S\n(?:(?!      System::Store L\n)[\s\S])*?      System::Store L\n/gm
  const matches = [...original.matchAll(old)]
  if (matches.length !== 1 || !matches[0][0].includes('SHGetKnownFolderPath') || !matches[0][0].includes('&w${NSIS_MAX_STRLEN}')) {
    throw Error('The pinned NSIS install-path template changed. Review the electron-builder #9769 backport.')
  }
  const boundedCopy = [
    '      Push $1',
    '      Push $2',
    '      StrCpy $2 0',
    `      System::Call 'SHELL32::SHGetKnownFolderPath(g "\${FOLDERID_UserProgramFiles}", i \${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'`,
    '      ${if} $1 == 0',
    `        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i \${NSIS_MAX_STRLEN})p'`,
    '      ${endif}',
    '      ${if} $2 != 0',
    `        System::Call 'OLE32::CoTaskMemFree(p r2)'`,
    '      ${endif}',
    '      Pop $2',
    '      Pop $1',
    '',
  ].join('\n')
  const scratch = mkdtempSync(join(tmpdir(), 'humanstudy-nsis-'))
  process.once('exit', () => rmSync(scratch, { force: true, recursive: true }))
  cpSync(nsis.nsisTemplatesDir, scratch, { recursive: true })
  writeFileSync(join(scratch, template), original.replace(old, () => boundedCopy), 'utf8')
  nsis.nsisTemplatesDir = scratch
}
