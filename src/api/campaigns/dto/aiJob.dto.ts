import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AiJobErrorKind, AiJobKind, AiJobStatus } from '../../../db/repositories/AiJobRepository';

export const AI_JOB_KINDS = ['image', 'appearance', 'quest-audit', 'character-bio'] as const;
export const AI_JOB_STATUSES = [
    'queued', 'running', 'awaiting_review', 'succeeded', 'discarded', 'failed', 'expired',
] as const;

/**
 * One piece of paid work, as the browser sees it.
 *
 * Deliberately the same shape wherever it is served — the card in the corner,
 * the bell, the campaign register — because they are three views of one row and
 * three shapes would drift.
 */
export class AiJobDto {
    @ApiProperty() id!: string;
    @ApiProperty() campaign_id!: number;
    @ApiProperty({ description: 'Resolved from the campaign: the notification has to link somewhere.' })
    guild_id!: string;
    @ApiProperty({ enum: AI_JOB_KINDS }) kind!: AiJobKind;
    @ApiProperty({ enum: ['npc', 'location', 'character', 'artifact', 'campaign'] })
    target_type!: string;
    @ApiProperty({ description: 'The public short id — what the URL carries.' })
    target_key!: string;
    @ApiProperty({ nullable: true, description: 'The name as it read when the work was asked for.' })
    target_label!: string | null;
    @ApiProperty() requested_by!: string;
    @ApiProperty({ enum: AI_JOB_STATUSES }) status!: AiJobStatus;
    @ApiProperty({ nullable: true }) error_kind!: AiJobErrorKind | null;
    @ApiProperty({ nullable: true }) error_message!: string | null;
    @ApiProperty({ nullable: true }) provider!: string | null;
    @ApiProperty({ nullable: true }) model!: string | null;
    /**
     * What it cost, summed from the ledger.
     *
     * `null` is not zero: it means the model has no published price. The two are
     * different answers and the most expensive click in the product is the worst
     * place to confuse them.
     */
    @ApiProperty({ nullable: true }) cost_usd!: number | null;
    @ApiProperty({ nullable: true }) cost_eur!: number | null;
    @ApiProperty({ description: 'False when the rate is unknown — which is not the same as free.' })
    pricing_available!: boolean;
    @ApiProperty({ description: 'True once the provider answered: from here the money is gone.' })
    charged!: boolean;
    @ApiProperty({ nullable: true }) seen_at!: number | null;
    @ApiProperty() created_at!: number;
    @ApiProperty({ nullable: true }) finished_at!: number | null;
    @ApiProperty({ nullable: true, description: 'When an unaccepted result is thrown away.' })
    expires_at!: number | null;
    /** Free-form per kind: the picture's size, how many suggestions were found. */
    @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
    result?: Record<string, unknown> | null;
    @ApiPropertyOptional({ nullable: true, description: 'The user\'s own words, echoed back for a repeat run.' })
    prompt?: string | null;
}

/** The answer to "I have accepted the work", before any of it is done. */
export class AiJobAcceptedDto {
    @ApiProperty() job_id!: string;
    @ApiProperty({ enum: AI_JOB_STATUSES }) status!: AiJobStatus;
}

/** Everything the corner card and the bell need, in one call. */
export class MyAiJobsDto {
    @ApiProperty({ type: [AiJobDto] }) items!: AiJobDto[];
    @ApiProperty({ description: 'Finished work this person has not looked at yet.' })
    unseen_count!: number;
    @ApiProperty({ description: 'Still queued or running. Zero means nothing is moving.' })
    active_count!: number;
}
