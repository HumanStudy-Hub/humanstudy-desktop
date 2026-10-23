#!/usr/bin/env python3
"""Make an artifact self-contained and check it.

    python .opencode/artifact-kit/inline.py artifacts/<name>.html [--program program.json]

Replaces <link href="hs-kit.css">, <script src="hs-kit.js"> and <script src="chart.umd.min.js">
with the kit's content (re-running refreshes them), embeds a slim copy of program.json as
<script id="hs-program"> so HS components can resolve ids and pages, adds a no-network
Content-Security-Policy, then checks: no network references, every static data-program-id exists
in program.json, data-page values match the item's evidence pages. Prints PASS or the problems
(exit 1). Standard library only.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parent
CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
       "font-src data:; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'")
MAX_BYTES = 3_000_000

BLOCK = re.compile(r'<(script|style)\b[^>]*\bdata-hs-kit="([a-z-]+)"[^>]*>.*?</\1>\s*', re.S | re.I)
LINK_CSS = re.compile(r'<link\b[^>]*href=["\'][^"\']*hs-kit\.css["\'][^>]*>\s*', re.I)
SCRIPT_SRC = re.compile(r'<script\b[^>]*src=["\'][^"\']*?(hs-kit\.js|chart(?:\.umd)?(?:\.min)?\.js)["\'][^>]*>\s*</script>\s*', re.I)
CSP_META = re.compile(r'<meta\b[^>]*http-equiv=["\']Content-Security-Policy["\'][^>]*>\s*', re.I)


def _js(text: str) -> str:
    return text.replace('</script', '<\\/script').replace('<!--', '<\\!--')


def slim_program(program: dict) -> dict:
    """What the kit needs: ids, titles, fields, steps, evidence pages and short quotes, issues."""
    def strip(x):
        if isinstance(x, dict):
            return {k: strip(v) for k, v in x.items() if k != 'extensions'}
        if isinstance(x, list):
            return [strip(v) for v in x]
        return x
    out = {k: strip(program.get(k)) for k in ('id', 'title', 'source', 'studies', 'nodes', 'steps', 'issues') if k in program}
    out['evidence'] = [
        {k: v for k, v in {'id': e.get('id'), 'locator': {'page': (e.get('locator') or {}).get('page')},
                           'quote': (e.get('quote') or ''), 'path': e.get('path')}.items() if v is not None}
        for e in program.get('evidence') or []
    ]
    return out


def known_ids(program: dict) -> dict[str, set]:
    """id -> evidence pages (empty set when the item has no cited page)."""
    ev = {e.get('id'): (e.get('locator') or {}).get('page') for e in program.get('evidence') or []}

    def pages(ids):
        return {ev.get(i) for i in ids or [] if ev.get(i) is not None}
    ids: dict[str, set] = {}
    for s in program.get('studies') or []:
        ids[s['id']] = set()
    for e in program.get('evidence') or []:
        ids[e['id']] = {ev.get(e['id'])} - {None}
    for n in program.get('nodes') or []:
        node_pages = pages(n.get('evidenceIds'))
        ids[n['id']] = set(node_pages)
        for f in n.get('fields') or []:
            fp = pages(f.get('evidenceIds'))
            ids[f"{n['id']}/{f['id']}"] = fp
            ids[n['id']] |= fp
    for s in program.get('steps') or []:
        ids[s['id']] = pages(s.get('evidenceIds'))
        ids['flow:' + s['id']] = ids[s['id']]
    for i in program.get('issues') or []:
        ids[i['id']] = pages(i.get('evidenceIds'))
    return ids


MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp'}


def embed_images(html: str, base: Path) -> str:
    """<img src="results.png"> (a project file next to the artifact) becomes a data: URI."""
    import base64

    def sub(m):
        src = m.group(2)
        if re.match(r'^(?:[a-z]+:|//|#)', src, re.I):
            return m.group(0)
        f = (base / src).resolve()
        if f.suffix.lower() not in MIME or not f.is_file() or f.stat().st_size > 5_000_000:
            return m.group(0)
        data = base64.b64encode(f.read_bytes()).decode('ascii')
        return f'{m.group(1)}data:{MIME[f.suffix.lower()]};base64,{data}{m.group(3)}'
    return re.sub(r'(<img\b[^>]*\bsrc=["\'])([^"\']+)(["\'])', sub, html, flags=re.I)


def inline(html: str, program: dict | None) -> str:
    css = (KIT / 'hs-kit.css').read_text('utf-8')
    js = (KIT / 'hs-kit.js').read_text('utf-8')
    chart = (KIT / 'chart.umd.min.js').read_text('utf-8')
    wants_chart = 'data-hs-kit="chart"' in html or bool(SCRIPT_SRC.search(page_text(html)) and any(
        m.group(1).lower() != 'hs-kit.js' for m in SCRIPT_SRC.finditer(page_text(html))))

    # Mark where previous kit blocks / references were, then drop them.
    placeholder = {'css': '\x00CSS\x00', 'js': '\x00JS\x00'}
    html = CSP_META.sub('', html)

    def from_block(m):
        kind = m.group(2)
        if kind == 'css':
            return placeholder['css']
        if kind == 'js':
            return placeholder['js']
        return ''  # program / chart are re-emitted next to js
    html = BLOCK.sub(from_block, html)
    html = LINK_CSS.sub(lambda m: placeholder['css'], html, count=1)
    html = LINK_CSS.sub('', html)

    def from_script(m):
        return placeholder['js'] if m.group(1).lower() == 'hs-kit.js' else ''
    html = SCRIPT_SRC.sub(from_script, html)

    if not re.search(r'<html\b', html, re.I):
        html = '<!doctype html>\n<html>\n<head></head>\n<body>\n' + html + '\n</body>\n</html>\n'
    if not re.search(r'<head\b', html, re.I):
        html = re.sub(r'(<html\b[^>]*>)', r'\1\n<head></head>', html, count=1, flags=re.I)

    css_block = f'<style data-hs-kit="css">\n{css}</style>\n'
    js_parts = []
    if program is not None:
        js_parts.append('<script type="application/json" id="hs-program" data-hs-kit="program">'
                        + _js(json.dumps(slim_program(program), ensure_ascii=False)) + '</script>\n')
    if wants_chart:
        js_parts.append(f'<script data-hs-kit="chart">\n{_js(chart)}\n</script>\n')
    js_parts.append(f'<script data-hs-kit="js">\n{_js(js)}</script>\n')
    js_block = ''.join(js_parts)

    head_open = re.search(r'<head\b[^>]*>', html, re.I)
    meta = f'\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="{CSP}">\n'
    if not re.search(r'<meta\b[^>]*name=["\']viewport', html, re.I):
        meta += '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    html = re.sub(r'<meta\s+charset=["\']?[\w-]+["\']?\s*/?>\s*', '', html, flags=re.I)
    head_open = re.search(r'<head\b[^>]*>', html, re.I)
    html = html[:head_open.end()] + meta + html[head_open.end():]

    # Kit CSS/JS go where the page referenced them; otherwise at the end of <head>,
    # so inline page scripts that call HS always run after it.
    head_close = re.search(r'</head\s*>', html, re.I)
    if placeholder['css'] not in html:
        html = html[:head_close.start()] + placeholder['css'] + html[head_close.start():]
    head_close = re.search(r'</head\s*>', html, re.I)
    if placeholder['js'] not in html:
        html = html[:head_close.start()] + placeholder['js'] + html[head_close.start():]
    html = html.replace(placeholder['css'], css_block, 1).replace(placeholder['css'], '')
    html = html.replace(placeholder['js'], js_block, 1).replace(placeholder['js'], '')
    return html


def _calls(script: str, names: tuple[str, ...]) -> list[str]:
    """The source text of each call to one of `names` (balanced parentheses, strings skipped)."""
    out = []
    for m in re.finditer('|'.join(re.escape(n) + r'\s*\(' for n in names), script):
        depth, i, quote = 0, m.end() - 1, None
        while i < len(script):
            c = script[i]
            if quote:
                if c == '\\':
                    i += 1
                elif c == quote:
                    quote = None
            elif c in '\'"`':
                quote = c
            elif c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    break
            i += 1
        out.append(script[m.start():i + 1])
    return out


def page_text(html: str) -> str:
    """The artifact without kit blocks: what the agent wrote."""
    return BLOCK.sub('', html)


def check(html: str, program: dict | None) -> tuple[list[str], list[str]]:
    problems: list[str] = []
    warnings: list[str] = []
    own = page_text(html)
    no_scripts = re.sub(r'<script\b.*?</script>', '', own, flags=re.S | re.I)
    for pat, what in [
        (r'\b(?:src|href|action|poster)\s*=\s*["\']?\s*(?:https?:)?//', 'loads a URL'),
        (r'url\(\s*["\']?\s*(?:https?:)?//', 'CSS url() to the network'),
        (r'@import\b', 'CSS @import'),
        (r'\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon|EventSource', 'network call in script'),
        (r'<iframe\b|<object\b|<embed\b', 'embedded frame/object'),
    ]:
        for m in re.finditer(pat, own, re.I):
            line = own.count('\n', 0, m.start()) + 1
            problems.append(f'line {line}: {what} — artifacts must work offline; inline it or remove it')
    for m in re.finditer(r'<(?:script|img|source|video|audio)\b[^>]*\bsrc=["\'](?!data:|blob:)([^"\']+)["\']|<link\b[^>]*\bhref=["\'](?!data:)([^"\']+)["\']', own, re.I):
        ref = m.group(1) or m.group(2)
        if re.match(r'^(?:https?:)?//', ref, re.I):
            continue  # already reported as a URL
        line = own.count('\n', 0, m.start()) + 1
        problems.append(f'line {line}: "{ref}" is a separate file; artifacts must carry everything inline '
                        '(images next to the artifact are embedded automatically when they exist)')
    if 'data-hs-kit="js"' not in html:
        problems.append('kit script missing after inlining (internal error)')
    if program is not None:
        ids = known_ids(program)
        for m in re.finditer(r'<[^>]*\bdata-program-id\s*=\s*["\']([^"\']+)["\'][^>]*>', no_scripts):
            pid = m.group(1)
            line = own.count('\n', 0, m.start()) + 1
            if pid not in ids:
                problems.append(f'line {line}: data-program-id="{pid}" is not an id in program.json '
                                '(use a node, step, study, evidence or "<nodeId>/<fieldId>" id)')
                continue
            pg = re.search(r'\bdata-page\s*=\s*["\'](\d+)["\']', m.group(0))
            if pg and ids[pid] and int(pg.group(1)) not in ids[pid]:
                problems.append(f'line {line}: data-page="{pg.group(1)}" on {pid} but its evidence is on '
                                f'p. {", ".join(str(p) for p in sorted(ids[pid]))}')
        # every reported value in a chart names the program item it comes from
        for script in re.findall(r'<script\b(?![^>]*data-hs-kit)[^>]*>(.*?)</script>', own, re.S | re.I):
            for call in _calls(script, ('HS.results', 'HS.forest')):
                if not re.search(r'\bid\s*:', call):
                    problems.append(f'{call[:40].strip()}...: no group has an id. Give each group (or bar) '
                                    "id: '<result node id>' so a click opens that result and its source")
        # ids passed to HS components in page scripts: id: 'x'
        for script in re.findall(r'<script\b(?![^>]*data-hs-kit)[^>]*>(.*?)</script>', own, re.S | re.I):
            for m in re.finditer(r'\b(?:id|programId)\s*:\s*["\']([A-Za-z0-9][A-Za-z0-9._:/-]*)["\']', script):
                if m.group(1) not in ids:
                    warnings.append(f'script: id "{m.group(1)}" is not an id in program.json '
                                    '(fine for a tab id; wrong if it names a program item)')
    size = len(html.encode('utf-8'))
    if size > MAX_BYTES:
        problems.append(f'file is {size // 1024} KB; keep artifacts under {MAX_BYTES // 1_000_000} MB')
    return problems, warnings


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(description='Inline the HumanStudy artifact kit and check an artifact.')
    ap.add_argument('html', help='artifacts/<name>.html, rewritten in place')
    ap.add_argument('--program', help='program.json (default: found next to the project root)')
    a = ap.parse_args(argv)
    target = Path(a.html)
    prog_path = Path(a.program) if a.program else None
    if prog_path is None:
        for base in [Path.cwd(), *target.resolve().parents]:
            if (base / 'program.json').is_file():
                prog_path = base / 'program.json'
                break
    program = None
    if prog_path and prog_path.is_file():
        try:
            program = json.loads(prog_path.read_text('utf-8'))
        except json.JSONDecodeError as e:
            print(f'program.json is not valid JSON ({e}); ids are not checked')
    out = inline(embed_images(target.read_text('utf-8'), target.resolve().parent), program)
    target.write_text(out, 'utf-8')
    problems, warnings = check(out, program)
    for w in warnings:
        print('  warning: ' + w)
    if problems:
        print(f'FAIL {target} - {len(problems)} problem(s):')
        for p in problems:
            print('  - ' + p)
        return 1
    version = json.loads((KIT / 'kit.json').read_text('utf-8'))['version']
    print(f'PASS {target} ({len(out.encode("utf-8")) // 1024} KB, hs-kit {version}'
          f'{", program embedded" if program is not None else ", no program.json found"})')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
