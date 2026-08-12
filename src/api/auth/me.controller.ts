import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from './session.guard';
import { GuildAccessGuard } from './guildAccess.guard';
import { SessionAccessService } from './sessionAccess.service';
import { AuthenticatedRequest } from './types';
import { getDiscordClient } from '../../discordClient';
import { campaignRepository } from '../../db';
import { assertMutationOrigin } from '../common/mutationOrigin';
import { exportUserData } from '../../services/dataExport';
import { eraseUserData } from '../../services/dataErasure';
import {
    legalStatusFor,
    recordLegalAcceptance,
    type LegalDocument,
} from '../../services/legalAcceptance';

@Controller('api/v1/me')
@UseGuards(SessionGuard)
export class MeController {
    constructor(private readonly sessionAccess: SessionAccessService) {}

    @Get()
    getProfile(@Req() request: AuthenticatedRequest) {
        const { discordUserId, username, globalName, avatar } = request.webSession;
        return { id: discordUserId, username, globalName, avatar };
    }

    /**
     * State of the legal documents for this user.
     *
     * Two distinct entries: the terms are **accepted** (they are a contract),
     * the privacy notice is **acknowledged** (it is an information duty, not a
     * contract — «I accept the notice» confuses transparency with consent, and
     * the authorities consider that unfair).
     */
    @Get('legal')
    getLegal(@Req() request: AuthenticatedRequest) {
        const statuses = legalStatusFor(request.webSession.discordUserId);
        return {
            documents: statuses.map(s => ({
                document: s.document,
                current_version: s.currentVersion,
                accepted_version: s.acceptedVersion,
                accepted_at: s.acceptedAt,
                needs_acceptance: s.needsAcceptance,
            })),
            needs_acceptance: statuses.some(s => s.needsAcceptance),
        };
    }

    /**
     * Records the acceptance of the current versions.
     *
     * The server decides the version, not the client: otherwise one could claim
     * to have accepted a text never seen, and the register would be worth about
     * as much as a sticky note.
     */
    @Post('legal')
    acceptLegal(@Req() request: AuthenticatedRequest, @Body() body: { documents?: string[] }) {
        assertMutationOrigin(request);
        const requested = Array.isArray(body?.documents) ? body.documents : [];
        const documents = requested.filter(
            (d): d is LegalDocument => d === 'terms' || d === 'privacy',
        );
        if (documents.length === 0) {
            throw new BadRequestException('No known document to record');
        }
        recordLegalAcceptance(request.webSession.discordUserId, documents);
        return this.getLegal(request);
    }

    /**
     * A copy of everything this server holds about the caller.
     *
     * The same scoping as {@link eraseUserData}, deliberately: what you can get
     * back is exactly what you can have erased. Discord's Developer Terms do not
     * ask for this — only for modification and deletion — but §5(a) requires
     * compliance with the GDPR, and art. 15(3) and 20 do.
     *
     * It lives under `/me` so the legal gate does not apply: someone who has
     * *refused* the terms must still be able to take their data and leave.
     */
    @Get('guilds/:guildId/export')
    @UseGuards(GuildAccessGuard)
    exportData(@Req() request: AuthenticatedRequest, @Param('guildId') guildId: string) {
        return exportUserData(guildId, request.webSession.discordUserId);
    }

    /**
     * Erases the caller's own data on a server. The web counterpart of
     * `$forgetme`, down to the same service call.
     *
     * The recaps and the campaign world are left standing: they are the whole
     * table's work, and honouring one person's request by deleting everyone
     * else's contribution is not what anyone is asking for.
     */
    @Delete('guilds/:guildId/data')
    @UseGuards(GuildAccessGuard)
    async eraseData(@Req() request: AuthenticatedRequest, @Param('guildId') guildId: string) {
        assertMutationOrigin(request);
        const result = await eraseUserData(guildId, request.webSession.discordUserId);
        return {
            rows: Object.values(result.rows).reduce((sum, n) => sum + n, 0),
            files: result.objects + result.localFiles,
            // Never report a clean deletion when part of it survived: the whole
            // point of the endpoint is that the answer can be trusted.
            complete: result.failedPrefixes.length === 0,
        };
    }

    @Get('guilds')
    async getGuilds(@Req() request: AuthenticatedRequest) {
        const session = await this.sessionAccess.ensureGuilds(request.webSessionId, request.webSession);
        const client = getDiscordClient();
        const standalonePreview = process.env.WEB_STANDALONE_PREVIEW === 'true';

        // Only guilds where the user is a member AND the bot is actually
        // installed — matching roadmap 2.2 point 3. `client` can briefly be
        // non-null-but-not-ready right at process boot (guilds.cache empty
        // until the Discord gateway 'ready' event); self-resolves in seconds.
        //
        // A local standalone preview deliberately does not log the production
        // bot into Discord a second time. In that opt-in mode, a campaign in
        // the isolated production snapshot is the installation signal. OAuth
        // membership is still mandatory because we start from session.guilds.
        return session.guilds
            .filter((g) =>
                standalonePreview
                    ? campaignRepository.getCampaigns(g.id).length > 0
                    : (client?.guilds.cache.has(g.id) ?? false),
            )
            .map((g) => ({ id: g.id, name: g.name, icon: g.icon, canManage: g.canManage }));
    }
}
