import { randomUUID } from 'crypto';
import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types';
import { canWriteCampaign } from '../../services/campaignAccess';
import { EntityMediaStorage } from '../../services/entityMediaStorage';
import { transformImageVariants } from '../../utils/imageTransform';
import { factionRepository } from '../../db/repositories/FactionRepository';
import {
    entityScopeKey,
    referenceImageRepository,
} from '../../db/repositories/ReferenceImageRepository';
import { entityMediaRepository } from '../../db/repositories/EntityMediaRepository';
import type { EntityMediaType, ReferenceImageEntry, ReferenceScope } from '../../db/types';
import { REFERENCE_SCOPES } from '../../db/types';
import type { ReferenceImage } from '../../bard/llm/image';
import { MAX_REFERENCE_IMAGES } from '../../bard/llm/image';
import { logger } from '../../utils/logger';
import type { ReferenceImageDto } from './dto/referenceImage.dto';
import type { ReferenceCandidateDto } from './dto/imageGeneration.dto';

const log = logger('ReferenceImages');

/**
 * The pictures a generation draws *from*.
 *
 * Three scopes, because the look of a portrait comes from three different
 * records. The campaign's art direction says what the gallery as a whole should
 * look like. A faction's livery says what its members wear — the fact that makes
 * a guard captain recognisable as one of the Vergini di Ferro, and the fact no
 * amount of searching for her name will find, because it is written on the
 * faction. And the entity's own accepted portrait keeps a face the same across
 * regenerations instead of re-rolling it.
 *
 * They are stored through the same object store as the portraits, under their
 * own prefix: same bucket, same credentials, same absence of a new env var.
 */
/**
 * How long a one-time reference waits to be used, and how many can wait.
 *
 * It is a scratch pad, not storage: a picture handed to a single generation and
 * then forgotten. Keeping it anywhere durable would be the opposite of what was
 * asked for — «without it being taken from or added to the gallery».
 */
const SCRATCH_TTL_MS = 30 * 60 * 1000;
const MAX_SCRATCH = 24;

interface ScratchReference {
    campaignId: number;
    bytes: Buffer;
    mimeType: string;
    label: string | null;
    previewDataUri: string;
    createdAt: number;
}

@Injectable()
export class ReferenceImagesService {
    private readonly storage = new EntityMediaStorage();

    /** One-time references, held in memory and never written anywhere. */
    private readonly scratch = new Map<string, ScratchReference>();

    list(request: AuthenticatedRequest, scope: ReferenceScope, scopeKey: string): ReferenceImageDto[] {
        const campaignId = request.campaignId!;
        return referenceImageRepository
            .listForScope(campaignId, scope, this.normalizeKey(campaignId, scope, scopeKey))
            .map(toReferenceImageDto);
    }

    /**
     * Everything that *could* be sent with one generation.
     *
     * Three sources, in weight order — the campaign's art direction, the livery
     * of the factions this subject serves, and the subject's own pictures. The
     * last of these is the gallery itself rather than a copy of it: a table that
     * uploads three pictures of their character has already said what it looks
     * like, and asking them to upload the same files again as "references"
     * would be a filing chore dressed up as a feature.
     */
    candidates(
        campaignId: number,
        entityType: EntityMediaType,
        entityKey: string,
        factionNames: string[] = [],
    ): ReferenceCandidateDto[] {
        const fromReferences = (scope: ReferenceScope, key: string) => referenceImageRepository
            .listForScope(campaignId, scope, key)
            .map(row => ({
                id: `reference:${row.id}`,
                scope: row.scope,
                imageUrl: `/api/v1/campaigns/${campaignId}/references/${row.id}/image`,
                label: row.label,
            }));

        return [
            ...fromReferences('campaign', ''),
            ...factionNames.flatMap(name => {
                const faction = factionRepository.getFaction(campaignId, name);
                return faction?.short_id ? fromReferences('faction', faction.short_id) : [];
            }),
            ...entityMediaRepository.listForEntity(campaignId, entityType, entityKey).map(row => ({
                id: `media:${row.id}`,
                scope: 'entity' as const,
                imageUrl: `/api/v1/campaigns/${campaignId}/media/${row.id}/display`,
                label: row.alt_text,
            })),
        ];
    }

    /**
     * Loads the pictures somebody actually chose.
     *
     * Nothing is loaded unasked: each reference is input tokens on the table's
     * own account, so an empty list means an empty list. Anything unreadable is
     * skipped rather than fatal — a missing reference makes a picture less
     * specific, and refusing to draw at all would be the worse answer.
     */
    async collectChosen(campaignId: number, ids: string[]): Promise<ReferenceImage[]> {
        if (!this.storage.isEnabled() || ids.length === 0) return [];

        const loaded: ReferenceImage[] = [];
        for (const id of ids.slice(0, MAX_REFERENCE_IMAGES)) {
            const [kind, key] = id.split(':', 2);
            if (!key) continue;

            if (kind === 'reference') {
                const row = referenceImageRepository.getById(campaignId, key);
                if (!row) continue;
                const bytes = await this.readBytes(row.object_key);
                if (bytes) loaded.push({ bytes, mimeType: row.mime_type, label: row.label ?? row.scope });
                continue;
            }

            if (kind === 'media') {
                const row = entityMediaRepository.getById(campaignId, key);
                if (!row) continue;
                const bytes = await this.readBytes(row.display_object_key);
                if (bytes) loaded.push({ bytes, mimeType: 'image/webp', label: row.alt_text ?? 'entity' });
                continue;
            }

            if (kind === 'scratch') {
                const held = this.scratch.get(key);
                // Another campaign's scratch is not reachable even by guessing
                // an id, and an expired one simply is not there any more.
                if (!held || held.campaignId !== campaignId) continue;
                loaded.push({ bytes: held.bytes, mimeType: held.mimeType, label: held.label ?? 'one-off' });
            }
        }
        return loaded;
    }

    /**
     * Takes a picture for this generation only.
     *
     * It never reaches the gallery, the reference table or the object store: it
     * lives in memory until it is used or expires. Somebody who wants to try a
     * pose from a photograph they will not keep should not have to file it
     * first and delete it after.
     */
    async holdScratch(
        request: AuthenticatedRequest,
        file: Buffer,
        label: string | null,
    ): Promise<ReferenceCandidateDto> {
        const campaignId = request.campaignId!;
        this.assertCanWrite(request);

        const variants = await transformImageVariants(file);
        this.sweepScratch();

        const id = randomUUID();
        this.scratch.set(id, {
            campaignId,
            bytes: variants.display,
            mimeType: 'image/webp',
            label: label?.trim() || null,
            previewDataUri: `data:image/webp;base64,${variants.thumbnail.toString('base64')}`,
            createdAt: Date.now(),
        });

        return {
            id: `scratch:${id}`,
            scope: 'scratch',
            imageUrl: this.scratch.get(id)!.previewDataUri,
            label: label?.trim() || null,
        };
    }

    async add(
        request: AuthenticatedRequest,
        scope: ReferenceScope,
        scopeKey: string,
        file: Buffer,
        label: string | null,
    ): Promise<ReferenceImageDto> {
        const campaignId = request.campaignId!;
        this.assertCanWrite(request);
        if (!this.storage.isEnabled()) {
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }
        if (scope === 'entity') {
            // The entity reference is the portrait the sheet already carries; it
            // is written when one is accepted, not uploaded by hand.
            throw new BadRequestException('An entity\'s own reference is set by keeping a generated portrait');
        }

        const key = this.normalizeKey(campaignId, scope, scopeKey);
        const variants = await transformImageVariants(file);
        const objectKey = `references/${campaignId}/${scope}/${randomUUID()}.webp`;
        await this.storage.put(objectKey, variants.display);

        const { saved, evicted } = referenceImageRepository.add({
            campaign_id: campaignId,
            scope,
            scope_key: key,
            object_key: objectKey,
            mime_type: 'image/webp',
            width: variants.width,
            height: variants.height,
            size_bytes: variants.display.length,
            label: label?.trim() || null,
            uploaded_by: request.webSession.discordUserId,
        });

        await this.forget(evicted);
        return toReferenceImageDto(saved);
    }

    async remove(request: AuthenticatedRequest, id: string): Promise<void> {
        this.assertCanWrite(request);
        const removed = referenceImageRepository.remove(request.campaignId!, id);
        if (!removed) throw new NotFoundException('No such reference image');
        await this.forget([removed]);
    }

    async read(campaignId: number, id: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
        const row = referenceImageRepository.getById(campaignId, id);
        if (!row) return null;
        const bytes = await this.readBytes(row.object_key);
        return bytes ? { bytes, mimeType: row.mime_type } : null;
    }

    parseScope(raw: unknown): ReferenceScope {
        if (typeof raw !== 'string' || !REFERENCE_SCOPES.includes(raw as ReferenceScope)) {
            throw new BadRequestException(`scope must be one of: ${REFERENCE_SCOPES.join(', ')}`);
        }
        return raw as ReferenceScope;
    }

    /** Drops what has expired, then the oldest if the pad is still too full. */
    private sweepScratch(): void {
        const now = Date.now();
        for (const [id, held] of this.scratch) {
            if (now - held.createdAt > SCRATCH_TTL_MS) this.scratch.delete(id);
        }
        if (this.scratch.size < MAX_SCRATCH) return;
        const oldest = [...this.scratch.entries()]
            .sort((a, b) => a[1].createdAt - b[1].createdAt)
            .slice(0, this.scratch.size - MAX_SCRATCH + 1);
        for (const [id] of oldest) this.scratch.delete(id);
    }

    private assertCanWrite(request: AuthenticatedRequest): void {
        const canWrite = canWriteCampaign(request.campaignId!, request.webSession.discordUserId, {
            guildCanManage: request.guildAccess?.canManage ?? false,
        });
        if (!canWrite) throw new ForbiddenException('You must be part of this campaign to change its references');
    }

    /** A campaign reference has no key; a faction one must name a faction of this campaign. */
    private normalizeKey(campaignId: number, scope: ReferenceScope, scopeKey: string): string {
        if (scope === 'campaign') return '';
        const key = (scopeKey ?? '').trim();
        if (!key) throw new BadRequestException('This scope needs the entity it refers to');
        if (scope === 'faction' && !factionRepository.getFactionByShortId(campaignId, key)) {
            throw new NotFoundException('Faction not found');
        }
        return key;
    }

    private async readBytes(objectKey: string): Promise<Buffer | null> {
        try {
            const result = await this.storage.read(objectKey);
            if (!result) return null;
            if (result.kind === 'buffer') return result.body;
            // A signed-URL store: the bytes have to be fetched to be sent to a
            // provider, and a reference is small enough for that to be fine.
            const response = await fetch(result.url);
            if (!response.ok) return null;
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            log.warn(`Reference image unreadable, generating without it: ${(error as Error).message}`);
            return null;
        }
    }

    private async forget(rows: ReferenceImageEntry[]): Promise<void> {
        for (const row of rows) {
            try {
                await this.storage.delete(row.object_key);
            } catch (error) {
                log.warn(`Orphaned reference object ${row.object_key}: ${(error as Error).message}`);
            }
        }
    }
}

function toReferenceImageDto(row: ReferenceImageEntry): ReferenceImageDto {
    return {
        id: row.id,
        imageUrl: `/api/v1/campaigns/${row.campaign_id}/references/${row.id}/image`,
        scope: row.scope,
        scope_key: row.scope_key,
        width: row.width,
        height: row.height,
        label: row.label,
        created_at: row.created_at,
    };
}
