/*! hs-kit.js 1.0.0 — HumanStudy Hub artifact kit (MIT). Offline, no dependencies.
 * Components for research views of a Human Program: participant flow, condition comparison,
 * reported vs simulated results, attrition, stat tiles, citation and missing chips.
 * Every program item it draws carries data-program-id and data-page; a click asks the app to
 * open the cited page (postMessage {type:'hs.openSource'}), [data-ask] elements send {type:'hs.ask'}. */
(function () {
  'use strict'
  var SVGNS = 'http://www.w3.org/2000/svg'
  var HS = { version: '1.0.0' }

  // ---------- language ----------
  var L = {
    en: {
      orderNotStated: 'Order not stated in the paper', noSource: 'no source', notReported: 'not reported',
      spreadNotReported: 'Spread not reported in the paper', sim: 'Simulation — not human data', human: 'Human (reported)',
      simulated: 'Simulated', conditions: 'Conditions', steps: 'Steps', openQuestions: 'Open questions',
      shared: 'Shared by all conditions', repeat: 'repeat', subSteps: 'sub-steps', ci: '95% CI', sd: '±1 SD',
      se: '±1 SE', bars: 'Bars show means', whiskers: 'whiskers', participants: 'Participants', procedure: 'Procedure',
      flowCaption: 'Arrows only where the paper states the order.', diffCaption: 'Highlighted words differ between conditions.',
      noConditions: 'The program states no experimental conditions for this study.', noSteps: 'No procedure steps recorded.',
      drop: 'lost', perCondition: 'per condition', sample: 'Sample', none: 'None recorded', blocking: 'blocking',
      decision: 'decision', check: 'check', ask: 'Ask the agent', unknownId: 'unknown id', simSpread: 'Dots: individual simulated sessions',
      run: 'Run', value: 'Value', estimate: 'Estimate', noSpread: 'no spread', inConditions: 'in {n} conditions'
    },
    zh: {
      orderNotStated: '论文未说明顺序', noSource: '无出处', notReported: '未报告', spreadNotReported: '未报告离散度',
      sim: '模拟 — 非真人数据', human: '人类（论文报告）', simulated: '模拟', conditions: '实验条件', steps: '步骤',
      openQuestions: '待确认问题', shared: '各条件共有', repeat: '重复', subSteps: '个子步骤', ci: '95% 置信区间',
      sd: '±1 标准差', se: '±1 标准误', bars: '柱为均值', whiskers: '误差线', participants: '被试', procedure: '流程',
      flowCaption: '仅在论文说明顺序处画箭头。', diffCaption: '高亮词为条件间的差异。', noConditions: '本研究在程序中没有实验条件。',
      noSteps: '尚未记录流程步骤。', drop: '流失', perCondition: '每条件', sample: '样本', none: '无', blocking: '阻塞',
      decision: '待决定', check: '待核对', ask: '询问助手', unknownId: '未知 id', simSpread: '点：单次模拟会话',
      run: '运行', value: '数值', estimate: '估计值', noSpread: '无离散度', inConditions: '{n} 个条件'
    }
  }
  function lang() {
    var l = (document.documentElement.getAttribute('lang') || navigator.language || 'en').toLowerCase()
    return l.indexOf('zh') === 0 ? 'zh' : 'en'
  }
  HS.t = function (k) { return (L[lang()] || L.en)[k] || L.en[k] || k }

  // A script error in the artifact shows up in the page instead of a silent blank view.
  window.addEventListener('error', function (e) {
    try {
      var box = document.createElement('div'); box.className = 'hs-error'
      box.textContent = 'Script error in this view: ' + (e.message || 'unknown') + (e.lineno ? ' (line ' + e.lineno + ')' : '')
      ;(document.body || document.documentElement).insertBefore(box, (document.body || document.documentElement).firstChild)
    } catch (x) { /* nothing more to do */ }
  })

  // ---------- utilities ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  HS.esc = esc
  function $(el) { return typeof el === 'string' ? document.querySelector(el) : el }
  function svg(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag)
    for (var k in attrs || {}) if (attrs[k] != null) n.setAttribute(k, attrs[k])
    if (parent) parent.appendChild(n)
    return n
  }
  function text(parent, x, y, s, cls, anchor) {
    var n = svg('text', { x: x, y: y, class: cls || 'hs-t', 'text-anchor': anchor || 'start' }, parent)
    n.textContent = s
    return n
  }
  function fail(el, msg) {
    if (el) el.innerHTML = '<div class="hs-error">' + esc(msg) + '</div>'
    if (window.console) console.error('[hs-kit] ' + msg)
  }
  var measureCtx = null
  function textWidth(s, px, weight) {
    if (!measureCtx) {
      try { measureCtx = document.createElement('canvas').getContext('2d') } catch (e) { measureCtx = null }
    }
    if (!measureCtx) return String(s).length * px * 0.56
    measureCtx.font = (weight || 400) + ' ' + px + 'px ' + getComputedStyle(document.body).fontFamily
    return measureCtx.measureText(s).width
  }
  /** Greedy word wrap (CJK-aware) into at most maxLines lines; the last line gets an ellipsis if cut. */
  function wrap(s, width, px, maxLines, weight) {
    var tokens = String(s).match(/[　-鿿＀-￯]|[^\s　-鿿＀-￯]+|\s+/g) || []
    var lines = [], cur = ''
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i]
      if (/^\s+$/.test(tk)) { if (cur) cur += ' '; continue }
      var next = cur + tk
      if (cur && textWidth(next.trim(), px, weight) > width) { lines.push(cur.trim()); cur = tk } else cur = next
    }
    if (cur.trim()) lines.push(cur.trim())
    if (maxLines && lines.length > maxLines) {
      lines = lines.slice(0, maxLines)
      var last = lines[maxLines - 1]
      while (last.length > 1 && textWidth(last + '…', px, weight) > width) last = last.slice(0, -1)
      lines[maxLines - 1] = last.replace(/\s+$/, '') + '…'
    }
    return lines
  }
  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v
    if (typeof v === 'string') { var m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null }
    return null
  }
  function fmt(v, d) {
    if (v == null || !isFinite(v)) return ''
    if (d == null) d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2
    return Number(v).toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  }
  function niceTicks(lo, hi, count) {
    var span = hi - lo || 1, step = Math.pow(10, Math.floor(Math.log10(span / count)))
    var err = span / count / step
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1
    var out = [], t0 = Math.floor(lo / step) * step
    for (var t = t0; t <= hi + step * 1e-9; t += step) out.push(+t.toFixed(10))
    return out
  }

  // ---------- program lookup (inline.py embeds program.json as #hs-program) ----------
  HS.program = null
  try {
    var tag = document.getElementById('hs-program')
    if (tag) HS.program = JSON.parse(tag.textContent)
  } catch (e) { HS.program = null }
  var P = HS.program || { nodes: [], steps: [], evidence: [], issues: [], studies: [] }
  function byId(list) { var m = {}; (list || []).forEach(function (x) { m[x.id] = x }); return m }
  var NODES = byId(P.nodes), STEPS = byId(P.steps), EVID = byId(P.evidence), STUDIES = byId(P.studies)
  HS.node = function (id) { return NODES[id] || null }
  HS.step = function (id) { return STEPS[id] || null }
  HS.studies = function () { return (P.studies || []).slice() }
  HS.field = function (nodeId, fieldId) {
    var n = NODES[nodeId]
    return n && (n.fields || []).filter(function (f) { return f.id === fieldId })[0] || null
  }
  /** The item behind an id: a node, a step, "node/field", or an evidence record. */
  HS.item = function (id) {
    if (!id) return null
    if (id.indexOf('/') > 0) { var p = id.split('/'); return HS.field(p[0], p[1]) }
    return NODES[id] || STEPS[id] || EVID[id] || null
  }
  /** The first cited evidence of an item (or of a list of evidence ids): {page, quote, file}. */
  HS.source = function (idOrEvidence) {
    var ids = Array.isArray(idOrEvidence) ? idOrEvidence : null
    if (!ids) {
      var it = HS.item(idOrEvidence)
      if (!it) return null
      if (it.locator) return { page: it.locator.page, quote: it.quote || '', file: it.path || null, evidenceId: it.id }
      ids = it.evidenceIds || []
    }
    for (var i = 0; i < ids.length; i++) {
      var e = EVID[ids[i]]
      if (e && e.locator && e.locator.page) return { page: e.locator.page, quote: e.quote || '', file: e.path || null, evidenceId: e.id }
    }
    return null
  }
  HS.pageOf = function (id) { var s = HS.source(id); return s ? s.page : null }
  function issuesFor(pred) { return (P.issues || []).filter(pred) }
  /** True when the item (or a field of it) is missing/decision/check or an issue names it. */
  HS.isOpen = function (id) {
    var it = HS.item(id)
    if (!it) return false
    if (it.state && it.state !== 'confirmed') return true
    if (it.rule && it.rule.state && it.rule.state !== 'confirmed') return true
    if ((it.fields || []).some(function (f) { return f.state === 'missing' || f.state === 'decision' })) return true
    return issuesFor(function (x) { return x.nodeId === id || x.stepId === id }).length > 0
  }

  // ---------- chips ----------
  /** A citation chip: HS.cite(5) → "p. 5"; HS.cite(5, {quote, id, file}). No page → grey "no source". */
  HS.cite = function (page, o) {
    o = o || {}
    if (page == null || page === '') return '<span class="hs-cite hs-nosource">' + esc(HS.t('noSource')) + '</span>'
    return '<button type="button" class="hs-cite" data-page="' + esc(page) + '"' +
      (o.quote ? ' data-quote="' + esc(o.quote) + '" data-tip="' + esc('“' + o.quote + '”') + '"' : '') +
      (o.id ? ' data-program-id="' + esc(o.id) + '"' : '') + (o.file ? ' data-file="' + esc(o.file) + '"' : '') +
      '>p. ' + esc(page) + '</button>'
  }
  /** Citation chip for a program id, resolved from its evidence. */
  HS.citeId = function (id) {
    var s = HS.source(id)
    return HS.cite(s && s.page, { quote: s && s.quote, id: id, file: s && s.file })
  }
  HS.missing = function (label) { return '<span class="hs-chip hs-missing">' + esc(label || HS.t('notReported')) + '</span>' }
  HS.simLabel = function () { return '<span class="hs-chip hs-simlabel">' + esc(HS.t('sim')) + '</span>' }
  HS.tag = function (label) { return '<span class="hs-chip hs-tag">' + esc(label) + '</span>' }
  HS.askButton = function (label, prompt) {
    return '<button type="button" class="hs-ask" data-ask="' + esc(prompt) + '">' + esc(label || HS.t('ask')) + '</button>'
  }

  // ---------- bridge to the app ----------
  function post(msg) { try { window.parent.postMessage(msg, '*') } catch (e) { /* standalone file */ } }
  HS.openSource = function (page, quote, programId, file) {
    var m = { type: 'hs.openSource' }
    if (page != null && page !== '') m.page = parseInt(page, 10)
    if (quote) m.quote = String(quote).slice(0, 2000)
    if (programId) m.programId = String(programId)
    if (file) m.file = String(file)
    post(m)
  }
  HS.ask = function (text) { if (text) post({ type: 'hs.ask', text: String(text).slice(0, 4000) }) }
  document.addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.closest) return
    var a = t.closest('[data-ask]')
    if (a) { e.preventDefault(); HS.ask(a.getAttribute('data-ask')); return }
    var el = t.closest('.hs-cite,[data-page],[data-program-id]')
    if (!el || el.classList.contains('hs-nosource')) return
    var holder = el.hasAttribute('data-program-id') ? el : el.parentElement && el.parentElement.closest('[data-program-id]')
    var pid = holder && holder.getAttribute('data-program-id')
    var page = el.getAttribute('data-page') || (holder && holder.getAttribute('data-page'))
    var quote = el.getAttribute('data-quote') || (holder && holder.getAttribute('data-quote'))
    var file = el.getAttribute('data-file') || (holder && holder.getAttribute('data-file'))
    if (!page && pid) { var s = HS.source(pid); if (s) { page = s.page; quote = quote || s.quote; file = file || s.file } }
    e.preventDefault()
    HS.openSource(page, quote, pid, file)
  })
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('g[data-program-id],[data-ask][tabindex]')) {
      e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
  })
  // Tooltips for [data-tip]
  var tip = null
  function showTip(e) {
    var el = e.target && e.target.closest && e.target.closest('[data-tip]')
    if (!el) { if (tip) tip.classList.remove('on'); return }
    if (!tip) { tip = document.createElement('div'); tip.className = 'hs-tip'; document.body.appendChild(tip) }
    tip.textContent = el.getAttribute('data-tip')
    var x = Math.min(e.clientX + 12, window.innerWidth - 370), y = e.clientY + 14
    if (y > window.innerHeight - 80) y = e.clientY - 60
    tip.style.left = Math.max(6, x) + 'px'; tip.style.top = y + 'px'; tip.classList.add('on')
  }
  document.addEventListener('mousemove', showTip)
  document.addEventListener('mouseleave', function () { if (tip) tip.classList.remove('on') })

  function attrsFor(id, page, quote) {
    var a = {}
    if (id) a['data-program-id'] = id
    if (page != null) a['data-page'] = page
    if (quote) a['data-quote'] = quote
    return a
  }
  /** SVG citation pill at (x, y) right-aligned; returns its width. */
  function svgCite(g, xRight, y, page, amber) {
    var label = page != null ? 'p. ' + page : HS.t('noSource')
    var w = textWidth(label, 11, 600) + 12
    svg('rect', { x: xRight - w, y: y - 12, width: w, height: 17, rx: 8.5, class: page != null ? 'hs-citebg' : '', fill: page != null ? null : 'none' }, g)
    text(g, xRight - w / 2, y, label, page != null ? 'hs-t-cite' : (amber ? 'hs-t-amber' : 'hs-t-muted'), 'middle')
    return w
  }
  function defs(root) {
    var d = svg('defs', {}, root)
    var m = svg('marker', { id: 'hs-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, d)
    svg('path', { d: 'M0,0 L10,5 L0,10 z', class: 'hs-arrowhead' }, m)
    var p = svg('pattern', { id: 'hs-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, d)
    svg('rect', { width: 6, height: 6, class: 'hs-hatch-bg' }, p)
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hs-hatch-line' }, p)
    return d
  }

  // ---------- stat tiles ----------
  /** HS.stats(el, [{label, value, page, id, quote, missing}]) */
  HS.stats = function (el, items) {
    el = $(el)
    if (!el) return
    el.classList.add('hs-stats')
    el.innerHTML = (items || []).map(function (it) {
      var src = it.page != null ? { page: it.page, quote: it.quote } : it.id ? HS.source(it.id) : null
      var miss = it.missing || it.value == null || it.value === ''
      var v = miss ? HS.t('notReported') : String(it.value)
      return '<div class="hs-stat' + (miss ? ' hs-amber' : '') + '"' + (it.id ? ' data-program-id="' + esc(it.id) + '"' : '') +
        (src && src.page != null ? ' data-page="' + esc(src.page) + '"' : '') + (it.tip ? ' data-tip="' + esc(it.tip) + '"' : '') + '>' +
        '<div class="hs-stat-label">' + esc(it.label) + '</div>' +
        '<div class="hs-stat-value' + (v.length > 12 ? ' hs-long' : '') + '">' + esc(v) + '</div>' +
        (it.note ? '<div class="hs-stat-note">' + esc(it.note) + '</div>' : '') +
        (it.cite === false || (miss && !src) ? '' : HS.cite(src && src.page, { quote: src && src.quote, id: it.id })) + '</div>'
    }).join('')
  }

  // ---------- participant / procedure flow ----------
  function flowFromProgram(study) {
    return (P.steps || []).filter(function (s) { return !study || s.studyId === study }).map(function (s) {
      var src = HS.source(s.id)
      return {
        id: s.id, title: s.title, next: (s.next || []).map(function (n) { return { to: n.to, when: n.when } }),
        actor: (s.actorIds || []).map(function (a) { return NODES[a] ? NODES[a].title : a }).join(', '),
        conditions: (s.conditionIds || []).map(function (c) { return NODES[c] ? NODES[c].title : c }),
        page: src && src.page, quote: src && src.quote, open: HS.isOpen(s.id), kind: s.kind, children: (s.children || []).length
      }
    })
  }
  /** HS.flow(el, {study}) from the embedded program, or {steps:[{id,title,next:[id|{to,when}],actor,page,open}]}. */
  HS.flow = function (el, o) {
    el = $(el); o = o || {}
    if (!el) return
    var steps = o.steps ? o.steps.map(function (s) {
      var src = s.page != null ? null : HS.source(s.id)
      return {
        id: s.id, title: s.title || (STEPS[s.id] && STEPS[s.id].title) || s.id,
        next: (s.next || []).map(function (n) { return typeof n === 'string' ? { to: n } : n }),
        actor: s.actor || '', conditions: s.conditions || [], page: s.page != null ? s.page : src && src.page,
        quote: s.quote || (src && src.quote), open: s.open != null ? s.open : HS.isOpen(s.id), children: s.children || 0
      }
    }) : flowFromProgram(o.study)
    if (!steps.length) { el.innerHTML = '<p class="hs-note">' + esc(HS.t('noSteps')) + '</p>'; return }
    var by = {}; steps.forEach(function (s, i) { s.i = i; by[s.id] = s })
    var edges = []
    steps.forEach(function (s) { s.next.forEach(function (n) { if (by[n.to] && n.to !== s.id) edges.push({ from: s.id, to: n.to, when: n.when }) }) })
    var linked = {}; edges.forEach(function (e) { linked[e.from] = linked[e.to] = true })
    var conn = steps.filter(function (s) { return linked[s.id] }), loose = steps.filter(function (s) { return !linked[s.id] })
    // back edges (loops) by DFS from roots in document order
    var indeg = {}; edges.forEach(function (e) { indeg[e.to] = (indeg[e.to] || 0) + 1 })
    var state = {}, back = {}
    function dfs(id) {
      state[id] = 1
      edges.forEach(function (e, k) {
        if (e.from !== id) return
        if (state[e.to] === 1) back[k] = true
        else if (!state[e.to]) dfs(e.to)
      })
      state[id] = 2
    }
    conn.forEach(function (s) { if (!indeg[s.id]) dfs(s.id) })
    conn.forEach(function (s) { if (!state[s.id]) dfs(s.id) })
    var layer = {}; conn.forEach(function (s) { layer[s.id] = 0 })
    for (var pass = 0; pass < conn.length; pass++) {
      var changed = false
      edges.forEach(function (e, k) { if (!back[k] && layer[e.to] < layer[e.from] + 1) { layer[e.to] = layer[e.from] + 1; changed = true } })
      if (!changed) break
    }
    var W = o.boxWidth || 250, GX = 28, GY = 46, PAD = 14
    var layers = []
    conn.forEach(function (s) { (layers[layer[s.id]] = layers[layer[s.id]] || []).push(s) })
    // measure boxes
    function measure(s) {
      s.lines = wrap(s.title, W - 24, 13, 4, 500)
      var metas = [s.actor, s.conditions.length ? (s.conditions.length === 1 ? s.conditions[0] : HS.t('inConditions').replace('{n}', s.conditions.length)) : '', s.children ? s.children + ' ' + HS.t('subSteps') : ''].filter(Boolean)
      s.meta = metas.join('\n')
      s.metaLines = []
      metas.forEach(function (m) { s.metaLines = s.metaLines.concat(wrap(m, W - 76, 12, 1)) })
      s.h = 14 + s.lines.length * 18 + Math.max(1, s.metaLines.length) * 16 + 10
    }
    steps.forEach(measure)
    // order within a layer by parent position
    var xpos = {}
    var maxCount = Math.max.apply(null, layers.map(function (l) { return l ? l.length : 0 }).concat([0]))
    var width = Math.max(maxCount * W + (maxCount - 1) * GX, W) + PAD * 2
    var y = PAD, root = svg('svg', { role: 'img', 'aria-label': HS.t('procedure') })
    defs(root)
    var gEdges = svg('g', {}, root), gNodes = svg('g', {}, root)
    var pos = {}
    var hasBack = Object.keys(back).length > 0
    if (hasBack) width += 60
    layers.forEach(function (ls) {
      if (!ls) return
      ls.sort(function (a, b) {
        function bc(s) { var xs = edges.filter(function (e) { return e.to === s.id && xpos[e.from] != null }).map(function (e) { return xpos[e.from] }); return xs.length ? xs.reduce(function (p, c) { return p + c }, 0) / xs.length : s.i * 1e-3 }
        return bc(a) - bc(b) || a.i - b.i
      })
      var rowW = ls.length * W + (ls.length - 1) * GX, x0 = (width - (hasBack ? 60 : 0) - rowW) / 2
      var hMax = Math.max.apply(null, ls.map(function (s) { return s.h }))
      ls.forEach(function (s, k) { pos[s.id] = { x: x0 + k * (W + GX), y: y, h: s.h }; xpos[s.id] = x0 + k * (W + GX) })
      y += hMax + GY
    })
    function drawBox(s, x, yy) {
      var g = svg('g', attrsFor(s.id, s.page, s.quote), gNodes)
      g.setAttribute('tabindex', '0')
      g.setAttribute('data-tip', s.title + (s.open ? ' — ' + HS.t('check') : ''))
      svg('rect', { x: x, y: yy, width: W, height: s.h, rx: 9, class: 'hs-box' + (s.open ? ' hs-box-amber' : '') }, g)
      s.lines.forEach(function (ln, k) { text(g, x + 12, yy + 22 + k * 18, ln, 'hs-t') })
      var my = yy + 14 + s.lines.length * 18 + 12
      s.metaLines.forEach(function (ln, k) { text(g, x + 12, my + k * 16, ln, 'hs-t-muted') })
      svgCite(g, x + W - 8, my + (s.metaLines.length ? (s.metaLines.length - 1) * 16 : 0), s.page, s.open)
      if (s.open && !s.metaLines.length) text(g, x + 12, my, '● ' + HS.t('check'), 'hs-t-amber')
      return g
    }
    conn.forEach(function (s) { drawBox(s, pos[s.id].x, pos[s.id].y) })
    edges.forEach(function (e, k) {
      var a = pos[e.from], b = pos[e.to]
      var d
      if (back[k]) {
        var xr = Math.max(a.x, b.x) + W, x1 = a.x + W, y1 = a.y + a.h / 2, x2 = b.x + W, y2 = b.y + b.h / 2
        d = 'M' + x1 + ',' + y1 + ' C' + (xr + 50) + ',' + y1 + ' ' + (xr + 50) + ',' + y2 + ' ' + (x2 + 2) + ',' + y2
        svg('path', { d: d, class: 'hs-edge', 'marker-end': 'url(#hs-arrow)' }, gEdges)
        text(gEdges, xr + 40, (y1 + y2) / 2, '↺ ' + HS.t('repeat'), 'hs-t-muted', 'middle')
      } else {
        var sx = a.x + W / 2, sy = a.y + a.h, tx = b.x + W / 2, ty = b.y - 2
        d = 'M' + sx + ',' + sy + ' C' + sx + ',' + (sy + GY * 0.6) + ' ' + tx + ',' + (ty - GY * 0.6) + ' ' + tx + ',' + ty
        svg('path', { d: d, class: 'hs-edge', 'marker-end': 'url(#hs-arrow)' }, gEdges)
        if (e.when) {
          var lbl = wrap(e.when, 150, 11.5, 1)[0], t = text(gEdges, (sx + tx) / 2 + 6, (sy + ty) / 2 + 4, lbl, 'hs-t-muted', 'start')
          t.setAttribute('data-tip', e.when)
        }
      }
    })
    if (!conn.length) y = PAD
    var html = ''
    var height = y - (conn.length ? GY : 0) + PAD
    root.setAttribute('viewBox', '0 0 ' + width + ' ' + Math.max(height, 10))
    root.setAttribute('width', width)
    el.innerHTML = ''
    var fig = document.createElement('div')
    fig.className = 'hs-figure'
    if (conn.length) fig.appendChild(root)
    if (loose.length) {
      // steps with no stated order: cards in a row separated by "·", never arrows
      var row = document.createElement('div')
      row.innerHTML = (conn.length ? '<p class="hs-note">' + esc(HS.t('orderNotStated')) + ':</p>' : '') + '<div class="hs-unordered"></div>'
      fig.appendChild(row)
      var holder = row.querySelector('.hs-unordered')
      loose.forEach(function (s, k) {
        if (k) { var dot = document.createElement('span'); dot.className = 'hs-dotsep'; dot.textContent = '·'; holder.appendChild(dot) }
        var r = svg('svg', { width: W, viewBox: '0 0 ' + (W + 2) + ' ' + (s.h + 2) })
        defs(r)
        var saved = gNodes; gNodes = r; drawBox(s, 1, 1); gNodes = saved
        holder.appendChild(r)
      })
    }
    var cap = document.createElement('p')
    cap.className = 'hs-caption'
    cap.textContent = (loose.length > 1 && !conn.length ? HS.t('orderNotStated') + '. ' : '') + HS.t('flowCaption')
    fig.appendChild(cap)
    el.appendChild(fig)
    void html
  }

  // ---------- condition comparison with word diff ----------
  function tokens(v) { return String(v).match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [] }
  /** Marks the words of `text` that are not in `reference` (LCS over words). */
  HS.wordDiff = function (textValue, reference) {
    var a = tokens(textValue), b = tokens(reference)
    if (a.length * b.length > 250000) return [{ text: textValue, changed: false }]
    var n = a.length, m = b.length, lcs = []
    for (var i0 = 0; i0 <= n; i0++) lcs.push(new Uint16Array(m + 1))
    for (var i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    var out = []
    function push(t, ch) { var mark = ch && Boolean(t.trim()), last = out[out.length - 1]; if (last && last.changed === mark) last.text += t; else out.push({ text: t, changed: mark }) }
    i = 0; j = 0
    while (i < n) { if (j < m && a[i] === b[j]) { push(a[i], false); i++; j++ } else if (j < m && lcs[i][j + 1] >= lcs[i + 1][j]) j++; else { push(a[i], true); i++ } }
    var words = function (v) { return v.split(/\s+/).filter(Boolean).length }
    var marked = out.filter(function (p) { return p.changed }).reduce(function (s, p) { return s + words(p.text) }, 0)
    if (marked / Math.max(1, words(textValue)) > 0.6) return [{ text: textValue, changed: false }]
    return out
  }
  function conditionsFromProgram(study) {
    return (P.nodes || []).filter(function (n) { return n.kind === 'condition' && (!study || (n.studyIds || []).indexOf(study) >= 0) }).map(function (c) {
      var mats = (P.nodes || []).filter(function (n) { return n.kind === 'material' && (n.conditionIds || []).indexOf(c.id) >= 0 })
      var verb = []
      mats.forEach(function (mn) { (mn.fields || []).forEach(function (f) { if (f.origin === 'verbatim' && typeof f.value === 'string') verb.push(f.value) }) })
      var src = HS.source(c.id)
      var fields = (c.fields || []).map(function (f) { return { id: c.id + '/' + f.id, label: f.label, value: typeof f.value === 'string' ? f.value : JSON.stringify(f.value), state: f.state } })
      return { id: c.id, title: c.title, text: verb.join('\n\n'), fields: fields, page: src && src.page, quote: src && src.quote, open: HS.isOpen(c.id) }
    })
  }
  /** HS.conditions(el, {study}) or {conditions:[{id,title,text,page,quote,open,meta}], shared:{text,page,id}}.
   *  `text` must be the verbatim material for that condition; differing words are highlighted. */
  HS.conditions = function (el, o) {
    el = $(el); o = o || {}
    if (!el) return
    var cs = o.conditions ? o.conditions.map(function (c) {
      var src = c.page != null ? null : HS.source(c.id)
      return { id: c.id, title: c.title || (NODES[c.id] && NODES[c.id].title) || c.id, text: c.text || '', fields: c.fields || [], meta: c.meta, page: c.page != null ? c.page : src && src.page, quote: c.quote || (src && src.quote), open: c.open != null ? c.open : HS.isOpen(c.id), missing: c.missing }
    }) : conditionsFromProgram(o.study)
    if (!cs.length) { el.innerHTML = '<p class="hs-note">' + esc(HS.t('noConditions')) + '</p>'; return }
    // A field with the same value in every condition is not a difference: show it once above the columns.
    var sharedFields = []
    if (cs.length > 1) {
      ;(cs[0].fields || []).forEach(function (f) {
        var key = f.id.split('/').pop()
        var same = cs.every(function (c) { return (c.fields || []).some(function (g) { return g.id.split('/').pop() === key && g.value === f.value && g.state === f.state }) })
        if (same) sharedFields.push(f)
      })
      if (sharedFields.length) cs.forEach(function (c) { c.fields = (c.fields || []).filter(function (g) { return !sharedFields.some(function (f) { return f.id.split('/').pop() === g.id.split('/').pop() }) }) })
    }
    var html = ''
    if (sharedFields.length) {
      html += '<p class="hs-cond-meta hs-cond-shared">' + esc(HS.t('shared')) + ': ' + sharedFields.map(function (f) {
        return '<span data-program-id="' + esc(f.id) + '"><b>' + esc(f.label) + ':</b> ' + esc(f.value) + (f.state && f.state !== 'confirmed' ? ' ' + HS.missing(HS.t(f.state === 'missing' ? 'notReported' : f.state)) : '') + '</span>'
      }).join('; ') + '</p>'
    }
    if (o.shared && o.shared.text) {
      html += '<div class="hs-card hs-cond-shared"' + (o.shared.id ? ' data-program-id="' + esc(o.shared.id) + '"' : '') + '><div class="hs-cond-meta">' + esc(HS.t('shared')) + ' ' + HS.cite(o.shared.page, { quote: o.shared.quote }) + '</div><div class="hs-verbatim">' + esc(o.shared.text) + '</div></div>'
    }
    html += '<div class="hs-cond-grid">'
    cs.forEach(function (c, i) {
      var ref = cs.length > 1 ? cs[i === 0 ? 1 : 0].text : ''
      var body = ''
      if (c.text) {
        body = '<div class="hs-verbatim">' + (ref ? HS.wordDiff(c.text, ref).map(function (p) { return p.changed ? '<mark>' + esc(p.text) + '</mark>' : esc(p.text) }).join('') : esc(c.text)) + '</div>'
      } else if (c.missing) {
        body = HS.missing(typeof c.missing === 'string' ? c.missing : HS.t('notReported'))
      }
      var fieldsHtml = (c.fields || []).map(function (f) {
        var amber = f.state && f.state !== 'confirmed'
        return '<div class="hs-cond-meta' + (amber ? ' hs-amber' : '') + '" data-program-id="' + esc(f.id) + '"' + (amber ? ' style="padding:4px 6px;border:1px solid;border-radius:6px"' : '') + '><b>' + esc(f.label) + ':</b> ' + esc(f.value) + (amber ? ' ' + HS.missing(HS.t(f.state === 'missing' ? 'notReported' : f.state)) : '') + '</div>'
      }).join('')
      html += '<section class="hs-cond' + (c.open ? ' hs-amber' : '') + '" data-program-id="' + esc(c.id) + '"' + (c.page != null ? ' data-page="' + esc(c.page) + '"' : '') + '>' +
        '<h3><span>' + esc(c.title) + '</span>' + HS.cite(c.page, { quote: c.quote, id: c.id }) + '</h3>' +
        (c.meta ? '<div class="hs-cond-meta">' + esc(c.meta) + '</div>' : '') + body + fieldsHtml + '</section>'
    })
    html += '</div>'
    var anyDiff = cs.length > 1 && cs.some(function (c) { return c.text })
    html += anyDiff ? '<p class="hs-caption">' + esc(HS.t('diffCaption')) + '</p>' : ''
    el.innerHTML = html
  }

  // ---------- reported vs simulated results ----------
  function summarize(v) {
    if (!v) return null
    var r = { mean: num(v.mean), sd: num(v.sd), se: num(v.se), ci: v.ci && v.ci.length === 2 ? [num(v.ci[0]), num(v.ci[1])] : null, n: num(v.n), page: v.page, quote: v.quote, id: v.id, values: v.values, label: v.label, spread: v.spread }
    if (Array.isArray(v.values) && v.values.length) {
      var xs = v.values.map(num).filter(function (x) { return x != null })
      var n = xs.length, mean = xs.reduce(function (a, b) { return a + b }, 0) / n
      var sd = n > 1 ? Math.sqrt(xs.reduce(function (a, b) { return a + (b - mean) * (b - mean) }, 0) / (n - 1)) : 0
      if (r.mean == null) r.mean = mean
      if (r.sd == null) r.sd = sd
      if (r.n == null) r.n = n
      if (!r.ci && n > 1) r.ci = [mean - 1.96 * sd / Math.sqrt(n), mean + 1.96 * sd / Math.sqrt(n)]
      r.values = xs
    }
    if (r.ci) { r.lo = r.ci[0]; r.hi = r.ci[1]; r.kind = 'ci' } else if (r.se != null) { r.lo = r.mean - r.se; r.hi = r.mean + r.se; r.kind = 'se' } else if (r.sd != null) { r.lo = r.mean - r.sd; r.hi = r.mean + r.sd; r.kind = 'sd' }
    return r
  }
  var SERIES = ['--hs-human', '--hs-s2', '--hs-s3', '--hs-s4']
  /** HS.results(el, {yLabel, unit, yMin, yMax, decimals, reference:{value,label}, caption, groups:[...]})
   *  A group is either {label, id, page, human:{mean, sd|se|ci, n, page}, sim:{mean|values, sd|se|ci, n}}
   *  (human vs simulated) or {label, id, page, bars:[{label, mean, sd|se|ci, n, page, id, sim}]}
   *  (several reported series per group, e.g. the rater's own choice; same bar labels across groups
   *  share a colour). Human bars are solid with p. N chips; simulated bars are hatched and labelled
   *  "Simulation — not human data"; spread is drawn only when reported. */
  HS.results = function (el, o) {
    el = $(el); o = o || {}
    if (!el) return
    var groups = (o.groups || []).map(function (g) {
      var bars = []
      if (Array.isArray(g.bars)) g.bars.forEach(function (b) { bars.push({ series: b.label || '', sim: !!b.sim, v: summarize(b) }) })
      else {
        if (g.human !== undefined) bars.push({ series: o.humanLabel || HS.t('human'), sim: false, v: summarize(g.human) })
        if (g.sim !== undefined) bars.push({ series: o.simLabel || HS.t('simulated'), sim: true, v: summarize(g.sim) })
      }
      bars.forEach(function (b) {
        if (!b.v) return
        if (b.v.id == null) b.v.id = g.id
        if (b.v.page == null && !b.sim) b.v.page = g.page
        if (!b.v.quote) b.v.quote = g.quote
        if (b.v.page == null && !b.sim && b.v.id) { var src = HS.source(b.v.id); if (src) { b.v.page = src.page; b.v.quote = b.v.quote || src.quote } }
      })
      return { label: g.label, id: g.id, bars: bars }
    })
    if (!groups.length) return fail(el, 'HS.results: no groups')
    var series = [], seriesSim = {}
    groups.forEach(function (g) { g.bars.forEach(function (b) { if (series.indexOf(b.series) < 0) { series.push(b.series); seriesSim[b.series] = b.sim } }) })
    var colour = {}, ci = 0
    series.forEach(function (s) { colour[s] = seriesSim[s] ? null : SERIES[ci++ % SERIES.length] })
    var all = []
    groups.forEach(function (g) { g.bars.forEach(function (b) { var v = b.v; if (!v || v.mean == null) return; all.push(v.mean); if (v.lo != null) all.push(v.lo, v.hi); if (v.values) all.push.apply(all, v.values) }) })
    if (o.reference) all.push(o.reference.value)
    if (!all.length) all.push(0, 1)
    var lo = o.yMin != null ? o.yMin : Math.min(0, Math.min.apply(null, all)), hi = o.yMax != null ? o.yMax : Math.max.apply(null, all) * 1.12
    if (!(hi > lo)) hi = lo + 1
    var ticks = niceTicks(lo, hi, 5); lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1])
    var nb = Math.max.apply(null, groups.map(function (g) { return g.bars.length })), BW = nb >= 3 ? 30 : nb === 2 ? 40 : 54, GAP = 6
    var inner = nb * BW + (nb - 1) * GAP
    var GW = Math.max(inner + 36, o.groupWidth || 128), ML = 58, MR = 16, MT = 26, PH = o.height || 250
    var humanBars = [], allHumanLackSpread = true
    groups.forEach(function (g) { g.bars.forEach(function (b) { if (!b.sim && b.v && b.v.mean != null) { humanBars.push(b); if (b.v.lo != null) allHumanLackSpread = false } }) })
    var perBarSpread = humanBars.length > 0 && !allHumanLackSpread
    var hasN = groups.some(function (g) { return g.bars.some(function (b) { return b.v && b.v.n != null }) })
    // rows under the axis: citation chips, n, (spread notes), then the wrapped group label
    var ROW_CITE = 20, ROW_N = hasN ? ROW_CITE + 18 : ROW_CITE, ROW_SPREAD = perBarSpread ? ROW_N + 15 : ROW_N, ROW_LABEL = ROW_SPREAD + 24
    var labelLines = groups.map(function (g) { return wrap(g.label, GW - 12, 13, 3, 600) })
    var maxLines = Math.max.apply(null, labelLines.map(function (l) { return l.length }))
    var width = ML + groups.length * GW + MR, height = MT + PH + ROW_LABEL + (maxLines - 1) * 16 + 12
    var y = function (v) { return MT + PH - (v - lo) / (hi - lo) * PH }
    var root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, role: 'img', 'aria-label': o.title || o.yLabel || 'results' })
    var d = defs(root)
    // hatch patterns per sim series colour (vermillion)
    ticks.forEach(function (t) {
      svg('line', { x1: ML, x2: width - MR, y1: y(t), y2: y(t), class: t === 0 ? 'hs-axis' : 'hs-grid-line' }, root)
      text(root, ML - 8, y(t) + 4, fmt(t, o.decimals) + (o.unit && o.unit.length <= 2 ? o.unit : ''), 'hs-t-muted', 'end')
    })
    if (o.yLabel) { var yl = text(root, 14, MT + PH / 2, o.yLabel, 'hs-t-muted', 'middle'); yl.setAttribute('transform', 'rotate(-90 14 ' + (MT + PH / 2) + ')') }
    if (o.reference) {
      svg('line', { x1: ML, x2: width - MR, y1: y(o.reference.value), y2: y(o.reference.value), class: 'hs-ref' }, root)
      if (o.reference.label) text(root, width - MR, y(o.reference.value) - 5, o.reference.label, 'hs-t-muted', 'end')
    }
    var kinds = {}, base0 = y(Math.max(lo, Math.min(0, hi))), axisY = MT + PH
    groups.forEach(function (g, gi) {
      var gx = ML + gi * GW + (GW - (g.bars.length * BW + (g.bars.length - 1) * GAP)) / 2
      var pages = g.bars.filter(function (b) { return !b.sim && b.v }).map(function (b) { return b.v.page })
      var samePage = pages.length > 0 && pages.every(function (p) { return p === pages[0] })
      g.bars.forEach(function (b, k) {
        var x = gx + k * (BW + GAP), v = b.v, cx = x + BW / 2
        var gg = svg('g', b.sim ? { 'data-tip': b.series + ': ' + HS.t('sim') } : attrsFor(v && v.id, v && v.page, v && v.quote), root)
        if (!b.sim) gg.setAttribute('data-tip', (g.label ? g.label + ', ' : '') + b.series + (v && v.mean != null ? ': ' + fmt(v.mean, o.decimals) : ''))
        if (!v || v.mean == null) {
          svg('rect', { x: x, y: axisY - 44, width: BW, height: 44, rx: 2, class: 'hs-funnel-missing' }, gg)
          text(gg, cx, axisY - 50, HS.t('notReported'), 'hs-t-amber', 'middle')
          return
        }
        var top = y(Math.max(v.mean, lo)), bottom = base0
        if (v.mean < 0) { top = base0; bottom = y(v.mean) }
        var r = svg('rect', { x: x, y: Math.min(top, bottom), width: BW, height: Math.max(1, Math.abs(bottom - top)), rx: 2, class: b.sim ? 'hs-bar-sim' : 'hs-bar-human' }, gg)
        if (!b.sim && colour[b.series]) r.setAttribute('style', 'fill: var(' + colour[b.series] + ')')
        if (b.sim && v.values && v.values.length <= 400) {
          v.values.forEach(function (val, i) {
            svg('circle', { cx: cx + ((i * 37) % 17 - 8) * BW / 40, cy: y(val), r: 1.8, class: 'hs-dot-sim', opacity: 0.6 }, gg)
          })
        }
        var labelY = (v.mean < 0 ? y(v.mean) + 15 : y(v.mean) - 6)
        if (v.lo != null) {
          kinds[v.kind] = true
          svg('line', { x1: cx, x2: cx, y1: y(v.lo), y2: y(v.hi), class: 'hs-err' }, gg)
          svg('line', { x1: cx - 6, x2: cx + 6, y1: y(v.lo), y2: y(v.lo), class: 'hs-err' }, gg)
          svg('line', { x1: cx - 6, x2: cx + 6, y1: y(v.hi), y2: y(v.hi), class: 'hs-err' }, gg)
          if (v.mean >= 0) labelY = Math.min(labelY, y(v.hi) - 6)
        }
        text(gg, cx, labelY, fmt(v.mean, o.decimals) + (o.unit && o.unit.length <= 2 ? o.unit : ''), 'hs-t-strong', 'middle')
        if (!b.sim && !samePage) svgCite(gg, cx + textWidth(v.page != null ? 'p. ' + v.page : HS.t('noSource'), 12, 600) / 2 + 6, axisY + ROW_CITE, v.page, true)
        if (v.n != null) text(gg, cx, axisY + ROW_N, 'n=' + fmt(v.n, 0), 'hs-t-muted', 'middle')
        if (!b.sim && perBarSpread && v.lo == null) text(gg, cx, axisY + ROW_SPREAD, HS.t('noSpread'), 'hs-t-amber', 'middle')
      })
      if (samePage) {
        var first = g.bars.filter(function (b) { return !b.sim && b.v })[0].v
        var cg = svg('g', attrsFor(first.id, first.page, first.quote), root)
        var gc = ML + gi * GW + GW / 2
        svgCite(cg, gc + textWidth(first.page != null ? 'p. ' + first.page : HS.t('noSource'), 12, 600) / 2 + 6, axisY + ROW_CITE, first.page, true)
      }
      labelLines[gi].forEach(function (ln, k) { text(root, ML + gi * GW + GW / 2, axisY + ROW_LABEL + k * 16, ln, 'hs-t-strong', 'middle') })
    })
    var legend = '<div class="hs-legend">' + series.map(function (s) {
      return seriesSim[s]
        ? '<span><span class="hs-swatch" style="background:var(--hs-sim-soft);border:1.5px solid var(--hs-sim)"></span>' + esc(s) + '</span>'
        : '<span><span class="hs-swatch" style="background:var(' + colour[s] + ')"></span>' + esc(s) + '</span>'
    }).join('') + (series.some(function (s) { return seriesSim[s] }) ? HS.simLabel() : '') +
      (humanBars.length && allHumanLackSpread ? HS.missing(HS.t('spreadNotReported')) : '') + '</div>'
    var whisk = Object.keys(kinds).map(function (k) { return HS.t(k) }).join(' / ')
    var caption = [HS.t('bars') + (whisk ? '; ' + HS.t('whiskers') + ': ' + whisk : '') + '.',
      groups.some(function (g) { return g.bars.some(function (b) { return b.sim && b.v && b.v.values }) }) ? HS.t('simSpread') + '.' : '', o.caption || ''].filter(Boolean).join(' ')
    el.innerHTML = (o.title ? '<h3 class="hs-h2" style="margin-top:0">' + esc(o.title) + '</h3>' : '') + '<div class="hs-figure">' + legend + '</div>'
    el.querySelector('.hs-figure').appendChild(root)
    var cap = document.createElement('p'); cap.className = 'hs-caption'; cap.textContent = caption
    el.querySelector('.hs-figure').appendChild(cap)
    void d
  }

  /** Forest / dot plot of estimates with intervals, human vs simulated per row.
   *  HS.forest(el, {xLabel, zero:0, rows:[{label, id, human:{est, ci:[lo,hi], page}, sim:{est, ci}}]}) */
  HS.forest = function (el, o) {
    el = $(el); o = o || {}
    if (!el) return
    var rows = o.rows || []
    if (!rows.length) return fail(el, 'HS.forest: no rows')
    var all = [o.zero != null ? o.zero : 0]
    rows.forEach(function (r) { [r.human, r.sim].forEach(function (v) { if (v && num(v.est) != null) { all.push(num(v.est)); if (v.ci) all.push(num(v.ci[0]), num(v.ci[1])) } }) })
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), pad = (hi - lo) * 0.08 || 1
    var ticks = niceTicks(lo - pad, hi + pad, 6); lo = ticks[0]; hi = ticks[ticks.length - 1]
    var LW = 230, PW = 420, RH = 44, MT = 18, width = LW + PW + 90, height = MT + rows.length * RH + 46
    var x = function (v) { return LW + (v - lo) / (hi - lo) * PW }
    var root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, role: 'img' })
    ticks.forEach(function (t) { svg('line', { x1: x(t), x2: x(t), y1: MT, y2: MT + rows.length * RH, class: 'hs-grid-line' }, root); text(root, x(t), MT + rows.length * RH + 16, fmt(t), 'hs-t-muted', 'middle') })
    var z = o.zero != null ? o.zero : 0
    if (z >= lo && z <= hi) svg('line', { x1: x(z), x2: x(z), y1: MT, y2: MT + rows.length * RH, class: 'hs-axis' }, root)
    if (o.xLabel) text(root, LW + PW / 2, height - 6, o.xLabel, 'hs-t-muted', 'middle')
    rows.forEach(function (r, i) {
      var cy = MT + i * RH + RH / 2
      var h = r.human || {}, src = h.page != null ? { page: h.page, quote: h.quote } : (r.id ? HS.source(r.id) : null)
      var g = svg('g', attrsFor(r.id, src && src.page, src && src.quote), root)
      wrap(r.label, LW - 16, 12.5, 2, 500).forEach(function (ln, k) { text(g, 0, cy - 4 + k * 15, ln, 'hs-t', 'start') })
      ;[['human', -6], ['sim', 6]].forEach(function (pair) {
        var v = r[pair[0]]
        if (!v || num(v.est) == null) return
        var yy = cy + (r.sim && r.human ? pair[1] : 0)
        if (v.ci) svg('line', { x1: x(num(v.ci[0])), x2: x(num(v.ci[1])), y1: yy, y2: yy, class: pair[0] === 'human' ? 'hs-ci-human' : 'hs-ci-sim' }, g)
        svg(pair[0] === 'human' ? 'rect' : 'circle', pair[0] === 'human' ? { x: x(num(v.est)) - 4.5, y: yy - 4.5, width: 9, height: 9, class: 'hs-dot-human' } : { cx: x(num(v.est)), cy: yy, r: 4.5, class: 'hs-dot-sim' }, g)
      })
      svgCite(g, width - 4, cy + 4, src && src.page, true)
    })
    var hasSim = rows.some(function (r) { return r.sim })
    el.innerHTML = (o.title ? '<h3 class="hs-h2" style="margin-top:0">' + esc(o.title) + '</h3>' : '') + '<div class="hs-figure"><div class="hs-legend"><span><span class="hs-swatch" style="background:var(--hs-human)"></span>' + esc(HS.t('human')) + '</span>' + (hasSim ? '<span><span class="hs-swatch" style="border:2px solid var(--hs-sim);border-radius:50%"></span>' + esc(HS.t('simulated')) + '</span>' + HS.simLabel() : '') + '</div></div>'
    el.querySelector('.hs-figure').appendChild(root)
    if (o.caption) { var c = document.createElement('p'); c.className = 'hs-caption'; c.textContent = o.caption; el.querySelector('.hs-figure').appendChild(c) }
  }

  // ---------- attrition / N flow ----------
  var N_FIELDS = ['n-recruited', 'n-randomised', 'n-randomized', 'n-completed', 'n-analysed', 'n-analyzed']
  function stagesFromProgram(study) {
    var ps = (P.nodes || []).filter(function (n) { return n.kind === 'participants' && (!study || (n.studyIds || []).indexOf(study) >= 0) })
    var out = []
    ps.forEach(function (p) {
      ;['n-recruited', 'n-completed', 'n-analysed'].forEach(function (fid) {
        var f = (p.fields || []).filter(function (x) { return x.id === fid || (fid === 'n-analysed' && x.id === 'n-analyzed') })[0]
        var src = f ? HS.source(f.evidenceIds || []) : null
        out.push({ id: p.id + '/' + (f ? f.id : fid), label: f ? f.label : fid.replace('n-', '').replace(/^\w/, function (c) { return c.toUpperCase() }), n: f ? num(f.value) : null, detail: f && typeof f.value === 'string' ? f.value : null, page: src && src.page, quote: src && src.quote, missing: !f || f.state === 'missing' || num(f.value) == null, absent: !f })
      })
    })
    // Hide trailing stages the program does not mention at all when nothing follows them.
    while (out.length > 1 && out[out.length - 1].absent) out.pop()
    return out
  }
  /** HS.attrition(el, {study}) or {stages:[{label, n, page, id, quote, detail}]} — sample size at each stage, losses between. */
  HS.attrition = function (el, o) {
    el = $(el); o = o || {}
    if (!el) return
    var st = o.stages ? o.stages.map(function (s) { var src = s.page != null ? null : s.id && HS.source(s.id); return { id: s.id, label: s.label, n: num(s.n), detail: s.detail, page: s.page != null ? s.page : src && src.page, quote: s.quote || (src && src.quote), missing: num(s.n) == null } }) : stagesFromProgram(o.study)
    if (!st.length) return
    var max = Math.max.apply(null, st.map(function (s) { return s.n || 0 }).concat([1]))
    var LW = 170, BW = 380, RH = 40, width = LW + BW + 120, height = st.length * RH + 10
    var root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, width: width, role: 'img', 'aria-label': HS.t('sample') })
    st.forEach(function (s, i) {
      var yy = 6 + i * RH, g = svg('g', attrsFor(s.id, s.page, s.quote), root)
      if (s.detail) g.setAttribute('data-tip', s.detail)
      wrap(s.label, LW - 12, 12.5, 2, 500).forEach(function (ln, k) { text(g, 0, yy + 17 + k * 14, ln, 'hs-t', 'start') })
      if (s.missing) {
        svg('rect', { x: LW, y: yy + 4, width: BW * 0.5, height: 24, rx: 4, class: 'hs-funnel-missing' }, g)
        text(g, LW + 10, yy + 21, HS.t('notReported'), 'hs-t-amber')
      } else {
        var w = Math.max(3, s.n / max * BW)
        svg('rect', { x: LW, y: yy + 4, width: w, height: 24, rx: 4, class: 'hs-funnel' }, g)
        text(g, LW + w + 8, yy + 21, 'N = ' + fmt(s.n, 0), 'hs-t-strong')
        var prev = i > 0 ? st[i - 1] : null
        if (prev && !prev.missing && prev.n > s.n) text(g, LW + w + 70, yy + 21, '−' + fmt(prev.n - s.n, 0) + ' ' + HS.t('drop'), 'hs-t-muted')
      }
      svgCite(g, width - 2, yy + 21, s.page, true)
    })
    el.innerHTML = '<div class="hs-figure"></div>'
    el.firstChild.appendChild(root)
  }

  // ---------- open questions ----------
  HS.issues = function (el, o) {
    el = $(el); o = o || {}
    if (!el) return
    var list = (P.issues || []).filter(function (x) { return !o.study || x.studyId === o.study || (!x.studyId && false) })
    if (!list.length) { el.innerHTML = '<p class="hs-note">' + esc(HS.t('openQuestions')) + ': ' + esc(HS.t('none')) + '</p>'; return }
    el.innerHTML = '<div class="hs-grid">' + list.map(function (x) {
      var target = x.stepId || (x.nodeId ? x.nodeId + (x.fieldId ? '/' + x.fieldId : '') : '')
      var src = HS.source(x.evidenceIds || [])
      return '<div class="hs-card hs-amber"' + (target ? ' data-program-id="' + esc(target) + '"' : '') + (src ? ' data-page="' + esc(src.page) + '"' : '') + '>' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><b>' + esc(x.title) + '</b>' + HS.missing(HS.t(x.severity)) + '</div>' +
        '<p class="hs-small" style="margin:6px 0">' + esc(x.reason) + '</p>' + HS.cite(src && src.page, { quote: src && src.quote }) + ' ' +
        HS.askButton(x.suggestedAction ? HS.t('ask') : '', 'About ' + x.title + ': ' + (x.suggestedAction || x.reason)) + '</div>'
    }).join('') + '</div>'
  }

  // ---------- tabs & composite overview ----------
  /** HS.tabs(el, [{id,label}], (id, panel) => render) — one panel visible at a time. */
  HS.tabs = function (el, items, render) {
    el = $(el)
    if (!el) return
    if (items.length < 2) { var only = document.createElement('div'); el.appendChild(only); if (items[0]) render(items[0].id, only); return }
    var bar = document.createElement('div'); bar.className = 'hs-tabs'; bar.setAttribute('role', 'tablist')
    var panel = document.createElement('div')
    el.appendChild(bar); el.appendChild(panel)
    function show(id) {
      Array.prototype.forEach.call(bar.children, function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-id') === id)) })
      panel.innerHTML = ''; render(id, panel)
    }
    items.forEach(function (it) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('data-id', it.id); b.textContent = it.label
      b.addEventListener('click', function () { show(it.id) }); bar.appendChild(b)
    })
    show(items[0].id)
  }
  function section(parent, title, sub) {
    var s = document.createElement('section'); s.className = 'hs-section'
    s.innerHTML = '<h2 class="hs-h2">' + esc(title) + '</h2>' + (sub ? '<p class="hs-sub">' + sub + '</p>' : '')
    var body = document.createElement('div'); s.appendChild(body); parent.appendChild(s)
    return body
  }
  /** One study at a glance: N tiles, attrition, procedure flow, conditions, open questions. Tabs when several studies. */
  HS.overview = function (el, o) {
    el = $(el); o = o || {}
    if (!el) return
    if (!HS.program) return fail(el, 'HS.overview needs the embedded program (run inline.py with program.json present).')
    var studies = (o.study ? [STUDIES[o.study]] : (P.studies || [])).filter(Boolean)
    if (!studies.length) studies = [{ id: null, title: P.title || '' }]
    HS.tabs(el, studies.map(function (s) { return { id: s.id, label: (s.title || s.id).replace(/:.*$/, '') } }), function (id, panel) {
      var s = STUDIES[id] || studies[0]
      var head = document.createElement('div')
      head.innerHTML = '<p class="hs-sub" style="font-size:14px;color:var(--hs-ink);margin-top:2px"' + (id ? ' data-program-id="' + esc(id) + '"' : '') + '><b>' + esc(s.title || '') + '</b>' + (s.description ? ' — ' + esc(s.description) : '') + '</p>'
      panel.appendChild(head)
      var ps = (P.nodes || []).filter(function (n) { return n.kind === 'participants' && (!id || (n.studyIds || []).indexOf(id) >= 0) })
      var conds = (P.nodes || []).filter(function (n) { return n.kind === 'condition' && (!id || (n.studyIds || []).indexOf(id) >= 0) })
      var steps = (P.steps || []).filter(function (x) { return !id || x.studyId === id })
      var iss = (P.issues || []).filter(function (x) { return !id || x.studyId === id })
      var tiles = []
      ps.forEach(function (p) {
        var f = (p.fields || []).filter(function (x) { return x.id === 'n-recruited' })[0]
        var fa = (p.fields || []).filter(function (x) { return x.id === 'n-analysed' || x.id === 'n-analyzed' })[0]
        tiles.push({ label: f ? f.label : HS.t('sample'), value: f ? (num(f.value) != null ? fmt(num(f.value), 0) : f.value) : null, id: p.id + '/' + (f ? f.id : 'n-recruited'), page: f ? (HS.source(f.evidenceIds || []) || {}).page : null, tip: f && typeof f.value === 'string' ? f.value : null })
        if (fa) tiles.push({ label: fa.label, value: num(fa.value) != null ? fmt(num(fa.value), 0) : fa.value, id: p.id + '/' + fa.id, page: (HS.source(fa.evidenceIds || []) || {}).page, tip: typeof fa.value === 'string' ? fa.value : null })
        var setting = (p.fields || []).filter(function (x) { return x.id === 'setting' })[0]
        if (setting) tiles.push({ label: setting.label, value: setting.value, id: p.id + '/setting', page: (HS.source(setting.evidenceIds || []) || {}).page })
      })
      tiles.push({ label: HS.t('conditions'), value: conds.length ? String(conds.length) : '—', note: conds.length ? conds.map(function (c) { return c.title }).join('; ') : HS.t('noConditions').replace(/\.$/, ''), cite: false })
      var t = document.createElement('div'); panel.appendChild(t)
      HS.stats(t, tiles)
      var stages = stagesFromProgram(id)
      if (stages.filter(function (x) { return !x.absent }).length >= 2) HS.attrition(section(panel, HS.t('sample')), { stages: stages })
      HS.flow(section(panel, HS.t('procedure')), { study: id })
      if (conds.length) HS.conditions(section(panel, HS.t('conditions')), { study: id })
      if (iss.length) HS.issues(section(panel, HS.t('openQuestions')), { study: id })
    })
  }

  // ---------- run manifest ----------
  /** HS.manifest(el, {model, temperature, seed, n, ...}) — a definition list of run settings. */
  HS.manifest = function (el, m) {
    el = $(el)
    if (!el) return
    el.innerHTML = '<dl class="hs-manifest">' + Object.keys(m || {}).map(function (k) {
      var v = m[k]; return '<dt>' + esc(k) + '</dt><dd>' + esc(typeof v === 'object' ? JSON.stringify(v) : v) + '</dd>'
    }).join('') + '</dl>'
  }

  // ---------- Chart.js wrapper (only when chart.umd.min.js is inlined too) ----------
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() }
  /** HS.chart(el, chartJsConfig) — themed Chart.js; colors default to human/sim tokens. */
  HS.chart = function (el, config) {
    el = $(el)
    if (!el) return null
    if (!window.Chart) return fail(el, 'HS.chart needs Chart.js: add <script src="chart.umd.min.js"></script> before hs-kit.js and re-run inline.py')
    var C = window.Chart
    C.defaults.font.family = getComputedStyle(document.body).fontFamily
    C.defaults.color = cssVar('--hs-muted'); C.defaults.borderColor = cssVar('--hs-line')
    var palette = [cssVar('--hs-human'), cssVar('--hs-sim'), '#6b8e23', '#7c5cbf', '#2a9d8f', '#b5485d']
    ;(config.data && config.data.datasets || []).forEach(function (d, i) {
      var c = d.simulated ? cssVar('--hs-sim') : palette[i % palette.length]
      if (d.backgroundColor == null) d.backgroundColor = d.simulated ? cssVar('--hs-sim-soft') : c
      if (d.borderColor == null) d.borderColor = c
      if (d.simulated && d.label && d.label.indexOf(HS.t('sim')) < 0) d.label += ' — ' + HS.t('sim')
    })
    config.options = config.options || {}
    if (config.options.maintainAspectRatio == null) config.options.maintainAspectRatio = false
    config.options.animation = false
    el.innerHTML = '<div class="hs-figure"><div style="position:relative;height:' + (config.height || 320) + 'px"><canvas></canvas></div></div>'
    return new C(el.querySelector('canvas'), config)
  }

  window.HS = HS
})()
