// The Study view: the web build-preview study model (app/build-preview/study-model.tsx) on the
// desktop. The 12 collaborator sections (sections.ts) are the stages; each shows its content as
// cards, the procedure as a flow, conditions and materials as coloured tiles. A card opens its
// details in the dock (web: program-details.tsx); the review guide (web: review-guide.tsx) lists
// what needs a decision. Citations open the paper beside the study with the quote boxed.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { HumanProgram, ProgramField, ProgramNode } from '../../shared/human-program';
import { conditionSuggestion, fieldText, itemSources, sourceRefs, studyConditions, wordDiff, type FlowItem, type SourceRef } from '../../shared/program-view';
import { quoteKey } from '../../shared/source-anchor';
import { amberItems, fieldNeed, isPlaceholderText } from './missing';
import { SECTIONS, readiness } from './sections';
import { otherCards, reviewIssues, stage, type Card, type ReviewIssue, type Stage, type StudyCard } from './model';
import { fieldLabel } from './labels';
import { track } from '../telemetry';
import { getLang, t, translate } from '../i18n';
import s from './StudyModel.module.css';

export type { SourceRef };
export type QuoteStatus = { found: boolean; page?: number };
export type StudyModelProps = {
  program: HumanProgram;
  studyId: string;
  onStudy?(id: string): void;
  selectedIds: string[];
  /** Items cited by the passage selected in the paper, and that passage's page. */
  support?: { page: number; ids: string[] } | null;
  onClearSupport?(): void;
  changedIds?: ReadonlySet<string>;
  /** What the paper pane found for each citation it opened (quoteKey). */
  quoteStatus?: ReadonlyMap<string, QuoteStatus>;
  onPick(id: string, extend: boolean): void;
  onClearSelection?(): void;
  onAskSelection?(): void;
  onSource(id: string, source: SourceRef): void;
  /** Discuss a program item, optionally one of its fields, with the agent; draft prefills the message. */
  onAsk(id: string, fieldId?: string, draft?: string): void;
  onPrefill?(draft: string): void;
  /** Human edit of a field's text. Absent: fields are read-only. */
  onEdit?(id: string, fieldId: string, text: string): void;
  /** Simulation scope is reviewed separately before a run. */
  view?: 'study' | 'simulation';
};

/** All research units remain readable, including analyses and incomplete extractions. */
export function viewStudies(program: HumanProgram) { return program.studies; }

type Focus = { id: string; fieldId?: string; edit?: boolean };
type Ctx = StudyModelProps & { open(id: string, fieldId?: string, extend?: boolean, edit?: boolean): void; focus: Focus | null };
const sectionsFor = (view: StudyModelProps['view']) => SECTIONS.filter(sec => view === 'simulation' ? sec.id === 'simulation' : sec.id !== 'simulation');

export default function StudyModel(props: StudyModelProps) {
  const { program, studyId, selectedIds, view = 'study' } = props;
  const sections = sectionsFor(view);
  const stages = useMemo(() => sections.map(sec => stage(program, sec, studyId)), [program, studyId, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const other = useMemo(() => view === 'study' ? otherCards(program, studyId) : [], [program, studyId, view]);
  // The scope review lists only what concerns the scope; the study view everything else.
  const issues = useMemo(() => reviewIssues(program, studyId, sections).filter(i => (view === 'simulation') === (program.nodes.find(n => n.id === i.entity)?.kind === 'simulation')), [program, studyId, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const amber = useMemo(() => amberItems(program, studyId, sections), [program, studyId, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const scroll = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [inspect, setInspect] = useState(true);
  const nextAmber = useRef(0);

  // The dock follows the selection: cleared with it, moved to the last item picked elsewhere.
  useEffect(() => {
    if (!selectedIds.length) setFocus(null);
    else if (!focus || !selectedIds.includes(focus.id)) setFocus({ id: selectedIds[selectedIds.length - 1] });
  }, [selectedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const reveal = (id: string) => requestAnimationFrame(() => requestAnimationFrame(() =>
    scroll.current?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })));
  const open = (id: string, fieldId?: string, extend = false, edit = false) => {
    if (!id) return;
    track('study.card_open', { target: id, metadata: { field: fieldId ?? null, extend } });
    if (extend || !selectedIds.includes(id) || selectedIds.length > 1) props.onPick(id, extend);
    setFocus({ id, fieldId, edit });
    setInspect(true);
    reveal(id);
  };
  /** An item to resolve: select it, show its details and the paper where it is (or should be) stated. */
  const jumpTo = (entity: string, fieldId?: string, edit = false, how = 'amber') => {
    open(entity, fieldId, false, edit);
    const field = fieldId ? fieldOf(program, entity, fieldId) : undefined;
    const ref = [...(field ? sourceRefs(program, field.evidenceIds) : []), ...itemSources(program, entity)].find(r => r.page);
    track('amber.jump', { target: entity, metadata: { field: fieldId ?? null, by: how, page: ref?.page ?? null } });
    if (ref) props.onSource(entity, ref);
  };
  const jumpAmber = (sectionId?: string) => {
    const list = sectionId ? amber.filter(a => a.sectionId === sectionId) : amber;
    if (!list.length) return;
    const a = list[(sectionId ? 0 : nextAmber.current++) % list.length];
    jumpTo(a.entity, a.fieldId, true, sectionId ? 'section' : 'glance');
  };
  const ctx: Ctx = { ...props, open, focus };
  const paper = stages.find(st => st.paper)?.paper;
  const bySection = useMemo(() => amber.reduce<Record<string, number>>((m, a) => ({ ...m, [a.sectionId]: (m[a.sectionId] ?? 0) + 1 }), {}), [amber]);

  return <section className={s.model} aria-label={t('wb.study')}>
    {view === 'study' && program.studies.length > 1 && <div className={s.toolbar}><div className={s.studyTabs} role="tablist" aria-label={t('study.which')}>
      {program.studies.map(st => <button key={st.id} role="tab" title={st.title} aria-selected={st.id === studyId} onClick={() => { setFocus(null); props.onStudy?.(st.id); }}>{st.title}</button>)}
    </div></div>}
    {props.support && <div className={s.support} role="status">
      {props.support.ids.length ? <><span>{t('model.support', { n: props.support.page })}</span>{props.support.ids.map(id => <button key={id} onClick={() => open(id)}>{titleOf(program, id)}</button>)}</> : <span>{t('model.support_none')}</span>}
      {props.onClearSupport && <button className={s.supportClose} aria-label={t('chat.clear')} onClick={props.onClearSupport}>×</button>}
    </div>}
    <div className={s.scroll} ref={scroll}>
      {view === 'study' && <header className={s.heading}>
        <h1>{paper?.title ?? program.title}</h1>
        {paper && paper.meta.length > 0 && <p>{paper.meta[0]}{paper.meta.length > 1 && <>. <i>{paper.meta.slice(1).join(', ')}</i></>}</p>}
        <Glance program={program} studyId={studyId} toFill={amber.length} onFill={() => jumpAmber()} />
      </header>}
      {view === 'simulation' && (() => { const r = readiness(program, studyId); return <p className={s.readiness} data-verdict={r.tone}><i />{t('doc.readiness')} · {r.text} <em>{t('doc.assessment')}</em></p>; })()}
      {issues.length > 0 && <Guide issues={issues} ctx={ctx} jumpTo={jumpTo} />}
      <div className={s.canvas}>
        {stages.map(st => <StageView key={st.section.id} st={st} ctx={ctx} toFill={bySection[st.section.id] ?? 0} onFill={() => jumpAmber(st.section.id)} />)}
        {other.length > 0 && <section className={s.stage}><div className={s.stageLabel}><h2>{t('doc.other')}</h2></div><div className={s.cards}>{other.map(c => <CardView key={c.key} card={c} ctx={ctx} />)}</div></section>}
      </div>
    </div>
    {selectedIds.length > 0 && <Dock ctx={ctx} inspect={inspect} setInspect={setInspect} />}
  </section>;
}

/* ---- at a glance -------------------------------------------------------------------- */

function Glance({ program, studyId, toFill, onFill }: { program: HumanProgram; studyId: string; toFill: number; onFill(): void }) {
  const inStudy = (ids: string[]) => !studyId || !ids.length || ids.includes(studyId);
  const participants = participantsFact(program.nodes.filter(n => n.kind === 'participants' && inStudy(n.studyIds)));
  const conditions = studyConditions(program, studyId).length;
  const steps = program.steps.filter(st => st.studyId === studyId && (st.kind !== 'sequence' || !st.children.length)).length;
  const verdict = readiness(program, studyId);
  const facts = [participants, conditions ? t('model.n_conditions', { n: conditions }) : '', steps ? t('model.n_steps', { n: steps }) : ''].filter(Boolean);
  return <div className={s.glance} aria-label={t('glance.aria')}>
    {facts.map(f => <span key={f}>{f}</span>)}
    <span className={s.verdict} data-verdict={verdict.tone} title={t('glance.enough')}><i />{verdict.text}</span>
    {toFill > 0 && <button className={s.fillTotal} data-count={toFill} onClick={onFill} title={t('doc.to_fill_goto')}>{t('doc.to_fill', { n: toFill })}</button>}
  </div>;
}

/** Sample size when a participants field states one. */
function participantsFact(list: ProgramNode[]): string {
  const fields = list.flatMap(n => n.fields).filter(f => f.value !== null && f.value !== '' && f.state !== 'missing');
  const sizeId = /^(n|n[-_]?(total|recruited|analysed|analyzed|completed)|sample[-_]?size|total[-_]?n)$/i, sizeLabel = /\bN\b|sample/i;
  for (const f of fields) {
    if (!(sizeId.test(f.id) || sizeLabel.test(f.label))) continue;
    if (typeof f.value === 'number') return `N = ${f.value}`;
    const text = fieldText(f.value).replace(/\s+/g, ' ').trim(), m = text.match(/\d[\d,]*/);
    if (m && text.length <= 40) return /^n\s*=/i.test(text) ? text : `N = ${m[0]}`;
  }
  for (const f of fields) if (typeof f.value === 'number') return `N = ${f.value}`;
  return '';
}

/* ---- review guide (web: components/studio/review-guide.tsx) -------------------------- */

function Guide({ issues, ctx, jumpTo }: { issues: ReviewIssue[]; ctx: Ctx; jumpTo(entity: string, fieldId?: string, edit?: boolean, how?: string): void }) {
  const [deferred, setDeferred] = useState<string[]>([]), [chosen, setChosen] = useState<string>();
  const issue = issues.find(i => i.id === chosen && !deferred.includes(i.id)) ?? issues.find(i => !deferred.includes(i.id));
  const severity = (i: ReviewIssue) => i.amber ? t('guide.fill_tag') : t(`guide.${i.severity}`);
  const go = (i: ReviewIssue) => {
    track('review.open', { target: i.id, metadata: { severity: i.severity, amber: Boolean(i.amber) } });
    setChosen(i.id);
    if (i.entity) jumpTo(i.entity, i.fieldId, Boolean(i.amber), 'guide');
    else if (i.source?.page) ctx.onSource('', i.source);
  };
  const discuss = (i: ReviewIssue) => {
    const draft = t('guide.help_draft', { t: i.title, r: i.reason });
    if (i.entity) ctx.onAsk(i.entity, i.fieldId, draft); else ctx.onPrefill?.(draft);
  };
  const answer = (i: ReviewIssue) => {
    if (i.amber && i.entity) return jumpTo(i.entity, i.fieldId, true, 'guide');
    const draft = t('guide.decide_draft', { t: i.title });
    if (i.entity) ctx.onAsk(i.entity, i.fieldId, draft); else ctx.onPrefill?.(draft);
  };
  return <section className={s.guide} aria-label={t('guide.next')}>
    <div className={s.guideHeading}><span>{t('guide.next')}</span><small>{issues.length - deferred.length}/{issues.length}</small></div>
    {issue ? <>
      <button className={s.guideTitle} onClick={() => go(issue)}><b className={s.severity} data-severity={issue.amber ? 'fill' : issue.severity}>{severity(issue)}</b>{issue.title} <span aria-hidden>↗</span></button>
      {issue.reason && <p>{issue.reason}</p>}
      {(issue.impact || issue.suggestedAction || issue.quote) && <details><summary>{t('guide.why')}</summary>
        {issue.impact && <p>{issue.impact}</p>}{issue.suggestedAction && <p>{issue.suggestedAction}</p>}
        {issue.quote && <blockquote>{issue.quote}</blockquote>}
        {issue.source?.page && <button className={s.linkButton} onClick={() => ctx.onSource(issue.entity ?? '', issue.source!)}>{t('guide.view_source', { n: issue.source.page })}</button>}
      </details>}
      <div className={s.guideActions}>
        <button onClick={() => answer(issue)}>{issue.amber ? t('guide.fill') : t('guide.answer')}</button>
        <button onClick={() => discuss(issue)}>{t('guide.discuss')}</button>
        <button onClick={() => { setDeferred(d => [...d, issue.id]); setChosen(undefined); }}>{t('guide.later')}</button>
      </div>
    </> : <p>{t('guide.return')}</p>}
    {issues.length > 1 && <details className={s.guideQueue}><summary>{t('guide.all')} · {issues.length}</summary>
      {issues.map(i => <button key={i.id} onClick={() => { setDeferred(d => d.filter(x => x !== i.id)); go(i); }}><span>{i.title}</span><small data-severity={i.amber ? 'fill' : i.severity}>{severity(i)}</small></button>)}
    </details>}
  </section>;
}

/* ---- the 12 sections as stages ------------------------------------------------------- */

function StageView({ st, ctx, toFill, onFill }: { st: Stage; ctx: Ctx; toFill: number; onFill(): void }) {
  const sec = st.section, program = ctx.program;
  const subject = sec.level === 'paper' ? program.title : program.studies.find(x => x.id === ctx.studyId)?.title ?? program.title;
  const ask = (what: string) => ctx.onPrefill?.(t('model.ask_about_draft', { what, x: subject }));
  const empty = st.empty;
  return <section className={`${s.stage} ${empty ? s.emptyStage : ''}`} data-section={sec.id} id={`section-${sec.id}`}>
    <div className={s.stageLabel}>
      <h2 title={getLang() === 'zh-CN' ? undefined : sec.titleZh}><span className={s.num}>{sec.number}</span>{sec.title}</h2>
      {toFill > 0 && <button className={s.count} data-count={toFill} onClick={onFill} title={t('doc.to_fill_goto')}>{t('doc.to_fill', { n: toFill })}</button>}
      {empty && <span className={s.nothing}>{t('doc.nothing_stated')}</span>}
      {ctx.onPrefill && <button className={s.askSection} onClick={() => ask(sec.title)} title={t('doc.ask_about', { what: sec.title })}>{t('doc.ask')}</button>}
    </div>
    {st.studies.length > 0 && <div className={s.cards}>{st.studies.map(c => <StudyTile key={c.id} card={c} ctx={ctx} />)}</div>}
    {st.facts.length > 0 && <div className={s.facts}>{st.facts.map(c => <Fact key={c.key} card={c} ctx={ctx} />)}</div>}
    {st.conditions.length > 0 && <div className={s.tiles}>{st.conditions.map(c => <CardView key={c.key} card={c} ctx={ctx} small />)}</div>}
    {sec.id === 'design' && !st.conditions.length && <Suggestion ctx={ctx} />}
    {st.flow.length > 0 && <Flow items={st.flow} ctx={ctx} />}
    {st.flowState && <p className={s.missingLine}>{st.flowState === 'analysis' ? t('doc.analysis_only') : <>{t('doc.procedure_unmapped')} <button className={s.linkButton} onClick={() => ctx.onAsk(program.nodes.find(n => n.kind === 'design' && n.studyIds.includes(ctx.studyId))?.id ?? '', undefined, 'Map the documented participant procedure into explicit steps and next connections. Preserve unknown order and conditions as questions rather than inventing them.')}>{t('doc.ask_map')}</button></>}</p>}
    {st.materials.length > 0 && <div className={s.tiles}>{st.materials.map(c => <CardView key={c.key} card={c} ctx={ctx} small />)}</div>}
    {st.cards.length > 0 && <div className={s.cards}>{st.cards.map(c => <CardView key={c.key} card={c} ctx={ctx} />)}</div>}
    {st.notRecorded.length > 0 && !empty && <p className={s.notRecorded}>{t('model.not_recorded')}: {st.notRecorded.join(' · ')}{ctx.onPrefill && <> <button className={s.linkButton} onClick={() => ask(st.notRecorded.join(', '))}>{t('doc.ask')}</button></>}</p>}
  </section>;
}

function Suggestion({ ctx }: { ctx: Ctx }) {
  const { program, studyId } = ctx;
  const design = program.nodes.find(n => n.kind === 'design' && (!n.studyIds.length || n.studyIds.includes(studyId)));
  const sug = conditionSuggestion(program, studyId);
  if (!sug) return null;
  return <p className={s.missingLine}><b>{t('doc.conditions_unstated')}</b> {t('doc.possibly')} {sug.labels.join(' / ')} ({t('doc.from')} {sug.basis}). <button className={s.linkButton} onClick={() => ctx.onAsk(design?.id ?? '', undefined, `The program does not state its experimental conditions. They may be ${sug.labels.join(', ')} (from ${sug.basis}). Check the paper, add a condition node for each, and set conditionIds on the steps and materials that belong to it. Mark anything the paper does not state as missing.`)}>{t('doc.ask_confirm')}</button></p>;
}

/** Selected, cited by the passage picked in the paper, or changed. A card of one field of a node is
 * selected only when that field is the one in focus, so its sibling cards stay quiet. */
const mark = (ctx: Ctx, id?: string, fieldId?: string) => !id ? '' : [ctx.selectedIds.includes(id) && !(fieldId && ctx.focus?.id === id && ctx.focus.fieldId && ctx.focus.fieldId !== fieldId) ? s.selected : '', ctx.support?.ids.includes(id) ? s.cited : '', ctx.changedIds?.has(id) ? s.changed : ''].filter(Boolean).join(' ');
const issuesOf = (ctx: Ctx, id?: string) => id ? ctx.program.issues.filter(i => i.nodeId === id || `flow:${i.stepId}` === id) : [];

function CardView({ card, ctx, small }: { card: Card; ctx: Ctx; small?: boolean }) {
  const issues = issuesOf(ctx, card.entity);
  const placeholder = card.need && isPlaceholderText(card.text);
  const text = placeholder ? '' : card.text;
  return <div data-model-id={card.entity} data-amber={card.need || undefined} data-tone={card.tone !== undefined && card.tone >= 0 ? card.tone % 4 : undefined}
    className={`${s.card} ${small ? s.tile : ''} ${card.need ? s.amber : ''} ${card.refs[0] ? s.hasCite : ''} ${mark(ctx, card.entity, card.fieldId)}`}>
    <button className={s.cardBody} disabled={!card.entity} onClick={e => card.entity && ctx.open(card.entity, card.fieldId, e.shiftKey, Boolean(card.need))}>
      {card.kicker && <small className={s.kicker}>{card.tone !== undefined && card.tone >= 0 && <i className={s.dot} />}{card.kicker}</small>}
      <span className={s.cardTitle}><strong>{card.title}</strong>{card.need && <em className={s.needTag}>{card.need === 'decision' ? t('doc.needs_input') : t('doc.missing_label')}</em>}{card.verbatim && <em className={s.tag}>{t('doc.origin_verbatim')}</em>}</span>
      {text ? <p>{text}</p> : card.need ? <p className={s.fillHint}>{ctx.onEdit ? t('doc.fill_hint') : t('doc.not_specified')}</p> : null}
    </button>
    {card.refs[0] && <span className={s.corner}><Cite id={card.entity ?? ''} refs={card.refs} ctx={ctx} /></span>}
    {issues.length > 0 && <footer className={s.cardFoot}>
      {issues.length > 0 && <button className={s.cardIssue} onClick={() => card.entity && ctx.open(card.entity)}><span>!</span>{t(issues.length === 1 ? 'model.question_1' : 'model.questions', { n: issues.length })}</button>}
    </footer>}
  </div>;
}

function Fact({ card, ctx }: { card: Card; ctx: Ctx }) {
  return <button data-model-id={card.entity} className={`${s.fact} ${mark(ctx, card.entity, card.fieldId)}`} disabled={!card.entity} onClick={e => card.entity && ctx.open(card.entity, card.fieldId, e.shiftKey)} title={card.kicker ? `${card.title} · ${card.kicker}` : card.title}>
    <small>{card.title}</small><strong>{card.text}</strong>
  </button>;
}

function StudyTile({ card, ctx }: { card: StudyCard; ctx: Ctx }) {
  const current = card.id === ctx.studyId;
  return <div className={`${s.card} ${current ? s.current : ''}`}>
    <button className={s.cardBody} aria-pressed={current} onClick={() => ctx.onStudy?.(card.id)}>
      <span className={s.cardTitle}><strong>{card.title}</strong>{card.type !== 'empirical' && <em className={s.tag}>{card.type}</em>}</span>
      {card.text && <p>{card.text}</p>}
      {card.meta.map(m => <small key={m} className={s.meta}>{m}</small>)}
    </button>
  </div>;
}

/** The procedure as a flow of step boxes; an arrow only where the program states the order (web StepBar). */
function Flow({ items, ctx }: { items: FlowItem[]; ctx: Ctx }) {
  const top = items.length === 1 && items[0].children.length && !items[0].columns ? items[0].children : items;
  const conditions = studyConditions(ctx.program, ctx.studyId);
  return <ol className={s.flow} aria-label={t('doc.stepbar_aria')}>{top.map((item, i) => <li key={item.step.id}>
    {i > 0 && <span className={s.arrow} aria-label={item.linked ? t('doc.then') : t('doc.order_unstated')}>{item.linked ? '→' : '·'}</span>}
    <StepBox item={item} n={i + 1} ctx={ctx} conditions={conditions} />
  </li>)}</ol>;
}
function StepBox({ item, n, ctx, conditions }: { item: FlowItem; n?: number; ctx: Ctx; conditions: ReturnType<typeof studyConditions> }) {
  const { step } = item, id = `flow:${step.id}`, program = ctx.program;
  const need = step.rule ? fieldNeed(step.rule) : null;
  // Conditions are named on a step only when it does not run in all of them.
  const own = conditions.filter(c => step.conditionIds?.includes(c.id)).filter((_, __, all) => all.length < conditions.length);
  const sees = step.visibleIds.map(v => program.nodes.find(x => x.id === v)?.title).filter(Boolean);
  const refs = itemSources(program, id);
  return <div data-model-id={id} data-amber={need || undefined} className={`${s.card} ${s.step} ${need ? s.amber : ''} ${refs[0] ? s.hasCite : ''} ${mark(ctx, id)}`}>
    <button className={s.cardBody} onClick={e => ctx.open(id, step.rule?.id, e.shiftKey, Boolean(need))}>
      <span className={s.cardTitle}><strong>{n !== undefined && <span className={s.stepNum}>{item.columns ? '⑂' : step.kind === 'repeat' ? '↻' : n}</span>}{step.title}</strong></span>
      {own.length > 0 && <small className={s.kicker}>{own.map(c => <span key={c.id} data-tone={c.tone % 4}><i className={s.dot} />{c.label} </span>)}</small>}
      {sees.length > 0 && <small className={s.meta}>{t('doc.sees')}: {sees.join(', ')}</small>}
      {need && <em className={s.needTag}>{need === 'decision' ? t('doc.needs_input') : t('doc.missing_label')}</em>}
    </button>
    {item.children.length > 0 && <div className={item.columns ? s.alternatives : s.substeps}>
      {item.children.map(child => <StepBox key={child.step.id} item={child} ctx={ctx} conditions={conditions} />)}
    </div>}
    {refs[0] && <span className={s.corner}><Cite id={id} refs={refs} ctx={ctx} /></span>}
  </div>;
}

/* ---- citation ------------------------------------------------------------------------ */

/** A citation chip. Once the paper pane has looked for the quote, a miss shows here in amber. */
function Cite({ id, refs, ctx }: { id: string; refs: SourceRef[]; ctx: Ctx }) {
  const ref = refs[0];
  if (!ref) return null;
  const status = ref.page ? ctx.quoteStatus?.get(quoteKey(ref.page, ref.quote)) : undefined;
  const missing = status && !status.found, moved = status?.found && status.page !== undefined && status.page !== ref.page;
  const title = missing ? t('model.quote_missing', { n: ref.page ?? '' }) : moved ? t('model.quote_moved', { n: ref.page ?? '', m: status!.page! }) : `${ref.verified ? t('doc.cite_open') : t('doc.cite_unmatched')}${ref.quote ? `: “${ref.quote.slice(0, 160)}${ref.quote.length > 160 ? '…' : ''}”` : ''}${ref.file ? ` (${ref.file})` : ''}`;
  return <button className={`${s.cite} ${missing || moved ? s.citeWarn : ''}`} title={title} onClick={e => { e.stopPropagation(); ctx.onSource(id, ref); }}>
    {ref.page ? t('doc.cite_page', { n: ref.page }) : t('doc.cite_file')}{moved ? ` → ${status!.page}` : ''}{missing ? ' ?' : ''} <span aria-hidden>↗</span>
  </button>;
}

/* ---- the dock: selection and details (web: study-model dock + program-details.tsx) ---- */

function fieldOf(program: HumanProgram, entity: string, fieldId: string): ProgramField | undefined {
  return entity.startsWith('flow:') ? program.steps.find(st => st.id === entity.slice(5))?.rule : program.nodes.find(n => n.id === entity)?.fields.find(f => f.id === fieldId);
}
function titleOf(program: HumanProgram, id: string): string {
  return id.startsWith('flow:') ? program.steps.find(st => st.id === id.slice(5))?.title ?? id : program.nodes.find(n => n.id === id)?.title ?? id;
}

function Dock({ ctx, inspect, setInspect }: { ctx: Ctx; inspect: boolean; setInspect(v: boolean): void }) {
  const { program, selectedIds, focus } = ctx;
  const id = focus?.id ?? selectedIds[selectedIds.length - 1];
  const source = itemSources(program, id).find(r => r.page);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus?.fieldId) { body.current?.scrollTo({ top: 0 }); return; }
    requestAnimationFrame(() => body.current?.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(focus.fieldId!)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [focus?.id, focus?.fieldId]);
  const many = selectedIds.length > 1;
  return <div className={`${s.dock} ${inspect ? '' : s.compactDock}`} aria-label={t('model.selection')}>
    <div className={s.dockHeader}>
      <span>{many ? t('study.selected', { n: selectedIds.length }) : t('model.selection')}</span>
      <button aria-label={t('model.clear')} title={t('model.clear')} onClick={() => ctx.onClearSelection?.()}>×</button>
    </div>
    {many && <div className={s.selectedNames}>{selectedIds.map(x => <button key={x} aria-pressed={x === id} onClick={() => ctx.open(x, undefined, false)}>{titleOf(program, x)}</button>)}</div>}
    <div className={s.selectionActions}>
      <button onClick={() => setInspect(!inspect)} aria-expanded={inspect}>{inspect ? t('model.hide_details') : t('model.details')}</button>
      {source ? <button onClick={() => ctx.onSource(id, source)}>{t('model.source_p', { n: source.page! })}</button> : <span className={s.noSource}>{t('model.no_source')}</span>}
      <button onClick={() => many ? ctx.onAskSelection?.() : ctx.onAsk(id, focus?.fieldId)}>{t('study.ask_selection')}</button>
    </div>
    {inspect && <div className={s.inspector} ref={body}><Details id={id} ctx={ctx} /></div>}
  </div>;
}

function Details({ id, ctx }: { id: string; ctx: Ctx }) {
  const { program } = ctx;
  const node = program.nodes.find(n => n.id === id), step = program.steps.find(st => `flow:${st.id}` === id);
  if (!node && !step) return <p className={s.muted}>{id}</p>;
  const names = (ids: string[]) => ids.map(x => program.nodes.find(n => n.id === x)).filter((n): n is ProgramNode => Boolean(n));
  const fields = (node?.fields ?? (step?.rule ? [step.rule] : [])).filter(f => f.value !== null && f.value !== '' || fieldNeed(f));
  const evidenceIds = [...new Set([...(node?.evidenceIds ?? step?.evidenceIds ?? []), ...fields.flatMap(f => f.evidenceIds)])];
  const connections = program.relations.filter(r => r.from === id || r.to === id);
  const issues = issuesOf(ctx, id);
  const against = node ? peerMaterial(program, node) : undefined;
  const link = (n: ProgramNode) => <button key={n.id} className={s.linkButton} onClick={() => ctx.open(n.id)}>{n.title}</button>;
  return <>
    <h3>{node?.title ?? step!.title}</h3>
    {node?.description && <p className={s.description}>{node.description}</p>}
    {issues.map(i => <div key={i.id} className={s.issueNote}><b>{t(`guide.${i.severity}`)}</b> {i.title}{i.reason && <p>{i.reason}</p>}<button className={s.linkButton} onClick={() => ctx.onAsk(id, i.fieldId, t('guide.help_draft', { t: i.title, r: i.reason }))}>{t('guide.discuss')} ↗</button></div>)}
    <dl className={s.fields}>{fields.map(f => <FieldRow key={f.id} id={id} field={f} ctx={ctx} against={against?.fields.find(x => x.id === f.id)} />)}</dl>
    {step && <>
      <dl className={s.fields}>{([[t('model.actors'), names(step.actorIds)], [t('doc.sees'), names(step.visibleIds)], [t('doc.uses'), names(step.inputIds.filter(x => !step.visibleIds.includes(x)))], [t('doc.records'), names(step.outputIds)]] as const).filter(([, v]) => v.length).map(([k, v]) => <div key={k} className={s.field}><dt><span>{k}</span></dt><dd>{v.map((n, i) => <Fragment key={n.id}>{i > 0 && ', '}{link(n)}</Fragment>)}</dd></div>)}</dl>
      {names(step.visibleIds).filter(n => n.fields.some(f => f.origin === 'verbatim' && typeof f.value === 'string')).map(n => <details key={n.id} className={s.more} open>
        <summary>{t('doc.text_of', { t: n.title })}</summary>
        {n.fields.filter(f => f.origin === 'verbatim').map(f => <FieldRow key={f.id} id={n.id} field={f} ctx={ctx} against={peerMaterial(program, n)?.fields.find(x => x.id === f.id)} />)}
      </details>)}
      {step.children.length > 0 && <div className={s.connections}>{step.children.map(c => <button key={c} onClick={() => ctx.open(`flow:${c}`)}>{program.steps.find(x => x.id === c)?.title ?? c} ↗</button>)}</div>}
      {step.next.length > 0 && <div className={s.connections}>{step.next.map(nx => <button key={nx.to} onClick={() => ctx.open(`flow:${nx.to}`)}>{nx.when || t('model.next')} → {program.steps.find(x => x.id === nx.to)?.title ?? nx.to}</button>)}</div>}
    </>}
    {connections.length > 0 && <details className={s.more}><summary>{t('model.connections', { n: connections.length })}</summary><div className={s.connections}>{connections.map(r => { const other = r.from === id ? r.to : r.from; return <button key={r.id} onClick={() => ctx.open(other)}>{r.label ?? r.type} · {titleOf(program, other)} ↗</button>; })}</div></details>}
    {evidenceIds.length > 0 && <details className={s.more}><summary>{t('model.evidence', { n: evidenceIds.length })}</summary>{evidenceIds.map(eid => {
      const e = program.evidence.find(x => x.id === eid); if (!e) return null;
      const ref = sourceRefs(program, [eid])[0];
      return <div key={eid} className={s.evidence}>{e.quote && <blockquote>{e.quote}</blockquote>}{ref ? <Cite id={id} refs={[ref]} ctx={ctx} /> : <small>{e.path || e.sourceId || e.url}</small>}</div>;
    })}</details>}
  </>;
}

/** The same material in the other condition, so the words that differ can be marked. */
function peerMaterial(program: HumanProgram, node: ProgramNode): ProgramNode | undefined {
  if (node.kind !== 'material' || !node.conditionIds?.length) return undefined;
  return program.nodes.find(n => n.kind === 'material' && n.id !== node.id && n.conditionIds?.length && !n.conditionIds.some(c => node.conditionIds!.includes(c)) && n.studyIds.some(x => node.studyIds.includes(x)));
}

/** Evidence badge: in zh the Chinese name with the English term kept small after it. */
const ORIGINS: Partial<Record<ProgramField['origin'], string>> = { verbatim: 'verbatim', reported: 'reported', derived: 'derived', researcher: 'researcher', implementation: 'implementation', unknown: 'unknown' };
function FieldRow({ id, field, ctx, against }: { id: string; field: ProgramField; ctx: Ctx; against?: ProgramField }) {
  const text = field.value === null ? '' : fieldText(field.value), need = fieldNeed(field);
  const editable = Boolean(ctx.onEdit) && (field.value === null || typeof field.value === 'string');
  const placeholder = need !== null && isPlaceholderText(text);
  const focused = ctx.focus?.id === id && ctx.focus.fieldId === field.id;
  const [editing, setEditing] = useState<string | null>(focused && ctx.focus?.edit && editable ? (placeholder ? '' : text) : null);
  useEffect(() => { if (focused && ctx.focus?.edit && editable) setEditing(placeholder ? '' : text); }, [ctx.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing !== null && box.current && document.activeElement !== box.current) { box.current.focus(); box.current.style.height = `${box.current.scrollHeight}px`; } }, [editing]);
  const commit = () => { if (editing === null) return; const next = editing.trim(); setEditing(null); if (next !== text && (next || !placeholder)) ctx.onEdit!(id, field.id, next); };
  const refs = sourceRefs(ctx.program, field.evidenceIds);
  const origin = ORIGINS[field.origin];
  const peer = against?.value != null ? fieldText(against.value) : undefined;
  const body = placeholder ? <span className={s.fillHint}>{editable ? t('doc.fill_hint') : t('doc.not_specified')}</span>
    : peer !== undefined && peer !== text ? wordDiff(text, peer).map((p, i) => p.changed ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>) : text;
  return <div data-field-id={field.id} data-amber={need || undefined} className={`${s.field} ${need ? s.amberField : ''} ${focused ? s.focusedField : ''}`}>
    <dt>
      <span>{fieldLabel(field.id, field.label)}</span>
      {need && <em className={s.needTag}>{need === 'decision' ? t('doc.needs_input') : t('doc.missing_label')}</em>}
      {origin && !placeholder && <em className={s.origin}>{t(`doc.origin_${origin}`)}{getLang() === 'zh-CN' && <small> {translate('en', `doc.origin_${origin}`)}</small>}</em>}
      <span className={s.fieldActions}>
        {refs[0] && <Cite id={id} refs={refs} ctx={ctx} />}
        <button className={s.linkButton} onClick={() => ctx.onAsk(id, field.id)} title={t('doc.discuss_hint')}>{t('doc.ask')}</button>
      </span>
    </dt>
    <dd>
      {editing !== null ? <>
        <textarea ref={box} className={s.editor} value={editing} rows={1} aria-label={t('doc.edit_aria', { what: fieldLabel(field.id, field.label) })}
          onChange={e => { setEditing(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); } }} />
        <small className={s.editHint}>{t('doc.edit_keys')}</small>
      </> : <p className={`${field.origin === 'verbatim' ? s.verbatim : ''} ${editable ? s.editable : ''}`} title={editable ? (need ? t('doc.fill_hint') : t('doc.edit_hint')) : undefined}
        onClick={need && editable ? () => { if (window.getSelection()?.isCollapsed !== false) setEditing(placeholder ? '' : text); } : undefined}
        onDoubleClick={editable && !need ? e => { e.preventDefault(); window.getSelection()?.removeAllRanges(); setEditing(text); } : undefined}>{body}</p>}
      {field.derivation && <details className={s.more}><summary>{t('model.derivation')}</summary><p>{field.derivation}</p></details>}
    </dd>
  </div>;
}

