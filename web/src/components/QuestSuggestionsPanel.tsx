import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import { actionErrorMessage } from '../api/errors';
import { useQuestLifecycleSuggestions } from '../api/hooks';
import type {
    QuestAuditEstimate,
    QuestAuditStart,
} from '../api/types';
import { useT } from '../i18n';
import { AiCostConfirmationModal } from './AiCostConfirmationModal';
import { AiCostIndicator } from './AiCostIndicator';
import { Badge } from './Badge';
import { StatusBadge } from './StatusBadge';

export function QuestSuggestionsPanel({
    campaignId,
    questId,
    enabled,
}: {
    campaignId: string;
    questId?: number;
    enabled: boolean;
}) {
    const t = useT();
    const queryClient = useQueryClient();
    const { data = [], isLoading } = useQuestLifecycleSuggestions(campaignId, enabled);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [estimating, setEstimating] = useState(false);
    const [auditing, setAuditing] = useState(false);
    const [estimate, setEstimate] = useState<QuestAuditEstimate | null>(null);
    const [auditMessage, setAuditMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const allowAudit = questId === undefined;
    const suggestions = data.filter((suggestion) =>
        questId === undefined ? true : suggestion.quest_id === questId,
    );

    if (!enabled) return null;
    if (!allowAudit && ((isLoading && suggestions.length === 0) || suggestions.length === 0)) return null;

    async function resolve(id: number, action: 'apply' | 'dismiss') {
        setBusyId(id);
        setError(null);
        try {
            await apiFetch(
                `/campaigns/${campaignId}/quests/lifecycle-suggestions/${id}/${action}`,
                { method: 'POST' },
            );
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] });
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
        } finally {
            setBusyId(null);
        }
    }

    async function requestAuditEstimate() {
        setEstimating(true);
        setAuditMessage(null);
        setError(null);
        try {
            const result = await apiFetch<QuestAuditEstimate>(
                `/campaigns/${campaignId}/quests/lifecycle-audit/estimate`,
            );
            if (result.status === 'READY') {
                setEstimate(result);
            } else if (result.status === 'RUNNING') {
                setAuditMessage(t.aiCost.auditAlreadyRunning);
            } else if (result.status === 'COOLDOWN') {
                await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] });
                setAuditMessage(t.aiCost.auditCooldown);
            } else if (result.status === 'NOTHING_TO_AUDIT') {
                setAuditMessage(t.aiCost.auditNothingToAudit);
            } else {
                setAuditMessage(t.aiCost.auditNoSessions);
            }
        } catch (reason) {
            setError(actionErrorMessage(reason, t));
        } finally {
            setEstimating(false);
        }
    }

    async function confirmAudit() {
        setAuditing(true);
        setAuditMessage(null);
        setError(null);
        try {
            const started = await apiFetch<QuestAuditStart>(
                `/campaigns/${campaignId}/quests/lifecycle-audit`,
                { method: 'POST' },
            );
            await queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] });
            await queryClient.invalidateQueries({ queryKey: ['me', 'ai-jobs'] });
            if (!started.invoked_ai) {
                setAuditMessage(
                    started.skipped_reason === 'NOTHING_TO_AUDIT'
                        ? t.aiCost.auditNothingToAudit
                        : t.aiCost.auditCooldown,
                );
            } else {
                // The audit reads every session the table has, so it runs on its
                // own and reports back through the card in the corner. Saying so
                // here is what stops someone waiting on a spinner that is not
                // coming back.
                setAuditMessage(t.quests.auditStarted);
            }
            setEstimate(null);
        } catch (reason) {
            setEstimate(null);
            setError(actionErrorMessage(reason, t));
        } finally {
            setAuditing(false);
        }
    }

    return (
        <section className="quest-suggestions" aria-labelledby={`quest-suggestions-${questId ?? 'all'}`}>
            <div className="quest-suggestions__header">
                <div>
                    <span className="campaign-kicker">{t.quests.aiKicker}</span>
                    <h2 id={`quest-suggestions-${questId ?? 'all'}`}>{t.quests.aiSuggestions}</h2>
                </div>
                <div className="quest-suggestions__tools">
                    <Badge tone="neutral">{suggestions.length}</Badge>
                    {allowAudit && (
                        <span className="ai-cost-action">
                            <button
                                type="button"
                                disabled={auditing || estimating}
                                onClick={() => void requestAuditEstimate()}
                            >
                                {auditing
                                    ? t.quests.auditing
                                    : estimating
                                        ? t.aiCost.loadingEstimate
                                        : t.quests.auditHistory}
                            </button>
                            <AiCostIndicator
                                label={t.aiCost.indicatorLabel}
                                description={t.aiCost.indicatorDescription}
                            />
                        </span>
                    )}
                </div>
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            {auditMessage && <p className="quest-suggestions__feedback" role="status">{auditMessage}</p>}
            <div className="quest-suggestions__list">
                {suggestions.map((suggestion) => (
                    <article key={suggestion.id} className="quest-suggestion">
                        <div className="quest-suggestion__title">
                            <strong>{suggestion.proposed_title}</strong>
                            <StatusBadge status={suggestion.proposed_status} />
                            <Badge tone="neutral">{suggestion.proposed_type}</Badge>
                        </div>
                        {suggestion.proposed_description && <p>{suggestion.proposed_description}</p>}
                        <p className="quest-suggestion__evidence">
                            <strong>{t.quests.evidence}:</strong> {suggestion.evidence}
                        </p>
                        <div className="quest-editor__actions">
                            <button
                                type="button"
                                disabled={busyId !== null}
                                onClick={() => void resolve(suggestion.id, 'dismiss')}
                            >
                                {t.quests.dismiss}
                            </button>
                            <button
                                type="button"
                                disabled={busyId !== null}
                                onClick={() => void resolve(suggestion.id, 'apply')}
                            >
                                {busyId === suggestion.id ? t.quests.saving : t.quests.apply}
                            </button>
                        </div>
                    </article>
                ))}
            </div>
            {allowAudit && (
                <AiCostConfirmationModal
                    open={estimate !== null}
                    estimate={estimate && {
                        action: t.aiCost.questHistoryAudit,
                        scope: t.aiCost.scopeValue(estimate.session_count, estimate.open_quest_count),
                        provider: estimate.provider,
                        model: estimate.model,
                        tokens: estimate.estimated_tokens,
                        billable: estimate.billable,
                        estimatedCostEur: estimate.estimated_cost_eur,
                        estimatedCostUsd: estimate.estimated_cost_usd,
                    }}
                    busy={auditing}
                    onClose={() => setEstimate(null)}
                    onConfirm={() => void confirmAudit()}
                />
            )}
        </section>
    );
}
