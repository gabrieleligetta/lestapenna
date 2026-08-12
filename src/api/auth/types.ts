import { FastifyRequest } from 'fastify';
import { WebSessionData } from './webSession.store';

/** Attached by SessionGuard once the `lp_session` cookie resolves to a live Redis session. */
export interface AuthenticatedRequest extends FastifyRequest {
    webSessionId: string;
    webSession: WebSessionData;
    /** Attached by GuildAccessGuard/CampaignAccessGuard, only on routes with a :guildId or :campaignId param. */
    guildAccess?: { guildId: string; canManage: boolean };
    /** Attached by CampaignAccessGuard, only on routes with a :campaignId param. */
    campaignId?: number;
}
