import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import { actionErrorMessage } from '../api/errors';
import { useEntityProfile } from '../api/hooks';
import type {
    EntityProfile,
    EntityProfileAnalysis,
    EntityProfileEstimate,
    MediaEntityType,
    TraitEvidence,
} from '../api/types';
import { useT } from '../i18n';
import { AiCostConfirmationModal, type AiCostConfirmation } from './AiCostConfirmationModal';
import { AiCostIndicator } from './AiCostIndicator';
import { Badge } from './Badge';
import { FormFeedback } from './FormFeedback';
import { Icon } from './icons';

/**
 * What the campaign records about how a subject looks, and where each claim came from.
 *
 * This panel exists because a portrait drawn from an invented description is
 * wrong in a way nobody notices. Asked to describe an NPC whose records held a
 * role, a temperament and no physical detail at all, the Bard produced a
 * tiefling with ram horns and gold eyes — fluent, confident, and made up. The
 * answer is not a better prompt but a record a person can check: every trait
 * here carries the words it came from, and a trait that could not be evidenced
 * never reaches the screen at all.
 *
 * So the two things this must never do are hide an absence and imply a
 * certainty. An empty dossier says it is empty; `not_recorded` lists what was
 * looked for and is genuinely missing; and the confidence shown is the weakest
 * claim in the set, not the strongest.
 *
 * The analysis is a paid action and is dressed as one: the coins indicator on
 * the trigger, an estimate before the click, the shared confirmation, and the
 * real figure afterwards — with an unknown rate shown as unknown, never as free.
 */
export function EntityProfilePanel({
    campaignId,
    entityType,
    entityId,
    canEdit,
}: {
    campaignId: string;
    entityType: MediaEntityType;
    entityId: string;
    canEdit: boolean;
}) {
    const t = useT();
    const queryClient = useQueryClient();
    const { data: profile, isLoading, refetch } = useEntityProfile(campaignId, entityType, entityId);

    const [estimate, setEstimate] = useState<AiCostConfirmation | null>(null);
    const [busy, setBusy] = useState<'estimating' | 'analyzing' | 'saving' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [notRecorded, setNotRecorded] = useState<string[]>([]);
    const [showEvidence, setShowEvidence] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<Record<string, string>>({});

    // The form follows the record, except while somebody is typing into it: a
    // background refetch that wiped a half-written correction would be the
    // rudest possible way to stay in sync.
    useEffect(() => {
        if (editing) return;
        setDraft(fieldsToDraft(profile));
    }, [profile, editing]);

    const base = `/campaigns/${campaignId}/${entityType}/${encodeURIComponent(entityId)}/profile`;

    async function askForConfirmation() {
        setBusy('estimating');
        setError(null);
        setMessage(null);
        try {
            const quote = await apiFetch<EntityProfileEstimate>(`${base}/analyze/estimate`);
            setEstimate({
                action: t.profile.analyze,
                provider: quote.provider,
                model: quote.model,
                billable: quote.billable,
                // Null stays null all the way to the modal, which renders it as
                // "pricing unavailable". Rounding it to zero here would be the
                // one place in the app that calls a paid call free.
                estimatedCostEur: quote.estimated_cost_eur,
                estimatedCostUsd: quote.estimated_cost_usd,
            });
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
        } finally {
            setBusy(null);
        }
    }

    async function analyze() {
        setBusy('analyzing');
        setError(null);
        try {
            const result = await apiFetch<EntityProfileAnalysis>(`${base}/analyze`, { method: 'POST' });
            setEstimate(null);
            setNotRecorded(result.not_recorded);
            setMessage(result.kept_fields.length > 0
                ? `${t.profile.analyzed} ${t.profile.keptFields(result.kept_fields.length)}`
                : t.profile.analyzed);
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'profile'] });
            await refetch();
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
            setEstimate(null);
        } finally {
            setBusy(null);
        }
    }

    async function save() {
        setBusy('saving');
        setError(null);
        try {
            // Only what actually changed: sending every field would claim
            // ownership of the ones the analysis found and the person merely
            // looked at.
            const original = fieldsToDraft(profile);
            const fields: Record<string, string | string[] | null> = {};
            for (const [path, value] of Object.entries(draft)) {
                if ((original[path] ?? '') === value) continue;
                const trimmed = value.trim();
                fields[path] = trimmed === ''
                    ? null
                    : LIST_FIELDS.has(path)
                        ? trimmed.split(',').map(item => item.trim()).filter(Boolean)
                        : trimmed;
            }
            if (Object.keys(fields).length === 0) {
                setEditing(false);
                setBusy(null);
                return;
            }

            await apiFetch<EntityProfile>(base, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields }),
            });
            setEditing(false);
            setMessage(t.profile.saved);
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'profile'] });
            await refetch();
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
        } finally {
            setBusy(null);
        }
    }

    if (isLoading) return null;

    const appearance = profile?.appearance_text ?? null;
    const personality = personalityAsText(profile);
    const evidence = profile?.evidence ?? [];
    // The dossier row always exists now — it carries the vocabulary of a form
    // that can be filled in by hand — so "has anything been established" is a
    // question about content, not about the object.
    const established = Boolean(appearance || personality);

    return (
        <section className="entity-profile" aria-label={t.profile.title}>
            <div className="entity-profile__head">
                <h3>{t.profile.title}</h3>
                <div className="badge-row">
                    {profile?.is_manual && <Badge tone="neutral">{t.profile.manualBadge}</Badge>}
                    {profile?.stale_since_session_id && <Badge tone="warning">{t.profile.staleBadge}</Badge>}
                    {profile?.confidence && (
                        <Badge tone={profile.confidence === 'HIGH' ? 'accent' : 'neutral'}>
                            {t.profile.confidences[profile.confidence]}
                        </Badge>
                    )}
                </div>
            </div>
            <p className="settings-hint">{t.profile.hint}</p>
            {profile?.stale_since_session_id && (
                <p className="settings-hint settings-hint--warn">{t.profile.staleHint}</p>
            )}

            {editing ? (
                <div className="entity-profile__form">
                    <p className="settings-hint">{t.profile.writeHint}</p>
                    <div className="entity-profile__fields">
                        {(profile?.fields ?? []).map((path) => {
                            const mine = profile?.manual_fields.includes(path) ?? false;
                            const filled = (fieldsToDraft(profile)[path] ?? '') !== '';
                            return (
                                <label key={path}>
                                    <span>
                                        {t.profile.fieldNames[path] ?? path.replace(/[._]/g, ' ')}
                                        {filled && (
                                            <small>{mine ? t.profile.byHand : t.profile.byAi}</small>
                                        )}
                                        {LIST_FIELDS.has(path) && <small>{t.profile.listHint}</small>}
                                    </span>
                                    <input
                                        type="text"
                                        value={draft[path] ?? ''}
                                        maxLength={2000}
                                        disabled={busy !== null}
                                        onChange={(event) => {
                                            // Read before the updater runs: by
                                            // the time React applies it the
                                            // event's currentTarget is gone.
                                            const value = event.target.value;
                                            setDraft((current) => ({ ...current, [path]: value }));
                                        }}
                                    />
                                </label>
                            );
                        })}
                    </div>
                    <div className="entity-profile__actions">
                        <button type="button" className="primary" disabled={busy !== null} onClick={() => void save()}>
                            {busy === 'saving' ? t.profile.saving : t.profile.save}
                        </button>
                        <button type="button" className="text-button" disabled={busy !== null} onClick={() => setEditing(false)}>
                            {t.profile.cancel}
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <dl className="entity-profile__facts">
                        <dt>{t.profile.appearance}</dt>
                        <dd>{appearance ?? <span className="card-meta">{t.profile.empty}</span>}</dd>
                        {personality && (
                            <>
                                <dt>{t.profile.personality}</dt>
                                <dd>{personality}</dd>
                            </>
                        )}
                    </dl>

                    {notRecorded.length > 0 && (
                        <p className="settings-hint">
                            <strong>{t.profile.notRecorded}</strong> {notRecorded.join(', ')}
                        </p>
                    )}

                    {evidence.length > 0 && (
                        <>
                            <button
                                type="button"
                                className="text-button"
                                onClick={() => setShowEvidence((open) => !open)}
                            >
                                {showEvidence ? t.profile.hideEvidence : t.profile.showEvidence}
                            </button>
                            {showEvidence && (
                                <ul className="entity-profile__evidence" aria-label={t.profile.evidenceTitle}>
                                    {evidence.map((item, index) => (
                                        <li key={`${item.trait}-${index}`}>
                                            <strong>{item.trait}</strong>
                                            <span className="card-meta">
                                                {t.profile.sources[item.source]}
                                                {item.session_id ? ` · ${t.profile.fromSession(item.session_id)}` : ''}
                                            </span>
                                            <q>{item.quote}</q>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    )}

                    {profile?.provider && profile.model && (
                        <p className="settings-hint">{t.profile.analyzedWith(profile.provider, profile.model)}</p>
                    )}

                    {canEdit && (
                        <div className="entity-profile__actions">
                            <span className="ai-cost-action">
                                <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => void askForConfirmation()}
                                >
                                    <Icon name="sparkles" />
                                    {busy === 'analyzing'
                                        ? t.profile.analyzing
                                        : busy === 'estimating'
                                            ? t.aiCost.loadingEstimate
                                            : established ? t.profile.reanalyze : t.profile.analyze}
                                </button>
                                <AiCostIndicator
                                    label={t.aiCost.indicatorLabel}
                                    description={t.aiCost.indicatorDescription}
                                />
                            </span>
                            <button type="button" className="text-button" onClick={() => setEditing(true)}>
                                {t.profile.edit}
                            </button>
                        </div>
                    )}
                </>
            )}

            <FormFeedback error={error} saved={message !== null} savedLabel={message ?? ''} />

            <AiCostConfirmationModal
                open={estimate !== null}
                estimate={estimate}
                busy={busy === 'analyzing'}
                onClose={() => setEstimate(null)}
                onConfirm={() => void analyze()}
            />
        </section>
    );
}

/** Fields that hold several values, entered as a comma-separated list. */
const LIST_FIELDS = new Set(['face_marks', 'garments', 'weapons', 'notable_features']);

/**
 * The dossier flattened into one editable string per field.
 *
 * Same shape whether a value came from the analysis or from a person: the form
 * is where the two meet, and the difference is shown as a note beside the
 * field rather than by keeping two sets of inputs.
 */
function fieldsToDraft(profile: EntityProfile | null | undefined): Record<string, string> {
    const draft: Record<string, string> = {};
    if (!profile) return draft;

    for (const path of profile.fields) {
        const source = path.startsWith('personality.') ? profile.personality : profile.appearance;
        const key = path.startsWith('personality.') ? path.slice('personality.'.length) : path;
        const [head, tail] = key.split('.');
        const holder = source?.[head];
        const value = tail
            ? (holder && typeof holder === 'object' ? (holder as Record<string, unknown>)[tail] : undefined)
            : holder;

        draft[path] = Array.isArray(value)
            ? value.join(', ')
            : typeof value === 'string' ? value : '';
    }
    return draft;
}

/**
 * The temperament as a sentence.
 *
 * It arrives either as fields the extractor filled or as prose somebody typed,
 * and the reader should not be able to tell which — the difference matters to
 * the AI, not to the person reading a sheet.
 */
function personalityAsText(profile: EntityProfile | null | undefined): string | null {
    if (!profile) return null;
    if (profile.personality_text) return profile.personality_text;
    if (!profile.personality) return null;
    const parts = Object.values(profile.personality)
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    return parts.length > 0 ? parts.join('; ') : null;
}

export type { TraitEvidence };
