import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { NativeRequest } from '../../shared/native'
export function NativeTerminal({ id, run }: { id: string; run(request: NativeRequest): Promise<unknown> }) {
  const host = useRef<HTMLDivElement>(null),
    [error, setError] = useState('')
  useEffect(() => {
    const terminal = new Terminal({
        convertEol: false,
        fontSize: 13,
        scrollback: 10000,
        theme: { background: '#172328', foreground: '#e5eff1' },
      }),
      fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current!)
    fit.fit()
    let socket: WebSocket | undefined,
      closed = false,
      cursor = 0,
      retries = 0,
      resizeTimer: ReturnType<typeof setTimeout> | undefined,
      reconnectTimer: ReturnType<typeof setTimeout> | undefined
    const resize = () => {
      if (closed) return
      fit.fit()
      void run({ operation: 'terminalResize', input: { id, cols: terminal.cols, rows: terminal.rows } }).catch((e) => {
        if (!closed) setError(String(e))
      })
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, 120)
    })
    observer.observe(host.current!)
    async function connect() {
      try {
        const result = (await run({ operation: 'terminalConnect', input: { id } })) as { url: string }
        if (closed) return
        const url = new URL(result.url)
        url.searchParams.set('cursor', String(cursor))
        socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'
        socket.onopen = () => {
          setError('')
          resize()
          terminal.focus()
        }
        socket.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(e.data)
            if (bytes[0] === 0) {
              try {
                const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
                if (Number.isSafeInteger(meta.cursor)) cursor = meta.cursor
              } catch {}
              return
            }
            terminal.write(bytes)
            cursor += bytes.length
          } else {
            terminal.write(e.data)
            cursor += e.data.length
          }
        }
        socket.onerror = () => setError('Terminal connection interrupted.')
        socket.onclose = () => {
          if (!closed && retries++ < 3) reconnectTimer = setTimeout(() => void connect(), 1000 * retries)
          else if (!closed) setError('Terminal disconnected. Reopen it to reconnect.')
        }
      } catch (e) {
        if (!closed) setError(String(e))
      }
    }
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data)
    })
    void connect()
    return () => {
      closed = true
      clearTimeout(resizeTimer)
      clearTimeout(reconnectTimer)
      observer.disconnect()
      input.dispose()
      socket?.close()
      terminal.dispose()
    }
  }, [id, run])
  return (
    <>
      <div className="native-terminal" ref={host} />
      {error && <p role="alert">{error}</p>}
    </>
  )
}
