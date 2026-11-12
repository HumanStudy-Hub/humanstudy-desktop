#!/usr/bin/env python3
"""Curated, source-linked pilot documents; no model calls and no edits to an existing protocol.

Mazzarella's CC BY document is shipped. Knobe is a local-only pilot; provide its existing
sandbox directory and a fresh --knobe-out. Never publish its source files with this script.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import re

ROOT = Path(__file__).resolve().parents[1]
KINDS = ['background', 'hypothesis', 'design', 'participants', 'material', 'procedure', 'variable', 'analysis', 'result', 'finding', 'limitation']


def make_program(folder, slug, title, authors, source_file, rows, pages, studies):
    raw = (folder / 'protocol.json').read_bytes()
    protocol = json.loads(raw)
    evidence = [{'id': f'p{page}', 'sourceId': 'paper', 'path': source_file,
                 'locator': {'page': page}, 'quote': quote, 'verification': 'unverified'} for page, quote in pages.items()]
    nodes = []
    for kind, heading, text, cites, interpretation in rows:
        field = {'id': 'account', 'label': heading, 'value': text, 'origin': 'derived' if interpretation else 'reported',
                 'state': 'check', 'evidenceIds': [f'p{page}' for page in cites]}
        if interpretation:
            field['derivation'] = interpretation
        node = {'id': kind, 'kind': kind, 'title': heading, 'studyIds': [s['id'] for s in studies],
                'fields': [field], 'evidenceIds': field['evidenceIds']}
        if kind == 'result':
            node['extensions'] = {'effectRefs': [e['id'] for e in protocol.get('analysis', {}).get('effects', [])]}
        nodes.append(node)
    assert set(n['kind'] for n in nodes) == set(KINDS)
    return {'schemaVersion': 2, 'id': slug, 'title': title, 'intent': 'reconstruct',
            'source': {'title': title, 'authors': authors, 'filename': source_file}, 'studies': studies,
            'nodes': nodes, 'steps': [], 'relations': [
                {'id': 'question-prediction', 'from': 'background', 'to': 'hypothesis', 'type': 'motivates'},
                {'id': 'prediction-design', 'from': 'hypothesis', 'to': 'design', 'type': 'tested-by'},
                {'id': 'result-conclusion', 'from': 'result', 'to': 'finding', 'type': 'informs'}],
            'evidence': evidence, 'issues': [], 'extensions': {'scholarly': {'profile': 'scholarly-v1',
                'status': 'draft', 'review': 'Curated pilot; scholarly source fidelity has not received independent review.',
                'protocol': {'path': 'protocol.json', 'id': protocol['id'], 'sha256': hashlib.sha256(raw).hexdigest()}}}}


def mazzarella():
    folder = ROOT / 'app/resources/protocol-sample'
    # Full source sentences on the cited physical PDF pages; kept separate from the paraphrases.
    text = (folder / 'sourcetext/paper.txt').read_text()
    parts = re.split(r'=== page (\d+) ===', text)
    page_text = {int(parts[i]): parts[i+1] for i in range(1, len(parts), 2)}
    # Original page text is retained in full in sourcetext; these are addressable source passages.
    pages = {
        1: 'In two experiments, we test the hypothesis that, in these face-threatening contexts, scalar inferences are largely derived but are less likely to be accepted as true.',
        4: 'Study 1 relies on Bonnefon et al.’s (2011) original materials, while Study 2 introduces some motivated changes to the materials in order to increase the likelihood that the scalar inference would be effectively derived.',
        5: 'We recruited 399 participants through Amazon Mechanical Turk',
        6: 'In the face-boost condition, participants were more divided: 36% said “No” and 64% answered “Yes.”',
        8: 'There was no conversational implicature question.',
        9: 'General Discussion',
        10: 'The challenge for the future is to devise new paradigms to study comprehension and epistemic assessment as two distinct components in the process of forming beliefs via testimony.',
    }
    for page, quote in pages.items():
        norm = lambda s: re.sub(r'\s+', ' ', s).strip().lower()
        assert norm(quote) in norm(page_text[page]), (page, quote)
    rows = [
        ('background', 'Why this research?', 'When someone says “some”, does politeness change what a listener understands, or whether the listener believes it? Earlier work treated answers to a compatibility question as evidence of comprehension. This paper separates comprehension from acceptance of a speaker’s message.', [1, 4], ''),
        ('hypothesis', 'What did the authors predict?', 'Face-threatening messages can trigger a “not all” inference that listeners subsequently reject as untrustworthy. The authors predict additional time at the later question/epistemic-assessment stage, rather than the utterance/comprehension stage. The two studies also examine categorical responses and the effect of clarifying the story.', [1, 4], ''),
        ('design', 'How the studies connect', 'Both studies compare face-threat and face-boost versions between participants. Study 1 separates the story, utterance and questions and includes a conversational-implicature question. Study 2 clarifies the speaker’s knowledge and the listener’s purpose, and removes that extra question. The studies are related tests, not two experimental conditions.', [4, 8], ''),
        ('participants', 'Who took part?', 'Amazon Mechanical Turk workers: Study 1 recruited 399 and analysed 292 participants; Study 2 recruited 398 and analysed 294. The paper reports exclusions involving reading/response behaviour. Recruited and analysed counts are kept separate in the experiment protocol.', [5, 8], ''),
        ('material', 'What participants encountered', 'A speech vignette and Denise’s comment that some people hated or loved the speech. Study-specific wording and questions are printed in the paper and Appendix A. The participant preview uses those original texts; this research summary is not shown to simulated participants.', [4, 5, 8], ''),
        ('procedure', 'What happened?', 'Participants read the vignette, then the utterance, then answer the semantic-compatibility question. Study 1 adds a question about giving the speech again. The original study collected separate reaction times. Exact executable screens and ordering belong to the linked protocol.', [4, 5, 8], ''),
        ('variable', 'What was measured?', 'The manipulated context is face-threat versus face-boost. Outcomes include Yes/No compatibility responses, the Study 1 conversational-implicature response and original reaction-time measures. Compatibility responses alone must not be equated with direct observation of comprehension.', [1, 5, 8], ''),
        ('analysis', 'What can we compare?', 'The current environment supports categorical response proportions and the declared within-study contrasts. The original paper also reports reaction-time analyses and logistic regressions; those are outside this environment’s supported replay. Timing/click exclusions cannot be claimed reproduced by this text-only replay.', [5, 8, 9], 'Supported replay scope is read from protocol.analysis and protocol.omitted; it is distinct from the paper’s complete analysis.'),
        ('result', 'What did the paper report?', 'Study 1: compatibility Yes responses were 45% for face-threat and 32% for face-boost; the speech-again question yielded 7% versus 64% Yes. Study 2: compatibility Yes responses were 45% versus 12.5%. These are reported human results, not new simulation outputs; exact computable targets and contrasts are referenced from the protocol.', [5, 6, 8], ''),
        ('finding', 'What is the main takeaway?', 'The authors argue that understanding an implied message and accepting it as true are distinct processes. They locate the face-threat slowdown in epistemic assessment rather than comprehension. A categorical-only AI trial would test only part of that account; matching its response percentages would not establish the proposed mechanism.', [1, 10], 'The final sentence limits what our categorical replay can establish; it does not claim the paper tested AI participants.'),
        ('limitation', 'What remains open?', 'The paper calls for paradigms that more clearly separate comprehension and epistemic assessment. Our replay additionally omits reaction-time analyses and unavailable consent/control/debrief wording. Those replay omissions are not presented as limitations stated by the authors, and the current scholarly pilot is not independently reviewed.', [10], 'Distinguishes the authors’ future-work statement from the declared implementation scope and review status.'),
    ]
    studies = [{'id': 's1', 'title': 'Study 1 · Speech and interpretation', 'type': 'empirical', 'description': 'Compare context and two kinds of interpretation questions.'},
               {'id': 's2', 'title': 'Study 2 · Clarified context', 'type': 'empirical', 'description': 'Clarify the speaker’s knowledge and retain the compatibility question.', 'dependsOn': ['s1']}]
    p = make_program(folder, 'mazzarella2018politeness-research', 'Believing what you’re told: politeness and scalar inferences', 'Mazzarella, Trouche, Mercier & Noveck · 2018', 'paper.pdf', rows, pages, studies)
    (folder / 'program.json').write_text(json.dumps(p, ensure_ascii=False, indent=2)+'\n')


def knobe(source, dest):
    if dest.exists():
        raise SystemExit('Knobe pilot destination already exists; refusing to replace a researcher project.')
    dest.mkdir(parents=True)
    for rel in ['protocol.json', 'sources/knobe_preprint.pdf', 'sourcetext/preprint.txt']:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / rel, target)
    pages = {2: 'This conclusion was too hasty.', 3: 'To test this hypothesis', 4: 'As predicted', 5: 'Subjects were 42 people', 6: 'Once again', 7: 'may be at the root'}
    # Expand short locators to their complete source sentences locally. The script does not
    # embed or publish the copyrighted full passages; only the private pilot contains them.
    source_text = (dest / 'sourcetext/preprint.txt').read_text()
    chunks = re.split(r'=== page (\d+) ===', source_text)
    originals = {int(chunks[i]): chunks[i+1] for i in range(1, len(chunks), 2)}
    for page, locator in list(pages.items()):
        whole = re.sub(r'\s+', ' ', originals[page]).strip()
        pos = whole.lower().find(locator.lower())
        if pos < 0:
            # The first locator crosses a printed line break but is otherwise unchanged.
            locator = locator.rstrip('.')
            pos = whole.lower().find(locator.lower())
        assert pos >= 0, (page, locator)
        start = max(whole.rfind('. ', 0, pos), whole.rfind('? ', 0, pos))
        start = start + 2 if start >= 0 else 0
        end = whole.find('. ', pos + len(locator))
        pages[page] = whole[start:end+1] if end >= 0 else whole[start:]

    rows = [
        ('background', 'Why this research?', 'Do people judge a foreseen but unwanted side effect as intentional, and does its moral valence affect that judgment? The paper revisits an earlier general claim that intention requires trying to bring the effect about.', [2, 3], ''),
        ('hypothesis', 'What did the author predict?', 'Judgments of intentionality depend on whether the side effect is viewed as good or bad. The second experiment tests whether the pattern extends beyond corporations and environmental damage.', [3, 4], ''),
        ('design', 'How the experiments connect', 'Both experiments randomly assign people to harm or help stories. Experiment 1 concerns a company chairman and the environment. Experiment 2 transposes the structure to a lieutenant and soldiers. Praise/blame is also examined across both experiments.', [3, 4, 5, 6], ''),
        ('participants', 'Who took part?', 'People spending time in a Manhattan public park: 78 in Experiment 1 and 42 in Experiment 2. Exact per-condition sample sizes are not printed; the protocol distinguishes reported percentages from reconstructed cells.', [3, 5], ''),
        ('material', 'What is available?', 'The paper prints chairman/environment and lieutenant/soldiers vignettes. It describes the questions but does not supply an administered questionnaire with exact prompts, response labels and scale anchors. The original replay therefore stays blocked. Supplying the questionnaire could resolve that gap.', [3, 4, 5, 6], 'Material availability follows the reviewed source search and protocol; descriptions are not exact administered question wording.'),
        ('procedure', 'What happened?', 'Participants read one vignette and rated blame or praise and judged intentionality. The linked protocol records uncertainty about presentation and question ordering. It does not treat earlier converter-written question stems as verbatim.', [3, 4, 5, 6], ''),
        ('variable', 'What was measured?', 'The manipulation is a harmful versus helpful side effect. Outcomes are intentionality judgments and blame/praise ratings. These measures and their interpretation should not be conflated with evidence that the proposed causal mechanism was experimentally isolated.', [3, 4, 6, 7], 'The caution distinguishes a measured association from a causal test of the proposed mechanism.'),
        ('analysis', 'What can we compare?', 'The paper reports condition differences in intentionality and a pooled association between moral evaluation and intentionality. Original replay remains unavailable until question wording is supplied. A researcher-confirmed wording variant can be prepared separately, with its assumptions documented and no claim to exact original replication.', [4, 6, 7], 'Readiness and the proposed variant are implementation decisions, not original experimental claims.'),
        ('result', 'What did the paper report?', 'Experiment 1: 82% in harm judged the side effect intentional; 77% in help judged it not intentional. Experiment 2: corresponding figures were 77% intentional and 70% not intentional. The reported pooled blame/praise means were 4.8 and 1.4, with correlation r=.53. These are human findings, not AI-run results.', [4, 6, 7], ''),
        ('finding', 'What is the main takeaway?', 'People were more willing to attribute intentionality to harmful than helpful side effects in both settings. The author proposes that the blame/praise asymmetry may explain the intentionality asymmetry. This is a proposed explanation supported by an association, not an independently manipulated mechanism.', [4, 6, 7], 'The last sentence separates the paper’s measured association from its proposed explanation.'),
        ('limitation', 'What remains open?', 'Experiment 2 addresses the possibility that the first result is specific to corporations and environmental damage. The missing exact question wording is a current reconstruction limitation, distinct from the author’s generality concern. No original experiment is marked runnable and no hypothetical variant has been accepted.', [4], 'Separates a stated generality concern from missing source material and the current implementation status.'),
    ]
    studies = [{'id': 'e1', 'title': 'Experiment 1 · Chairman', 'type': 'empirical', 'description': 'Harm versus help in a corporate/environmental setting.'}, {'id': 'e2', 'title': 'Experiment 2 · Lieutenant', 'type': 'empirical', 'description': 'Test generality in a military setting.', 'dependsOn': ['e1']}]
    p = make_program(dest, 'knobe2003sideeffect-research', 'Intentional action and side effects in ordinary language', 'Joshua Knobe · 2003', 'sources/knobe_preprint.pdf', rows, pages, studies)
    (dest / 'program.json').write_text(json.dumps(p, ensure_ascii=False, indent=2)+'\n')
    print('Local Knobe pilot:', dest)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--knobe-source', type=Path)
    parser.add_argument('--knobe-out', type=Path)
    args = parser.parse_args()
    mazzarella()
    if args.knobe_source and args.knobe_out:
        knobe(args.knobe_source, args.knobe_out)
