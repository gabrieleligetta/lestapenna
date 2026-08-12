import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TRAIT_CONFIDENCES, TRAIT_SOURCES, type TraitConfidence, type TraitSource } from '../../../db/types';
import { AiExchangeRateDto, AiMoneyRangeDto } from './entities.dto';

/**
 * One recorded trait's provenance.
 *
 * Shown, not merely stored. A dossier a reader can check a line at a time is
 * the only kind worth drawing from, and the difference between «the campaign
 * says her hair is white» and «something said so» is the quote.
 */
export class TraitEvidenceDto {
    @ApiProperty({ description: 'Dotted path into the appearance, e.g. `hair.colour`.' })
    trait!: string;
    @ApiProperty({ description: 'What the material says, as close to verbatim as it got.' })
    quote!: string;
    @ApiProperty({ enum: TRAIT_SOURCES }) source!: TraitSource;
    @ApiProperty({ nullable: true }) session_id!: string | null;
}

export class EntityProfileDto {
    @ApiProperty({
        enum: ['person', 'place', 'object'],
        description: 'Which vocabulary of visible traits applies: a place has no bearing, a sword no temperament.',
    })
    kind!: 'person' | 'place' | 'object';
    @ApiProperty({
        isArray: true,
        type: String,
        description: 'Every field this kind of subject can have, in the order a form should show them. Served so the sheet does not keep a second copy of the list.',
    })
    fields!: string[];
    @ApiProperty({
        isArray: true,
        type: String,
        description: 'The fields a person filled in by hand. An analysis fills the rest and never touches these.',
    })
    manual_fields!: string[];
    @ApiProperty({ nullable: true, description: 'The structured traits the image prompt is assembled from.' })
    appearance!: Record<string, unknown> | null;
    @ApiProperty({ nullable: true, description: 'The same traits, rendered for a reader.' })
    appearance_text!: string | null;
    @ApiProperty({ nullable: true, description: 'Temperament, manner and voice — people only.' })
    personality!: Record<string, unknown> | null;
    @ApiProperty({ nullable: true, description: 'Free text when a person wrote it by hand.' })
    personality_text!: string | null;
    @ApiProperty({ type: [TraitEvidenceDto] }) evidence!: TraitEvidenceDto[];
    @ApiProperty({ enum: TRAIT_CONFIDENCES, nullable: true, description: 'The weakest claim in the dossier.' })
    confidence!: TraitConfidence | null;
    @ApiProperty({ description: 'True when any field was written by hand.' })
    is_manual!: boolean;
    @ApiProperty({ nullable: true }) provider!: string | null;
    @ApiProperty({ nullable: true }) model!: string | null;
    @ApiProperty({ nullable: true }) generated_at!: number | null;
    @ApiProperty({
        nullable: true,
        description: 'The first session that moved past this dossier. Set means "worth redoing", never spends by itself.',
    })
    stale_since_session_id!: string | null;
}

/** What an analysis would cost, built without a client and without a credential. */
export class EntityProfileEstimateDto {
    @ApiProperty() provider!: string;
    @ApiProperty() model!: string;
    @ApiProperty({ description: 'Always true: the analysis is a real model call on the table\'s account.' })
    billable!: boolean;
    @ApiProperty({ description: 'False when we do not know the rate. That is not the same as free.' })
    pricing_available!: boolean;
    /**
     * A range, not a figure. An agent's cost depends on how many tools it ends
     * up calling, and quoting the floor as if it were the price would understate
     * the click on somebody else's account.
     */
    @ApiProperty({ type: AiMoneyRangeDto, nullable: true })
    estimated_cost_usd!: AiMoneyRangeDto | null;
    @ApiProperty({ type: AiMoneyRangeDto, nullable: true })
    estimated_cost_eur!: AiMoneyRangeDto | null;
    @ApiProperty({ type: AiExchangeRateDto }) exchange_rate!: AiExchangeRateDto;
}

export class EntityProfileAnalysisDto {
    @ApiProperty({ type: EntityProfileDto }) profile!: EntityProfileDto;
    @ApiProperty({
        isArray: true,
        type: String,
        description: 'What was looked for and the records genuinely do not hold.',
    })
    not_recorded!: string[];
    @ApiProperty({
        isArray: true,
        type: String,
        description: 'Fields the analysis stepped around because a person owns them.',
    })
    kept_fields!: string[];
    @ApiProperty({ nullable: true }) cost_usd!: number | null;
    @ApiProperty({ nullable: true }) cost_eur!: number | null;
    @ApiProperty() pricing_available!: boolean;
}

/**
 * Filling in the dossier by hand.
 *
 * Field by field rather than as prose, for two reasons that both came from
 * using it: the fields an analysis leaves empty are exactly the ones a person
 * can answer, and a value in a field reaches the picture — free text next to
 * the structured record would have been ignored by the prompt that composes
 * from fields.
 *
 * Each field written is owned by the writer from then on; each field cleared is
 * released back to the AI.
 */
export class UpdateEntityProfileDto {
    @ApiProperty({
        type: 'object',
        additionalProperties: true,
        description: 'Field path to value, e.g. { "eyes": "amber", "weapons": ["longsword"], "hair.colour": null }. Null or empty releases a field back to the AI.',
    })
    fields!: Record<string, string | string[] | null>;
}
