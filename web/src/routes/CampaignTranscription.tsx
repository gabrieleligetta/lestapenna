import { useEffect, useState } from 'react';
import {
    useCampaignTranscription,
    useCampaignTranscriptionActions,
    useProviderModels,
    useRemoteWhisperModels,
} from '../api/hooks';
import type { AiModelOption } from '../api/types';
import { ModelSelect } from '../components/ModelSelect';
import { useT } from '../i18n';
import { FormFeedback } from '../components/FormFeedback';

/**
 * Which model turns this campaign's audio into text.
 *
 * **The engine is shown, not chosen.** Picking between the table's own PC and a
 * cloud model is picking who pays, and that belongs to the server: two
 * campaigns sharing a Discord server share the bill. What legitimately differs
 * between them is the model — one played in a noisy room wants the accurate
 * one, another is happy with the fast one — and that is what this section
 * moves.
 */
export function CampaignTranscription({
    campaignId, guildId, readOnly,
}: {
    campaignId: string;
    guildId: string;
    readOnly: boolean;
}) {
    const t = useT();
    const transcription = useCampaignTranscription(campaignId);
    const actions = useCampaignTranscriptionActions(campaignId);
    const engine = transcription.data?.engine ?? null;

    // Only the engine actually in use is asked about: the cloud catalogue is
    // pointless for a table on its own PC, and waking a home PC to list models
    // nobody will pick would be rude.
    const cloud = useProviderModels(guildId, engine === 'cloud' ? (transcription.data?.effective_provider ?? null) : null);
    const remote = useRemoteWhisperModels(guildId, engine === 'remote');

    const [model, setModel] = useState('');
    const [saved, setSaved] = useState(false);

    const effective = transcription.data?.effective_model ?? '';
    useEffect(() => { setModel(effective); }, [effective]);

    if (!transcription.data) return null;

    const options: AiModelOption[] = engine === 'cloud'
        ? cloud.data?.transcription ?? []
        // The PC's answer is a plain list of names: it knows nothing about
        // prices, and there is none to know — that machine is the table's own.
        : (remote.data?.models ?? []).map((id) => ({
            id,
            label: null,
            recommended: id === remote.data?.current,
            input_per_million: null,
            output_per_million: null,
            per_minute_usd: null,
            per_image_usd: null,
            context_tokens: null,
            runs_on_your_hardware: true,
        }));

    async function save() {
        const trimmed = model.trim();
        const patch = engine === 'cloud'
            ? { cloud_model: trimmed || null }
            : { remote_model: trimmed || null };
        if (await actions.save(patch)) setSaved(true);
    }

    return (
        <section className="settings-section">
            <h2>{t.campaignTranscription.title}</h2>
            <p className="settings-hint">{t.campaignTranscription.intro}</p>

            <p className="settings-hint">
                <strong>{t.campaignTranscription.engine}:</strong>{' '}
                {engine === 'remote' && t.campaignTranscription.engineRemote}
                {engine === 'cloud' && t.campaignTranscription.engineCloud}
                {engine === null && t.campaignTranscription.engineNone}
                {' — '}{t.campaignTranscription.engineHint}
            </p>

            {engine === null && (
                <p className="settings-hint">{t.campaignTranscription.notConfigured}</p>
            )}

            {engine !== null && (
                <>
                    <label>
                        <span>{t.campaignTranscription.model}</span>
                        <ModelSelect
                            value={model}
                            options={options}
                            disabled={readOnly || actions.busy}
                            allowEmpty
                            emptyLabel={t.campaignTranscription.followGuild}
                            onChange={(next) => { setModel(next); setSaved(false); }}
                        />
                    </label>

                    {engine === 'cloud' && transcription.data.usd_per_minute !== null && (
                        <p className="model-select__estimate">
                            {t.campaignTranscription.perMinute(
                                `$${transcription.data.usd_per_minute.toFixed(4)}`,
                            )}
                        </p>
                    )}
                    {engine === 'remote' && (
                        <p className="model-select__estimate">{t.campaignTranscription.freeOnYourPc}</p>
                    )}

                    {/* A home PC being off is its normal state, not a failure:
                        the choice can still be made and saved now. */}
                    {remote.data?.reason === 'UNREACHABLE' && (
                        <p className="settings-hint">{t.campaignTranscription.pcOff}</p>
                    )}
                    {remote.data?.reason === 'UNAUTHORIZED' && (
                        <p className="form-error" role="alert">{t.campaignTranscription.pcUnauthorized}</p>
                    )}
                    {transcription.data.reason === 'NO_CLOUD_KEY' && (
                        <p className="form-error" role="alert">{t.campaignTranscription.noKey}</p>
                    )}

                    <FormFeedback error={actions.error} saved={saved} savedLabel={t.campaignTranscription.saved} />

                    <button type="button" disabled={readOnly || actions.busy} onClick={save}>
                        {t.campaignTranscription.save}
                    </button>
                </>
            )}
        </section>
    );
}
