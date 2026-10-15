// Runs the renderer alone in a browser for design review (see src/renderer/browser-api.ts).
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), {
    // Preview only: artifact pages are served by this dev server (Electron serves them over hsfile:),
    // so let the page frame same-origin URLs. The app's own CSP is unchanged.
    name: 'preview-frame-src',
    transformIndexHtml: (html: string) => html.replace('frame-src hsfile: data:', "frame-src 'self' hsfile: data:"),
  }],
  server: { port: 5180 },
})
