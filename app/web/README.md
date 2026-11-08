# The web edition

The same app, run in a browser: the desktop **main process, renderer and preload are not changed**.
humanstudy-hub.com/try gives each signed-in user a Vercel Sandbox of their own that runs the main
process in Node, the agent kernel and the research runtime; the browser talks to it directly.

```
browser ──▶ https://<sandbox>.vercel.run
            server.cjs ── /ipc/<channel>  ─▶ ipcMain.handle(channel)   (out/main/index.js, unchanged)
                       ── /events (SSE)   ◀─ webContents.send
                       ── /hsfile/<path>  ─▶ the hsfile:// protocol handler
                       ── /upload, /download   picked files in, saved files out
            opencode (HumanStudy edition, Linux) + Python runtime, as on desktop
```

| File | Role |
|---|---|
| `electron-shim.cjs` | The `electron` module in Node: `app`, `BrowserWindow`, `ipcMain`, `dialog`, `shell`, `safeStorage`, `protocol`, `net`; dialogs never block, `shell.openExternal` opens a tab in the browser. |
| `electron-updater-shim.cjs` | No self-update: the sandbox image is updated by the launcher. |
| `server.cjs` | HTTP server around the main process: token auth (cookie after `/?t=`), IPC, a resumable event stream (`Last-Event-ID`), project files, uploads, downloads, and `/__seed`, which the launcher uses to sign the app in as the website's user. |
| `browser-electron.ts` | The `electron` module the preload (`src/preload/index.ts`) is compiled against for the browser: `ipcRenderer` over fetch/SSE, `webUtils.getPathForFile` uploads, file pickers, downloads, the "session ended" notice. |
| `image/setup.sh`, `image/start.sh` | Build the sandbox base image; start the server in it. |
| `web.test.mjs` | Server tests against the real main process with the mock kernel. |

What differs from desktop, all outside the shared code: folder pickers return nothing (projects live in
the sandbox's projects folder), "Show in Finder" does nothing, save dialogs become browser downloads,
closing the tab with unsaved edits asks through the browser, and model access for simulations uses the
key path (`relaySupported()` is macOS-only), inside the user's own sandbox.

## Build and run locally

```sh
npx electron-vite build && node scripts/build-web.mjs        # -> out/web
HS_WEB_INSECURE=1 HUMANSTUDY_KERNEL=mock PORT=5310 node out/web/server.cjs
node --test web/web.test.mjs
```

## The sandbox image

```sh
COPYFILE_DISABLE=1 tar -czf web.tgz -C out/web .
vercel sandbox create --name hs-web-img --runtime node24 --vcpus 2 --timeout 30m --non-persistent
vercel sandbox copy web.tgz hs-web-img:/vercel/sandbox/web.tgz
vercel sandbox exec hs-web-img -- bash -lc 'mkdir -p /vercel/sandbox/hs/app && tar -xzf /vercel/sandbox/web.tgz -C /vercel/sandbox/hs/app && bash /vercel/sandbox/hs/app/setup.sh hs-v1.19.0-2'
vercel sandbox snapshot hs-web-img --stop --expiration 0      # -> TRY_SNAPSHOT_ID on humanstudy-hub-web
```

`setup.sh` installs the Linux kernel from the HumanStudy-Hub/opencode release (checked against its
`SHA256SUMS.txt`; tag `hs-v1.19.0-2` is the first with Linux builds) and starts the app once so it installs
the research runtime (`PYTHON_ASSETS` has Linux entries for this). The image holds nothing user- or
install-specific.

Each user's sandbox is **persistent**: Vercel snapshots its filesystem when it stops and restores it on
the next visit, so a new image reaches only users created after it. To update everyone's app, attach the
build to a desktop release and point the launcher at it:

```sh
COPYFILE_DISABLE=1 tar -czf humanstudy-web-0.7.3.tgz -C out/web .
gh release upload v0.7.3 humanstudy-web-0.7.3.tgz            # electron-updater ignores it
# humanstudy-hub-web env: TRY_APP_URL=<asset URL>  TRY_APP_SHA256=<sha256 of the file>
```

`start.sh` installs it (checked against the digest) the next time a user's app starts; projects, account
and conversations are outside the app folder and stay.

Limits (Hobby): 45-minute sessions, 10 at a time, 5 active-CPU hours a month. A session that ends shows
"This online session has ended … Reopen"; nothing is lost.
