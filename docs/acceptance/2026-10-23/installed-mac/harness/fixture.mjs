// Builds a synthetic walkthrough project (no paper content): two tiny PDFs sharing one sentence,
// a CRLF + 4-space program.json with citations into both, and package fixtures.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export function makePdf(lines) {
  const esc = (s) => s.replace(/[()\\]/g, (c) => '\\' + c)
  const content = 'BT /F1 12 Tf 72 740 Td ' + lines.map((l, i) => `${i ? '0 -18 Td ' : ''}(${esc(l)}) Tj `).join('') + 'ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = []
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return pdf
}
export const SHARED = 'Participants judged the side effect as intentional in most cases.'
export const STAT = 'The effect was reliable, t(38) = 2.45, p<.001, in both samples.'
export const PKG = ['study.json', 'source/paper_metadata.json', 'source/evidence.json', 'materials/materials.json', 'task/task.json', 'task/adapter.py', 'evaluation/evaluation.py', 'audit/missing_information.json']

export function makeProject(dir, samplePath) {
  mkdirSync(join(dir, 'sources'), { recursive: true })
  writeFileSync(join(dir, 'paper.pdf'), makePdf(['DOCUMENT A ONLY first version of the paper.', SHARED, STAT]))
  writeFileSync(join(dir, 'sources/doc-b.pdf'), makePdf(['DOCUMENT B ONLY a second source.', SHARED]))
  writeFileSync(join(dir, 'paper-replacement.pdf.bin'), makePdf(['DOCUMENT C REPLACED the paper at the same path.']))
  const p = JSON.parse(readFileSync(samplePath, 'utf8'))
  p.evidence.push(
    { id: 'ev-a-shared', path: 'paper.pdf', locator: { page: 1 }, quote: SHARED, verification: 'unverified' },
    { id: 'ev-a-flip', path: 'paper.pdf', locator: { page: 1 }, quote: STAT.replace('p<.001', 'p>.001'), verification: 'unverified' },
    { id: 'ev-a-clean', path: 'paper.pdf', locator: { page: 1 }, quote: STAT, verification: 'unverified' },
    { id: 'ev-b-shared', path: 'sources/doc-b.pdf', locator: { page: 1 }, quote: SHARED, verification: 'unverified' })
  const hyp = p.nodes.find((n) => n.id === 'hypothesis'); hyp.fields[0].evidenceIds = ['ev-a-flip', 'ev-a-clean']; hyp.evidenceIds = ['ev-a-flip', 'ev-a-clean']
  const des = p.nodes.find((n) => n.id === 'design'); des.fields[0].evidenceIds = ['ev-a-shared']; des.evidenceIds = ['ev-a-shared']
  const par = p.nodes.find((n) => n.id === 'participant'); par.fields[0].evidenceIds = ['ev-b-shared']; par.evidenceIds = ['ev-b-shared']
  writeFileSync(join(dir, 'program.json'), JSON.stringify(p, null, 4).replace(/\n/g, '\r\n') + '\r\n')
  mkdirSync(join(dir, '.humanstudy'), { recursive: true })
  writeFileSync(join(dir, '.humanstudy/paper-build.json'), JSON.stringify({ status: 'complete', phase: 'checking' }))
  writeFileSync(join(dir, 'review_notes.txt'), 'Reviewer notes.\n')
  return p
}
export function incompletePackage(dir) {
  mkdirSync(join(dir, 'package/x/task'), { recursive: true })
  writeFileSync(join(dir, 'package/x/task/adapter.py'), '# placeholder only\n')
}
export function completePackage(dir, p) {
  const P = join(dir, 'package/x')
  for (const f of PKG) { mkdirSync(join(P, f, '..'), { recursive: true }); writeFileSync(join(P, f), '{}') }
  writeFileSync(join(P, 'task/adapter.py'), 'def run_sessions(llm, seed, n, arms=None):\n    return []\n')
  writeFileSync(join(P, 'evaluation/evaluation.py'), 'def evaluate(sessions):\n    return {}\n')
  writeFileSync(join(P, 'study.json'), JSON.stringify({ program: p }))
  writeFileSync(join(P, 'task/task.json'), JSON.stringify({ programBindings: { programId: p.id, stepIds: p.steps.map((s) => s.id), recordNodeIds: p.nodes.filter((n) => ['record', 'variable'].includes(n.kind)).map((n) => n.id), analysisNodeIds: p.nodes.filter((n) => n.kind === 'analysis').map((n) => n.id) } }))
}
