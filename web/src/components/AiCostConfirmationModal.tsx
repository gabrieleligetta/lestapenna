import { useLocale, useT } from '../i18n';
import { formatAiMoneyRange } from './aiCostFormatting';
import { Modal } from './Modal';

export interface AiCostConfirmation {
    /** What the user is about to buy, already localised. */
    action: string;
    /** What it will be applied to, already localised. Omitted when there is nothing useful to say. */
    scope?: string;
    provider: string;
    model: string;
    /** Token forecast, when the action can produce one. */
    tokens?: { input_min: number; input_max: number; output_min: number; output_max: number } | null;
    /** False on a local provider: no money is spent, only time and hardware. */
    billable: boolean;
    /** Estimated spend on the user's own provider account; null when the model has no known price. */
    estimatedCostEur?: { min: number; max: number } | null;
    estimatedCostUsd?: { min: number; max: number } | null;
}

/**
 * Informed confirmation of a costly AI action.
 *
 * Under BYOK the cost is not a price we collect but the spend the action will
 * produce on the user's provider account: the modal therefore shows provider,
 * model and an estimate in real currency, and on a local model it declares €0
 * while still flagging the commitment of time and hardware.
 *
 * It is not the right pattern everywhere: in the chat with the Bardo the cost
 * sits in a fixed line above the composer, because a modal on every turn would
 * be dismissed blindly and would stop informing anyone.
 */
export function AiCostConfirmationModal({
    open,
    estimate,
    busy,
    onClose,
    onConfirm,
}: {
    open: boolean;
    estimate: AiCostConfirmation | null;
    busy: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const t = useT();
    const { locale } = useLocale();
    if (!estimate) return null;

    const tokenRange = estimate.tokens;
    const costLabel = !estimate.billable
        ? t.aiCost.localProviderCost
        : estimate.estimatedCostEur
            ? formatAiMoneyRange(estimate.estimatedCostEur, 'EUR', locale)
            : estimate.estimatedCostUsd
                ? formatAiMoneyRange(estimate.estimatedCostUsd, 'USD', locale)
                : t.aiCost.pricingUnavailable;

    return (
        <Modal
            open={open}
            onClose={() => !busy && onClose()}
            title={t.aiCost.modalTitle}
        >
            <div className="ai-cost-confirm">
                <header>
                    <span className="campaign-kicker">{t.aiCost.kicker}</span>
                    <h2>{t.aiCost.modalTitle}</h2>
                    <p>{t.aiCost.intro}</p>
                </header>

                <div className="ai-cost-confirm__notice">
                    <strong>{t.aiCost.byokNotice}</strong>
                    <span>{t.aiCost.costWithoutResults}</span>
                </div>

                <dl className="ai-cost-confirm__details">
                    <div>
                        <dt>{t.aiCost.action}</dt>
                        <dd>{estimate.action}</dd>
                    </div>
                    {estimate.scope && (
                        <div>
                            <dt>{t.aiCost.scope}</dt>
                            <dd>{estimate.scope}</dd>
                        </div>
                    )}
                    <div>
                        <dt>{t.aiCost.providerModel}</dt>
                        <dd>{estimate.provider} · {estimate.model}</dd>
                    </div>
                    {tokenRange && (
                        <>
                            <div>
                                <dt>{t.aiCost.inputTokens}</dt>
                                <dd>{tokenRange.input_min.toLocaleString(locale)} – {tokenRange.input_max.toLocaleString(locale)}</dd>
                            </div>
                            <div>
                                <dt>{t.aiCost.outputTokens}</dt>
                                <dd>{tokenRange.output_min.toLocaleString(locale)} – {tokenRange.output_max.toLocaleString(locale)}</dd>
                            </div>
                        </>
                    )}
                    <div className="ai-cost-confirm__cost">
                        <dt>{t.aiCost.estimatedCost}</dt>
                        <dd>{costLabel}</dd>
                    </div>
                </dl>

                <p className="ai-cost-confirm__disclaimer">{t.aiCost.disclaimer}</p>

                <div className="quest-editor__actions">
                    <button type="button" onClick={onClose} disabled={busy}>
                        {t.quests.cancel}
                    </button>
                    <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
                        {busy ? t.aiCost.runningAction : t.aiCost.confirm}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
