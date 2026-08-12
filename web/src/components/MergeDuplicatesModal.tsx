import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from './Modal';
import { Loading, Empty } from './StateViews';
import { useMergeMembers, useMergePreview, useMergeDuplicates } from '../api/hooks';
import { useT } from '../i18n';
import type { Messages } from '../i18n/messages';
import type { DuplicateMember, MergeableEntityType, MergePreview, MergeResult } from '../api/types';

type Mode = 'review' | 'confirm' | 'success';

interface Props {
    open: boolean;
    onClose: (completed?: boolean) => void;
    campaignId: string;
    guildId: string;
    entityType: MergeableEntityType;
    /** short_ids selected by the user in the list (manual merge, no detection). */
    selectedShortIds: string[];
}

/**
 * "Merge selection" flow: the user selects the entities from the list (checkbox)
 * and opens this modal. Here they designate the survivor (radio), choose the final
 * name, see the full diff (record + events + RAG of both records) and confirm
 * in two steps. No automatic detection.
 *
 * Reuses Modal (wide) like ReportDialog.
 */
export function MergeDuplicatesModal({ open, onClose, campaignId, guildId, entityType, selectedShortIds }: Props) {
    const t = useT();
    const [mode, setMode] = useState<Mode>('review');
    const [survivorId, setSurvivorId] = useState<string>('');
    const [finalName, setFinalName] = useState<string>('');
    const [finalNameTouched, setFinalNameTouched] = useState(false);
    const [override, setOverride] = useState<string>('');
    const [result, setResult] = useState<MergeResult | null>(null);

    const { members, busy: membersBusy, error: membersError, fetchMembers, setMembers } = useMergeMembers(campaignId, entityType);
    const { preview, busy: previewBusy, error: previewError, fetchPreview, setPreview } = useMergePreview(campaignId, entityType);
    const { merge, busy, error: mergeError } = useMergeDuplicates(campaignId, entityType);

    // Load member details whenever the modal opens with a selection.
    useEffect(() => {
        if (open && selectedShortIds.length >= 2) {
            setMode('review');
            setSurvivorId('');
            setFinalName('');
            setFinalNameTouched(false);
            setOverride('');
            setResult(null);
            setPreview(null);
            setMembers(null);
            void fetchMembers(selectedShortIds);
        }
    }, [open, selectedShortIds, fetchMembers, setPreview, setMembers]);

    // Pick a default survivor once members load: manual first, then most history.
    useEffect(() => {
        if (!members || members.length === 0 || survivorId) return;
        const manual = members.find((m) => m.is_manual === 1);
        const pick = manual ?? members.slice().sort((a, b) => b.history_count - a.history_count || a.name.length - b.name.length)[0];
        if (pick) {
            setSurvivorId(pick.short_id);
            setFinalName(pick.name);
        }
    }, [members, survivorId]);

    const drops = useMemo(() => (members ?? []).filter((m) => m.short_id !== survivorId), [members, survivorId]);
    const survivor = useMemo(() => (members ?? []).find((m) => m.short_id === survivorId), [members, survivorId]);

    function startConfirm() {
        if (!survivorId || drops.length === 0) return;
        void loadPreview();
        setMode('confirm');
    }

    function loadPreview() {
        if (!survivorId || drops.length === 0) return;
        setPreview(null);
        void fetchPreview({
            keepShortId: survivorId,
            dropShortIds: drops.map((d) => d.short_id),
            finalName: finalName || undefined,
            description: override.trim() || undefined,
        });
    }

    function changeFinalName(value: string) {
        setFinalNameTouched(true);
        setFinalName(value);
    }

    function pickSurvivor(id: string) {
        setSurvivorId(id);
        if (!finalNameTouched) {
            const member = members?.find((candidate) => candidate.short_id === id);
            if (member) setFinalName(member.name);
        }
    }

    async function doMerge() {
        if (!survivorId || drops.length === 0) return;
        const hasManualDrop = drops.some((m) => m.is_manual === 1);
        const res = await merge({
            keepShortId: survivorId,
            dropShortIds: drops.map((d) => d.short_id),
            description: override || undefined,
            confirmManualMerge: hasManualDrop || undefined,
            finalName: finalName.trim() || undefined,
        });
        if (res) {
            setResult(res);
            setMode('success');
        }
    }

    const title = mode === 'success' ? t.merge.success : mode === 'confirm' ? t.merge.confirm : t.merge.title;

    return (
        <Modal open={open} onClose={onClose} title={title} wide>
            <div className="merge-modal" aria-busy={membersBusy || previewBusy || busy}>
                <header className="merge-modal__header">
                    <div>
                        <span className="merge-modal__eyebrow">{t.merge.button}</span>
                        <h2>{title}</h2>
                    </div>
                    <ol className="merge-steps" aria-label={t.merge.title}>
                        {(['review', 'confirm', 'success'] as const).map((step, index) => (
                            <li
                                key={step}
                                className={[
                                    'merge-steps__item',
                                    mode === step ? 'is-active' : '',
                                    (mode === 'confirm' && step === 'review') || mode === 'success' && step !== 'success'
                                        ? 'is-complete'
                                        : '',
                                ].filter(Boolean).join(' ')}
                                aria-current={mode === step ? 'step' : undefined}
                            >
                                <span>{index + 1}</span>
                                {step === 'review' ? t.merge.review : step === 'confirm' ? t.merge.confirm : t.merge.success}
                            </li>
                        ))}
                    </ol>
                </header>
                {mode === 'review' && (
                    <ReviewStep
                        membersBusy={membersBusy}
                        membersError={membersError}
                        members={members ?? []}
                        survivorId={survivorId}
                        onPickSurvivor={pickSurvivor}
                        finalName={finalName}
                        onFinalNameChange={changeFinalName}
                        override={override}
                        onOverride={setOverride}
                        onRetry={() => void fetchMembers(selectedShortIds)}
                        onConfirm={startConfirm}
                        canMerge={drops.length > 0 && !!finalName.trim()}
                    />
                )}

                {mode === 'confirm' && survivor && (
                    <ConfirmStep
                        members={members ?? []}
                        survivorId={survivorId}
                        finalName={finalName}
                        override={override}
                        preview={preview}
                        previewBusy={previewBusy}
                        previewError={previewError}
                        busy={busy}
                        error={mergeError}
                        onRetryPreview={loadPreview}
                        onMerge={doMerge}
                        onBack={() => setMode('review')}
                    />
                )}

                {mode === 'success' && result && (
                    <SuccessStep
                        result={result}
                        guildId={guildId}
                        campaignId={campaignId}
                        entityType={entityType}
                        onClose={onClose}
                    />
                )}
            </div>
        </Modal>
    );
}

// --- Review step ---

function ReviewStep(props: {
    membersBusy: boolean;
    membersError: string | null;
    members: DuplicateMember[];
    survivorId: string;
    onPickSurvivor: (id: string) => void;
    finalName: string;
    onFinalNameChange: (value: string) => void;
    override: string;
    onOverride: (value: string) => void;
    onRetry: () => void;
    onConfirm: () => void;
    canMerge: boolean;
}) {
    const t = useT();
    const { members, survivorId } = props;

    if (props.membersBusy) return <Loading />;
    if (props.membersError) {
        return (
            <div className="merge-modal__preview-error" role="alert">
                <p className="merge-modal__error">{t.merge.error}: {props.membersError}</p>
                <button type="button" className="merge-btn merge-btn--ghost" onClick={props.onRetry}>
                    {t.common.retry}
                </button>
            </div>
        );
    }
    if (members.length < 2) return <Empty message={t.merge.selectAtLeastTwo} />;

    return (
        <div className="merge-modal__review">
            <p className="merge-modal__hint">{t.merge.reviewHint}</p>
            <p className="merge-cluster__legend">
                <span className="merge-legend merge-legend--survivor">{t.merge.survives}</span>
                <span className="merge-legend merge-legend--drop">{t.merge.dies}</span>
            </p>
            <ul className="merge-cards">
                {members.map((m) => (
                    <MemberCard
                        key={m.short_id}
                        member={m}
                        isSurvivor={m.short_id === survivorId}
                        radioName="merge-survivor"
                        onPick={() => props.onPickSurvivor(m.short_id)}
                    />
                ))}
            </ul>

            <label className="merge-finalname">
                <span className="merge-finalname__label">{t.merge.finalName}</span>
                <input
                    type="text"
                    className="merge-finalname__input"
                    list="merge-finalname-options"
                    value={props.finalName}
                    placeholder={t.merge.finalNamePlaceholder}
                    onChange={(e) => props.onFinalNameChange(e.target.value)}
                />
                <datalist id="merge-finalname-options">
                    {members.map((m) => <option key={m.short_id} value={m.name} />)}
                </datalist>
            </label>

            <label className="merge-cluster__override">
                <span className="merge-cluster__override-label">{t.merge.descriptionOverride}</span>
                <textarea
                    value={props.override}
                    placeholder={t.merge.descriptionPlaceholder}
                    onChange={(e) => props.onOverride(e.target.value)}
                    rows={3}
                />
            </label>

            <div className="merge-cluster__actions">
                <button
                    type="button"
                    className="merge-btn merge-btn--primary"
                    onClick={props.onConfirm}
                    disabled={!props.canMerge}
                    title={props.canMerge ? undefined : t.merge.selectAtLeastOne}
                >
                    {t.merge.verifyMerge} →
                </button>
            </div>
        </div>
    );
}

function MemberCard({ member, isSurvivor, radioName, onPick }: { member: DuplicateMember; isSurvivor: boolean; radioName: string; onPick: () => void }) {
    const t = useT();
    return (
        <li className={isSurvivor ? 'merge-card merge-card--survivor' : 'merge-card merge-card--drop'}>
            <label className="merge-card__radio">
                <input type="radio" checked={isSurvivor} onChange={onPick} name={radioName} />
                <span className="merge-card__state-label">{isSurvivor ? t.merge.survives : t.merge.dies}</span>
            </label>
            <div className="merge-card__name">{member.name}</div>
            <div className="merge-card__meta">
                {member.is_manual === 1 && <span className="chip chip--manual">{t.merge.manualBadge}</span>}
                <span className="chip">{t.merge.historyEvents(member.history_count)}</span>
                <span className="chip">{member.has_rag ? t.merge.ragPresent : t.merge.ragAbsent}</span>
            </div>
            {member.description && <p className="merge-card__desc">{member.description}</p>}
        </li>
    );
}

// --- Confirm step ---

function ConfirmStep(props: {
    members: DuplicateMember[];
    survivorId: string;
    finalName: string;
    override: string;
    preview: MergePreview | null;
    previewBusy: boolean;
    previewError: string | null;
    busy: boolean;
    error: string | null;
    onRetryPreview: () => void;
    onMerge: () => void;
    onBack: () => void;
}) {
    const t = useT();
    const { members, survivorId, finalName, preview } = props;
    const survivor = members.find((m) => m.short_id === survivorId);
    const drops = members.filter((m) => m.short_id !== survivorId);
    const hasManualDrop = drops.some((m) => m.is_manual === 1);
    const ragKept = preview?.rag.filter((r) => r.action === 'kept') ?? [];
    const ragDeleted = preview?.rag.filter((r) => r.action === 'deleted') ?? [];
    const ragConsolidated = preview?.rag.filter((r) => r.action === 'consolidated') ?? [];
    const ragRewritten = preview?.rag.filter((r) => r.action === 'rewritten') ?? [];
    const lostFields = preview?.record.filter((field) => field.verdict !== 'kept') ?? [];
    const keptFields = preview?.record.filter((field) => field.verdict === 'kept') ?? [];
    const uniqueRagDeleted = new Set(ragDeleted.map((item) => item.fragment_id)).size;
    const ragVersionsConsolidated = Array.from(new Map(
        ragConsolidated.map((item) => [item.fragment_id, item.version_count]),
    ).values()).reduce((total, count) => total + count, 0);
    const uniqueRagKept = new Set(ragKept.map((item) => item.fragment_id)).size;
    const uniqueRagRewritten = new Set(ragRewritten.map((item) => item.fragment_id)).size;
    const relations = preview?.relations ?? [];

    return (
        <div className="merge-modal__confirm">
            <p className="merge-modal__hint">{t.merge.confirmSummary}</p>
            {hasManualDrop && <p className="merge-modal__warning">{t.merge.manualWarning}</p>}

            <div className="merge-summary">
                <div className="merge-summary__survivor">
                    <span className="merge-summary__label merge-summary__label--survivor">{t.merge.survives}</span>
                    <strong>{survivor?.name}{finalName && finalName !== survivor?.name ? ` → ${finalName}` : ''}</strong>
                </div>
                <ul className="merge-summary__drops">
                    {drops.map((m) => (
                        <li key={m.short_id}>
                            <span className="merge-summary__label merge-summary__label--drop">{t.merge.dies}</span> {m.name}
                        </li>
                    ))}
                </ul>
                {props.override.trim() && (
                    <p className="merge-summary__override">
                        {t.merge.descriptionOverride}: {truncate(props.override.trim(), 160)}
                    </p>
                )}
            </div>

            <div className="merge-diff">
                {props.previewBusy && !preview && <Loading />}
                {props.previewError && (
                    <div className="merge-modal__preview-error">
                        <p className="merge-modal__error">{t.merge.error}: {props.previewError}</p>
                        <button type="button" className="merge-btn merge-btn--ghost" onClick={props.onRetryPreview}>
                            {t.common.retry}
                        </button>
                    </div>
                )}
                {preview && (
                    <>
                        <section className="merge-impact" aria-label={t.merge.confirm}>
                            <article className="merge-impact__card merge-impact__card--keep">
                                <strong>{keptFields.length}</strong>
                                <span>{t.merge.fieldKept}</span>
                            </article>
                            <article className="merge-impact__card merge-impact__card--lose">
                                <strong>{lostFields.length}</strong>
                                <span>{t.merge.fieldDiscarded}</span>
                            </article>
                            <article className="merge-impact__card merge-impact__card--move">
                                <strong>{preview.events.length}</strong>
                                <span>{t.merge.eventsRepointed(preview.events.length)}</span>
                            </article>
                            <article className="merge-impact__card merge-impact__card--rag">
                                <strong>{ragVersionsConsolidated}</strong>
                                <span>{t.merge.ragWillConsolidate(ragVersionsConsolidated)}</span>
                            </article>
                            {uniqueRagDeleted > 0 && (
                                <article className="merge-impact__card merge-impact__card--lose">
                                    <strong>{uniqueRagDeleted}</strong>
                                    <span>{t.merge.ragWillDelete(uniqueRagDeleted)}</span>
                                </article>
                            )}
                            {relations.length > 0 && (
                                <article className="merge-impact__card merge-impact__card--move">
                                    <strong>{relations.length}</strong>
                                    <span>{t.merge.relationsPreserved(relations.length)}</span>
                                </article>
                            )}
                        </section>
                        {preview.rename && (
                            <DiffSection title={t.merge.diffRename} tone="rename">
                                <p className="merge-diff__rename">
                                    {t.merge.reportRenamed(preview.rename.from, preview.rename.to)} —{' '}
                                    {t.merge.eventsRepointed(preview.rename.history_repointed)},{' '}
                                    {t.merge.ragWillRewrite(preview.rename.rag_headers_rewritten)}
                                </p>
                            </DiffSection>
                        )}
                        <DiffSection title={t.merge.diffRecord} tone="record">
                            {preview.record.length === 0 ? <p className="merge-diff__empty">—</p> : (
                                <ul className="merge-diff__fields">
                                    {preview.record.map((f, i) => (
                                        <li key={i} className={`merge-diff__field merge-diff__field--${f.verdict}`}>
                                            <span className="merge-diff__field-name">{mergeFieldLabel(t, f.field)}</span>
                                            <span className="merge-diff__field-values">
                                                <span className="merge-diff__field-value merge-diff__field-value--keep">
                                                    <small>{t.merge.survives}</small>
                                                    {f.survivor_value ? truncate(f.survivor_value, 90) : '—'}
                                                </span>
                                                <span className="merge-diff__field-arrow" aria-hidden="true">←</span>
                                                <span className="merge-diff__field-value merge-diff__field-value--drop">
                                                    <small>{f.drop_name}</small>
                                                    {f.drop_value ? truncate(f.drop_value, 90) : '—'}
                                                </span>
                                            </span>
                                            <span className={`merge-diff__verdict merge-diff__verdict--${f.verdict}`}>
                                                {f.verdict === 'discarded' ? t.merge.fieldDiscarded : f.verdict === 'differs' ? t.merge.fieldDiffers : t.merge.fieldKept}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </DiffSection>
                        <DiffSection title={t.merge.diffEvents} tone="events">
                            {preview.events.length === 0 ? <p className="merge-diff__empty">—</p> : (
                                <>
                                    <p className="merge-diff__count">{t.merge.eventsRepointed(preview.events.length)}</p>
                                    <ul className="merge-diff__events">
                                        {preview.events.slice(0, 20).map((e, i) => (
                                            <li key={i}>
                                                <span className="merge-diff__event-meta">{e.drop_name} · {e.event_type}{e.session_date ? ` · ${e.session_date.slice(0, 10)}` : ''}</span>
                                                <span className="merge-diff__event-desc">{e.description_preview}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                        </DiffSection>
                        {relations.length > 0 && (
                            <DiffSection title={t.merge.diffRelations} tone="relations">
                                <p className="merge-diff__count">{t.merge.relationsPreserved(relations.length)}</p>
                                <ul className="merge-diff__events">
                                    {relations.map((relation, index) => (
                                        <li key={`${relation.drop_short_id}-${relation.relation_type}-${index}`}>
                                            <span className="merge-diff__event-meta">
                                                {relation.drop_name} · {relation.relation_type}
                                            </span>
                                            <span className="merge-diff__event-desc">
                                                {relation.action === 'deduplicated'
                                                    ? t.merge.relationDeduplicated
                                                    : t.merge.relationRepointed}
                                                {' · '}{relation.label}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </DiffSection>
                        )}
                        <DiffSection title={t.merge.diffRag} tone="rag">
                            <p className="merge-diff__count">
                                {t.merge.ragWillKeep(uniqueRagKept)} · {t.merge.ragWillConsolidate(ragVersionsConsolidated)} · {t.merge.ragWillRewrite(uniqueRagRewritten)}
                                {uniqueRagDeleted > 0 ? ` · ${t.merge.ragWillDelete(uniqueRagDeleted)}` : ''}
                            </p>
                            <ul className="merge-diff__rag">
                                {ragKept.map((r) => (
                                    <li key={`k-${r.fragment_id}`} className="merge-diff__rag-item merge-diff__rag-item--kept"><span className="merge-diff__rag-action">✓</span> {r.drop_name}: {r.header}</li>
                                ))}
                                {ragConsolidated.map((r) => (
                                    <li key={`c-${r.fragment_id}`} className="merge-diff__rag-item merge-diff__rag-item--consolidated"><span className="merge-diff__rag-action">↻</span> {r.drop_name}: {r.header}</li>
                                ))}
                                {ragDeleted.map((r) => (
                                    <li key={`d-${r.fragment_id}`} className="merge-diff__rag-item merge-diff__rag-item--deleted"><span className="merge-diff__rag-action">✗</span> {r.drop_name}: {r.header}</li>
                                ))}
                                {ragRewritten.map((r) => (
                                    <li key={`r-${r.fragment_id}`} className="merge-diff__rag-item merge-diff__rag-item--rewritten"><span className="merge-diff__rag-action">↻</span> {r.drop_name}: {r.header}</li>
                                ))}
                            </ul>
                        </DiffSection>
                    </>
                )}
            </div>

            {props.error && <p className="merge-modal__error">{t.merge.error}: {props.error}</p>}

            <div className="merge-modal__actions">
                <button type="button" className="merge-btn merge-btn--ghost" onClick={props.onBack} disabled={props.busy}>{t.merge.cancel}</button>
                <button
                    type="button"
                    className="merge-btn merge-btn--danger"
                    onClick={props.onMerge}
                    disabled={props.busy || props.previewBusy || !preview || !!props.previewError}
                >
                    {props.busy ? t.merge.merging : t.merge.confirmMerge}
                </button>
            </div>
        </div>
    );
}

// --- Success step ---

function SuccessStep(props: { result: MergeResult; guildId: string; campaignId: string; entityType: MergeableEntityType; onClose: (completed?: boolean) => void }) {
    const t = useT();
    const { result, guildId, campaignId, entityType } = props;
    const r = result.report;
    const detailPath = `/guilds/${guildId}/campaigns/${campaignId}/${entityType}/${result.survivor_short_id}`;
    return (
        <div className="merge-modal__success">
            <p className="merge-modal__hint merge-modal__hint--success">{t.merge.successSummary(result.survivor_name)}</p>
            <ul className="merge-report">
                <li>{t.merge.reportMerged(r.merged_rows.length)}</li>
                <li>{t.merge.reportHistory(r.history_repointed)}</li>
                <li>{t.merge.reportRagDeleted(r.rag_fragments_deleted)}</li>
                <li>{t.merge.reportRagRefs(r.rag_refs_rewritten)}</li>
                {r.relations_repointed > 0 && <li>{t.merge.relationsPreserved(r.relations_repointed)}</li>}
                {r.short_id_regenerated && <li>{t.merge.reportShortId}</li>}
                {r.manual_propagated && <li>{t.merge.reportManual}</li>}
                {r.bio_auto_merged && <li>{t.merge.reportBio}</li>}
                {r.renamed && <li>{t.merge.reportRenamed(r.renamed.from, r.renamed.to)}</li>}
            </ul>
            <div className="merge-modal__actions">
                <Link to={detailPath} className="merge-btn merge-btn--primary" onClick={() => props.onClose(true)}>{t.merge.viewSurvivor}</Link>
                <button type="button" className="merge-btn merge-btn--ghost" onClick={() => props.onClose(true)}>{t.common.close}</button>
            </div>
        </div>
    );
}

// --- Diff helpers ---

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

function mergeFieldLabel(t: Messages, field: string): string {
    const labels: Partial<Record<string, keyof Messages['fields']>> = {
        description: 'description',
        effects: 'effects',
        owner_name: 'owner',
        status: 'status',
        curse_description: 'curse',
        location_macro: 'region',
        location_micro: 'place',
        role: 'role',
    };
    const key = labels[field];
    return key ? t.fields[key] : field.replaceAll('_', ' ');
}

function DiffSection(props: { title: string; tone: string; children: ReactNode }) {
    return (
        <section className={`merge-diff__section merge-diff__section--${props.tone}`}>
            <h4 className="merge-diff__title">{props.title}</h4>
            {props.children}
        </section>
    );
}
