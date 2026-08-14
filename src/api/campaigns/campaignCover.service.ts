import { randomUUID } from 'crypto';
import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import { canWriteCampaign } from '../../services/campaignAccess';
import { EntityMediaStorage, type EntityMediaReadResult } from '../../services/entityMediaStorage';
import { transformImageVariants } from '../../utils/imageTransform';
import { logger } from '../../utils/logger';
import type { CampaignCoverDto } from './dto/campaignCover.dto';

const log = logger('CampaignCover');

/** The two sizes a cover is stored in; the card asks for the small one. */
export const COVER_VARIANTS = ['thumbnail', 'display'] as const;
export type CoverVariant = (typeof COVER_VARIANTS)[number];

/**
 * The picture on a campaign's card.
 *
 * It travels through the same validation, transcoding and object store as a
 * portrait — same bucket, same credentials, same 5 MiB ceiling — and under the
 * `media/{guildId}/` prefix, so the erasure paths that already sweep a server's
 * pictures take the cover with them instead of leaving one behind.
 *
 * It is *not* a `reference_image` of scope 'campaign'. Those are handed to the
 * image model on every generation, so filing a cover among them would mean
 * choosing a cover quietly repainted every portrait drawn afterwards.
 */
@Injectable()
export class CampaignCoverService {
    private readonly storage = new EntityMediaStorage();

    async upload(request: AuthenticatedRequest, file: Buffer): Promise<CampaignCoverDto> {
        const campaignId = request.campaignId!;
        this.assertCanWrite(request);
        if (!this.storage.isEnabled()) {
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }

        const previous = campaignRepository.getCampaignById(campaignId);
        const variants = await transformImageVariants(file);
        const prefix = `media/${request.guildAccess!.guildId}/${campaignId}/cover/${randomUUID()}`;
        const displayKey = `${prefix}/display.webp`;
        const thumbnailKey = `${prefix}/thumbnail.webp`;

        let displayStored = false;
        try {
            await this.storage.put(displayKey, variants.display);
            displayStored = true;
            await this.storage.put(thumbnailKey, variants.thumbnail);
            campaignRepository.setCampaignCover(campaignId, displayKey, thumbnailKey);
        } catch (error) {
            // Objects with no row pointing at them are unreachable and unbilled
            // to nobody's benefit: take them back out before giving up.
            await this.storage.delete(thumbnailKey).catch(() => undefined);
            if (displayStored) await this.storage.delete(displayKey).catch(() => undefined);
            throw error;
        }

        await this.forget(previous?.cover_object_key, previous?.cover_thumbnail_key);
        return this.describe(campaignId);
    }

    async remove(request: AuthenticatedRequest): Promise<void> {
        const campaignId = request.campaignId!;
        this.assertCanWrite(request);
        const campaign = campaignRepository.getCampaignById(campaignId);
        if (!campaign?.cover_object_key) throw new NotFoundException('This campaign has no cover');

        campaignRepository.clearCampaignCover(campaignId);
        await this.forget(campaign.cover_object_key, campaign.cover_thumbnail_key);
    }

    async read(campaignId: number, rawVariant: string): Promise<EntityMediaReadResult | null> {
        if (!COVER_VARIANTS.includes(rawVariant as CoverVariant)) {
            throw new BadRequestException(`variant must be one of: ${COVER_VARIANTS.join(', ')}`);
        }
        const campaign = campaignRepository.getCampaignById(campaignId);
        const key = rawVariant === 'display' ? campaign?.cover_object_key : campaign?.cover_thumbnail_key;
        if (!key) return null;
        return this.storage.read(key);
    }

    private describe(campaignId: number): CampaignCoverDto {
        const campaign = campaignRepository.getCampaignById(campaignId)!;
        return {
            coverUrl: coverUrl(campaign.id, campaign.cover_thumbnail_key)!,
            updatedAt: campaign.cover_updated_at ?? Date.now(),
        };
    }

    private assertCanWrite(request: AuthenticatedRequest): void {
        // Same rule as the rest of campaign content: being an administrator of
        // the Discord server is not the same as sitting at this table, and only
        // the backend knows which of the two the caller is.
        const canWrite = canWriteCampaign(request.campaignId!, request.webSession.discordUserId, {
            guildCanManage: request.guildAccess?.canManage ?? false,
        });
        if (!canWrite) throw new ForbiddenException('You must be part of this campaign to change its cover');
    }

    private async forget(...keys: (string | null | undefined)[]): Promise<void> {
        for (const key of keys) {
            if (!key) continue;
            try {
                await this.storage.delete(key);
            } catch (error) {
                log.warn(`Orphaned cover object ${key}: ${(error as Error).message}`);
            }
        }
    }
}

/**
 * Where the browser asks for a cover, or `null` when there is none.
 *
 * A route rather than a signed URL in the payload: the campaign list is cached
 * by the client, and a URL that expires inside that cache would show a broken
 * picture for as long as the cache lives.
 */
export function coverUrl(campaignId: number, thumbnailKey: string | null | undefined): string | null {
    return thumbnailKey ? `/api/v1/campaigns/${campaignId}/cover/thumbnail` : null;
}
