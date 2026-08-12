import { useState } from 'react';
import { useCampaignEmbedding, useCampaignEmbeddingActions } from '../api/hooks';
import type { ReindexEstimate, ReindexResult } from '../api/types';
import { useT } from '../i18n';
import { FormFeedback } from '../components/FormFeedback';

/**
 * The campaign's memory, and which model it is written with.
 *
 * Changing model is the only action in the pipeline that **makes work already
 * done invisible**: the old vectors stay in the database but search no longer
 * finds them. That is why there is no select that saves here, but an estimate —
 * how many fragments, how much it costs — and then an explicit action.
 */
export function CampaignEmbedding({ campaignId, readOnly }: { campaignId: string; readOnly: boolean }) {
    const t = useT();
    const embedding = useCampaignEmbedding(campaignId);
    const actions = useCampaignEmbeddingActions(campaignId);

    const [target, setTarget] = useState('');
    const [estimate, setEstimate] = useState<ReindexEstimate | null>(null);
    const [result, setResult] = useState<ReindexResult | null>(null);

    if (!embedding.data) return null;
    const data = embedding.data;
    const disabled = readOnly || actions.busy;

    const alternatives = data.options.filter((option) => option.model !== data.model);
    const chosen = data.options.find((option) => option.model === target);

    return (
        <section className="settings-section">
            <h2>{t.embedding.title}</h2>
            <p className="settings-hint">{t.embedding.intro}</p>

            <p className="status" role="status">
                {data.model
                    ? t.embedding.currentModel(data.model, String(data.fragments))
                    : t.embedding.notIndexed}
            </p>

            {data.options.length === 0 ? (
                <p className="form-error">{t.embedding.noOptions}</p>
            ) : alternatives.length > 0 && (
                <>
                    <label>
                        <span>{t.embedding.change}</span>
                        <select
                            value={target}
                            disabled={disabled}
                            onChange={async (event) => {
                                const model = event.target.value;
                                setTarget(model);
                                setResult(null);
                                // The estimate is asked of the server: only it knows
                                // how many fragments there really are.
                                setEstimate(model ? await actions.estimate(model) : null);
                            }}
                        >
                            <option value="">—</option>
                            {alternatives.map((option) => (
                                <option key={option.model} value={option.model}>
                                    {option.model}
                                    {option.usd_per_million_tokens === 0
                                        ? ` — ${t.embedding.free}`
                                        : ` — $${option.usd_per_million_tokens}/1M token`}
                                </option>
                            ))}
                        </select>
                    </label>

                    {estimate && (
                        <>
                            <p className="settings-hint">
                                {chosen?.usd_per_million_tokens === 0 || estimate.estimated_usd === 0
                                    ? t.embedding.estimateFree(String(estimate.fragments))
                                    : t.embedding.estimate(
                                        String(estimate.fragments),
                                        (estimate.estimated_usd ?? 0).toFixed(4),
                                    )}
                            </p>
                            {/* The warning belongs here and not later: this is
                                the moment the person decides. */}
                            <p className="form-error">{t.embedding.warning}</p>

                            <button
                                type="button"
                                disabled={disabled}
                                onClick={async () => setResult(await actions.reindex(target))}
                            >
                                {actions.busy ? t.embedding.reindexing : t.embedding.reindex}
                            </button>
                        </>
                    )}
                </>
            )}

            <FormFeedback error={actions.error} />
            {result && (
                <>
                    <p className="status" role="status">{t.embedding.done(String(result.reindexed))}</p>
                    {result.failed > 0 && (
                        <p className="form-error">{t.embedding.partial(String(result.failed))}</p>
                    )}
                </>
            )}
        </section>
    );
}
