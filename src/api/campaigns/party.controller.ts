import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import { CampaignAccessGuard } from './campaignAccess.guard';
import { AuthenticatedRequest } from '../auth/types';
import { PartyDto, toAlignmentDto } from './dto/party.dto';
import { campaignRepository, characterRepository, factionRepository } from '../../db';
import { EntityMediaService } from './entityMedia.service';

/**
 * The party.
 *
 * Split out of campaigns.controller.ts, which is already past 500 lines.
 *
 * "Party" is not a table: it is the faction row flagged `is_party = 1`
 * (schema.ts). Its alignment comes from that faction's aggregated scores, and
 * falls back to the campaign's own party_* columns when no such faction exists
 * — the same order the bot's `$party` command uses.
 */
@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
export class PartyController {
    constructor(private readonly entityMedia: EntityMediaService) {}

    @Get(':campaignId/party')
    @ApiOkResponse({ type: PartyDto })
    getParty(@Req() request: AuthenticatedRequest): PartyDto {
        const campaignId = request.campaignId!;
        const campaign = campaignRepository.getCampaignById(campaignId)!;
        const faction = factionRepository.getPartyFaction(campaignId);

        // A faction with no history has both scores at 0, which is a real
        // answer ("true neutral"), not a missing one — so the source is the
        // faction whenever the row exists, not whenever its scores are truthy.
        const alignmentSource = faction ? 'faction' : 'campaign';
        const alignment = faction
            ? toAlignmentDto(faction.moral_score, faction.ethical_score)
            : toAlignmentDto(campaign.party_moral_score, campaign.party_ethical_score);

        const roster = characterRepository.getPartyRoster(campaignId);
        const images = this.entityMedia.getImages(
            campaignId,
            roster.map((member) => ({ entityType: 'character', entityKey: member.user_id })),
        );
        const members = roster.map((member) => ({
            userId: member.user_id,
            name: member.character_name,
            race: member.race,
            class: member.class,
            role: member.role,
            alignment: toAlignmentDto(member.moral_score, member.ethical_score),
            hasBio: !!member.description,
            image: this.entityMedia.imageFromMap(images, 'character', member.user_id),
        }));

        return {
            name: faction?.name ?? campaign.name,
            factionShortId: faction?.short_id ?? null,
            alignmentSource,
            alignment,
            members,
        };
    }
}
