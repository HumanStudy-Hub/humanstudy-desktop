import { memo, useMemo } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// One parser for the app. Raw HTML in the text is shown as text (never interpreted); the output is
// sanitised again as a second line of defence.
const md = new Marked({ gfm: true, breaks: false })
md.use({
  renderer: {
    html: ({ text }) => esc(text),
    code({ text, lang }) {
      const label = (lang ?? '').trim().split(/\s+/)[0].slice(0, 24)
      return (
        `<div class="md-code"><div class="md-code-head"><span>${esc(label || 'text')}</span>` +
        `<button type="button" class="md-copy" data-copy>Copy</button></div>` +
        `<pre><code>${esc(text)}</code></pre></div>`
      )
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens)
      return `<a href="${esc(href ?? '')}" rel="noreferrer noopener">${inner}</a>`
    },
    table(token) {
      const row = (cells: typeof token.header, tag: string) =>
        '<tr>' +
        cells.map((c) => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`).join('') +
        '</tr>'
      return (
        `<div class="md-table"><table><thead>${row(token.header, 'th')}</thead><tbody>` +
        token.rows.map((r) => row(r, 'td')).join('') +
        '</tbody></table></div>'
      )
    },
  },
})

export function renderMarkdown(text: string): string {
  const html = md.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
    ADD_ATTR: ['data-copy'],
    FORBID_TAGS: ['style', 'form', 'input', 'img', 'iframe', 'script'],
  })
}

/** Copies text to the clipboard; falls back to a hidden textarea where the async API is blocked. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="md"
      onClick={(e) => {
        const el = e.target as HTMLElement
        const link = el.closest('a')
        if (link) {
          e.preventDefault()
          const href = link.getAttribute('href') ?? ''
          if (/^https?:|^mailto:/i.test(href)) window.open(href, '_blank', 'noopener')
          return
        }
        const btn = el.closest<HTMLButtonElement>('[data-copy]')
        if (btn) {
          const code = btn.closest('.md-code')?.querySelector('code')?.textContent ?? ''
          void copyText(code)
          btn.textContent = 'Copied'
          window.setTimeout(() => (btn.textContent = 'Copy'), 1400)
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})
