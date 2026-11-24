// Keep PDFs local. Native read otherwise embeds their entire base64 bytes in every model request.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

export default async function HumanStudyPdf({ directory }: { directory: string }) {
  const root = realpathSync(directory)
  function pages(file: string): string {
    const source = realpathSync(resolve(root, file))
    const rel = relative(root, source)
    if (rel.startsWith('..' + sep) || rel === '..') throw new Error('Read project PDFs from the imported project copy.')
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex')
    const folder = join(root, '.humanstudy', 'tmp', 'pdf-pages')
    mkdirSync(folder, { recursive: true })
    const target = join(folder, hash + '.txt')
    try { readFileSync(target); return target } catch {}
    const result = spawnSync('hs-pdf', ['pages', source], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error('PDF text extraction failed. ' + (result.error?.message ?? result.stderr))
    if (!result.stdout.replace(/=== page \d+ ===/g, '').trim()) throw new Error('This PDF has no readable text. OCR is required; do not invent its contents.')
    writeFileSync(target, result.stdout, 'utf8') // Full page text, never sliced or summarized.
    return target
  }
  const attachments = new Map<string, string>()
  function attachmentPages(attachment: any): string {
    if (attachments.has(attachment.url)) return attachments.get(attachment.url)!
    let source: string
    if (attachment.url?.startsWith('data:application/pdf;base64,')) {
      const bytes = Buffer.from(attachment.url.slice('data:application/pdf;base64,'.length), 'base64')
      const hash = createHash('sha256').update(bytes).digest('hex')
      const folder = join(root, '.humanstudy', 'tmp', 'pdf-history')
      mkdirSync(folder, { recursive: true })
      source = join(folder, hash + '.pdf')
      writeFileSync(source, bytes)
    } else if (attachment.url?.startsWith('file:')) source = decodeURIComponent(new URL(attachment.url).pathname)
    else if (attachment.source?.path) source = attachment.source.path
    else throw new Error('Import this PDF into the project before building its program.')
    const target = pages(source)
    attachments.set(attachment.url, target)
    return target
  }
  const reference = (target: string) => `The complete PDF text with physical page markers is stored at ${target}. Read that file in page ranges as needed. The original PDF is unchanged; binary PDF data is not repeated in model requests.`
  return {
    'tool.execute.before': async (input: { tool: string }, output: { args: { filePath?: string } }) => {
      if (input.tool === 'read' && output.args.filePath?.toLowerCase().endsWith('.pdf')) output.args.filePath = pages(output.args.filePath)
    },
    'experimental.chat.messages.transform': async (_input: unknown, output: { messages: any[] }) => {
      // Repair outgoing context only. Persisted user messages/tool records are never edited.
      for (let index = 0; index < output.messages.length; index++) {
        const message = output.messages[index]
        output.messages[index] = { ...message, parts: (message.parts ?? []).map((part: any) => {
          if (part.type === 'file' && part.mime === 'application/pdf') return { id: part.id, sessionID: part.sessionID, messageID: part.messageID, type: 'text', text: reference(attachmentPages(part)) }
          if (part.type !== 'tool' || part.state?.status !== 'completed') return part
          const pdfs = (part.state.attachments ?? []).filter((a: any) => a.mime === 'application/pdf')
          if (!pdfs.length) return part
          return { ...part, state: { ...part.state, attachments: part.state.attachments.filter((a: any) => a.mime !== 'application/pdf'), output: `${part.state.output ?? ''}\n${pdfs.map((a: any) => reference(attachmentPages(a))).join('\n')}` } }
        }) }
      }
    },
  }
}
