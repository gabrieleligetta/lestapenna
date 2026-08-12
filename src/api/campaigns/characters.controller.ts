import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Patch,
    Post,
    Put,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiAcceptedResponse,
    ApiBadRequestResponse,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
} from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import { AuthenticatedRequest } from '../auth/types';
import { CampaignAccessGuard } from './campaignAccess.guard';
import { CampaignWriteGuard } from './campaignWrite.guard';
import { assertMutationOrigin } from '../common/mutationOrigin';
import { db } from '../../db';
import { characterRepository } from '../../db/repositories/CharacterRepository';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import { phaseConfigFor } from '../../bard/config';
import { scopeForCampaign } from '../../bard/ai/scope';
import { ensureMembership, getCampaignRole } from '../../services/campaignAccess';
import {
    BioRegenEstimateDto,
    BioRegenStartDto,
    CharacterSheetDto,
    CharacterSheetPatchDto,
} from './dto/table.dto';
import { CharacterBioService } from './characterBio.service';

const NAME_MAX_CHARS = 80;
const DESCRIPTION_MAX_CHARS = 4000;

interface CharacterRow {
    user_id: string;
    character_name: string | null;
    race: string | null;
    class: string | null;
    description: string | null;
    is_manual: number | null;
}

function parseText(raw: unknown, field: string, max: number): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0) throw new BadRequestException(`${field} must not be empty`);
    if (value.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
    return value;
}

function toSheetDto(row: CharacterRow): CharacterSheetDto {
    return {
        user_id: row.user_id,
        character_name: row.character_name,
        race: row.race,
        class: row.class,
        description: row.description,
        is_manual: row.is_manual === 1,
    };
}

/**
 * The character sheet, writable: the web counterpart of `$iam` and `$bio`.
 *
 * Until now the web showed characters read-only, so changing class or race
 * meant going back to Discord. `characters` deliberately stays outside the
 * parametric CRUD: the row is born from a Discord user, not from a world
 * record, and "create"/"delete" are not the right operations there.
 */
@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
export class CharactersController {
    constructor(private readonly bios: CharacterBioService) {}

    /**
     * One's own sheet.
     *
     * Guild access is enough, membership of the table is not required: creating
     * your own character *is* the gesture of sitting down, and it is exactly
     * what `$iam` does by enrolling whoever invokes it.
     */
    @Put(':campaignId/characters/me')
    @ApiOkResponse({ type: CharacterSheetDto })
    @ApiBadRequestResponse({ description: 'Invalid or oversized field.' })
    upsertOwn(
        @Req() request: AuthenticatedRequest,
        @Body() body: CharacterSheetPatchDto,
    ): CharacterSheetDto {
        assertMutationOrigin(request);
        const campaignId = request.campaignId!;
        const userId = request.webSession.discordUserId;

        ensureMembership(campaignId, userId);
        this.applySheet(campaignId, userId, body, true);
        return this.readSheet(campaignId, userId);
    }

    @Get(':campaignId/characters/:userId/sheet')
    @ApiOkResponse({ type: CharacterSheetDto })
    @ApiNotFoundResponse({ description: 'No character for that user in this campaign.' })
    getSheet(
        @Req() request: AuthenticatedRequest,
        @Param('userId') userId: string,
    ): CharacterSheetDto {
        return this.readSheet(request.campaignId!, userId);
    }

    /** A master can fix anyone's sheet; everyone else only their own. */
    @Patch(':campaignId/characters/:userId/sheet')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: CharacterSheetDto })
    @ApiForbiddenResponse({ description: 'Only a master can edit another player sheet.' })
    @ApiNotFoundResponse({ description: 'No character for that user in this campaign.' })
    updateSheet(
        @Req() request: AuthenticatedRequest,
        @Param('userId') userId: string,
        @Body() body: CharacterSheetPatchDto,
    ): CharacterSheetDto {
        assertMutationOrigin(request);
        const campaignId = request.campaignId!;
        this.assertCanEdit(request, userId);
        this.readSheet(campaignId, userId);
        this.applySheet(campaignId, userId, body, true);
        return this.readSheet(campaignId, userId);
    }

    /**
     * Estimate for the regeneration: no call to the model.
     *
     * `NO_HISTORY` is the free fast path already present on `$bio`: with no
     * history events there is nothing to rewrite, so the provider is not invoked
     * and nothing is charged.
     */
    @Get(':campaignId/characters/:userId/bio/estimate')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: BioRegenEstimateDto })
    async estimateBio(
        @Req() request: AuthenticatedRequest,
        @Param('userId') userId: string,
    ): Promise<BioRegenEstimateDto> {
        const campaignId = request.campaignId!;
        const actorUserId = request.webSession.discordUserId;
        const sheet = this.readSheet(campaignId, userId);

        // Estimate: names the table's provider and model without building a
        // client. A table that has not put in its own keys yet must be able to
        // see what the action would cost it, not an error.
        const phase = phaseConfigFor('metadata', scopeForCampaign(campaignId));
        const willInvokeAi = this.hasUsableHistory(campaignId, sheet.character_name);

        return {
            status: willInvokeAi ? 'READY' : 'NO_HISTORY',
            will_invoke_ai: willInvokeAi,
            provider: phase.provider,
            model: phase.model,
        };
    }

    /**
     * Starts a regeneration of the biography from the history, like `$bio reset`.
     *
     * **202 with a job id.** Until now this route had no lock of any kind, so a
     * double click was two paid rewrites of the same biography; the register
     * gives it one, and the rewrite no longer depends on the browser waiting for
     * it.
     */
    @Post(':campaignId/characters/:userId/bio')
    @HttpCode(202)
    @UseGuards(CampaignWriteGuard)
    @ApiAcceptedResponse({ type: BioRegenStartDto })
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to spend on it.' })
    @ApiNotFoundResponse({ description: 'No character for that user in this campaign.' })
    @ApiConflictResponse({ description: 'This biography is already being rewritten.' })
    regenerateBio(
        @Req() request: AuthenticatedRequest,
        @Param('userId') userId: string,
    ): BioRegenStartDto {
        assertMutationOrigin(request);
        const campaignId = request.campaignId!;
        const sheet = this.readSheet(campaignId, userId);
        this.assertCanEdit(request, userId);

        // Free fast path: with no history there is nothing to rewrite, so no job
        // is created and nothing is spent.
        if (!this.hasUsableHistory(campaignId, sheet.character_name)) {
            return { job_id: null, invoked_ai: false };
        }

        const { jobId } = this.bios.enqueue(request, userId, sheet.character_name);
        return { job_id: jobId, invoked_ai: true };
    }

    /**
     * With no history events carrying text, `generateBio` has no raw material:
     * the same condition that avoids the AI call on `$bio reset`.
     */
    private hasUsableHistory(campaignId: number, characterName: string | null): boolean {
        if (!characterName) return false;
        return Boolean(db.prepare(`
            SELECT 1 FROM character_history
            WHERE campaign_id = ? AND lower(character_name) = lower(?)
              AND trim(COALESCE(description, '')) <> '' LIMIT 1
        `).get(campaignId, characterName));
    }

    private assertCanEdit(request: AuthenticatedRequest, targetUserId: string): void {
        const actorUserId = request.webSession.discordUserId;
        if (actorUserId === targetUserId) return;
        if (request.guildAccess?.canManage) return;
        if (getCampaignRole(request.campaignId!, actorUserId) === 'MASTER') return;
        throw new ForbiddenException('Only a master can edit another player sheet');
    }

    private applySheet(
        campaignId: number,
        userId: string,
        body: CharacterSheetPatchDto,
        isManual: boolean,
    ): void {
        let touched = false;
        if (body?.character_name !== undefined) {
            characterRepository.updateUserCharacter(
                userId, campaignId, 'character_name', parseText(body.character_name, 'character_name', NAME_MAX_CHARS), isManual,
            );
            touched = true;
        }
        if (body?.race !== undefined) {
            characterRepository.updateUserCharacter(
                userId, campaignId, 'race', parseText(body.race, 'race', NAME_MAX_CHARS), isManual,
            );
            touched = true;
        }
        if (body?.class !== undefined) {
            characterRepository.updateUserCharacter(
                userId, campaignId, 'class', parseText(body.class, 'class', NAME_MAX_CHARS), isManual,
            );
            touched = true;
        }
        if (body?.description !== undefined) {
            // `updateUserCharacter` with isManual also writes `manual_description`
            // and raises `is_manual`: from here on the AI no longer rewrites the sheet.
            characterRepository.updateUserCharacter(
                userId, campaignId, 'description', parseText(body.description, 'description', DESCRIPTION_MAX_CHARS), isManual,
            );
            touched = true;
        }
        if (!touched) throw new BadRequestException('No character field to update');
    }

    private readSheet(campaignId: number, userId: string): CharacterSheetDto {
        const row = db.prepare(`
            SELECT user_id, character_name, race, class, description, is_manual
            FROM characters WHERE campaign_id = ? AND user_id = ?
        `).get(campaignId, userId) as CharacterRow | undefined;
        if (!row) throw new NotFoundException('No character for that user in this campaign');
        return toSheetDto(row);
    }
}
