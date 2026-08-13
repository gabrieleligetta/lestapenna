import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IMAGE_GENERATION_MODES, type ImageGenerationMode } from '../../../db/types';
import type {
    ShotBackground,
    ShotFraming,
    ShotLight,
    ShotPose,
} from '../../../bard/imageShot';
import { AiExchangeRateDto } from './entities.dto';
import {
    MAX_REFERENCE_INSTRUCTION_CHARS,
    REFERENCE_ROLES,
    type ReferenceRole,
} from '../../../bard/imageReferences';

export class ReferenceDirectiveDto {
    @ApiProperty({ description: 'Candidate id, for example `media:<uuid>`.' })
    id!: string;
    @ApiProperty({ isArray: true, enum: REFERENCE_ROLES })
    roles!: ReferenceRole[];
    @ApiPropertyOptional({ type: String, nullable: true, maxLength: MAX_REFERENCE_INSTRUCTION_CHARS })
    instruction?: string | null;
    @ApiProperty({ minimum: 1 })
    priority!: number;
}

export class GenerateEntityImageDto {
    @ApiProperty({ enum: IMAGE_GENERATION_MODES })
    mode!: ImageGenerationMode;
    @ApiPropertyOptional({
        nullable: true,
        description: 'The description in the user\'s own words. Required for `prompt` and `mixed`.',
    })
    prompt?: string | null;
    /**
     * How the picture should be taken: how close, from where, in what light.
     *
     * Separate from the description because it answers a different question,
     * and closed sets rather than prose because each value maps to one phrase a
     * model reliably understands.
     */
    @ApiPropertyOptional({ type: 'object', additionalProperties: true })
    shot?: {
        framing?: ShotFraming | null;
        pose?: ShotPose | null;
        light?: ShotLight | null;
        background?: ShotBackground | null;
    } | null;
    /**
     * Which pictures to draw from, chosen explicitly.
     *
     * Empty means none: references cost input tokens on the table's own
     * account, so they travel because somebody asked for them, not by default.
     */
    @ApiPropertyOptional({ isArray: true, type: String })
    reference_ids?: string[];
    @ApiPropertyOptional({
        isArray: true,
        type: ReferenceDirectiveDto,
        description: 'Provider-neutral reference manifest. Takes precedence over legacy `reference_ids`.',
    })
    references?: ReferenceDirectiveDto[];
}

/** A picture that could be sent as a reference, for the picker to list. */
export class ReferenceCandidateDto {
    @ApiProperty() id!: string;
    @ApiProperty({
        enum: ['campaign', 'faction', 'entity', 'scratch'],
        description: '`scratch` is kept privately for one durable job, then deleted.',
    })
    scope!: 'campaign' | 'faction' | 'entity' | 'scratch';
    @ApiProperty() imageUrl!: string;
    @ApiProperty({ nullable: true }) label!: string | null;
    @ApiProperty({ isArray: true, enum: REFERENCE_ROLES }) roles!: ReferenceRole[];
    @ApiProperty({ type: String, nullable: true, maxLength: MAX_REFERENCE_INSTRUCTION_CHARS })
    instruction!: string | null;
    @ApiProperty({ description: 'Whether the UI should select this candidate before the paid confirmation.' })
    auto_selected!: boolean;
}

/**
 * What a portrait will cost, before anything is spent.
 *
 * Dossier composition is local. The nullable text-model fields remain in the
 * response for additive compatibility with clients deployed before that change.
 */
export class ImageGenerationEstimateDto {
    @ApiProperty({ enum: IMAGE_GENERATION_MODES }) mode!: ImageGenerationMode;
    @ApiProperty() provider!: string;
    @ApiProperty() model!: string;
    @ApiProperty({ nullable: true, description: 'The model that writes the brief, when the mode uses one.' })
    text_provider!: string | null;
    @ApiProperty({ nullable: true }) text_model!: string | null;
    @ApiProperty({ description: 'Always true: no image provider runs on the table\'s own hardware.' })
    billable!: boolean;
    @ApiProperty({ description: 'False when we do not know the rate. That is not the same as free.' })
    pricing_available!: boolean;
    @ApiProperty({ nullable: true }) estimated_cost_usd!: number | null;
    @ApiProperty({ nullable: true }) estimated_cost_eur!: number | null;
    @ApiProperty({ description: 'How many selected visual references were included in this quote.' })
    reference_count!: number;
    @ApiProperty({
        description: 'False when selected reference-token rates cannot be estimated; the total is then unavailable.',
    })
    reference_input_cost_included!: boolean;
    @ApiProperty({ type: AiExchangeRateDto }) exchange_rate!: AiExchangeRateDto;
}

/**
 * A picture waiting for a decision.
 *
 * The bytes travel as base64 rather than a URL because there is nothing to
 * address yet: the picture is not stored until it is accepted. A `data:` URI is
 * already allowed by the app's CSP, so nothing had to be loosened for it.
 */
export class ImageGenerationDraftDto {
    @ApiProperty() draft_id!: string;
    @ApiProperty({ description: 'Base64 WebP, for the preview only.' }) preview!: string;
    @ApiProperty() preview_mime_type!: string;
    @ApiProperty() width!: number;
    @ApiProperty() height!: number;
    @ApiProperty({ enum: IMAGE_GENERATION_MODES }) mode!: ImageGenerationMode;
    @ApiProperty({ nullable: true, description: 'The user\'s own words, echoed back for a repeat run.' })
    prompt!: string | null;
    /**
     * What the picture was drawn from. `dossier` is the analysed appearance
     * record and is the campaign-based source; `sheet`/`rag` remain readable on
     * jobs created before the dossier requirement was introduced.
     */
    @ApiProperty({ isArray: true, enum: ['dossier', 'sheet', 'rag', 'user'] })
    sources!: Array<'dossier' | 'sheet' | 'rag' | 'user'>;
    @ApiProperty() provider!: string;
    @ApiProperty() model!: string;
    @ApiProperty({ description: 'Epoch milliseconds. After this the preview is gone.' })
    expires_at!: number;
    @ApiProperty({ nullable: true, description: 'What this actually cost. Null means unknown, never free.' })
    cost_usd!: number | null;
    @ApiProperty({ nullable: true }) cost_eur!: number | null;
    @ApiProperty() pricing_available!: boolean;
}
