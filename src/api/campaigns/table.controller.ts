import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Patch,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
} from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import { AuthenticatedRequest } from '../auth/types';
import { CampaignAccessGuard } from './campaignAccess.guard';
import { CampaignMasterGuard } from './campaignMaster.guard';
import { assertMutationOrigin } from '../common/mutationOrigin';
import { campaignMemberRepository } from '../../db/repositories/CampaignMemberRepository';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import { characterRepository } from '../../db/repositories/CharacterRepository';
import { factionRepository } from '../../db/repositories/FactionRepository';
import { findCampaignByName } from '../../services/campaignSetup';
import { normalizeLocale } from '../../i18n';
import { resolveGuildDisplayNames } from '../../services/discordDirectory';
import { TAROT_ARCANA, isTarotArcanum, resolveTarotArcanum } from '../../services/tarotArcana';
import { coverUrl } from './campaignCover.service';
import {
    CampaignMemberDto,
    CampaignMemberRoleDto,
    CampaignSettingsDto,
    CampaignSettingsPatchDto,
} from './dto/table.dto';

const NAME_MAX_CHARS = 80;

function parseName(raw: unknown, field: string): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0) throw new BadRequestException(`${field} must not be empty`);
    if (name.length > NAME_MAX_CHARS) {
        throw new BadRequestException(`${field} must be at most ${NAME_MAX_CHARS} characters`);
    }
    return name;
}

/**
 * The governance of the table: who belongs to it and which world is played in.
 *
 * The web counterpart of `$membri`, `$setworld` and `$language`, which until now
 * lived only on Discord — a master managing the campaign from the site still had
 * to go back to chat to add or remove someone.
 *
 * Reading the members is open to whoever sits at the table (it is the group's
 * information, as it already is on the bot); every write goes through `CampaignMasterGuard`.
 */
@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
export class CampaignTableController {
    /**
     * Everyone at this table, enrolled or not.
     *
     * `campaign_members` is the seat register, and it only ever got a row when
     * someone ran `$iam` or created the campaign — a table whose players joined
     * before that rule existed shows a single member and looks broken. Whoever
     * has a character here is visibly at the table, so they are listed too, with
     * `enrolled: false` and no seat: a master sees who is missing and can add
     * them, and a removal stays a removal instead of being silently undone.
     */
    @Get(':campaignId/members')
    @ApiOkResponse({ type: [CampaignMemberDto] })
    async listMembers(@Req() request: AuthenticatedRequest): Promise<CampaignMemberDto[]> {
        const campaignId = request.campaignId!;
        const characters = characterRepository.getCampaignCharacters(campaignId);
        const names = new Map(characters.map((c) => [c.user_id, c.character_name ?? null]));

        const enrolled = campaignMemberRepository.list(campaignId);
        const seated = new Set(enrolled.map((m) => m.user_id));
        const guests = characters
            .filter((c) => !seated.has(c.user_id))
            .map((c) => ({ user_id: c.user_id, role: 'PLAYER' as const, added_at: null }));

        const rows = [...enrolled, ...guests];
        const discord = await resolveGuildDisplayNames(
            request.guildAccess!.guildId,
            rows.map((row) => row.user_id),
        );

        return rows.map((row) => ({
            user_id: row.user_id,
            role: row.role,
            character_name: names.get(row.user_id) ?? null,
            display_name: discord.get(row.user_id)?.displayName ?? null,
            username: discord.get(row.user_id)?.username ?? null,
            enrolled: seated.has(row.user_id),
            added_at: row.added_at,
        }));
    }

    /**
     * Sets a role — and gives a seat to whoever did not have one.
     *
     * A character owner listed with `enrolled: false` is enrolled by this same
     * call: it is the "add them back to the table" gesture, and inventing a
     * second endpoint for it would only split the master's permission check.
     */
    @Patch(':campaignId/members/:userId')
    @UseGuards(CampaignMasterGuard)
    @HttpCode(204)
    @ApiForbiddenResponse({ description: 'Only a campaign master can change roles.' })
    @ApiNotFoundResponse({ description: 'That user neither sits at this table nor has a character here.' })
    @ApiConflictResponse({ description: 'The last master cannot be demoted.' })
    setRole(
        @Req() request: AuthenticatedRequest,
        @Param('userId') userId: string,
        @Body() body: CampaignMemberRoleDto,
    ): void {
        assertMutationOrigin(request);
        const campaignId = request.campaignId!;
        const role = body?.role;
        if (role !== 'MASTER' && role !== 'PLAYER') {
            throw new BadRequestException("role must be 'MASTER' or 'PLAYER'");
        }

        const current = campaignMemberRepository.getRole(campaignId, userId);
        if (current === null) {
            if (!characterRepository.getCampaignCharacters(campaignId).some((c) => c.user_id === userId)) {
                throw new NotFoundException('That user is not part of this campaign');
            }
            // `upsert` never demotes an existing MASTER; there is no row here.
            campaignMemberRepository.upsert(campaignId, userId, role);
            return;
        }

        // Demoting the last master would leave the campaign with nobody able to
        // manage its members — same rule as `$membri`.
        if (current === 'MASTER' && role === 'PLAYER' && campaignMemberRepository.countMasters(campaignId) <= 1) {
            throw new ConflictException('The last master of this campaign cannot be demoted');
        }

        campaignMemberRepository.setRole(campaignId, userId, role);
    }

    @Delete(':campaignId/members/:userId')
    @UseGuards(CampaignMasterGuard)
    @HttpCode(204)
    @ApiForbiddenResponse({ description: 'Only a campaign master can remove members.' })
    @ApiNotFoundResponse({ description: 'That user is not part of this campaign.' })
    @ApiConflictResponse({ description: 'The last master cannot be removed.' })
    removeMember(
        @Req() request: AuthenticatedRequest,
        @Param('userId') userId: string,
    ): void {
        assertMutationOrigin(request);
        const campaignId = request.campaignId!;
        const current = campaignMemberRepository.getRole(campaignId, userId);
        if (current === null) throw new NotFoundException('That user is not part of this campaign');

        if (current === 'MASTER' && campaignMemberRepository.countMasters(campaignId) <= 1) {
            throw new ConflictException('The last master of this campaign cannot be removed');
        }

        // The character stays: it is narrative content, not a permission.
        campaignMemberRepository.remove(campaignId, userId);
    }

    @Get(':campaignId/settings')
    @ApiOkResponse({ type: CampaignSettingsDto })
    getSettings(@Req() request: AuthenticatedRequest): CampaignSettingsDto {
        return this.readSettings(request.campaignId!);
    }

    /**
     * Name, spoken language, current year and party name.
     *
     * The language is not the interface one: it drives Whisper transcription and
     * the output language of the summaries, so changing it is a decision of the
     * table, not a personal preference.
     */
    @Patch(':campaignId/settings')
    @UseGuards(CampaignMasterGuard)
    @ApiOkResponse({ type: CampaignSettingsDto })
    @ApiBadRequestResponse({ description: 'Invalid name, language or year.' })
    @ApiForbiddenResponse({ description: 'Only a campaign master can change the campaign.' })
    @ApiConflictResponse({ description: 'Another campaign in this server already has that name.' })
    updateSettings(
        @Req() request: AuthenticatedRequest,
        @Body() body: CampaignSettingsPatchDto,
    ): CampaignSettingsDto {
        assertMutationOrigin(request);
        const campaignId = request.campaignId!;
        const campaign = campaignRepository.getCampaignById(campaignId);
        if (!campaign) throw new NotFoundException('No such campaign');

        if (body?.name !== undefined) {
            const name = parseName(body.name, 'name');
            const clash = findCampaignByName(campaign.guild_id, name);
            if (clash && clash.id !== campaignId) {
                throw new ConflictException('Another campaign in this server already has that name');
            }
            campaignRepository.renameCampaign(campaignId, name);
        }

        if (body?.language !== undefined) {
            if (body.language === null) {
                campaignRepository.setCampaignLanguage(campaignId, null);
            } else {
                const language = normalizeLocale(body.language);
                if (!language) throw new BadRequestException('language is not a supported locale');
                campaignRepository.setCampaignLanguage(campaignId, language);
            }
        }

        if (body?.current_year !== undefined && body.current_year !== null) {
            const year = Number(body.current_year);
            if (!Number.isInteger(year)) throw new BadRequestException('current_year must be an integer');
            campaignRepository.setCampaignYear(campaignId, year);
        }

        if (body?.party_name !== undefined) {
            const partyName = parseName(body.party_name, 'party_name');
            // An imported campaign may not have a party faction yet.
            if (!factionRepository.renamePartyFaction(campaignId, partyName)) {
                factionRepository.createPartyFaction(campaignId, partyName);
            }
        }

        if (body?.allow_auto_character_update !== undefined) {
            if (typeof body.allow_auto_character_update !== 'boolean') {
                throw new BadRequestException('allow_auto_character_update must be a boolean');
            }
            campaignRepository.setCampaignAutoUpdate(campaignId, body.allow_auto_character_update);
        }

        if (body?.art_direction !== undefined) {
            if (body.art_direction !== null && typeof body.art_direction !== 'string') {
                throw new BadRequestException('art_direction must be a string or null');
            }
            const artDirection = body.art_direction?.trim() ?? null;
            if (artDirection && artDirection.length > 400) {
                throw new BadRequestException('art_direction must be at most 400 characters');
            }
            // Empty and null mean the same thing — no preference — so clearing
            // the field restores the built-in style rather than sending an empty
            // instruction to the image model.
            campaignRepository.setCampaignArtDirection(campaignId, artDirection);
        }

        if (body?.tarot_arcana !== undefined) {
            if (!isTarotArcanum(body.tarot_arcana)) {
                throw new BadRequestException(`tarot_arcana must be one of: ${TAROT_ARCANA.join(', ')}`);
            }
            campaignRepository.setCampaignTarotArcanum(campaignId, body.tarot_arcana);
        }

        return this.readSettings(campaignId);
    }

    private readSettings(campaignId: number): CampaignSettingsDto {
        const campaign = campaignRepository.getCampaignById(campaignId);
        if (!campaign) throw new NotFoundException('No such campaign');
        return {
            id: campaign.id,
            name: campaign.name,
            language: campaign.language ?? null,
            current_year: campaign.current_year ?? null,
            party_name: factionRepository.getPartyFaction(campaignId)?.name ?? null,
            allow_auto_character_update: campaign.allow_auto_character_update === 1,
            art_direction: campaign.art_direction ?? null,
            tarot_arcana: resolveTarotArcanum(campaign),
            cover_url: coverUrl(campaign.id, campaign.cover_thumbnail_key),
        };
    }
}
