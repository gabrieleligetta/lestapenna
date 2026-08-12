import { useState } from 'react';
import {
    usePricingActions,
    usePricingOverrides,
    useSessionEstimate,
} from '../api/hooks';
import type { PricingOverride, PricingSource } from '../api/types';
import { useLocale, useT } from '../i18n';
import { phaseName, formatRate } from '../components/aiLabels';
import { FormFeedback } from '../components/FormFeedback';

const LENGTHS = [60, 120, 180, 240, 300];

/**
 * How much a session costs, before running it.
 *
 * Cost transparency is not the end-of-session recap: that explains spend already
 * incurred. It is needed here, where the decision is made — and it needs to say
 * **also when we do not know**, because a missing figure quietly rounded to zero
 * is the only way this page can lie about somebody else's money.
 */
export function SessionCostPanel({ guildId, readOnly }: { guildId: string; readOnly: boolean }) {
    const t = useT();
    const { locale } = useLocale();
    const [minutes, setMinutes] = useState(240);
    const estimate = useSessionEstimate(guildId, minutes);

    const label: Record<PricingSource, string> = {
        builtin: t.costs.sourceBuiltin,
        tenant_override: t.costs.sourceOverride,
        free: t.costs.sourceFree,
        subscription: t.costs.sourceSubscription,
        unknown: t.costs.sourceUnknown,
    };

    return (
        <>
            <section className="settings-section">
                <h2>{t.costs.title}</h2>
                <p className="settings-hint">{t.costs.intro}</p>

                <label>
                    <span>{t.costs.sessionLength}</span>
                    <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
                        {LENGTHS.map((value) => (
                            <option key={value} value={value}>{value / 60} h</option>
                        ))}
                    </select>
                </label>

                {estimate.data && (
                    <>
                        <p className={estimate.data.pricing_complete ? 'status' : 'form-error'} role="status">
                            {!estimate.data.pricing_complete || estimate.data.total_usd === null
                                ? t.costs.incomplete
                                : estimate.data.total_usd === 0
                                    ? t.costs.totalFree
                                    : t.costs.total(estimate.data.total_usd.toFixed(2))}
                        </p>

                        {/* If the estimate comes from generic values it must
                            say so: a number that looks measured and is not is
                            worth less than one declared approximate. */}
                        <p className="settings-hint">
                            {estimate.data.calibrated ? t.costs.calibrated : t.costs.notCalibrated}
                        </p>

                        <div className="table-scroll">
                            <table className="ai-effective">
                                <thead>
                                    <tr>
                                        <th>{t.costs.phase}</th>
                                        <th>{t.costs.tokensIn}</th>
                                        <th>{t.costs.tokensOut}</th>
                                        <th>{t.costs.cost}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {estimate.data.per_phase.map((phase) => (
                                        <tr key={phase.phase}>
                                            <td>
                                                {phaseName(t, phase.phase)}
                                                <br />
                                                <small>{phase.provider} · <code>{phase.model}</code></small>
                                            </td>
                                            <td>
                                                {phase.input_tokens > 0 ? phase.input_tokens.toLocaleString(locale) : '—'}
                                                {phase.input_per_million != null && phase.output_per_million != null && (
                                                    <>
                                                        <br />
                                                        <small>
                                                            {t.aiSettings.perMillionTokens(
                                                                formatRate(phase.input_per_million),
                                                                formatRate(phase.output_per_million),
                                                            )}
                                                        </small>
                                                    </>
                                                )}
                                            </td>
                                            <td>
                                                {phase.output_tokens > 0 ? phase.output_tokens.toLocaleString(locale) : '—'}
                                            </td>
                                            <td>
                                                {phase.cost_usd === null ? '—' : `$${phase.cost_usd.toFixed(4)}`}
                                                <br />
                                                <small>
                                                    {label[phase.pricing_source]}
                                                    {phase.resource_intensive && ` · ${t.costs.resourceIntensive}`}
                                                </small>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </section>

            <PricingOverrides guildId={guildId} readOnly={readOnly} />
        </>
    );
}

function PricingOverrides({ guildId, readOnly }: { guildId: string; readOnly: boolean }) {
    const t = useT();
    const stored = usePricingOverrides(guildId);
    const actions = usePricingActions(guildId);
    const [draft, setDraft] = useState<PricingOverride[] | null>(null);
    const [saved, setSaved] = useState(false);

    const rows = draft ?? stored.data ?? [];
    const disabled = readOnly || actions.busy;

    function update(index: number, patch: Partial<PricingOverride>) {
        setSaved(false);
        setDraft(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    }

    return (
        <section className="settings-section">
            <h2>{t.costs.pricingTitle}</h2>
            <p className="settings-hint">{t.costs.pricingIntro}</p>

            {rows.map((row, index) => (
                <div key={index} className="ai-phase-override">
                    <input
                        value={row.model}
                        placeholder={t.costs.pricingModel}
                        disabled={disabled}
                        onChange={(event) => update(index, { model: event.target.value })}
                    />
                    <input
                        type="number"
                        step="0.001"
                        value={row.input_per_million}
                        placeholder={t.costs.pricingInput}
                        disabled={disabled}
                        onChange={(event) => update(index, { input_per_million: Number(event.target.value) })}
                    />
                    <input
                        type="number"
                        step="0.001"
                        value={row.output_per_million}
                        placeholder={t.costs.pricingOutput}
                        disabled={disabled}
                        onChange={(event) => update(index, { output_per_million: Number(event.target.value) })}
                    />
                    {/* Image models are billed per picture, which the two fields
                        above cannot express — without this the escape hatch never
                        reached the most expensive action in the product. */}
                    <input
                        type="number"
                        step="0.001"
                        value={row.per_image_usd ?? ''}
                        placeholder={t.costs.pricingPerImage}
                        disabled={disabled}
                        onChange={(event) => update(index, {
                            per_image_usd: event.target.value === '' ? undefined : Number(event.target.value),
                        })}
                    />
                    <button
                        type="button"
                        className="danger-button"
                        disabled={disabled}
                        onClick={() => setDraft(rows.filter((_, i) => i !== index))}
                    >
                        {t.costs.pricingRemove}
                    </button>
                </div>
            ))}

            <div className="ai-credential__row">
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setDraft([...rows, { model: '', input_per_million: 0, output_per_million: 0 }])}
                >
                    {t.costs.pricingAdd}
                </button>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={async () => {
                        // Rows without a model are rows that were started and never finished:
                        // saving them would create a rate that applies to nothing.
                        const result = await actions.save(rows.filter((row) => row.model.trim() !== ''));
                        if (result) {
                            setDraft(null);
                            setSaved(true);
                        }
                    }}
                >
                    {t.costs.save}
                </button>
            </div>

            <FormFeedback error={actions.error} saved={saved} savedLabel={t.costs.saved} />
        </section>
    );
}
