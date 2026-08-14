import { BadRequestException, Body, ConflictException, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiOkResponse } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import { GuildAccessGuard } from '../auth/guildAccess.guard';
import { AuthenticatedRequest } from '../auth/types';
import { assertMutationOrigin } from '../common/mutationOrigin';
import { campaignRepository } from '../../db';
import type { Campaign } from '../../db/types';
import { createCampaignWithParty, findCampaignByName } from '../../services/campaignSetup';
import { canWriteCampaign } from '../../services/campaignAccess';
import { coverUrl } from '../campaigns/campaignCover.service';
import { resolveTarotArcanum } from '../../services/tarotArcana';
import { normalizeLocale } from '../../i18n';
import { CreateCampaignDto } from '../campaigns/dto/table.dto';

const CAMPAIGN_NAME_MAX_CHARS = 80;

function parseName(raw: unknown, field: string): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0) throw new BadRequestException(`${field} must not be empty`);
    if (name.length > CAMPAIGN_NAME_MAX_CHARS) {
        throw new BadRequestException(`${field} must be at most ${CAMPAIGN_NAME_MAX_CHARS} characters`);
    }
    return name;
}

function toCampaignSummary(c: Campaign, canWrite = false) {
    return {
        id: c.id,
        name: c.name,
        isActive: c.is_active === 1,
        currentYear: c.current_year ?? null,
        currentLocation:
            c.current_macro_location || c.current_micro_location
                ? { macro: c.current_macro_location ?? null, micro: c.current_micro_location ?? null }
                : null,
        language: c.language ?? null,
        tarotArcanum: resolveTarotArcanum(c),
        coverUrl: coverUrl(c.id, c.cover_thumbnail_key),
        /**
         * Whether this caller may change the campaign's cover.
         *
         * Decided here rather than in the browser: administering the Discord
         * server and sitting at this table are two different things, and only
         * the backend knows which of them the caller is.
         */
        canWrite,
    };
}

@Controller('api/v1/guilds')
@UseGuards(SessionGuard)
export class GuildsController {
    @Get(':guildId')
    @UseGuards(GuildAccessGuard)
    getGuild(@Req() request: AuthenticatedRequest) {
        const { guildId, canManage } = request.guildAccess!;
        const guild = request.webSession.guilds.find((g) => g.id === guildId)!;
        return { id: guild.id, name: guild.name, icon: guild.icon, canManage };
    }

    @Get(':guildId/campaigns')
    @UseGuards(GuildAccessGuard)
    getCampaigns(@Req() request: AuthenticatedRequest, @Param('guildId') guildId: string) {
        const guildCanManage = request.guildAccess?.canManage ?? false;
        return campaignRepository.getCampaigns(guildId).map((campaign) => toCampaignSummary(
            campaign,
            canWriteCampaign(campaign.id, request.webSession.discordUserId, { guildCanManage }),
        ));
    }

    /**
     * Creates a campaign from the site.
     *
     * No charge: creating a campaign invokes no provider, it only touches
     * SQLite. A fee here would be a price with no variable cost, against the
     * rule of a price list governed by the real margin
     * (see the BYOK model: every table uses its own keys).
     *
     * It also accepts language, year and party name: on Discord these are three
     * separate steps (`$creacampagna`, `$language`, `$setworld`), but from the
     * web a single creation form is expected.
     */
    @Post(':guildId/campaigns')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ description: 'The campaign that was just created.' })
    @ApiBadRequestResponse({ description: 'Invalid name, language or year.' })
    @ApiConflictResponse({ description: 'A campaign with that name already exists in this server.' })
    createCampaign(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Body() body: CreateCampaignDto,
    ) {
        assertMutationOrigin(request);
        const name = parseName(body?.name, 'name');

        if (findCampaignByName(guildId, name)) {
            throw new ConflictException('A campaign with that name already exists in this server');
        }

        let language: string | undefined;
        if (body?.language !== undefined && body.language !== null) {
            const normalized = normalizeLocale(body.language);
            if (!normalized) throw new BadRequestException('language is not a supported locale');
            language = normalized;
        }

        let currentYear: number | undefined;
        if (body?.current_year !== undefined && body.current_year !== null) {
            currentYear = Number(body.current_year);
            if (!Number.isInteger(currentYear)) throw new BadRequestException('current_year must be an integer');
        }

        const campaign = createCampaignWithParty({
            guildId,
            name,
            creatorUserId: request.webSession.discordUserId,
            language,
            currentYear,
            partyName: body?.party_name === undefined ? undefined : parseName(body.party_name, 'party_name'),
        });

        return toCampaignSummary(
            campaign,
            canWriteCampaign(campaign.id, request.webSession.discordUserId, {
                guildCanManage: request.guildAccess?.canManage ?? false,
            }),
        );
    }
}
