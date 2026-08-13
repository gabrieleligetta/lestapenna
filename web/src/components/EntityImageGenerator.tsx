import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import { actionErrorMessage } from '../api/errors';
import {
    useAiJob,
    useEntityProfile,
    useGenerationReferences,
    usePendingImageJob,
} from '../api/hooks';
import type {
    AiJobAccepted,
    EntityImage,
    ImageGenerationEstimate,
    ImageGenerationMode,
    ImageShot,
    MediaEntityType,
    ReferenceCandidate,
    ReferenceDirective,
    ReferenceManifestEntry,
} from '../api/types';
import { useLocale, useT } from '../i18n';
import { AiCostConfirmationModal, type AiCostConfirmation } from './AiCostConfirmationModal';
import { AiCostIndicator } from './AiCostIndicator';
import { formatAiMoney } from './aiCostFormatting';
import { FormFeedback } from './FormFeedback';
import { Icon } from './icons';
import { ImageLightbox } from './ImageLightbox';
import { ReferenceMetadataFields } from './ReferenceMetadataFields';

const MODES: ImageGenerationMode[] = ['auto', 'prompt', 'mixed'];

/**
 * Asking the AI for an entity's picture.
 *
 * **Everything here is arranged around the fact that this costs real money on
 * somebody else's account.** A portrait is worth several hundred chat messages,
 * so it follows the same four steps as every other paid action in the app: the
 * coins indicator on the trigger, an estimate fetched before the click, the
 * shared confirmation modal, and the actual figure shown afterwards. When the
 * model's rate is unknown the modal says so — it never implies free.
 *
 * **Nothing is applied until it is accepted.** The generated picture comes back
 * as a preview and waits: replacing what is on a sheet with something the person
 * has not seen would be the wrong default for an irreversible-feeling change.
 *
 * **A generated picture remembers how it was asked for.** Reopening the panel
 * restores the mode and the person's own words into an editable field, so the
 * same request can be repeated as it was or adjusted first — which is what makes
 * iterating on a portrait cheap in effort, though never in money: every run goes
 * through the confirmation again.
 */
export function EntityImageGenerator({
    campaignId,
    entityType,
    entityId,
    image,
    onGenerated,
}: {
    campaignId: string;
    entityType: MediaEntityType;
    entityId: string;
    image?: EntityImage | null;
    onGenerated: () => Promise<void> | void;
}) {
    const t = useT();
    const { locale } = useLocale();
    const queryClient = useQueryClient();
    // What the picture will actually be built from. Worth saying before the
    // click rather than after: the two paths do not produce comparable
    // likenesses, and the weaker one is the one a new table lands on.
    const { data: profile } = useEntityProfile(campaignId, entityType, entityId);
    const { data: candidates } = useGenerationReferences(campaignId, entityType, entityId);

    const [mode, setMode] = useState<ImageGenerationMode>(image?.generationMode ?? 'auto');
    const [prompt, setPrompt] = useState(image?.generationPrompt ?? '');
    // The job this panel is following. It is an id and not the picture itself,
    // because the work outlives this component: closing the dialog, changing
    // page or losing the connection no longer throws away what was paid for.
    const [jobId, setJobId] = useState<string | null>(null);
    // How the picture should be taken, and what it may look at. Both start
    // empty: the shot falls back to what every portrait had until now, and a
    // reference travels only when somebody ticks it, because each one is
    // tokens on their own account.
    const [shot, setShot] = useState<ImageShot>(image?.generationRequest?.shot ?? {});
    const [references, setReferences] = useState<ReferenceDirective[]>([]);
    const preselectionKey = useRef<string | null>(null);
    // Pictures handed to this one generation: kept privately long enough for
    // the durable job, then deleted without entering gallery or catalogue.
    const [oneTime, setOneTime] = useState<ReferenceCandidate[]>([]);
    const [estimate, setEstimate] = useState<AiCostConfirmation | null>(null);
    const [busy, setBusy] = useState<'estimating' | 'generating' | 'keeping' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [previewZoomed, setPreviewZoomed] = useState(false);

    const { data: pending } = usePendingImageJob(campaignId, entityType, entityId);
    const { data: job } = useAiJob(campaignId, jobId);
    const drawing = job?.status === 'queued' || job?.status === 'running';
    const ready_to_review = job?.status === 'awaiting_review';

    // Reopening on an entity whose picture was generated should offer to repeat
    // that request, not start from a blank one.
    useEffect(() => {
        setMode(image?.generationMode ?? 'auto');
        setPrompt(image?.generationPrompt ?? '');
        setShot(image?.generationRequest?.shot ?? {});
        preselectionKey.current = null;
    }, [entityId, image?.id, image?.generationMode, image?.generationPrompt, image?.generationRequest]);

    // Context defaults are a visible starting point, never an invisible server
    // choice. A saved AI picture instead restores its immutable request so a
    // repeat really is a repeat. Scratch inputs are intentionally not reusable.
    useEffect(() => {
        if (!candidates) return;
        const key = `${entityId}:${image?.id ?? 'new'}`;
        if (preselectionKey.current === key) return;
        preselectionKey.current = key;
        const saved = image?.generationRequest?.references
            ?.filter((reference) => reference.scope !== 'scratch')
            .filter((reference) => candidates.some((candidate) => candidate.id === reference.id))
            .map(({ id, roles, instruction, priority }) => ({ id, roles, instruction, priority }));
        const defaults = candidates
            .filter((candidate) => candidate.auto_selected)
            // Identity first: if six style/livery references exist, the
            // current portrait must not be the seventh input silently omitted.
            .sort((a, b) => defaultCandidatePriority(a) - defaultCandidatePriority(b))
            .slice(0, 6)
            .map((candidate, index) => directiveFor(candidate, index + 1));
        setReferences(normalizePriorities(saved?.length ? saved : defaults));
    }, [candidates, entityId, image?.id, image?.generationRequest]);

    /*
     * Picks up a generation already under way for this entity.
     *
     * This is the whole point of the register, seen from the interface: the
     * modal can be closed, the page navigated away from, the browser reloaded,
     * the server redeployed — and the picture is still there to be accepted,
     * because it was never living in this component's state.
     */
    useEffect(() => {
        if (!jobId && pending) setJobId(pending.id);
    }, [jobId, pending]);

    const base = `/campaigns/${campaignId}/${entityType}/${encodeURIComponent(entityId)}/image/generate`;
    const needsPrompt = mode !== 'auto';
    const hasDossier = Boolean(profile?.appearance && Object.keys(profile.appearance).length > 0);
    const ready = (!needsPrompt || prompt.trim() !== '') && (mode === 'prompt' || hasDossier);

    function draft() {
        return {
            mode,
            prompt: prompt.trim() || null,
            shot,
            references: normalizePriorities(references),
        };
    }

    /** Fetches the price and opens the confirmation. Nothing is spent yet. */
    async function askForConfirmation() {
        setBusy('estimating');
        setError(null);
        setMessage(null);
        try {
            const quote = await apiFetch<ImageGenerationEstimate>(`${base}/estimate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft()),
            });
            setEstimate({
                action: t.media.generateTitle,
                scope: quote.text_model
                    ? `${quote.provider} · ${quote.model} + ${quote.text_provider} · ${quote.text_model}`
                    : undefined,
                provider: quote.provider,
                model: quote.model,
                billable: quote.billable,
                // A null cost reaches the modal as null and is rendered as
                // "pricing unavailable". Coercing it to 0 here would be the one
                // place in the app that tells someone an image was free.
                estimatedCostEur: quote.estimated_cost_eur === null
                    ? null
                    : { min: quote.estimated_cost_eur, max: quote.estimated_cost_eur },
                estimatedCostUsd: quote.estimated_cost_usd === null
                    ? null
                    : { min: quote.estimated_cost_usd, max: quote.estimated_cost_usd },
            });
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
        } finally {
            setBusy(null);
        }
    }

    /** Uploads a picture for this generation only, and ticks it: asking for it was the choice. */
    async function addOneTime(file: File) {
        setError(null);
        if (references.length >= 6) {
            setError(t.references.referenceLimit);
            return;
        }
        try {
            const body = new FormData();
            body.append('file', file);
            const held = await apiFetch<ReferenceCandidate>(
                `/campaigns/${campaignId}/references/one-time`,
                { method: 'POST', body },
            );
            setOneTime((current) => [...current, held]);
            setReferences((current) => {
                if (current.length >= 6) {
                    setError(t.references.referenceLimit);
                    return current;
                }
                return normalizePriorities([...current, directiveFor(held, current.length + 1)]);
            });
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
        }
    }

    async function generate() {
        setBusy('generating');
        setError(null);
        try {
            const accepted = await apiFetch<AiJobAccepted>(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft()),
            });
            setJobId(accepted.job_id);
            setEstimate(null);
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
            setEstimate(null);
        } finally {
            setBusy(null);
        }
    }

    async function keep() {
        if (!jobId) return;
        setBusy('keeping');
        setError(null);
        try {
            await apiFetch<EntityImage>(`${base}/${encodeURIComponent(jobId)}/commit`, {
                method: 'POST',
            });
            setJobId(null);
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] });
            await queryClient.invalidateQueries({ queryKey: ['me', 'ai-jobs'] });
            await onGenerated();
            setMessage(t.media.updated);
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
        } finally {
            setBusy(null);
        }
    }

    async function discard() {
        if (!jobId) return;
        const id = jobId;
        setJobId(null);
        await apiFetch<void>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' })
            .catch(() => undefined);
        await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId, 'image-pending'] });
        await queryClient.invalidateQueries({ queryKey: ['me', 'ai-jobs'] });
    }

    return (
        <section className="entity-image-generator" aria-label={t.media.generateTitle}>
            <h3>{t.media.generateTitle}</h3>
            <p className="settings-hint">{t.media.generateHint}</p>

            {mode !== 'prompt' && (
                <p className="settings-hint">
                    {profile?.appearance_text ? t.media.drawnFromDossier : t.media.drawnWithoutDossier}
                    {references.length > 0 && (
                        <> {t.media.referencesUsed(references.length)}</>
                    )}
                </p>
            )}

            <fieldset className="entity-image-generator__modes">
                <legend className="visually-hidden">{t.media.generateTitle}</legend>
                {MODES.map((option) => (
                    <label key={option} className="settings-form__check">
                        <input
                            type="radio"
                            name={`image-mode-${entityId}`}
                            checked={mode === option}
                            disabled={busy !== null || (option !== 'prompt' && !hasDossier)}
                            onChange={() => { setMode(option); setMessage(null); }}
                        />
                        <span>
                            {t.media[MODE_LABEL[option]]}
                            <small>{t.media[MODE_HINT[option]]}</small>
                        </span>
                    </label>
                ))}
            </fieldset>

            {needsPrompt && (
                <label>
                    <span>{t.media.promptLabel}</span>
                    <textarea
                        value={prompt}
                        rows={3}
                        maxLength={1000}
                        disabled={busy !== null}
                        placeholder={t.media.promptPlaceholder}
                        onChange={(event) => { setPrompt(event.currentTarget.value); setMessage(null); }}
                    />
                </label>
            )}

            {!ready_to_review && (
                <fieldset className="entity-image-generator__shot">
                    <legend>{t.media.shot}</legend>
                    <p className="settings-hint">{t.media.shotHint}</p>
                    <div className="entity-image-generator__shot-grid">
                        <ShotSelect
                            label={t.media.framing}
                            value={shot.framing ?? ''}
                            options={FRAMINGS[profile?.kind ?? 'person']}
                            onChange={(value) => setShot((current) => ({ ...current, framing: value as never }))}
                        />
                        {profile?.kind !== 'place' && profile?.kind !== 'object' && (
                            <ShotSelect
                                label={t.media.pose}
                                value={shot.pose ?? ''}
                                options={POSES}
                                onChange={(value) => setShot((current) => ({ ...current, pose: value as never }))}
                            />
                        )}
                        <ShotSelect
                            label={t.media.light}
                            value={shot.light ?? ''}
                            options={LIGHTS}
                            onChange={(value) => setShot((current) => ({ ...current, light: value as never }))}
                        />
                        <ShotSelect
                            label={t.media.background}
                            value={shot.background ?? ''}
                            options={BACKGROUNDS}
                            onChange={(value) => setShot((current) => ({ ...current, background: value as never }))}
                        />
                    </div>
                </fieldset>
            )}

            {!ready_to_review && (
                <fieldset className="entity-image-generator__references">
                    <legend>{t.media.referencePicker}</legend>
                    <p className="settings-hint">{t.media.referencePickerHint}</p>
                    {[...(candidates ?? []), ...oneTime].length > 0 ? (
                        <ul className="entity-image-generator__reference-list">
                            {[...(candidates ?? []), ...oneTime].map((candidate) => {
                                const directive = references.find((reference) => reference.id === candidate.id);
                                const position = directive
                                    ? references.findIndex((reference) => reference.id === candidate.id)
                                    : -1;
                                return (
                                <li key={candidate.id} className={directive ? 'is-selected' : undefined}>
                                    <label className="entity-image-generator__reference-summary">
                                        <input
                                            type="checkbox"
                                            checked={Boolean(directive)}
                                            disabled={busy !== null}
                                            onChange={(event) => {
                                                const { checked } = event.target;
                                                setReferences((current) => {
                                                    if (!checked) {
                                                        return normalizePriorities(current.filter((item) => item.id !== candidate.id));
                                                    }
                                                    if (current.length >= 6) {
                                                        setError(t.references.referenceLimit);
                                                        return current;
                                                    }
                                                    setError(null);
                                                    return normalizePriorities([
                                                        ...current,
                                                        directiveFor(candidate, current.length + 1),
                                                    ]);
                                                });
                                            }}
                                        />
                                        <img src={candidate.imageUrl} alt="" loading="lazy" />
                                        <span className="card-meta">
                                            {candidate.label ?? t.media.referenceScopes[candidate.scope]}
                                        </span>
                                    </label>
                                    {directive && (
                                        <div className="entity-image-generator__reference-contract">
                                            <ReferenceMetadataFields
                                                roles={directive.roles}
                                                instruction={directive.instruction ?? ''}
                                                disabled={busy !== null}
                                                onRolesChange={(roles) => setReferences((current) => current.map((item) => (
                                                    item.id === candidate.id ? { ...item, roles } : item
                                                )))}
                                                onInstructionChange={(instruction) => setReferences((current) => current.map((item) => (
                                                    item.id === candidate.id
                                                        ? { ...item, instruction: instruction.trim() ? instruction : null }
                                                        : item
                                                )))}
                                            />
                                            <div className="entity-image-generator__priority">
                                                <span>#{position + 1}</span>
                                                <button
                                                    type="button"
                                                    className="text-button"
                                                    aria-label={t.references.moveUp}
                                                    disabled={busy !== null || position === 0}
                                                    onClick={() => setReferences((current) => moveReference(current, position, -1))}
                                                >↑</button>
                                                <button
                                                    type="button"
                                                    className="text-button"
                                                    aria-label={t.references.moveDown}
                                                    disabled={busy !== null || position === references.length - 1}
                                                    onClick={() => setReferences((current) => moveReference(current, position, 1))}
                                                >↓</button>
                                            </div>
                                        </div>
                                    )}
                                </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="settings-hint">{t.media.noReferences}</p>
                    )}

                    <label className="entity-image-generator__one-time">
                        <span>
                            {t.media.oneTimeReference}
                            <small>{t.media.oneTimeReferenceHint}</small>
                        </span>
                        <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            disabled={busy !== null || references.length >= 6}
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = '';
                                if (file) void addOneTime(file);
                            }}
                        />
                    </label>
                    <p className="settings-hint">{t.media.rightsHint}</p>
                    {references.length > 0 && (
                        <ReferenceManifestSummary
                            title={t.references.selectedManifest}
                            references={references.map((directive) => ({
                                ...directive,
                                label: [...(candidates ?? []), ...oneTime]
                                    .find((candidate) => candidate.id === directive.id)?.label ?? null,
                                scope: [...(candidates ?? []), ...oneTime]
                                    .find((candidate) => candidate.id === directive.id)?.scope ?? 'entity',
                            }))}
                        />
                    )}
                </fieldset>
            )}

            {ready_to_review && job ? (
                <div className="entity-image-generator__preview">
                    <button
                        type="button"
                        className="entity-image-generator__preview-zoom"
                        aria-label={t.media.enlarge}
                        onClick={() => setPreviewZoomed(true)}
                    >
                        <img
                            src={`/api/v1${base}/${encodeURIComponent(job.id)}/preview`}
                            alt={t.media.preview}
                        />
                    </button>
                    <ImageLightbox
                        src={`/api/v1${base}/${encodeURIComponent(job.id)}/preview`}
                        alt={t.media.preview}
                        open={previewZoomed}
                        onClose={() => setPreviewZoomed(false)}
                    />
                    <p className="settings-hint">{t.media.previewHint}</p>
                    <p className="settings-hint">
                        {t.media.generatedWith(job.provider ?? '', job.model ?? '')}
                        {' · '}
                        {job.cost_usd === null
                            ? t.media.costUnknown
                            : t.media.actualCost(
                                formatAiMoney(job.cost_eur ?? job.cost_usd, job.cost_eur === null ? 'USD' : 'EUR', locale),
                            )}
                    </p>
                    {referenceManifestFromResult(job.result).length > 0 && (
                        <ReferenceManifestSummary
                            title={t.references.selectedManifest}
                            references={referenceManifestFromResult(job.result)}
                        />
                    )}
                    <div className="entity-image-generator__actions">
                        <button type="button" className="primary" disabled={busy !== null} onClick={() => void keep()}>
                            {busy === 'keeping' ? t.media.keeping : t.media.keep}
                        </button>
                        {/* Generating again spends again, so it goes back through
                            the confirmation like any first run would. */}
                        <button type="button" disabled={busy !== null} onClick={() => void askForConfirmation()}>
                            {t.media.regenerate}
                        </button>
                        <button type="button" className="text-button" disabled={busy !== null} onClick={() => void discard()}>
                            {t.media.discard}
                        </button>
                    </div>
                </div>
            ) : (
                <span className="ai-cost-action">
                    <button
                        type="button"
                        disabled={busy !== null || drawing || !ready}
                        onClick={() => void askForConfirmation()}
                    >
                        <Icon name="sparkles" />
                        {drawing || busy === 'generating'
                            ? t.media.generating
                            : busy === 'estimating'
                                ? t.aiCost.loadingEstimate
                                : image?.source === 'ai' ? t.media.regenerate : t.media.generate}
                    </button>
                    <AiCostIndicator
                        label={t.aiCost.indicatorLabel}
                        description={t.aiCost.indicatorDescription}
                    />
                </span>
            )}

            {drawing && (
                /* Said here as well as in the corner card, because someone
                   watching this panel should not have to look elsewhere — and
                   because leaving is now safe, which is worth telling them. */
                <p className="settings-hint" role="status">{t.media.drawingInBackground}</p>
            )}

            {job?.status === 'failed' && (
                <p className="form-error" role="alert">
                    {job.error_kind === 'interrupted'
                        ? t.media.jobInterrupted
                        : job.error_message ?? t.common.error}
                </p>
            )}

            {image?.source === 'ai' && image.generationPrompt && !ready_to_review && (
                <p className="settings-hint">
                    <strong>{t.media.generatedFrom}</strong> {image.generationPrompt}
                </p>
            )}

            <FormFeedback error={error} saved={message !== null} savedLabel={message ?? ''} />

            <AiCostConfirmationModal
                open={estimate !== null}
                estimate={estimate}
                busy={busy === 'generating'}
                onClose={() => setEstimate(null)}
                onConfirm={() => void generate()}
            />
        </section>
    );
}

function directiveFor(candidate: ReferenceCandidate, priority: number): ReferenceDirective {
    return {
        id: candidate.id,
        roles: candidate.roles,
        instruction: candidate.instruction,
        priority,
    };
}

function defaultCandidatePriority(candidate: ReferenceCandidate): number {
    if (candidate.scope === 'entity') return 0;
    if (candidate.scope === 'faction') return 1;
    if (candidate.scope === 'campaign') return 2;
    return 3;
}

function normalizePriorities(references: ReferenceDirective[]): ReferenceDirective[] {
    return references.map((reference, index) => ({ ...reference, priority: index + 1 }));
}

function moveReference(
    references: ReferenceDirective[],
    position: number,
    movement: -1 | 1,
): ReferenceDirective[] {
    const target = position + movement;
    if (position < 0 || target < 0 || target >= references.length) return references;
    const next = [...references];
    [next[position], next[target]] = [next[target], next[position]];
    return normalizePriorities(next);
}

function referenceManifestFromResult(result: Record<string, unknown> | null | undefined): ReferenceManifestEntry[] {
    const raw = result?.references;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is ReferenceManifestEntry => Boolean(
        entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string',
    ));
}

function ReferenceManifestSummary({
    title,
    references,
}: {
    title: string;
    references: ReferenceManifestEntry[];
}) {
    const t = useT();
    return (
        <details className="entity-image-generator__manifest">
            <summary>{title}</summary>
            <ol>
                {[...references].sort((a, b) => a.priority - b.priority).map((reference) => (
                    <li key={reference.id}>
                        <strong>{reference.label ?? reference.scope}</strong>
                        <span>{reference.roles.map((role) => t.references.roleNames[role]).join(', ')}</span>
                        {reference.instruction && <small>{reference.instruction}</small>}
                    </li>
                ))}
            </ol>
        </details>
    );
}

/** One closed set of shot options, with «as it comes» as the empty choice. */
function ShotSelect({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string;
    options: readonly string[];
    onChange: (value: string | null) => void;
}) {
    const t = useT();
    return (
        <label>
            <span>{label}</span>
            <select
                value={value}
                onChange={(event) => onChange(event.currentTarget.value || null)}
            >
                <option value="">{t.media.shotDefault}</option>
                {options.map((option) => (
                    <option key={option} value={option}>
                        {t.media.shotOptions[option] ?? option}
                    </option>
                ))}
            </select>
        </label>
    );
}

const FRAMINGS: Record<'person' | 'place' | 'object', readonly string[]> = {
    person: ['face', 'bust', 'half', 'full'],
    place: ['wide', 'detail'],
    object: ['full', 'detail'],
};
const POSES = ['frontal', 'three_quarter', 'profile', 'back', 'action', 'seated'] as const;
const LIGHTS = ['soft', 'dramatic', 'backlit', 'candlelight', 'daylight', 'night'] as const;
const BACKGROUNDS = ['neutral', 'location', 'dark', 'light'] as const;

const MODE_LABEL = {
    auto: 'modeAuto',
    prompt: 'modePrompt',
    mixed: 'modeMixed',
} as const;

const MODE_HINT = {
    auto: 'modeAutoHint',
    prompt: 'modePromptHint',
    mixed: 'modeMixedHint',
} as const;
