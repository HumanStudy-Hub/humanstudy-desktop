#!/usr/bin/env python3
"""Trusted, static desktop readiness gate. Never imports or executes package code.

The app runs its own bundled copy, never the project's editable checker scripts.
Dynamic prompt capture and adapter smoke tests remain part of the independent build audit.
"""
import contextlib
import io
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sandbox_run


def static_checks(root, slug):
    import jsonschema
    import check_program
    import check_validity
    import check_verbatim
    import check_results
    import sources
    import effects
    root = Path(root).resolve()
    program_path = root / 'program.json'
    program = json.loads(program_path.read_text(encoding='utf-8'))
    schema = json.loads((Path(__file__).resolve().parents[2] / 'schema/human-program.schema.json').read_text())
    problems = []

    def record(name, found):
        for problem in found:
            message = problem[0] if isinstance(problem, (list, tuple)) else problem
            problems.append({'check': name, 'reason': ' '.join(str(message).split())[:350]})

    def run(name, fn):
        try:
            record(name, fn())
        except Exception as exc:
            record(name, ['cannot complete check (%s)' % type(exc).__name__])

    def program_check():
        found = [('schema: %s' % e.message, '') for e in jsonschema.validators.validator_for(schema)(schema).iter_errors(program)]
        if not found:
            found += check_program.check(program)
        if not found:
            found += check_program.coverage_problems(program)
        return found

    run('program', program_check)
    run('sources', lambda: sources.problems(root))
    run('validity', lambda: check_validity.check(root, root / 'package' / slug, capture_prompts=False)['problems'])
    run('verbatim', lambda: [r['field'] + ': ' + r['status'] + ': ' + r['info']
                            for r in check_verbatim.check(program_path)['results']
                            if r['status'] not in ('found', 'unchecked', 'table_text_layer', 'close_unverified')])
    run('results', lambda: check_results.check(program_path)['problems'])

    def effect_check():
        doc = effects.effects_core.load(root)
        if doc is None:
            return ['effects.json is missing']
        found, _ = effects.effects_core.check(root, doc, program)
        return found + effects.build_rules(doc, program)
    run('effects', effect_check)  # Never effects.field_gaps: it executes an adapter probe.
    return {'problems': problems, 'mode': 'static; no package execution'}


def main(argv):
    if len(argv) == 3 and argv[0] == '--worker':
        try:
            # Imported helpers may print diagnostics; the protocol remains a single JSON document.
            with contextlib.redirect_stdout(io.StringIO()):
                report = static_checks(argv[1], argv[2])
        except Exception as exc:
            report = {'problems': [{'check': 'runtime', 'reason': 'cannot complete scientific checks (%s)' % type(exc).__name__}]}
        print(json.dumps(report))
        return 0
    if len(argv) != 2 or Path(argv[1]).name != argv[1] or argv[1] in ('.', '..'):
        raise SystemExit('usage: check_readiness.py PROJECT PACKAGE_SLUG')
    root = Path(argv[0]).resolve()
    with sandbox_run.work_dir(prefix='readiness-') as work:
        result = sandbox_run.run_python(Path(__file__).resolve(), ['--worker', root, argv[1]],
                                        cwd=work, work=work, read=[root], timeout=120)
    if result.returncode or result.timed_out:
        print(json.dumps({'problems': [{'check': 'runtime', 'reason': 'scientific checks could not complete'}]}))
        return 0
    try:
        report = json.loads(result.stdout)
        if not isinstance(report.get('problems'), list):
            raise ValueError('missing result')
    except (ValueError, AttributeError):
        report = {'problems': [{'check': 'runtime', 'reason': 'scientific check result is unreadable'}]}
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
