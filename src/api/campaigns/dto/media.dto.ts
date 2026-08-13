import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ENTITY_MEDIA_SOURCES,
    IMAGE_GENERATION_MODES,
    type EntityMediaEntry,
    type EntityMediaSource,
    type ImageGenerationMode,
} from '../../../db/types';
import {
    MAX_REFERENCE_INSTRUCTION_CHARS,
    REFERENCE_ROLES,
    defaultReferenceRoles,
    parseStoredReferenceRoles,
    type ReferenceRole,
} from '../../../bard/imageReferences';

export class EntityImageDto {
    @ApiProperty() id!: string;
    @ApiProperty() thumbnailUrl!: string;
    @ApiProperty({ description: 'True on the one picture the sheet shows. The others are the gallery.' })
    isPrimary!: boolean;
    @ApiProperty() displayUrl!: string;
    @ApiProperty() width!: number;
    @ApiProperty() height!: number;
    @ApiProperty({ minimum: 0, maximum: 100 }) focalX!: number;
    @ApiProperty({ minimum: 0, maximum: 100 }) focalY!: number;
    @ApiPropertyOptional({ nullable: true, maxLength: 300 }) altText!: string | null;
    @ApiProperty({ enum: ENTITY_MEDIA_SOURCES, description: 'Uploaded by hand, or generated.' })
    source!: EntityMediaSource;
    /**
     * How a generated picture was asked for, and in the person's own words.
     *
     * They are what makes "generate it again" possible: the panel reopens with
     * this mode selected and this text back in the editable field, so the same
     * request can be repeated unchanged or amended first. The expanded prompt
     * that reached the provider is deliberately **not** exposed — it is machine
     * prose, and offering it for editing would invite people to fight with it
     * instead of saying what they want.
     */
    @ApiPropertyOptional({ enum: IMAGE_GENERATION_MODES, nullable: true })
    generationMode!: ImageGenerationMode | null;
    @ApiPropertyOptional({ nullable: true }) generationPrompt!: string | null;
    @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
    generationRequest!: Record<string, unknown> | null;
    @ApiProperty({ isArray: true, enum: REFERENCE_ROLES }) referenceRoles!: ReferenceRole[];
    @ApiPropertyOptional({ type: String, nullable: true, maxLength: MAX_REFERENCE_INSTRUCTION_CHARS })
    referenceInstruction!: string | null;
    @ApiProperty() referenceAutoSelect!: boolean;
    @ApiProperty({ description: 'Epoch milliseconds.' }) updatedAt!: number;
}

export class UpdateEntityImageDto {
    @ApiPropertyOptional({ minimum: 0, maximum: 100 }) focalX?: number;
    @ApiPropertyOptional({ minimum: 0, maximum: 100 }) focalY?: number;
    @ApiPropertyOptional({ nullable: true, maxLength: 300 }) altText?: string | null;
    @ApiPropertyOptional({ isArray: true, enum: REFERENCE_ROLES }) referenceRoles?: ReferenceRole[];
    @ApiPropertyOptional({ type: String, nullable: true, maxLength: MAX_REFERENCE_INSTRUCTION_CHARS })
    referenceInstruction?: string | null;
    @ApiPropertyOptional() referenceAutoSelect?: boolean;
}

function parseGenerationRequest(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function toEntityImageDto(row: EntityMediaEntry): EntityImageDto {
    const base = `/api/v1/campaigns/${row.campaign_id}/media/${row.id}`;
    return {
        id: row.id,
        thumbnailUrl: `${base}/thumbnail`,
        isPrimary: row.is_primary === 1,
        displayUrl: `${base}/display`,
        width: row.width,
        height: row.height,
        focalX: row.focal_x,
        focalY: row.focal_y,
        altText: row.alt_text,
        source: row.source,
        generationMode: row.generation_mode,
        // The person's own words, not the expanded prompt sent to the provider.
        generationPrompt: row.generation_user_prompt,
        generationRequest: parseGenerationRequest(row.generation_request_json),
        referenceRoles: parseStoredReferenceRoles(
            row.reference_roles_json,
            defaultReferenceRoles('entity'),
        ),
        referenceInstruction: row.reference_instruction,
        referenceAutoSelect: row.reference_auto_select === 1,
        updatedAt: row.updated_at,
    };
}
