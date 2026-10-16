// Isolated fixture profiling only: no real accounts/projects; HTTP(S) is restricted to its local server.
// Build first, then run with Electron. PERF_SOAK_SECONDS=900 adds a 15-minute live-progress soak.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "..");
const output = process.env.PERF_OUT || fs.mkdtempSync(path.join(require("node:os").tmpdir(), "humanstudy-cpu-"));
const seconds = Number(process.env.PERF_SECONDS || 20);
const soak = Number(process.env.PERF_SOAK_SECONDS || 0);
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600 || !Number.isFinite(soak) || soak < 0 || soak > 3600) throw Error("Invalid profiling duration");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", output + "/user-data");
const samples = [], errors = [];
let phase = "startup";
let server;
let win;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (s) => win.webContents.executeJavaScript(s);
let timeout = setTimeout(() => {
  fs.writeFileSync(output + "/timeout.json", JSON.stringify({ phase, samples, errors }));
  app.exit(2);
}, (seconds * 6 + soak + 60) * 1e3);
console.log("startup");
app.whenReady().then(async () => {
  console.log("ready");
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://local");
    let file = u.pathname === "/preview/paper.pdf" ? root + "/resources/sample/KNOBE.pdf" : root + "/out/renderer" + (u.pathname === "/" ? "/index.html" : u.pathname);
    if (!file.startsWith(root + "/out/renderer/") && !file.endsWith("/resources/sample/KNOBE.pdf")) {
      res.writeHead(403).end();
      return;
    }
    try {
      let b = fs.readFileSync(file);
      const ext = path.extname(file);
      if (ext === ".html") b = Buffer.from(b.toString().replace("frame-src hsfile: data:", "frame-src 'self' hsfile: data:"));
      if (ext === ".js" && b.includes(Buffer.from("installCapture();"))) b = Buffer.from(b.toString().replace("\ninstallCapture();", "\nconst api=window.humanstudy; const old=api.kernel.onEvent;api.kernel.onEvent=(cb)=>{window.__perf.listeners.add(cb);const off=old(cb);return()=>{window.__perf.listeners.delete(cb);off()}};for(const method of ['resume','create']){const original=api.threads[method];api.threads[method]=async(...a)=>{const t=await original(...a);window.__perf.sid=t.kernelSessionId;return t}}const read=api.project.read;api.project.read=(...a)=>{window.__perf.reads++;return read(...a)};\ninstallCapture();"));
      res.setHeader("content-type", { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".pdf": "application/pdf", ".html": "text/html" }[ext] || "application/octet-stream");
      res.end(b);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log("listening", origin);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (d, done) => done({ cancel: !d.url.startsWith(origin + "/") }));
  win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadURL("about:blank");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Page.enable");
  await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `window.__perf={renders:0,reads:0,events:0,sid:null,listeners:new Set()}; const w=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'width');Object.defineProperty(HTMLCanvasElement.prototype,'width',{...w,set(v){if(this.closest('.pdf-page'))window.__perf.renders++;w.set.call(this,v)}});` });
  console.log("loading");
  await win.loadURL(origin + "/?agent=1&lang=en&sim=running");
  console.log("loaded", await js("typeof window.__perf"));
  await wait(1e3);
  await js(`document.querySelector('button.project-row').click()`);
  await wait(1e3);
  await js(`document.querySelector('.wb-compare').click()`);
  await wait(2500);
  console.log("sample opened");
  const sample = async () => {
    samples.push({ phase, metrics: app.getAppMetrics().filter((p) => p.type === "Tab").map((p) => ({ pid: p.pid, cpu: p.cpu.percentCPUUsage })) });
  };
  const run = async (name, setup) => {
    phase = name;
    if (setup) await js(setup);
    app.getAppMetrics();
    await win.webContents.debugger.sendCommand("Profiler.enable");
    await win.webContents.debugger.sendCommand("Profiler.start");
    for (let i = 0; i < seconds; i++) {
      await wait(1e3);
      await sample();
    }
    const { profile } = await win.webContents.debugger.sendCommand("Profiler.stop");
    fs.writeFileSync(output + "/" + name + ".cpuprofile", JSON.stringify(profile));
    const counts = await js(`({renders:__perf.renders,reads:__perf.reads,pages:document.querySelectorAll('.pdf-page').length,canvasSizes:[...document.querySelectorAll('.pdf-page')].map(p=>({w:p.clientWidth,h:p.clientHeight,canvas:p.querySelector('canvas').height})),sid:__perf.sid,emittedChunks:window.__n??0,lastChunkVisible:!window.__n||[...document.querySelectorAll('.msg.assistant .md')].some(el=>el.textContent.includes('Study evidence '+(window.__n-1)+' supports')),errors:document.querySelector('.part.error')?.textContent})`);
    if (name === "after-stream-idle" && !counts.lastChunkVisible) throw Error("The completed stream lost its final text");
    console.log(name, JSON.stringify(counts));
    fs.writeFileSync(output + "/" + name + ".json", JSON.stringify(counts));
  };
  await run("pdf-idle");
  await run("pdf-resize", `window.__resize=setInterval(()=>{const el=document.querySelector('.wb-content');if(el)el.style.flex='0 0 '+(35+Math.random()*30)+'%'},80)`);
  await js(`clearInterval(window.__resize)`);
  await run("after-resize-idle");
  await run("stream", `window.__n=0;window.__stream=setInterval(()=>{for(let i=0;i<5;i++){const event={sessionId:__perf.sid,type:'text',text:'Study evidence '+window.__n+++' supports the reported condition.\\n'};for(const cb of __perf.listeners)cb(event)}},25)`);
  await js(`clearInterval(window.__stream);for(const cb of __perf.listeners)cb({sessionId:__perf.sid,type:'done'})`);
  await run("after-stream-idle");
  await js(`const tabs=[...document.querySelectorAll('.wb-tab-label')];tabs.find(b=>b.textContent==='Simulation')?.click()`);
  await js(`(async()=>{const api=window.humanstudy;const snapshot=await api.project.read('/preview/knobe-2003');const flat=es=>es.flatMap(e=>e.children?flat(e.children):[e]);const file=flat(snapshot.tree).find(e=>e.rel.includes('simulations/')&&e.rel.endsWith('/progress.json')&&!e.rel.includes('example'));if(!file)throw Error('Missing simulation fixture');const progress=JSON.parse(await api.project.readText(file.path));window.__simulationTick=async()=>{progress.stage='running';progress.updatedAt=new Date().toISOString();progress.done=(progress.done+1)%progress.total;await api.project.writeText(file.path,JSON.stringify(progress))};window.__progressTimer=setInterval(window.__simulationTick,1000);await window.__simulationTick()})()`);
  await run("simulation");
  // Pausing off-screen canvases must not destroy an existing multi-page text selection.
  await js(`document.querySelectorAll('.wb-tab-label')[1].click()`);
  await wait(500);
  await js(`(() => { const first=document.querySelector('[data-page="1"] .pdf-text span');const last=document.querySelector('[data-page="2"] .pdf-text span');if(!first||!last)throw Error('Missing PDF text layers');const range=document.createRange();range.setStart(first.firstChild,0);range.setEnd(last.firstChild,last.firstChild.textContent.length);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);const pages=document.querySelector('.wb-paper .pages');pages.scrollTop=pages.scrollHeight })()`);
  await wait(800);
  const selectionPreserved = await js(`Boolean(window.getSelection().anchorNode?.isConnected && !window.getSelection().isCollapsed)`);
  if (!selectionPreserved) throw Error('Scrolling destroyed the multi-page selection');
  console.log('multi-page selection preserved', selectionPreserved);
  await js(`window.getSelection().removeAllRanges();[...document.querySelectorAll('.wb-tab-label')].find(b=>b.textContent==='Simulation').click()`);
  if (soak) {
    phase = "soak";
    console.log("soak started", soak);
    for (let i = 0; i < soak; i++) {
      await wait(1e3);
      await sample();
      if ((i + 1) % 60 === 0) {
        console.log("soak seconds", i + 1);
        fs.writeFileSync(output + "/soak-progress.json", JSON.stringify({ seconds: i + 1, samples: samples.slice(-60) }));
      }
    }
    await js(`clearInterval(window.__progressTimer)`);
  }
  const report = { secondsPerPhase: seconds, samples, errors };
  fs.writeFileSync(output + "/report.json", JSON.stringify(report, null, 2));
  clearTimeout(timeout);
  win.destroy();
  server.close();
  app.quit();
}).catch((e) => {
  console.error(e);
  fs.writeFileSync(output + "/error.json", JSON.stringify({ error: String(e), phase, errors }));
  app.exit(1);
});
