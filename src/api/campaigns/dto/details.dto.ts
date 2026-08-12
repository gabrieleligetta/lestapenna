import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AlignmentDto, toAlignmentDto } from './party.dto';
import type { AffiliationRole, FactionAffiliation } from '../../../db/types';
import { EntityImageDto } from './media.dto';

/** A membership as seen from the member's side — the mirror of FactionMemberDto. */
export class AffiliationDto {
    @ApiProperty() factionName!: string;

    @ApiPropertyOptional({ nullable: true, description: 'short_id of the faction, for linking.' })
    factionShortId!: string | null;

    @ApiProperty({ description: 'LEADER | MEMBER | ALLY | ENEMY | CONTROLLED | HQ | PRESENCE | HOSTILE | PRISONER' })
    role!: AffiliationRole;

    @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export function toAffiliationDto(row: FactionAffiliation & { faction_short_id?: string | null }): AffiliationDto {
    return {
        factionName: row.faction_name ?? '',
        factionShortId: row.faction_short_id ?? null,
        role: row.role,
        notes: row.notes,
    };
}

export class NpcDetailDto {
    @ApiProperty() short_id!: string;
    @ApiProperty() name!: string;
    @ApiPropertyOptional({ nullable: true }) role!: string | null;
    @ApiProperty({ description: 'ALIVE | DEAD | UNKNOWN | MISSING' }) status!: string;
    @ApiPropertyOptional({ nullable: true }) description!: string | null;
    @ApiPropertyOptional({ nullable: true, description: 'Comma-separated alternate names.' })
    aliases!: string | null;

    @ApiProperty({ type: AlignmentDto })
    alignment!: AlignmentDto;

    @ApiProperty({ type: [AffiliationDto] })
    factions!: AffiliationDto[];

    @ApiPropertyOptional({ nullable: true }) last_updated!: string | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class LocationDetailDto {
    @ApiProperty() short_id!: string;
    @ApiProperty() macro_location!: string;
    @ApiProperty() micro_location!: string;
    @ApiPropertyOptional({ nullable: true }) description!: string | null;

    @ApiProperty({ type: [AffiliationDto] })
    factions!: AffiliationDto[];

    @ApiPropertyOptional({ nullable: true }) last_updated!: string | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export class CharacterDetailDto {
    @ApiProperty() userId!: string;
    @ApiPropertyOptional({ nullable: true }) character_name!: string | null;
    @ApiPropertyOptional({ nullable: true }) race!: string | null;
    @ApiPropertyOptional({ nullable: true }) class!: string | null;
    @ApiPropertyOptional({ nullable: true }) description!: string | null;

    @ApiPropertyOptional({
        nullable: true,
        description: 'The player-written foundation the AI must not contradict.',
    })
    foundation_description!: string | null;

    @ApiProperty({ type: AlignmentDto })
    alignment!: AlignmentDto;

    @ApiProperty({ type: [AffiliationDto] })
    factions!: AffiliationDto[];

    @ApiPropertyOptional({
        nullable: true,
        description: 'Present only when the requester is the character owner — the one non-lore column on `characters`.',
    })
    email?: string | null;
    @ApiProperty({ type: EntityImageDto, nullable: true }) image!: EntityImageDto | null;
}

export function toNpcDetailDto(
    npc: {
        short_id?: string;
        name: string;
        role: string | null;
        status: string;
        description: string | null;
        aliases?: string | null;
        moral_score?: number | null;
        ethical_score?: number | null;
        last_updated?: string | null;
    },
    factions: AffiliationDto[],
    image: EntityImageDto | null = null,
): NpcDetailDto {
    return {
        short_id: npc.short_id!,
        name: npc.name,
        role: npc.role,
        status: npc.status,
        description: npc.description,
        aliases: npc.aliases ?? null,
        alignment: toAlignmentDto(npc.moral_score, npc.ethical_score),
        factions,
        last_updated: npc.last_updated ?? null,
        image,
    };
}

export function toLocationDetailDto(
    location: {
        short_id?: string;
        macro_location: string;
        micro_location: string;
        description: string | null;
        last_updated?: string | null;
    },
    factions: AffiliationDto[],
    image: EntityImageDto | null = null,
): LocationDetailDto {
    return {
        short_id: location.short_id!,
        macro_location: location.macro_location,
        micro_location: location.micro_location,
        description: location.description,
        factions,
        last_updated: location.last_updated ?? null,
        image,
    };
}
