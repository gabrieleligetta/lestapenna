import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Paginated } from '../../common/pagination';
import { AlignmentDto, toAlignmentDto } from './party.dto';
import type { AffiliationEntityType, AffiliationRole, FactionEntry, ReputationLevel } from '../../../db/types';

export class FactionMemberDto {
    @ApiProperty({ enum: ['npc', 'location', 'pc'] })
    entityType!: AffiliationEntityType;

    @ApiPropertyOptional({ nullable: true })
    name!: string | null;

    @ApiProperty({ description: 'LEADER | MEMBER | ALLY | ENEMY | CONTROLLED | HQ | PRESENCE | HOSTILE | PRISONER' })
    role!: AffiliationRole;

    @ApiPropertyOptional({
        nullable: true,
        description: 'short_id of the NPC or location, so the client can link to it. Null for characters, which have none.',
    })
    shortId!: string | null;

    @ApiPropertyOptional({ nullable: true, description: 'Discord user id, for members of entityType "pc".' })
    userId!: string | null;

    @ApiPropertyOptional({ nullable: true })
    notes!: string | null;
}

export class PaginatedFactionMemberDto extends Paginated(FactionMemberDto) {}

export function toFactionMemberDto(row: {
    entity_type: AffiliationEntityType;
    role: AffiliationRole;
    name: string | null;
    short_id: string | null;
    user_id: string | null;
    notes: string | null;
}): FactionMemberDto {
    return {
        entityType: row.entity_type,
        name: row.name,
        role: row.role,
        shortId: row.short_id,
        userId: row.user_id,
        notes: row.notes,
    };
}

export class MemberCountsDto {
    @ApiProperty() npcs!: number;
    @ApiProperty() locations!: number;
    @ApiProperty() pcs!: number;
}

export class FactionDetailDto {
    @ApiProperty() short_id!: string;
    @ApiProperty() name!: string;
    @ApiPropertyOptional({ nullable: true }) description!: string | null;
    @ApiProperty({ description: 'PARTY | GUILD | KINGDOM | CULT | ORGANIZATION | GENERIC' }) type!: string;
    @ApiProperty({ description: 'ACTIVE | DISBANDED | DESTROYED' }) status!: string;
    @ApiProperty({ description: '1 for the party faction itself.' }) is_party!: number;

    @ApiProperty({ type: AlignmentDto })
    alignment!: AlignmentDto;

    @ApiProperty({
        description: "The party's standing toward this faction. NEUTRAL when nothing has been recorded.",
        example: 'CORDIAL',
    })
    reputation!: ReputationLevel;

    @ApiProperty({ type: MemberCountsDto })
    memberCounts!: MemberCountsDto;

    @ApiPropertyOptional({ nullable: true }) last_updated!: string | null;
}

/**
 * Note what is deliberately absent: the `breakdown` object from
 * getFactionAlignmentDetails. Its membersMoral/membersEthical/memberCount are
 * hardcoded to 0 in FactionRepository, so the per-member contribution the
 * `$faction` embed appears to show never actually computes — publishing it
 * would make a promise the data cannot keep. The flat scores are the real
 * numbers.
 */
export function toFactionDetailDto(
    faction: FactionEntry,
    reputation: ReputationLevel,
    memberCounts: MemberCountsDto,
): FactionDetailDto {
    return {
        short_id: faction.short_id!,
        name: faction.name,
        description: faction.description,
        type: faction.type,
        status: faction.status,
        is_party: faction.is_party,
        alignment: toAlignmentDto(faction.moral_score, faction.ethical_score),
        reputation,
        memberCounts,
        last_updated: faction.last_updated ?? null,
    };
}
