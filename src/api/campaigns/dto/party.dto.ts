import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AffiliationRole } from '../../../db/types';
import { getEthicalAlignment, getMoralAlignment } from '../../../utils/alignmentUtils';
import { EntityImageDto } from './media.dto';

export class AlignmentAxisDto {
    @ApiProperty({ description: '-100..100.' })
    score!: number;

    @ApiProperty({
        description: 'Enum key, never a translated string — the client owns the wording.',
        example: 'GOOD',
    })
    label!: string;
}

export class AlignmentDto {
    @ApiProperty({ type: AlignmentAxisDto })
    moral!: AlignmentAxisDto;

    @ApiProperty({ type: AlignmentAxisDto })
    ethical!: AlignmentAxisDto;

    @ApiProperty({ description: 'The nine-cell key, `${ethical}_${moral}`.', example: 'CHAOTIC_GOOD' })
    cell!: string;
}

/**
 * Derives both axis labels and the cell key from raw scores.
 *
 * The ±25 thresholds live in utils/alignmentUtils.ts and are applied here so
 * the client never re-derives them: a second copy in the SPA would drift the
 * moment they are tuned, and the bot and the web would disagree about the same
 * character.
 */
export function toAlignmentDto(moralScore: number | null | undefined, ethicalScore: number | null | undefined): AlignmentDto {
    const moral = moralScore ?? 0;
    const ethical = ethicalScore ?? 0;
    const moralLabel = getMoralAlignment(moral);
    const ethicalLabel = getEthicalAlignment(ethical);
    return {
        moral: { score: moral, label: moralLabel },
        ethical: { score: ethical, label: ethicalLabel },
        cell: `${ethicalLabel}_${moralLabel}`,
    };
}

export class PartyMemberDto {
    @ApiProperty()
    userId!: string;

    @ApiPropertyOptional({ nullable: true })
    name!: string | null;

    @ApiPropertyOptional({ nullable: true })
    race!: string | null;

    @ApiPropertyOptional({ nullable: true })
    class!: string | null;

    @ApiPropertyOptional({
        nullable: true,
        description: 'Role in the party faction. Null for members with no affiliation row — the DM, typically.',
    })
    role!: AffiliationRole | null;

    @ApiProperty({ type: AlignmentDto })
    alignment!: AlignmentDto;

    @ApiProperty({ description: 'Whether the character has a written bio, without shipping the whole text in a list.' })
    hasBio!: boolean;

    @ApiProperty({ type: EntityImageDto, nullable: true })
    image!: EntityImageDto | null;
}

export class PartyDto {
    @ApiPropertyOptional({
        nullable: true,
        description: 'Name of the faction flagged is_party, falling back to the campaign name.',
    })
    name!: string | null;

    @ApiPropertyOptional({ nullable: true, description: 'short_id of the party faction, when one exists.' })
    factionShortId!: string | null;

    @ApiProperty({
        enum: ['faction', 'campaign'],
        description: 'Where the alignment came from: the party faction, or the campaign columns as fallback.',
    })
    alignmentSource!: 'faction' | 'campaign';

    @ApiProperty({ type: AlignmentDto })
    alignment!: AlignmentDto;

    @ApiProperty({ type: [PartyMemberDto] })
    members!: PartyMemberDto[];
}
