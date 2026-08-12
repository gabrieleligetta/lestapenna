import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types';
import { phaseConfigFor } from '../../bard/config';
import { scopeForCampaign } from '../../bard/ai/scope';
import { runHistoricalQuestAuditAgent } from '../../bard/agent/questLifecycle';
import { parseSummaryData } from '../../bard/summaryData';
import { QuestStatus } from '../../db/types';
import {
    buildEuroCostSnapshot,
    calculateActualAiCost,
    getUsdEurRate,
    UNAVAILABLE_EXCHANGE_RATE,
} from '../../services/aiCostTransparency';
import {
    ActiveJobExistsError,
    aiJobRepository,
    type AiJobRow,
} from '../../db/repositories/AiJobRepository';
import { aiJobEvents } from '../../services/aiJobs/events';
import { AiJobFailure, type AiJobHandler, type AiJobOutcome } from '../../services/aiJobs/types';
import { aiUsageRepository } from '../../db/repositories/AiUsageRepository';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import { questLifecycleRepository } from '../../db/repositories/QuestLifecycleRepository';
import { questRepository } from '../../db/repositories/QuestRepository';
import { sessionRepository } from '../../db/repositories/SessionRepository';
import { tenantRepository } from '../../db/repositories/TenantRepository';
import { logger } from '../../utils/logger';

const log = logger('QuestAudit');

/**
 * How long a table must wait between two audits of the same campaign.
 *
 * It used to live in a `Map` keyed by campaign, which meant a restart handed out
 * a free re-run — of an agent, on the table's own account. It is now read from
 * the register, where it survives everything.
 */
export const QUEST_AUDIT_COOLDOWN_MS = 5 * 60 * 1000;

/** A campaign-wide job has no entity to point at, so it points at the campaign. */
const CAMPAIGN_TARGET = { targetType: 'campaign' as const, targetKey: 'campaign' };

/**
 * Reading the whole campaign back to see which open quests are actually over.
 *
 * The one paid action whose subject is the table rather than a record in it, and
 * the one whose output was already a proposal a person has to accept
 * (`quest_lifecycle_suggestions`). That review surface stays exactly as it is:
 * the register tracks *the run*, not the decisions it proposes.
 */
@Injectable()
export class QuestAuditService implements AiJobHandler {
    /** Why an audit would do nothing right now, or `null` if it would run. */
    skipReason(campaignId: number): 'NO_SESSIONS' | 'NOTHING_TO_AUDIT' | 'RUNNING' | 'COOLDOWN' | null {
        if (buildQuestAuditTimeline(campaignId).sessions.length === 0) return 'NO_SESSIONS';
        if (questRepository.getOpenQuests(campaignId, 1, 0).length === 0) return 'NOTHING_TO_AUDIT';
        if (aiJobRepository.activeFor(campaignId, 'quest-audit', 'campaign', 'campaign')) return 'RUNNING';
        if (this.cooldownEndsAt(campaignId) !== null) return 'COOLDOWN';
        return null;
    }

    /** When the current cooldown lifts, or `null` when there is none. */
    cooldownEndsAt(campaignId: number): number | null {
        const last = aiJobRepository.lastFinishedAt(campaignId, 'quest-audit');
        if (!last) return null;
        const ends = last + QUEST_AUDIT_COOLDOWN_MS;
        return Date.now() < ends ? ends : null;
    }

    /** Takes the request, unless there is nothing to do or it is too soon. */
    enqueue(request: AuthenticatedRequest): { jobId: string | null; skipped: string | null } {
        const campaignId = request.campaignId!;
        const skip = this.skipReason(campaignId);

        if (skip === 'NO_SESSIONS') {
            throw new BadRequestException('No completed sessions are available for this audit');
        }
        if (skip === 'RUNNING') {
            throw new ConflictException('A quest history audit is already running for this campaign');
        }
        // Not an error: nothing to audit and "too soon" are both answers, and
        // neither should cost anything or look like a failure.
        if (skip) return { jobId: null, skipped: skip };

        try {
            const job = aiJobRepository.enqueue({
                campaignId,
                kind: 'quest-audit',
                ...CAMPAIGN_TARGET,
                targetLabel: campaignRepository.getCampaignById(campaignId)?.name ?? null,
                requestedBy: request.webSession.discordUserId,
                params: {},
            });
            aiJobEvents.emitEnqueued();
            return { jobId: job.id, skipped: null };
        } catch (error) {
            if (error instanceof ActiveJobExistsError) {
                throw new ConflictException('A quest history audit is already running for this campaign');
            }
            throw error;
        }
    }

    async run(job: AiJobRow): Promise<AiJobOutcome> {
        const campaignId = job.campaign_id;
        const { sessions, timeline } = buildQuestAuditTimeline(campaignId);
        if (sessions.length === 0) {
            throw new AiJobFailure('refused', 'No completed sessions are available for this audit');
        }

        const audit = await runHistoricalQuestAuditAgent({ campaignId, timelineText: timeline });

        const suggestions = [];
        for (const decision of audit.data.decisions) {
            if (
                decision.action !== 'STATUS_CHANGE'
                || !decision.id
                || !decision.evidence.trim()
                || (decision.proposed_status !== QuestStatus.COMPLETED
                    && decision.proposed_status !== QuestStatus.FAILED)
            ) continue;
            const quest = questRepository.getQuestByShortId(campaignId, decision.id);
            if (!quest) continue;
            suggestions.push(questLifecycleRepository.createSuggestion({
                campaignId,
                questId: quest.id,
                sessionId: null,
                proposedAction: 'STATUS_CHANGE',
                proposedTitle: quest.title,
                proposedDescription: decision.description || null,
                proposedStatus: decision.proposed_status,
                proposedType: quest.type || 'MAJOR',
                evidence: decision.evidence,
                confidence: decision.confidence,
            }));
        }

        await this.recordSpend(job, campaignId, audit);

        return { status: 'succeeded', summary: { suggestions: suggestions.length } };
    }

    private async recordSpend(
        job: AiJobRow,
        campaignId: number,
        audit: { provider?: string; model?: string; tokens: { input: number; output: number; cached?: number } },
    ): Promise<void> {
        const analystConfig = phaseConfigFor('analyst', scopeForCampaign(campaignId));
        const provider = audit.provider || analystConfig.provider;
        const model = audit.model || analystConfig.model;
        const actualCost = calculateActualAiCost(provider as never, model, audit.tokens);
        const exchangeRate = actualCost.billable && actualCost.costUsd !== null
            ? await getUsdEurRate()
            : UNAVAILABLE_EXCHANGE_RATE;
        const euroCost = actualCost.costUsd === null
            ? null
            : buildEuroCostSnapshot(actualCost.costUsd, exchangeRate);
        const guildId = campaignRepository.getCampaignById(campaignId)?.guild_id ?? null;
        const runId = `AIJOB:${job.id}`;

        aiJobRepository.recordSpend(job.id, {
            usageRunId: runId,
            provider,
            model,
            pricingAvailable: actualCost.costUsd !== null,
        });

        try {
            if (actualCost.costUsd !== null) {
                aiUsageRepository.logSessionUsage(runId, guildId, campaignId, [{
                    phase: 'quest-history-audit',
                    provider,
                    model,
                    inputTokens: audit.tokens.input,
                    outputTokens: audit.tokens.output,
                    cachedInputTokens: audit.tokens.cached || 0,
                    inputPricePerMillion: actualCost.inputPricePerMillion ?? undefined,
                    outputPricePerMillion: actualCost.outputPricePerMillion ?? undefined,
                    cachedInputPricePerMillion: actualCost.cachedInputPricePerMillion ?? undefined,
                    costUSD: actualCost.costUsd,
                    costEUR: euroCost?.costEur,
                    usdPerEur: euroCost?.usdPerEur,
                    exchangeRateSource: euroCost?.exchangeRateSource,
                    exchangeRateDate: euroCost?.exchangeRateDate,
                    exchangeRateFetchedAt: euroCost?.exchangeRateFetchedAt,
                }]);
                if (guildId && actualCost.costUsd > 0) {
                    tenantRepository.addAiCost(guildId, actualCost.costUsd, euroCost?.costEur ?? null);
                }
            }
        } catch (costError) {
            // The audit's result must not become an error, nor be repeated, just
            // because the cost ledger is unavailable.
            log.error(`Unable to persist usage for ${runId}`, costError as Error);
        }

        log.info(
            `guild=${guildId ?? 'unknown'} campaign=${campaignId} `
            + `total=${actualCost.costUsd === null ? 'unknown' : `$${actualCost.costUsd.toFixed(6)}`} `
            + `${provider}/${model} in=${audit.tokens.input} out=${audit.tokens.output}`,
        );
    }
}

/**
 * The whole campaign, compacted into something an agent can read at once.
 *
 * A stable global budget rather than a per-session one: every session stays
 * represented however many there are, and a long one keeps its beginning and its
 * end, which is where a quest is opened and closed.
 */
export function buildQuestAuditTimeline(campaignId: number) {
    const sessions = sessionRepository
        .getAvailableSessions(undefined, campaignId, 0)
        .sort((a, b) => a.start_time - b.start_time);
    if (sessions.length === 0) return { sessions, timeline: '' };

    const charsPerSession = Math.max(1200, Math.floor(100000 / sessions.length));
    const timeline = sessions.map((session) => {
        const aiOutput = sessionRepository.getSessionAIOutput(session.session_id);
        const summary = parseSummaryData(aiOutput?.summaryData);
        const narrative = summary?.narrative || summary?.brief || '';
        const half = Math.floor(charsPerSession / 2);
        const compactNarrative = narrative.length <= charsPerSession
            ? narrative
            : `${narrative.slice(0, half)}\n[…]\n${narrative.slice(-half)}`;
        const analystQuests = Array.isArray(aiOutput?.analystData?.quests)
            ? aiOutput.analystData.quests
            : [];
        return [
            `SESSION ${session.session_number ?? '?'} | id=${session.session_id} | start=${session.start_time}`,
            `TITLE: ${session.title || summary?.metadata.title || 'Session'}`,
            compactNarrative,
            analystQuests.length > 0
                ? `QUEST OUTPUT: ${JSON.stringify(analystQuests)}`
                : '',
        ].filter(Boolean).join('\n');
    }).join('\n\n');
    return { sessions, timeline };
}
