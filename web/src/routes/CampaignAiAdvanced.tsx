import { useEffect, useState } from 'react';
import { useCampaignAiPhaseActions, usePhaseCostEstimate, useProviderModels } from '../api/hooks';
import type { AiPhaseConfig, AiPhaseOverride, AiProvider } from '../api/types';
import { ModelSelect } from '../components/ModelSelect';
import { phaseName, providerName } from '../components/aiLabels';
import { formatAiMoney } from '../components/aiCostFormatting';
import { useLocale, useT } from '../i18n';
import { FormFeedback } from '../components/FormFeedback';

/** The same as the guild page: only those that cover the whole pipeline. */
const PROVIDERS: AiProvider[] = ['openai', 'gemini', 'ollama'];

/**
 * Advanced settings: the model of a single phase, for this campaign.
 *
 * Collapsed by default, and for a reason: the normal choice is two selects, and
 * someone who does not know the pipeline should not be faced with nine rows to
 * decide. Anyone who opens them knows what they are after.
 *
 * What moves here is **which model**, never who pays: the keys belong to the
 * Discord server and cannot even be named from this section.
 */
export function CampaignAiAdvanced({
    campaignId, guildId, effective, overrides, readOnly,
}: {
    campaignId: string;
    guildId: string;
    effective: AiPhaseConfig[];
    overrides: AiPhaseOverride[];
    readOnly: boolean;
}) {
    const t = useT();
    const actions = useCampaignAiPhaseActions(campaignId);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<AiPhaseOverride[]>(overrides);
    const [saved, setSaved] = useState(false);

    // The draft used to be seeded once at mount and never again, so a refetch —
    // saving elsewhere on the page, a window regaining focus — left these rows
    // showing values the server no longer held.
    useEffect(() => { setDraft(overrides); }, [overrides]);

    // Embedding is not overridable: it is pinned to the campaign and changed
    // through the reindex flow, which is the only place that can price making
    // the existing fragments unreadable. The server refuses it too.
    const overridablePhases = effective.filter((phase) => phase.phase !== 'embedding');

    function overrideFor(phase: string): AiPhaseOverride | undefined {
        return draft.find((entry) => entry.phase === phase);
    }

    function setOverride(phase: string, next: AiPhaseOverride | null) {
        setSaved(false);
        setDraft((current) => {
            const without = current.filter((entry) => entry.phase !== phase);
            return next ? [...without, next] : without;
        });
    }

    async function save() {
        // Only overrides with a model written in are sent: a half-filled row
        // would save a phase pointed at nothing. Embedding is dropped rather
        // than sent to be refused: a legacy value could still be sitting in a
        // draft seeded before this page stopped offering it.
        const complete = draft.filter(
            (entry) => entry.model.trim() !== '' && entry.phase !== 'embedding',
        );
        const result = await actions.save(complete);
        if (result) {
            setDraft(result);
            setSaved(true);
        }
    }

    return (
        <details
            className="settings-section"
            open={open}
            onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
        >
            <summary><h2>{t.aiSettings.advancedTitle}</h2></summary>
            <p className="settings-hint">{t.aiSettings.advancedIntro}</p>

            {/*
              * Indexing is not here, and the row that used to be was worse than
              * missing: it offered the text catalogue — models that cannot
              * embed — and wrote a setting nothing reads, because embedding
              * resolves from the model pinned to the campaign, not from the
              * per-phase overrides. Changing it also makes every fragment
              * already indexed invisible to search, which is why its real
              * control prices the recalculation before doing it.
              */}
            <p className="settings-hint">{t.aiSettings.embeddingElsewhere}</p>

            {overridablePhases.map((phase) => (
                <PhaseRow
                    key={phase.phase}
                    campaignId={campaignId}
                    guildId={guildId}
                    phase={phase}
                    override={overrideFor(phase.phase)}
                    disabled={readOnly || actions.busy}
                    // Only mount the model select of an open section: nine rows
                    // would otherwise fetch nine catalogues to show nothing.
                    active={open}
                    onChange={(next) => setOverride(phase.phase, next)}
                />
            ))}

            <FormFeedback error={actions.error} saved={saved} savedLabel={t.aiSettings.saved} />

            <button type="button" disabled={readOnly || actions.busy} onClick={save}>
                {t.aiSettings.save}
            </button>
        </details>
    );
}

function PhaseRow({
    campaignId, guildId, phase, override, disabled, active, onChange,
}: {
    campaignId: string;
    guildId: string;
    phase: AiPhaseConfig;
    override: AiPhaseOverride | undefined;
    disabled: boolean;
    active: boolean;
    onChange: (next: AiPhaseOverride | null) => void;
}) {
    const t = useT();
    const provider = override?.provider ?? null;
    const models = useProviderModels(guildId, active ? provider : null);

    // Which half of the catalogue this phase belongs to. The transcript
    // correction is in neither group but is still a text phase, so the full
    // list is the honest answer rather than an arbitrary half. Embedding used
    // to land here too and got the same text catalogue — models that cannot
    // embed at all; it is no longer among the rows.
    const options = phase.phase === 'image'
        // Not a tier and not a text model: offering the text catalogue here
        // would fill the select with models that cannot draw.
        ? models.data?.image ?? []
        : phase.tier === 'quality'
            ? models.data?.quality ?? []
            : phase.tier === 'fast'
                ? models.data?.fast ?? []
                : [...(models.data?.quality ?? []), ...(models.data?.fast ?? [])];

    return (
        <div className="ai-phase-override">
            <span className="ai-phase-override__name">{phaseName(t, phase.phase)}</span>

            <select
                className="model-select__control"
                aria-label={t.aiSettings.provider}
                value={provider ?? ''}
                disabled={disabled}
                onChange={(event) => {
                    const chosen = event.target.value as AiProvider | '';
                    onChange(chosen === ''
                        ? null
                        : { phase: phase.phase, provider: chosen, model: override?.model ?? '' });
                }}
            >
                {/* Empty = no override: the phase follows the guild's group.
                    What that resolves to is shown beside it, not crammed into
                    this option — it never fitted, and every unconfigured row
                    read as a truncated "Usa il default dell'ista…". */}
                <option value="">{t.aiSettings.useDefault}</option>
                {PROVIDERS.map((candidate) => (
                    <option key={candidate} value={candidate}>{providerName(t, candidate)}</option>
                ))}
            </select>

            {override ? (
                <div>
                    <ModelSelect
                        value={override.model}
                        options={options}
                        disabled={disabled}
                        ariaLabel={t.aiSettings.model}
                        onChange={(model) => onChange({ ...override, model })}
                    />
                    <PhaseEstimate
                        campaignId={campaignId}
                        phase={phase.phase}
                        provider={override.provider}
                        model={override.model}
                    />
                </div>
            ) : (
                // The column would otherwise be dead space on eight rows out of
                // nine, while the one thing worth reading there — what this
                // phase actually uses right now — was hidden inside the select.
                <span className="ai-phase-override__inherited">
                    {providerName(t, phase.provider)} · <code>{phase.model}</code>
                </span>
            )}
        </div>
    );
}

/**
 * What this phase would cost with the model currently selected.
 *
 * The whole point of the figure being here: the session estimate prices what is
 * already configured, so by the time it moves the choice has been made. This is
 * the number someone needs *while* the select is open.
 */
function PhaseEstimate({
    campaignId, phase, provider, model,
}: {
    campaignId: string;
    phase: string;
    provider: AiProvider;
    model: string;
}) {
    const t = useT();
    const { locale } = useLocale();
    const estimate = usePhaseCostEstimate(campaignId, phase, provider, model);

    if (!estimate.data) return null;
    const { cost_eur: costEur, pricing_source: source, calibrated, audio_minutes: minutes } = estimate.data;

    if (source === 'free') {
        return <p className="model-select__estimate">{t.aiSettings.estimateFree}</p>;
    }
    // Unknown is not zero. Saying so is the whole reason `pricing_source` exists.
    if (costEur === null) {
        return (
            <p className="model-select__estimate model-select__estimate--unknown">
                {t.aiSettings.estimateUnknown}
            </p>
        );
    }

    return (
        <p className="model-select__estimate">
            <strong>
                {t.aiSettings.estimateFor(
                    formatAiMoney(costEur, 'EUR', locale),
                    String(Math.round(minutes / 60)),
                )}
            </strong>
            {' '}
            {calibrated ? t.aiSettings.estimateFromHistory : t.aiSettings.estimateFromDefaults}
        </p>
    );
}
