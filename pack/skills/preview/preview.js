/* Participant preview renderer (offline). Data: <script type="application/json" id="hs-preview">.
 * Kit conventions (pack/artifact-kit/hs-kit.js): elements carry data-program-id (here the protocol ref
 * "<stage>.<item>") and data-page; a click posts {type:'hs.openSource', page, quote, programId, file} to the
 * parent; [data-tip] shows a tooltip. Network is never used. */
(function () {
  'use strict'
  var D = null
  var S = { arm: 0, pid: 0, scr: 0, view: 'participant', marks: true, theme: 'auto' }
  var app = document.getElementById('app')

  window.addEventListener('error', function (e) {
    try {
      var box = document.createElement('div'); box.className = 'hs-error'
      box.textContent = 'Script error in this preview: ' + (e.message || 'unknown') + (e.lineno ? ' (line ' + e.lineno + ')' : '')
      document.body.insertBefore(box, document.body.firstChild)
    } catch (x) { /* nothing more to do */ }
  })

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem('hs-preview.' + k); localStorage.setItem('hs-preview.' + k, v) } catch (e) { return null } }

  // ---------- load ----------
  function load() {
    var tag = document.getElementById('hs-preview')
    if (!tag) return Promise.reject(new Error('preview data missing'))
    if (tag.getAttribute('data-encoding') === 'gzip+base64') {
      var b64 = JSON.parse(tag.textContent)
      var bin = atob(b64), bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('this browser cannot unpack the preview (no DecompressionStream)'))
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
      return new Response(stream).text().then(JSON.parse)
    }
    return Promise.resolve(JSON.parse(tag.textContent))
  }

  // ---------- theme ----------
  function applyTheme() {
    var r = document.documentElement
    if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme)
  }

  // ---------- provenance ----------
  var LABEL_TXT = { reported: 'Reported', derived: 'Derived', missing: 'Missing' }
  function citeTip(c, what) {
    if (!c) return ''
    var lab = c.label || 'unlabelled'
    var head = (LABEL_TXT[lab] || lab) + (what ? ' — ' + what : '')
    var src = [c.source, c.file, c.page != null ? 'p. ' + c.page : null, c.evidence].filter(Boolean).join(' · ')
    var lines = [head]
    if (lab === 'reported') lines.push('Taken from the paper\'s description, not from the administered material.')
    if (lab === 'derived') lines.push('Reconstructed by the converter, not printed verbatim in a source.')
    if (lab === 'missing') lines.push('No source gives this text; it is a gap.')
    if (src) lines.push('Source: ' + src)
    if (c.read === 'image') lines.push('Read off an image (blind readings agree).')
    if (c.quote) lines.push('“' + c.quote + '”')
    if (c.note) lines.push('Note: ' + c.note)
    return lines.join('\n')
  }
  /** attributes + chip for a cited element. verbatim: plain (still clickable to its source). */
  function prov(c, ref, what) {
    var lab = c && c.label
    var marked = lab && lab !== 'verbatim'
    var a = ''
    if (ref) a += ' data-program-id="' + esc(ref) + '"'
    if (c && c.page != null) a += ' data-page="' + esc(c.page) + '"'
    if (c && c.quote) a += ' data-quote="' + esc(c.quote) + '"'
    if (c && c.file) a += ' data-file="' + esc(c.file) + '"'
    if (marked) a += ' data-tip="' + esc(citeTip(c, what)) + '"'
    return {
      cls: marked ? ' mk mk-' + esc(lab) : '',
      attrs: a,
      chip: marked ? '<span class="chip c-' + esc(lab) + '">' + esc(lab) + '</span>' : '',
      marked: !!marked
    }
  }

  // ---------- styles ----------
  var NAMED = { red: '#c0392b', blue: '#1f5fbf', green: '#2e7d4f', white: null, grey: '#888', gray: '#888' }
  /** "bold underline large", "size 16px font Times New Roman", "colour #D3D3D3 italic" → {css, cls} */
  function parseStyle(style) {
    var css = [], cls = []
    if (!style) return { css: '', cls: '' }
    var s = String(style).replace(/_/g, ' ')
    var m
    if ((m = s.match(/\bfont ([^#]+?)(?=\s+(?:size|colou?r|bold|italic|underline)\b|$)/i))) { css.push('font-family:"' + m[1].trim().replace(/["<>]/g, '') + '",serif') ; s = s.replace(m[0], ' ') }
    if ((m = s.match(/\bsize (\d+(?:\.\d+)?)(px|pt)\b/i)) || (m = s.match(/\bsize (\d+(?:\.\d+)?)(px|pt)/i))) css.push('font-size:' + m[1] + m[2])
    if ((m = s.match(/\bcolou?r (#[0-9a-f]{3,8})\b/i))) css.push('color:' + m[1])
    s.split(/\s+/).forEach(function (w) {
      w = w.toLowerCase()
      if (w === 'bold') css.push('font-weight:700')
      else if (w === 'italic') css.push('font-style:italic')
      else if (w === 'underline') css.push('text-decoration:underline')
      else if (w === 'large' || w === 'big') css.push('font-size:1.2em')
      else if (w === 'heading') { css.push('font-weight:650'); cls.push('st-heading') }
      else if (w === 'small') cls.push('st-small')
      else if (w === 'red' || w === 'blue' || w === 'green') css.push('color:' + NAMED[w])
      else if (w === 'centre' || w === 'center') css.push('text-align:center')
      else if (w === 'right') css.push('text-align:right')
      else if (['bullet', 'box', 'alert', 'button'].indexOf(w) >= 0) cls.push('st-' + w)
      else if (['tooltip', 'popup', 'tabs', 'disabled_input'].indexOf(w) >= 0) cls.push('st-hidden-ui')
    })
    if (/^bold italic$|bold italic/.test(s)) css.push('font-weight:700;font-style:italic')
    return { css: css.join(';'), cls: cls.map(function (c) { return ' ' + c }).join('') }
  }
  function uiTag(style) {
    var w = String(style || '').toLowerCase()
    var t = /tooltip/.test(w) ? 'hover text' : /popup/.test(w) ? 'pop-up' : /tabs/.test(w) ? 'tab' : /disabled/.test(w) ? 'disabled field' : ''
    return t ? '<span class="uitag">[' + t + ']</span>' : ''
  }

  /** Text with style spans ({start,end,style|tooltip}); overlapping spans combine. */
  function richText(text, spans) {
    text = String(text == null ? '' : text)
    if (!spans || !spans.length) return esc(text)
    var cuts = [0, text.length]
    spans.forEach(function (sp) { cuts.push(Math.max(0, Math.min(text.length, sp.start | 0)), Math.max(0, Math.min(text.length, sp.end | 0))) })
    cuts = cuts.filter(function (v, i, a) { return a.indexOf(v) === i }).sort(function (a, b) { return a - b })
    var out = ''
    for (var i = 0; i < cuts.length - 1; i++) {
      var a = cuts[i], b = cuts[i + 1]
      if (a === b) continue
      var seg = esc(text.slice(a, b)), css = [], tip = null
      spans.forEach(function (sp) {
        if (sp.start <= a && sp.end >= b) {
          if (sp.style) css.push(parseStyle(sp.style).css)
          if (sp.tooltip) tip = sp.tooltip
        }
      })
      if (tip) { css.push('text-decoration:underline dotted'); }
      out += css.length || tip ? '<span style="' + esc(css.filter(Boolean).join(';')) + '"' + (tip ? ' data-tip="' + esc('Hover text shown to participants:\n' + tip) + '"' : '') + '>' + seg + '</span>' : seg
    }
    return out
  }
  function cellText(c) {
    if (c == null) return ''
    if (typeof c === 'string') return esc(c)
    return richText(c.text, c.spans) + (c.mark ? ' <span class="uitag">' + esc(c.mark) + '</span>' : '')
  }

  // ---------- items ----------
  function renderItem(it) {
    var p = prov(it.cite, it.ref, it.type === 'image' ? 'image' : null)
    var st = parseStyle(it.style)
    if (it.text != null) {
      return '<div class="it' + st.cls + p.cls + '"' + p.attrs + (st.css ? ' style="' + esc(st.css) + '"' : '') + '>' +
        uiTag(it.style) + richText(it.text, it.spans) + p.chip + '</div>'
    }
    var h = '<div class="it' + p.cls + '"' + p.attrs + '>'
    if (it.src) {
      var im = D.images[it.src] || { omitted: 'image not recorded' }
      if (im.uri) {
        var sz = it.size || {}
        h += '<img class="pic" alt="' + esc((it.lines || []).map(function (l) { return typeof l === 'string' ? l : l.text }).join(' ').slice(0, 300) || 'image shown to participants') + '"' +
          ' data-img="' + esc(it.src) + '"' + (sz.width ? ' width="' + esc(sz.width) + '"' : '') + (sz.height ? ' height="' + esc(sz.height) + '"' : '') + '>'
      } else {
        h += '<div class="imgmiss">Image not embedded: ' + esc(im.omitted) + (im.file ? ' (' + esc(im.file) + ')' : '') + (im.url ? '<br><span class="uitag">' + esc(im.url) + '</span>' : '') + '</div>'
      }
    }
    if (it.rows) {
      h += '<table class="tbl">' + it.rows.map(function (row) {
        return '<tr>' + row.map(function (c) { return '<td>' + cellText(c) + '</td>' }).join('') + '</tr>'
      }).join('') + '</table>'
    }
    if (it.lines && it.lines.length) {
      var lines = it.lines.map(function (l) { return '<div>' + (typeof l === 'string' ? esc(l) : richText(l.text, l.spans)) + '</div>' }).join('')
      var embedded = it.src && D.images[it.src] && D.images[it.src].uri
      h += embedded ? '<details class="imglines"><summary>Text in this image (' + it.lines.length + ' line' + (it.lines.length > 1 ? 's' : '') + ')</summary>' + lines + '</details>'
        : '<div class="imglines" style="color:inherit;font-size:inherit">' + lines + '</div>'
    }
    return h + p.chip + '</div>'
  }

  // ---------- responses ----------
  function optLabel(r, o) {
    var c = (r.option_cites || {})[o.code] || r.options_cite
    var p = prov(c, r.ref + '#' + o.code, 'option')
    return '<span class="' + p.cls.trim() + '"' + p.attrs + '>' + richText(o.label, o.spans) + p.chip + '</span>' +
      (o.text_entry ? ' <input type="text" size="12" aria-label="text entry">' : '')
  }
  function anchorsHtml(r) {
    var an = r.anchors
    if (!an) return ''
    var list = []
    if (Array.isArray(an)) list = an.map(function (x) { return typeof x === 'object' && x ? (x.text || x.label || JSON.stringify(x)) : x })
    else if (typeof an === 'object') {
      if ('left' in an || 'right' in an) list = [an.left, an.middle, an.right].filter(function (x) { return x != null })
      else list = Object.keys(an).sort(function (a, b) { return +a - +b }).map(function (k) { return (isFinite(+k) ? k + ' = ' : '') + an[k] })
    }
    var p = prov(r.anchors_cite, r.ref + '#anchors', 'anchors')
    return '<div class="anch' + p.cls + '"' + p.attrs + '>' + list.map(function (x) { return '<span>' + esc(typeof x === 'object' ? (x && x.text) : x) + '</span>' }).join('') + p.chip + '</div>'
  }
  function wnote(parts) { parts = parts.filter(Boolean); return parts.length ? '<div class="wnote">' + esc(parts.join(' · ')) + '</div>' : '' }
  function renderResp(r, name) {
    var p = prov(r.cite, r.ref, 'question')
    var ps = parseStyle(r.prompt_style)
    var h = '<div class="q">'
    if (r.prompt != null && r.prompt !== '') {
      h += '<div class="prompt' + ps.cls + p.cls + '"' + p.attrs + (ps.css ? ' style="' + esc(ps.css) + '"' : '') + '>' +
        richText(r.prompt, r.prompt_spans) + (r.required ? '<span class="req" title="required">*</span>' : '') + p.chip + '</div>'
    }
    if (r.instruction) {
      var pi = prov(r.instruction_cite, r.ref + '#instruction', 'instruction')
      h += '<div class="instr' + pi.cls + '"' + pi.attrs + '>' + esc(r.instruction) + pi.chip + '</div>'
    }
    var w = r.widget || '', k = r.kind, opts = r.options || [], notes = []
    var nm = 'q' + name
    if (k === 'choice' || k === 'multi' || (k === 'scale' && opts.length)) {
      var type = k === 'multi' ? 'checkbox' : 'radio'
      if (/dropdown|autocomplete/.test(w)) {
        h += '<select><option>' + (r.start === null ? '' : '—') + '</option>' + opts.map(function (o) { return '<option>' + esc(o.label) + '</option>' }).join('') + '</select>'
        h += '<div class="ddlist"><div class="wnote">Drop-down options in shown order (operator note; participants saw them only when opening the list):</div>' + opts.map(function (o) { return '<div>' + optLabel(r, o) + '</div>' }).join('') + '</div>'
      } else if (/buttons/.test(w)) {
        h += '<div class="btnopts">' + opts.map(function (o) { return '<span>' + optLabel(r, o) + '</span>' }).join('') + '</div>'
      } else {
        var horiz = /horizontal|likert|^horizontal$/.test(w) || (k === 'scale')
        h += '<div class="opts' + (horiz ? ' h' : '') + '"' + (typeof r.columns === 'number' ? ' style="display:grid;grid-template-columns:repeat(' + r.columns + ',minmax(0,1fr))"' : '') + '>' +
          opts.map(function (o) { return '<label><input type="' + type + '" name="' + nm + '">' + optLabel(r, o) + '</label>' }).join('') + '</div>'
      }
      if (r.anchors) h += '<div class="slider">' + anchorsHtml(r) + '</div>'
    } else if (k === 'slider' || (k === 'scale' && !opts.length) || (k === 'number' && /slider/.test(w))) {
      var rg = r.range || [0, 100], lo = rg[0] == null ? 0 : rg[0], hi = rg[1] == null ? 100 : rg[1]
      var wp = r.widget_params || {}
      var hidden = (r.hidden || []).indexOf('start') >= 0 || wp.handle_hidden_until_clicked || r.start === 'unknown'
      var start = typeof r.start === 'number' ? r.start : (lo + hi) / 2
      h += '<div class="slider' + (hidden ? ' nohandle' : '') + '"><input type="range" min="' + esc(lo) + '" max="' + esc(hi) + '" step="' + esc(r.step || 1) + '" value="' + esc(start) + '" aria-label="slider">' + anchorsHtml(r) + '</div>'
      if (r.range && (r.hidden || []).indexOf('range') < 0) notes.push('range ' + lo + '–' + hi)
      if ((r.hidden || []).indexOf('range') >= 0) notes.push('range not shown to participants')
      if (typeof r.start === 'number') notes.push('starts at ' + r.start)
      if (hidden) notes.push(r.start === 'unknown' ? 'start position unknown' : 'no handle until clicked')
      if (r.shows_value === false) notes.push('value not displayed'); else if (r.shows_value) notes.push('value displayed')
      if (w === 'bar') notes.push('bar slider')
      if (r.na_option) notes.push('N/A option: ' + (typeof r.na_option === 'string' ? r.na_option : 'yes'))
    } else if (k === 'number' || k === 'scale') {
      h += (r.prefix ? esc(r.prefix) + ' ' : '') + '<input type="number"' + (r.range ? ' min="' + esc(r.range[0]) + '" max="' + esc(r.range[1]) + '"' : '') + (r.prefill != null ? ' value="' + esc(r.prefill) + '"' : '') + ' aria-label="number">' + (r.suffix ? ' ' + esc(r.suffix) : '')
      if (r.range && (r.hidden || []).indexOf('range') < 0) notes.push('accepts ' + r.range[0] + '–' + r.range[1])
      if (w && w !== 'text' && w !== 'number' && w !== 'text_box') notes.push('widget: ' + w.replace(/_/g, ' '))
    } else if (k === 'text') {
      h += /textarea/.test(w) ? '<textarea aria-label="text">' + esc(r.prefill || '') + '</textarea>' : (r.prefix ? esc(r.prefix) + ' ' : '') + '<input type="text" aria-label="text"' + (r.prefill ? ' value="' + esc(r.prefill) + '"' : '') + '>' + (r.suffix ? ' ' + esc(r.suffix) : '')
      if (r.min_chars) notes.push('at least ' + r.min_chars + ' characters')
    } else {
      notes.push('response type ' + k + (w ? '/' + w : ''))
    }
    if (r.soft_required) notes.push('soft-required (a reminder if left blank)')
    if (r.shuffled) notes.push('options shown in this participant\'s shuffled order')
    if (r.shuffled_with_others) notes.push('question order shuffled')
    h += wnote(notes)
    return h + '</div>'
  }
  function sameOpts(a, b) {
    var x = (a.options || []).map(function (o) { return o.label }).join('\u0001'), y = (b.options || []).map(function (o) { return o.label }).join('\u0001')
    return x === y && x.length > 0
  }
  function renderMatrix(rs, name) {
    var opts = rs[0].options
    var h = '<table class="matrix"><thead><tr><th></th>' + opts.map(function (o) { return '<th>' + optLabel(rs[0], o) + '</th>' }).join('') + '</tr></thead><tbody>'
    rs.forEach(function (r, i) {
      var p = prov(r.cite, r.ref, 'question')
      h += '<tr><td class="rowq' + p.cls + '"' + p.attrs + '>' + richText(r.prompt, r.prompt_spans) + (r.required ? '<span class="req">*</span>' : '') + p.chip + '</td>' +
        opts.map(function () { return '<td><input type="radio" name="m' + name + '_' + i + '" aria-label="option"></td>' }).join('') + '</tr>'
    })
    return h + '</tbody></table>' + wnote([rs[0].shuffled ? 'columns in shuffled order' : null, rs.some(function (r) { return r.shuffled_with_others }) ? 'row order shuffled' : null])
  }

  // ---------- screen ----------
  function timingNotes(sc) {
    var t = sc.timing || {}, n = sc.navigation || {}, out = []
    var adv = { self: 'self-paced', auto: 'advances automatically', timed: 'advances when time is up', none: 'no way forward (end page)', wait: 'waits for others', link: 'continues via a link', after: 'continue appears after a delay', 'after(min_sec)': 'continue appears after the minimum time' }
    if (t.advance) out.push(adv[t.advance] || 'advance: ' + t.advance)
    if (t.min_sec != null) out.push('minimum ' + t.min_sec + ' s on page')
    if (t.time_limit != null) out.push('time limit ' + t.time_limit + (typeof t.time_limit === 'number' ? ' s' : ''))
    if (t.timer_shown) out.push('timer shown')
    if (n.back) out.push(n.back === 'not_allowed' ? 'no going back' : n.back === 'allowed' ? 'back allowed' : 'back rule ' + n.back)
    if (n.paging && n.paging !== 'missing') out.push(String(n.paging).replace(/_/g, ' '))
    ;(sc.stages || []).forEach(function (s) { if (s.note) out.push(s.note) })
    return out
  }
  function buttonHtml(sc, inline) {
    var t = sc.timing || {}
    if (sc.button == null && /^(auto|timed|none|wait|link)$/.test(t.advance || '')) return ''
    var label = sc.button != null ? sc.button : '→'
    return '<div class="cont' + (inline ? ' inline' : '') + '"><span' + (sc.button == null ? ' data-tip="Button label not recorded in the protocol"' : '') + '>' + esc(label) + '</span></div>'
  }
  function renderScreen(sc, name) {
    var items = {}, resps = {}
    sc.items.forEach(function (i) { items[i.id] = i })
    sc.responses.forEach(function (r) { resps[r.id] = r })
    var order = sc.order && sc.order.length ? sc.order.slice() : sc.items.map(function (i) { return i.id }).concat(sc.responses.map(function (r) { return r.id }))
    // anything the layout left out still shows (at the end), so nothing is silently hidden
    sc.items.concat(sc.responses).forEach(function (x) { if (order.indexOf(x.id) < 0) order.push(x.id) })
    var h = '', i = 0
    while (i < order.length) {
      var id = order[i]
      if (id === 'button') { h += buttonHtml(sc, true); i++; continue }
      if (items[id]) { h += renderItem(items[id]); i++; continue }
      var r = resps[id]
      if (!r) { i++; continue }
      if (/^matrix/.test(r.widget || '') && r.options) {
        var group = [r], j = i + 1
        while (j < order.length && resps[order[j]] && /^matrix/.test(resps[order[j]].widget || '') && sameOpts(r, resps[order[j]])) { group.push(resps[order[j]]); j++ }
        if (r.widget === 'matrix' && group.length) { h += renderMatrix(group, name + '_' + i); i = j; continue }
      }
      h += renderResp(r, name + '_' + i); i++
    }
    if (order.indexOf('button') < 0) h += buttonHtml(sc, false)
    return h
  }

  // ---------- word diff (conditions view) ----------
  function screenText(sc) {
    var parts = []
    sc.items.forEach(function (i) {
      if (i.text != null) parts.push(i.text)
      else {
        if (i.src) parts.push('[image ' + ((D.images[i.src] || {}).file || i.src) + ']')
        ;(i.lines || []).forEach(function (l) { parts.push(typeof l === 'string' ? l : l.text) })
        ;(i.rows || []).forEach(function (row) { parts.push(row.map(function (c) { return typeof c === 'string' ? c : (c && c.text) || '' }).join(' | ')) })
      }
    })
    sc.responses.forEach(function (r) {
      if (r.prompt) parts.push(r.prompt)
      if (r.instruction) parts.push(r.instruction)
      if (r.options) parts.push(r.options.map(function (o) { return '( ) ' + o.label }).join('  '))
      if (r.anchors) parts.push('[' + JSON.stringify(r.anchors) + ']')
    })
    if (sc.button) parts.push('[' + sc.button + ']')
    return parts.join('\n')
  }
  function diffHtml(base, other) {
    var a = base.split(/(\s+)/), b = other.split(/(\s+)/)
    if (a.length * b.length > 4e6) return esc(other)
    var n = a.length, m = b.length, dp = new Array(n + 1)
    for (var i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1)
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    var same = dp[0][0], words = b.filter(function (w) { return /\S/.test(w) }).length
    if (words && same / b.length < 0.35) return { html: esc(other), mostly: true }
    var out = '', run = ''
    i = 0; j = 0
    while (j < m) {
      if (i < n && a[i] === b[j]) { if (run) { out += '<ins>' + esc(run) + '</ins>'; run = '' } out += esc(b[j]); i++; j++ }
      else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++
      else { run += b[j]; j++ }
    }
    if (run) out += '<ins>' + esc(run) + '</ins>'
    return { html: out, mostly: false }
  }

  // ---------- views ----------
  function arm() { return D.arms[S.arm] }
  function part() { return (arm().participants || [])[S.pid] }
  function header() {
    var h = '<p class="hs-eyebrow">Participant preview · private protocol text · not for publication</p>' +
      '<h1 class="hs-title">' + esc(D.study) + '</h1>' +
      (D.citation ? '<p class="hs-sub">' + esc(String(D.citation).slice(0, 400)) + '</p>' : '')
    h += '<div class="bar"><div class="tabs" role="tablist">' +
      '<button role="tab" data-view="participant" aria-selected="' + (S.view === 'participant') + '">Participant view</button>' +
      '<button role="tab" data-view="conditions" aria-selected="' + (S.view === 'conditions') + '">Conditions (operators)</button></div>' +
      '<span class="spacer"></span>' +
      '<label><input type="checkbox" id="marks"' + (S.marks ? ' checked' : '') + '> provenance marks</label>' +
      '<button class="ghost" id="theme" title="Theme">' + ({ auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' })[S.theme] + '</button></div>'
    return h
  }
  function armPicker() {
    var a = arm()
    var h = '<div class="bar"><label>Arm <select id="arm">' + D.arms.map(function (x, i) {
      return '<option value="' + i + '"' + (i === S.arm ? ' selected' : '') + '>' + esc(x.id) + (x.language && D.arms.some(function (y) { return y.language !== x.language }) ? ' (' + esc(x.language) + ')' : '') + (x.runnable ? '' : ' — not runnable') + '</option>'
    }).join('') + '</select></label>'
    if ((a.participants || []).length > 1) {
      h += '<label>Group member <select id="pid">' + a.participants.map(function (p, i) { return '<option value="' + i + '"' + (i === S.pid ? ' selected' : '') + '>' + esc(p.pid) + '</option>' }).join('') + '</select></label>'
    }
    h += '</div>'
    var bits = []
    if (a.what) bits.push('<b>' + esc(a.what.length > 260 ? a.what.slice(0, 260) + '…' : a.what) + '</b>')
    var facts = []
    if (a.n_paper != null) facts.push('paper N ' + a.n_paper + (a.group_size ? ' groups of ' + a.group_size : ''))
    if (a.language) facts.push('language ' + a.language)
    if (a.assignment) facts.push(a.assignment.length > 120 ? a.assignment.slice(0, 120) + '…' : a.assignment)
    if (facts.length) bits.push(esc(facts.join(' · ')))
    var p = part()
    if (p) bits.push(esc('One played session (seed ' + D.seed + ', ' + p.policy + ' answers' + (a.participants.length > 1 ? ', member ' + p.pid : '') + '): ' + p.screens.length + ' screens, ' + p.status + '.'))
    if (!a.runnable) bits.push('<span class="warn">Not runnable: ' + esc(a.reason || 'no reason recorded') + '</span>')
    if (a.release_hold) bits.push('<span class="warn">Release hold: ' + esc(a.release_hold) + '</span>')
    if (a.derived_on_screen) bits.push('<span class="warn">Derived text on screen: ' + esc([].concat(a.derived_on_screen).join('; ')) + '</span>')
    if (a.error) bits.push('<span class="warn">Preview failed: ' + esc(a.error) + '</span>')
    if (p && a.runnable && p.status !== 'completed') bits.push('<span class="warn">This session did not complete (' + esc(p.status) + ').</span>')
    return h + '<div class="armcard">' + bits.join('<br>') + '</div>'
  }
  function legend() {
    return '<div class="legend"><span>Plain text = verbatim from the administered material</span>' +
      '<span><i class="sw rep"></i>reported / derived (hover for the source)</span><span><i class="sw mis"></i>missing (a gap)</span>' +
      '<span>Small grey notes are operator notes, not on the participant\'s screen.</span></div>'
  }
  function participantView() {
    var a = arm(), p = part()
    var h = armPicker() + legend()
    if (!p || !p.screens.length) return h + '<div class="hs-card imgmiss">No session of this arm could be played to a screen. ' + (a.runnable ? 'This is a finding for review.' : '') + '</div>'
    S.scr = Math.max(0, Math.min(S.scr, p.screens.length - 1))
    var cur = p.screens[S.scr], sc = D.screens[cur.key]
    h += '<div class="nav"><button class="ghost" id="prev"' + (S.scr === 0 ? ' disabled' : '') + ' aria-label="Previous screen">← Prev</button>' +
      '<span class="pos">Screen ' + (S.scr + 1) + ' of ' + p.screens.length + '</span>' +
      '<button class="ghost" id="next"' + (S.scr === p.screens.length - 1 ? ' disabled' : '') + ' aria-label="Next screen">Next →</button>' +
      '<select id="jump" aria-label="Jump to screen">' + p.screens.map(function (s, i) {
        return '<option value="' + i + '"' + (i === S.scr ? ' selected' : '') + '>' + (i + 1) + '. ' + esc(D.screens[s.key].names.join(' + ')) + '</option>'
      }).join('') + '</select></div>'
    var notes = timingNotes(sc)
    if (cur.reviewable) notes.push(cur.reviewable + ' earlier item(s) can be reopened')
    h += '<div class="notes">' + notes.map(function (n) { return '<span>' + esc(n) + '</span>' }).join('') + '<span class="uitag" style="margin-left:auto">' + esc(sc.names.join(' + ')) + '</span></div>'
    if (cur.events && cur.events.length) h += '<div class="events"><b>Shown on arrival (group outcome)</b>' + cur.events.map(function (e) { return '<div>' + esc(typeof e === 'string' ? e : JSON.stringify(e)) + '</div>' }).join('') + '</div>'
    h += '<div class="screen" lang="' + esc(a.language || D.language || 'en') + '">' + renderScreen(sc, 's' + S.scr) + '</div>'
    return h
  }
  function conditionsView() {
    var C = D.conditions
    var h = '<div class="opbanner"><b>Operator view.</b> Participants never see this page: it names arms, conditions and flow variables. ' +
      'It compares every screen played while building this preview (' + C.sessions + ' sessions, seed ' + D.seed + '); a variant that no session drew is not listed, so read it with the static list below.</div>'
    var partial = C.partial || []
    if (partial.length) {
      h += '<h3 style="margin:14px 0 4px;font-size:14px">Screens only some arms see</h3><p class="hs-sub">Shown in every played session of these arms and in no session of the others (' + C.played_arms.length + ' arms played).</p>'
      partial.forEach(function (e, k) {
        h += '<div class="cv"><p class="by">Only in ' + e.arms.map(function (x) { return '<code>' + esc(x) + '</code>' }).join(' ') + ' · ' + e.screens.length + ' screen(s)</p>' +
          e.screens.map(function (x, i) {
            var t = x.names.join(' + ') + (Object.keys(x.item).length ? ' — ' + Object.keys(x.item).map(function (q) { return q + ' = ' + x.item[q] }).join(', ') : '')
            return '<details data-pk="' + k + '" data-pi="' + i + '"><summary>' + esc(t) + '</summary><div class="screen mini"></div></details>'
          }).join('') + '</div>'
      })
    }
    if (C.sometimes) h += '<p class="hs-sub">' + C.sometimes + ' screen(s) appeared in only some sessions (a random draw or an earlier answer decides), so they are not counted as arm-specific.</p>'
    h += '<h3 style="margin:22px 0 4px;font-size:14px">Screens whose content differs</h3><p class="hs-sub">' + C.differ.length + ' screen(s) differ between sessions; ' + C.same + ' are identical wherever they appeared. Highlighted words differ from the first variant.</p>'
    C.differ.forEach(function (d, k) {
      var title = d.names.join(' + ') + (Object.keys(d.item).length ? ' — ' + Object.keys(d.item).map(function (x) { return x + ' = ' + d.item[x] }).join(', ') : '')
      var by = d.by.length ? 'Differs by ' + d.by.join(' × ') : 'Differs with earlier answers or random draws (no single variable explains it)'
      var only = C.played_arms && d.in_arms && d.in_arms.length < C.played_arms.length ? ' · only in ' + d.in_arms.join(', ') : ''
      h += '<div class="cv"><h3>' + esc(title) + '</h3><p class="by">' + esc(by + only) + ' · ' + d.variants.length + ' variants</p>'
      var base = screenText(D.screens[d.variants[0].key])
      var cap = d.by.length ? d.variants.length : Math.min(3, d.variants.length)
      d.variants.forEach(function (v, i) {
        if (i >= cap) return
        var who = []
        var allArms = D.arms.length > 1 && v.arms.length === D.arms.length
        if (d.by.indexOf('arm') >= 0 || D.arms.length > 1) who.push(allArms ? 'all arms' : 'arms: ' + v.arms.map(function (x) { return '<code>' + esc(x) + '</code>' }).join(''))
        Object.keys(v.when || {}).forEach(function (key) { if (key !== 'arm') who.push(esc(key) + ' = ' + v.when[key].map(function (x) { return '<code>' + esc(x.replace(/^"|"$/g, '')) + '</code>' }).join(' ')) })
        who.push(v.n + ' time(s)')
        var txt = screenText(D.screens[v.key])
        var df = i === 0 ? { html: esc(txt), mostly: false } : diffHtml(base, txt)
        h += '<div class="var"><div class="who">' + who.join(' · ') + (df.mostly ? ' · <i>mostly different text (e.g. another language)</i>' : '') + '</div>' +
          '<div class="txt">' + df.html + '</div>' +
          '<details data-k="' + k + '" data-v="' + i + '"><summary>Show as the participant saw it</summary><div class="screen mini"></div></details></div>'
      })
      if (cap < d.variants.length) h += '<p class="wnote">+ ' + (d.variants.length - cap) + ' more variant(s) of the same kind (values piped from earlier answers or random draws).</p>'
      h += '</div>'
    })
    var st = C.static || {}, keys = Object.keys(st)
    h += '<h3 style="margin:22px 0 4px;font-size:14px">Static: stages whose content reads a condition or flow variable</h3>' +
      '<p class="hs-sub">From the protocol\'s expressions, independent of which sessions were drawn.</p>'
    h += keys.length ? '<ul class="static">' + keys.map(function (s) { return '<li><code>' + esc(s) + '</code> — ' + st[s].map(esc).join(', ') + '</li>' }).join('') + '</ul>' : '<p class="static">None: no stage reads <code>arm</code> or a flow variable.</p>'
    return h
  }

  function render() {
    document.body.classList.toggle('marks-on', S.marks)
    app.innerHTML = header() + (S.view === 'participant' ? participantView() : conditionsView())
    hydrateImages(app)
    try { store('state', JSON.stringify({ arm: D.arms[S.arm].id, view: S.view, marks: S.marks, theme: S.theme, study: D.study })) } catch (e) { /* no storage */ }
  }
  /** images are set through the DOM from the data table (no URL in the markup). */
  function hydrateImages(root) {
    Array.prototype.forEach.call(root.querySelectorAll('img[data-img]'), function (im) {
      var x = D.images[im.getAttribute('data-img')]
      if (x && x.uri) im.src = x.uri
    })
  }

  // ---------- events ----------
  document.addEventListener('change', function (e) {
    var t = e.target
    if (t.id === 'arm') { S.arm = +t.value; S.pid = 0; S.scr = 0; render() }
    else if (t.id === 'pid') { S.pid = +t.value; S.scr = 0; render() }
    else if (t.id === 'jump') { S.scr = +t.value; render() }
    else if (t.id === 'marks') { S.marks = t.checked; render() }
  })
  document.addEventListener('toggle', function (e) {
    var d = e.target
    if (!d || d.tagName !== 'DETAILS' || !d.open) return
    var box = d.querySelector('.screen.mini'), key = null, nm = ''
    if (!box || box.innerHTML) return
    if (d.hasAttribute('data-k')) {
      key = D.conditions.differ[+d.getAttribute('data-k')].variants[+d.getAttribute('data-v')].key
      nm = 'c' + d.getAttribute('data-k') + '_' + d.getAttribute('data-v')
    } else if (d.hasAttribute('data-pk')) {
      var ks = D.conditions.partial[+d.getAttribute('data-pk')].screens[+d.getAttribute('data-pi')].keys
      key = ks[0]; nm = 'p' + d.getAttribute('data-pk') + '_' + d.getAttribute('data-pi')
      if (ks.length > 1) box.insertAdjacentHTML('beforebegin', '<div class="wnote">' + ks.length + ' variants of this screen; the first is shown.</div>')
    }
    if (key) { box.innerHTML = renderScreen(D.screens[key], nm); hydrateImages(box) }
  }, true)
  function post(msg) { try { window.parent.postMessage(msg, '*') } catch (e) { /* standalone file */ } }
  document.addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.closest) return
    if (t.closest('[data-view]')) { S.view = t.closest('[data-view]').getAttribute('data-view'); render(); return }
    if (t.id === 'prev') { S.scr--; render(); return }
    if (t.id === 'next') { S.scr++; render(); return }
    if (t.id === 'theme') { S.theme = { auto: 'light', light: 'dark', dark: 'auto' }[S.theme]; applyTheme(); render(); return }
    var el = t.closest('[data-page],[data-program-id]')
    if (!el || t.closest('input,select,textarea,summary')) return
    var m = { type: 'hs.openSource' }
    if (el.getAttribute('data-page')) m.page = parseInt(el.getAttribute('data-page'), 10)
    if (el.getAttribute('data-quote')) m.quote = el.getAttribute('data-quote').slice(0, 2000)
    if (el.getAttribute('data-program-id')) m.programId = el.getAttribute('data-program-id')
    if (el.getAttribute('data-file')) m.file = el.getAttribute('data-file')
    if (m.page != null || m.quote || m.file) post(m)
  })
  document.addEventListener('keydown', function (e) {
    if (S.view !== 'participant' || /INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return
    var p = part()
    if (!p) return
    if (e.key === 'ArrowRight' && S.scr < p.screens.length - 1) { S.scr++; render() }
    else if (e.key === 'ArrowLeft' && S.scr > 0) { S.scr--; render() }
  })
  var tip = null
  function showTip(e) {
    var el = e.target && e.target.closest && e.target.closest('[data-tip]')
    if (el && el.classList.contains('mk') && !S.marks) el = null
    if (!el) { if (tip) tip.classList.remove('on'); return }
    if (!tip) { tip = document.createElement('div'); tip.className = 'hs-tip'; document.body.appendChild(tip) }
    tip.textContent = el.getAttribute('data-tip')
    var x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 12), y = e.clientY + 14
    if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 10
    tip.style.left = Math.max(12, x) + 'px'; tip.style.top = Math.max(8, y) + 'px'
    tip.classList.add('on')
  }
  document.addEventListener('mousemove', showTip)
  document.addEventListener('focusin', function (e) { if (e.target && e.target.closest && e.target.closest('[data-tip]')) { var r = e.target.getBoundingClientRect(); showTip({ target: e.target, clientX: r.left, clientY: r.bottom }) } })

  load().then(function (d) {
    D = d
    var saved = null
    try { saved = JSON.parse(store('state') || 'null') } catch (e) { saved = null }
    if (saved && saved.study === D.study) {
      var i = D.arms.findIndex(function (a) { return a.id === saved.arm })
      if (i >= 0) S.arm = i
      if (saved.view) S.view = saved.view
      if (typeof saved.marks === 'boolean') S.marks = saved.marks
      if (saved.theme) S.theme = saved.theme
    }
    applyTheme()
    render()
  }).catch(function (e) {
    app.innerHTML = '<div class="hs-error">' + esc('Could not open the preview: ' + (e && e.message || e)) + '</div>'
  })
})()
