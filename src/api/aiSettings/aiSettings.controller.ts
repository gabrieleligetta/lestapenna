import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Put,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiForbiddenResponse,
    ApiNoContentResponse,
    ApiOkResponse,
    ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import type { AIProvider } from '../../config';
import type { AiPhase } from '../../bard/ai/types';
import { SessionGuard } from '../auth/session.guard';
import { GuildAccessGuard } from '../auth/guildAccess.guard';
import { GuildManageGuard } from '../auth/guildManage.guard';
import { AuthenticatedRequest } from '../auth/types';
import { assertMutationOrigin } from '../common/mutationOrigin';
import { CampaignAccessGuard } from '../campaigns/campaignAccess.guard';
import { CampaignWriteGuard } from '../campaigns/campaignWrite.guard';
import { isAgenticSummaryEnabled } from '../../bard/ai/resolver';
import { AiSettingsService } from './aiSettings.service';
import {
    AI_PROVIDERS,
    CampaignAiSettingsDto,
    CampaignEmbeddingDto,
    CampaignTranscriptionDto,
    UpdateCampaignTranscriptionDto,
    ReindexEstimateDto,
    ReindexRequestDto,
    ReindexResultDto,
    CredentialTestResultDto,
    PhaseModelCostDto,
    PhaseOverrideDto,
    UpdateCampaignPhasesDto,
    GuildAiSettingsDto,
    ProviderModelsDto,
    RemoteWhisperModelsDto,
    PutCredentialDto,
    PricingOverrideDto,
    PutWakeSecretDto,
    SessionCostEstimateDto,
    UpdatePricingOverridesDto,
    TranscriptionProbeDto,
    TranscriptionSettingsDto,
    UpdateCampaignFlowDto,
    UpdateGuildAiSettingsDto,
    UpdateTranscriptionDto,
    WakeMethodDto,
} from './aiSettings.dto';

function parseProvider(raw: string): AIProvider {
    if (!AI_PROVIDERS.includes(raw as AIProvider)) {
        throw new BadRequestException(`Unknown provider: ${raw}`);
    }
    return raw as AIProvider;
}

/** A four-hour evening: what a D&D session usually is. */
const DEFAULT_SESSION_MINUTES = 240;

/** Bounded so a query string cannot ask for an estimate over a year of audio. */
function parseAudioMinutes(raw: string | undefined): number {
    const minutes = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_SESSION_MINUTES;
    return Math.min(minutes, 24 * 60);
}

/**
 * A table's keys and models.
 *
 * The routes live under the **guild**, not under the campaign, because it is the
 * guild that owns the keys: a campaign master is not necessarily an
 * administrator of the server, and confusing the two levels is how one player's
 * key ends up paying for another campaign's sessions.
 * Reading only requires membership; writing requires `GuildManageGuard`.
 *
 * **There is no `GET` for a credential's value.** You can know that it exists,
 * how it ends and whether the provider rejected it; the value goes in and never
 * comes back out.
 */
@Controller('api/v1')
@UseGuards(SessionGuard)
export class AiSettingsController {
    constructor(private readonly settings: AiSettingsService) {}

    @Get('guilds/:guildId/ai-settings')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ type: GuildAiSettingsDto })
    read(@Req() request: AuthenticatedRequest, @Param('guildId') guildId: string): GuildAiSettingsDto {
        return this.settings.read(guildId, request.guildAccess!.canManage);
    }

    @Put('guilds/:guildId/ai-settings')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @ApiOkResponse({ type: GuildAiSettingsDto })
    @ApiForbiddenResponse({ description: 'Managing this server is required.' })
    update(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Body() body: UpdateGuildAiSettingsDto,
    ): GuildAiSettingsDto {
        assertMutationOrigin(request);
        return this.settings.update(guildId, body ?? {}, request.webSession.discordUserId);
    }

    /**
     * Stores a key. Write-only: no route returns it.
     *
     * `204` on purpose — even echoing the `hint` back in response to a `PUT`
     * would create an endpoint from which something about the value could be
     * inferred.
     */
    @Put('guilds/:guildId/ai-settings/credentials/:provider')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @HttpCode(204)
    @ApiNoContentResponse({ description: 'Key stored, encrypted at rest.' })
    @ApiServiceUnavailableResponse({ description: 'The secret vault is not configured on this instance.' })
    putCredential(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Param('provider') provider: string,
        @Body() body: PutCredentialDto,
    ): void {
        assertMutationOrigin(request);
        const apiKey = typeof body?.api_key === 'string' ? body.api_key : '';
        this.settings.putCredential(
            guildId, parseProvider(provider), apiKey, request.webSession.discordUserId,
        );
    }

    @Delete('guilds/:guildId/ai-settings/credentials/:provider')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @HttpCode(204)
    @ApiNoContentResponse({ description: 'Key removed.' })
    removeCredential(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Param('provider') provider: string,
    ): void {
        assertMutationOrigin(request);
        this.settings.removeCredential(guildId, parseProvider(provider));
    }

    /**
     * Tests the key against the provider, from the server.
     *
     * The probe does not start in the browser: the key must not reach it, and an
     * Ollama node normally sits on a network the browser cannot see.
     */
    @Post('guilds/:guildId/ai-settings/credentials/:provider/test')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @ApiOkResponse({ type: CredentialTestResultDto })
    testCredential(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Param('provider') provider: string,
    ): Promise<CredentialTestResultDto> {
        assertMutationOrigin(request);
        return this.settings.testCredential(guildId, parseProvider(provider));
    }

    // ============================================
    // TRASCRIZIONE
    // ============================================

    @Get('guilds/:guildId/ai-settings/transcription')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ type: TranscriptionSettingsDto })
    readTranscription(@Param('guildId') guildId: string): TranscriptionSettingsDto {
        return this.settings.readTranscription(guildId);
    }

    @Put('guilds/:guildId/ai-settings/transcription')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @ApiOkResponse({ type: TranscriptionSettingsDto })
    updateTranscription(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Body() body: UpdateTranscriptionDto,
    ): TranscriptionSettingsDto {
        assertMutationOrigin(request);
        return this.settings.updateTranscription(guildId, body ?? {}, request.webSession.discordUserId);
    }

    @Put('guilds/:guildId/ai-settings/transcription/auth-token')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @HttpCode(204)
    @ApiNoContentResponse({ description: 'Token stored, encrypted at rest.' })
    putTranscriptionAuthToken(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Body() body: PutWakeSecretDto,
    ): void {
        assertMutationOrigin(request);
        this.settings.putTranscriptionAuthToken(
            guildId,
            typeof body?.value === 'string' ? body.value : '',
            request.webSession.discordUserId,
        );
    }

    /**
     * The Whisper models installed on the table's PC.
     *
     * Read-only, so plain access is enough: it says nothing that whoever can see
     * the settings cannot already see.
     */
    @Get('guilds/:guildId/ai-settings/transcription/models')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ type: RemoteWhisperModelsDto })
    remoteTranscriptionModels(@Param('guildId') guildId: string): Promise<RemoteWhisperModelsDto> {
        return this.settings.remoteTranscriptionModels(guildId);
    }

    /**
     * Tries to reach the table's PC. Probes **from the server**: the token must
     * not reach the browser, and that PC normally sits on a network the browser
     * cannot see.
     */
    @Post('guilds/:guildId/ai-settings/transcription/test')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @ApiOkResponse({ type: TranscriptionProbeDto })
    testTranscription(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
    ): Promise<TranscriptionProbeDto> {
        assertMutationOrigin(request);
        return this.settings.testTranscription(guildId);
    }

    /**
     * Switches the PC on and waits.
     *
     * A separate action from the test, not a fallback inside it: a boot
     * legitimately takes minutes, and two buttons tell the story of something
     * that happens in two stages better.
     */
    @Post('guilds/:guildId/ai-settings/transcription/wake')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @ApiOkResponse({ type: TranscriptionProbeDto })
    wakeTranscription(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
    ): Promise<TranscriptionProbeDto> {
        assertMutationOrigin(request);
        return this.settings.wakeTranscription(guildId);
    }

    /** The ways of switching the PC on, with the fields each of them asks for. */
    @Get('guilds/:guildId/ai-settings/wake-methods')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ type: [WakeMethodDto] })
    wakeMethods(): WakeMethodDto[] {
        return this.settings.wakeMethods();
    }

    /** A secret field of the wake method. Write-only, like the keys. */
    @Put('guilds/:guildId/ai-settings/wake-secrets/:method/:field')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @HttpCode(204)
    @ApiNoContentResponse({ description: 'Stored, encrypted at rest.' })
    putWakeSecret(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Param('method') method: string,
        @Param('field') field: string,
        @Body() body: PutWakeSecretDto,
    ): void {
        assertMutationOrigin(request);
        this.settings.putWakeSecret(
            guildId, method, field,
            typeof body?.value === 'string' ? body.value : '',
            request.webSession.discordUserId,
        );
    }

    /**
     * Roughly how much a session of several hours will cost.
     *
     * It is the question a person asks before pressing «listen»: the answer
     * belongs there, not in the recap four hours later.
     */
    @Get('guilds/:guildId/ai-settings/session-estimate')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ type: SessionCostEstimateDto })
    sessionEstimate(
        @Param('guildId') guildId: string,
        @Query('minutes') minutes: string,
    ): Promise<SessionCostEstimateDto> {
        const audioMinutes = Number(minutes);
        if (!Number.isFinite(audioMinutes) || audioMinutes <= 0) {
            throw new BadRequestException('minutes must be a positive number');
        }
        return this.settings.estimateSession({ guildId }, audioMinutes);
    }

    @Get('guilds/:guildId/ai-settings/pricing')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ type: [PricingOverrideDto] })
    pricingOverrides(@Param('guildId') guildId: string): PricingOverrideDto[] {
        return this.settings.pricingOverrides(guildId);
    }

    /**
     * Rates declared by the table.
     *
     * They win even over the models we know: anyone with an enterprise discount
     * or using the Batch API really does pay something else, and imposing our
     * price list on them would be a lie about their own invoice.
     */
    @Put('guilds/:guildId/ai-settings/pricing')
    @UseGuards(GuildAccessGuard, GuildManageGuard)
    @ApiOkResponse({ type: [PricingOverrideDto] })
    savePricingOverrides(
        @Req() request: AuthenticatedRequest,
        @Param('guildId') guildId: string,
        @Body() body: UpdatePricingOverridesDto,
    ): PricingOverrideDto[] {
        assertMutationOrigin(request);
        return this.settings.savePricingOverrides(
            guildId, body?.overrides ?? [], request.webSession.discordUserId,
        );
    }

    /**
     * The models this table can choose from.
     *
     * Guild-scoped and not instance-scoped because of Ollama: what is installed
     * on someone's own PC is known only by that PC, and the catalogue cannot
     * guess it.
     */
    @Get('guilds/:guildId/ai-settings/models')
    @UseGuards(GuildAccessGuard)
    @ApiOkResponse({ type: ProviderModelsDto })
    models(
        @Param('guildId') guildId: string,
        @Query('provider') provider: string,
    ): Promise<ProviderModelsDto> {
        return this.settings.models(parseProvider(provider), guildId);
    }

    /**
     * What this campaign will actually use, read-only.
     *
     * Masters stay informed about provider and model without gaining access to
     * the keys, which belong to the server.
     */
    @Get('campaigns/:campaignId/ai-settings/effective')
    @UseGuards(CampaignAccessGuard)
    @ApiOkResponse({ type: CampaignAiSettingsDto })
    effective(@Req() request: AuthenticatedRequest): CampaignAiSettingsDto {
        const { guildId, canManage } = request.guildAccess!;
        const campaignId = request.campaignId!;
        const scope = { guildId, campaignId };

        return {
            campaign_id: campaignId,
            guild_id: guildId,
            effective: this.settings.effectivePhases(scope),
            can_manage: canManage,
            ready: this.settings.read(guildId).ready,
            overrides: this.settings.campaignOverrides(campaignId),
            agentic_summary: isAgenticSummaryEnabled(scope),
        };
    }

    /** The campaign's embedding model and the possible alternatives. */
    @Get('campaigns/:campaignId/ai-settings/embedding')
    @UseGuards(CampaignAccessGuard)
    @ApiOkResponse({ type: CampaignEmbeddingDto })
    campaignEmbedding(@Req() request: AuthenticatedRequest): CampaignEmbeddingDto {
        return this.settings.campaignEmbedding({
            guildId: request.guildAccess!.guildId,
            campaignId: request.campaignId!,
        });
    }

    /** How much it would cost to move the campaign's memory onto another model. */
    @Get('campaigns/:campaignId/ai-settings/embedding/estimate')
    @UseGuards(CampaignAccessGuard)
    @ApiOkResponse({ type: ReindexEstimateDto })
    estimateReindex(
        @Req() request: AuthenticatedRequest,
        @Query('model') model: string,
    ): ReindexEstimateDto {
        return this.settings.estimateReindex(request.campaignId!, model);
    }

    /**
     * Changes the model and recomputes the vectors.
     *
     * An explicit action and not a side effect of a save: changing model makes
     * all the already indexed memory invisible, and it should be done knowing
     * how many fragments are being recomputed and what they cost.
     */
    @Post('campaigns/:campaignId/ai-settings/embedding/reindex')
    @UseGuards(CampaignAccessGuard, CampaignWriteGuard)
    @ApiOkResponse({ type: ReindexResultDto })
    reindex(
        @Req() request: AuthenticatedRequest,
        @Body() body: ReindexRequestDto,
    ): Promise<ReindexResultDto> {
        assertMutationOrigin(request);
        return this.settings.reindex(
            request.guildAccess!.guildId,
            request.campaignId!,
            body?.model,
        );
    }

    /**
     * Chooses this campaign's summary pipeline.
     *
     * Being able to write to the campaign is enough: it is a choice about how the
     * session is told and how much that costs, not about who pays.
     */
    @Put('campaigns/:campaignId/ai-settings/flow')
    @UseGuards(CampaignAccessGuard, CampaignWriteGuard)
    @ApiOkResponse({ type: UpdateCampaignFlowDto })
    setCampaignFlow(
        @Req() request: AuthenticatedRequest,
        @Body() body: UpdateCampaignFlowDto,
    ): UpdateCampaignFlowDto {
        assertMutationOrigin(request);
        return {
            agentic_summary: this.settings.setCampaignFlow(
                request.guildAccess!.guildId,
                request.campaignId!,
                body?.agentic_summary === true,
                request.webSession.discordUserId,
            ),
        };
    }

    /**
     * What a phase would cost with a model that has not been chosen yet.
     *
     * It is the figure that belongs next to an open select: the session estimate
     * prices what is already configured, so by the time it moves the decision
     * has been taken.
     */
    @Get('campaigns/:campaignId/ai-settings/phase-estimate')
    @UseGuards(CampaignAccessGuard)
    @ApiOkResponse({ type: PhaseModelCostDto })
    phaseEstimate(
        @Req() request: AuthenticatedRequest,
        @Query('phase') phase: string,
        @Query('provider') provider: string,
        @Query('model') model: string,
        @Query('minutes') minutes?: string,
    ): Promise<PhaseModelCostDto> {
        return this.settings.estimatePhase(
            { guildId: request.guildAccess!.guildId, campaignId: request.campaignId! },
            phase as AiPhase,
            parseProvider(provider),
            model ?? '',
            parseAudioMinutes(minutes),
        );
    }

    @Get('campaigns/:campaignId/ai-settings/transcription')
    @UseGuards(CampaignAccessGuard)
    @ApiOkResponse({ type: CampaignTranscriptionDto })
    campaignTranscription(@Req() request: AuthenticatedRequest): CampaignTranscriptionDto {
        return this.settings.readCampaignTranscription({
            guildId: request.guildAccess!.guildId,
            campaignId: request.campaignId!,
        });
    }

    /**
     * The transcription model for this campaign.
     *
     * Write access to the campaign is enough: the body cannot name the PC, the
     * tokens or a key, so nothing here can move who pays.
     */
    @Put('campaigns/:campaignId/ai-settings/transcription')
    @UseGuards(CampaignAccessGuard, CampaignWriteGuard)
    @ApiOkResponse({ type: CampaignTranscriptionDto })
    saveCampaignTranscription(
        @Req() request: AuthenticatedRequest,
        @Body() body: UpdateCampaignTranscriptionDto,
    ): CampaignTranscriptionDto {
        assertMutationOrigin(request);
        return this.settings.saveCampaignTranscription(
            request.guildAccess!.guildId,
            request.campaignId!,
            body ?? {},
            request.webSession.discordUserId,
        );
    }

    /**
     * Advanced settings: the model of a single phase, for this campaign.
     *
     * Being able to write to the campaign is enough, no need to administer the
     * server: what is chosen here is *which model*, and who pays does not change
     * — the keys stay the guild's and cannot be named from this route.
     */
    @Put('campaigns/:campaignId/ai-settings/phases')
    @UseGuards(CampaignAccessGuard, CampaignWriteGuard)
    @ApiOkResponse({ type: [PhaseOverrideDto] })
    saveCampaignPhases(
        @Req() request: AuthenticatedRequest,
        @Body() body: UpdateCampaignPhasesDto,
    ): PhaseOverrideDto[] {
        assertMutationOrigin(request);
        return this.settings.saveCampaignOverrides(
            request.guildAccess!.guildId,
            request.campaignId!,
            body?.overrides ?? [],
            request.webSession.discordUserId,
        );
    }
}
