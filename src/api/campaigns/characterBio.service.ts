import { ConflictException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types';
import { phaseConfigFor } from '../../bard/config';
import { scopeForCampaign } from '../../bard/ai/scope';
import { resetAndRegenerateCharacterBio } from '../../bard';
import type { BioGenerationCost } from '../../bard/bio';
import {
    buildEuroCostSnapshot,
    getUsdEurRate,
    UNAVAILABLE_EXCHANGE_RATE,
} from '../../services/aiCostTransparency';
import {
    ActiveJobExistsError,
    aiJobRepository,
    parseAiJobParams,
    type AiJobRow,
} from '../../db/repositories/AiJobRepository';
import { aiJobEvents } from '../../services/aiJobs/events';
import { AiJobFailure, type AiJobHandler, type AiJobOutcome } from '../../services/aiJobs/types';
import { aiUsageRepository } from '../../db/repositories/AiUsageRepository';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import { logger } from '../../utils/logger';

const log = logger('CharacterBio');

/**
 * Rewriting a player character's biography from what actually happened.
 *
 * It is on the register for a reason the others did not have: this action had
 * **no lock at all**, so two clicks — or one impatient double click — were two
 * paid regenerations of the same biography. The partial unique index gives it
 * one for free, and the run outliving the request means a slow rewrite no longer
 * depends on the browser staying put.
 */
@Injectable()
export class CharacterBioService implements AiJobHandler {
    enqueue(
        request: AuthenticatedRequest,
        userId: string,
        characterName: string | null,
    ): { jobId: string } {
        const campaignId = request.campaignId!;
        try {
            const job = aiJobRepository.enqueue({
                campaignId,
                kind: 'character-bio',
                // A character is keyed by the player's Discord id here as it is
                // in `entity_media`: it is what the sheet's URL carries.
                targetType: 'character',
                targetKey: userId,
                targetLabel: characterName,
                requestedBy: request.webSession.discordUserId,
                params: { userId },
            });
            aiJobEvents.emitEnqueued();
            return { jobId: job.id };
        } catch (error) {
            if (error instanceof ActiveJobExistsError) {
                throw new ConflictException('This biography is already being rewritten');
            }
            throw error;
        }
    }

    async run(job: AiJobRow): Promise<AiJobOutcome> {
        const params = parseAiJobParams<{ userId: string }>(job);
        if (!params) throw new AiJobFailure('internal', 'This job has no readable request');

        let costUsd: number | null = 0;
        let costEur: number | null = 0;
        const collect = (cost: BioGenerationCost): void => {
            costUsd = costUsd === null || cost.costUsd === null ? null : costUsd + cost.costUsd;
            costEur = costEur === null || cost.costEur === null ? null : costEur + cost.costEur;
        };

        const regenerated = await resetAndRegenerateCharacterBio(job.campaign_id, params.userId, collect);
        if (regenerated === null) {
            throw new AiJobFailure('provider', 'The biography could not be regenerated');
        }

        await this.recordSpend(job, costUsd, costEur);
        return { status: 'succeeded', summary: { characters: 1 } };
    }

    /**
     * Writes the spend the generator reported back.
     *
     * The figures arrive already computed from the bio pipeline, so this only
     * files them — but it files them under the job's run id, which is what makes
     * the register able to show a price at all.
     */
    private async recordSpend(job: AiJobRow, costUsd: number | null, costEur: number | null): Promise<void> {
        const scope = scopeForCampaign(job.campaign_id);
        const phase = phaseConfigFor('metadata', scope);
        const guildId = campaignRepository.getCampaignById(job.campaign_id)?.guild_id ?? null;
        const runId = `AIJOB:${job.id}`;

        aiJobRepository.recordSpend(job.id, {
            usageRunId: runId,
            provider: phase.provider,
            model: phase.model,
            pricingAvailable: costUsd !== null,
        });

        if (costUsd === null) return;
        const exchangeRate = costEur === null ? await getUsdEurRate() : UNAVAILABLE_EXCHANGE_RATE;
        const euro = buildEuroCostSnapshot(costUsd, exchangeRate);

        try {
            aiUsageRepository.logSessionUsage(runId, guildId, job.campaign_id, [{
                phase: 'bio',
                provider: phase.provider,
                model: phase.model,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                costUSD: costUsd,
                costEUR: costEur ?? euro.costEur ?? undefined,
                usdPerEur: euro.usdPerEur ?? undefined,
                exchangeRateSource: euro.exchangeRateSource,
                exchangeRateDate: euro.exchangeRateDate ?? undefined,
                exchangeRateFetchedAt: euro.exchangeRateFetchedAt ?? undefined,
            }]);
        } catch (error) {
            // The biography is rewritten and paid for; losing the ledger row
            // must not lose the rewrite too.
            log.warn(`Could not record the spend for ${runId}: ${(error as Error).message}`);
        }
    }
}
