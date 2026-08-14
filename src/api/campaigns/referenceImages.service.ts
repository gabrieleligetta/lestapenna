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
import { referenceImageRepository } from '../../db/repositories/ReferenceImageRepository';
import { entityMediaRepository } from '../../db/repositories/EntityMediaRepository';
import type { EntityMediaType, ReferenceImageEntry, ReferenceScope } from '../../db/types';
import { REFERENCE_SCOPES } from '../../db/types';
import type { ReferenceImage } from '../../bard/llm/image';
import {
    MAX_REFERENCE_IMAGES,
    ReferenceContractError,
    defaultReferenceRoles,
    normalizeReferenceInstruction,
    normalizeReferenceLabel,
    normalizeReferenceRoles,
    parseStoredReferenceRoles,
    type ReferenceManifestEntry,
    type ReferenceRole,
} from '../../bard/imageReferences';
import { scratchReferenceRepository } from '../../db/repositories/ScratchReferenceRepository';
import { logger } from '../../utils/logger';
import type { ReferenceImageDto, UpdateReferenceImageDto } from './dto/referenceImage.dto';
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
 * How long a one-time reference waits to be attached to a job.
 *
 * It is a scratch pad, not storage: a picture handed to a single generation and
 * then forgotten. Durability here is transport durability, not cataloguing: it
 * is never added to the gallery or the permanent reference collection.
 */
const SCRATCH_TTL_MS = 30 * 60 * 1000;
const ATTACHED_SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ReferenceUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReferenceUnavailableError';
    }
}

@Injectable()
export class ReferenceImagesService {
    private readonly storage = new EntityMediaStorage();

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
                roles: parseStoredReferenceRoles(row.roles_json, defaultReferenceRoles(row.scope)),
                instruction: row.instruction,
                auto_selected: row.auto_select === 1,
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
                roles: parseStoredReferenceRoles(row.reference_roles_json, defaultReferenceRoles('entity')),
                instruction: row.reference_instruction,
                // The current portrait is always pertinent. Other gallery
                // pictures opt in explicitly through their persistent default.
                auto_selected: row.is_primary === 1 || row.reference_auto_select === 1,
            })),
        ];
    }

    /**
     * Loads the pictures somebody actually chose.
     *
     * Nothing is loaded unasked: each reference is input tokens on the table's
     * own account, so an empty list means an empty list. A chosen reference is
     * binding: unreadable input fails before the paid provider call instead of
     * silently producing a different character.
     */
    snapshotChosen(
        campaignId: number,
        selections: Array<{
            id: string;
            roles?: ReferenceRole[];
            instruction?: string | null;
            priority?: number;
        }>,
    ): ReferenceManifestEntry[] {
        return selections.map((selection, index) => {
            const candidate = this.resolveMetadata(campaignId, selection.id, false);
            if (!candidate) {
                throw new ReferenceUnavailableError(`Selected reference ${selection.id} is unavailable`);
            }
            return {
                id: selection.id,
                scope: candidate.scope,
                label: candidate.label,
                roles: selection.roles ?? candidate.roles,
                instruction: selection.instruction === undefined
                    ? candidate.instruction
                    : selection.instruction,
                priority: selection.priority ?? index + 1,
            };
        });
    }

    attachScratch(campaignId: number, jobId: string, manifest: ReferenceManifestEntry[]): void {
        const scratch = manifest.filter(reference => reference.id.startsWith('scratch:'));
        const ids = scratch.map(reference => reference.id.slice('scratch:'.length));
        try {
            if (scratchReferenceRepository.attachManyToJob(
                campaignId,
                ids,
                jobId,
                Date.now() + ATTACHED_SCRATCH_TTL_MS,
            )) return;
        } catch (error) {
            if ((error as Error).message !== 'SCRATCH_REFERENCE_ATTACH_RACE') throw error;
        }
        throw new ReferenceUnavailableError('One or more one-time references are unavailable');
    }

    async collectChosen(
        campaignId: number,
        manifest: ReferenceManifestEntry[],
        jobId: string,
    ): Promise<ReferenceImage[]> {
        if (manifest.length === 0) return [];
        if (!this.storage.isEnabled()) {
            throw new ReferenceUnavailableError('Reference image storage is not configured');
        }

        const loaded: ReferenceImage[] = [];
        if (manifest.length > MAX_REFERENCE_IMAGES) {
            throw new ReferenceUnavailableError(
                `At most ${MAX_REFERENCE_IMAGES} reference images may be loaded`,
            );
        }
        for (const directive of [...manifest].sort((a, b) => a.priority - b.priority)) {
            const { id } = directive;
            const [kind, key] = id.split(':', 2);
            if (!key) throw new ReferenceUnavailableError(`Selected reference ${id} is invalid`);

            if (kind === 'reference') {
                const row = referenceImageRepository.getById(campaignId, key);
                if (!row) throw new ReferenceUnavailableError(`Selected reference ${id} no longer exists`);
                const bytes = await this.readBytes(row.object_key);
                if (!bytes) throw new ReferenceUnavailableError(`Selected reference ${id} cannot be read`);
                loaded.push({ ...directive, bytes, mimeType: row.mime_type });
                continue;
            }

            if (kind === 'media') {
                const row = entityMediaRepository.getById(campaignId, key);
                if (!row) throw new ReferenceUnavailableError(`Selected reference ${id} no longer exists`);
                const bytes = await this.readBytes(row.display_object_key);
                if (!bytes) throw new ReferenceUnavailableError(`Selected reference ${id} cannot be read`);
                loaded.push({ ...directive, bytes, mimeType: 'image/webp' });
                continue;
            }

            if (kind === 'scratch') {
                const row = scratchReferenceRepository.getById(campaignId, key);
                if (!row || row.job_id !== jobId || row.expires_at <= Date.now()) {
                    throw new ReferenceUnavailableError(`One-time reference ${directive.label ?? key} is unavailable`);
                }
                const bytes = await this.readBytes(row.object_key);
                if (!bytes) throw new ReferenceUnavailableError(`One-time reference ${directive.label ?? key} cannot be read`);
                loaded.push({ ...directive, bytes, mimeType: row.mime_type });
                continue;
            }

            throw new ReferenceUnavailableError(`Selected reference ${id} has an unknown kind`);
        }
        return loaded;
    }

    /**
     * Takes a picture for this generation only.
     *
     * It never reaches the gallery or permanent reference table. It does reach
     * object storage, because the generation job is durable and may run after a
     * restart; the row and object expire automatically.
     */
    async holdScratch(
        request: AuthenticatedRequest,
        file: Buffer,
        label: string | null,
    ): Promise<ReferenceCandidateDto> {
        const campaignId = request.campaignId!;
        this.assertCanWrite(request);
        if (!this.storage.isEnabled()) {
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }

        const variants = await transformImageVariants(file);
        const objectKey = `references/${campaignId}/scratch/${randomUUID()}.webp`;
        await this.storage.put(objectKey, variants.display);
        let saved;
        try {
            saved = scratchReferenceRepository.add({
                campaign_id: campaignId,
                object_key: objectKey,
                mime_type: 'image/webp',
                width: variants.width,
                height: variants.height,
                size_bytes: variants.display.length,
                label: label?.trim() || null,
                roles_json: JSON.stringify(defaultReferenceRoles('scratch')),
                instruction: null,
                uploaded_by: request.webSession.discordUserId,
                expires_at: Date.now() + SCRATCH_TTL_MS,
            });
        } catch (error) {
            await this.storage.delete(objectKey).catch(() => undefined);
            throw error;
        }

        return {
            id: `scratch:${saved.id}`,
            scope: 'scratch',
            imageUrl: `data:image/webp;base64,${variants.thumbnail.toString('base64')}`,
            label: saved.label,
            roles: defaultReferenceRoles('scratch'),
            instruction: null,
            auto_selected: true,
        };
    }

    async add(
        request: AuthenticatedRequest,
        scope: ReferenceScope,
        scopeKey: string,
        file: Buffer,
        label: string | null,
        metadata?: { roles?: unknown; instruction?: unknown; autoSelect?: unknown },
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
        let roles: ReferenceRole[];
        let instruction: string | null;
        try {
            roles = metadata?.roles === undefined
                ? defaultReferenceRoles(scope)
                : normalizeReferenceRoles(metadata.roles);
            instruction = normalizeReferenceInstruction(metadata?.instruction);
            label = normalizeReferenceLabel(label);
        } catch (error) {
            if (error instanceof ReferenceContractError) throw new BadRequestException(error.message);
            throw error;
        }
        const autoSelect = metadata?.autoSelect === undefined
            ? true
            : metadata.autoSelect === true || metadata.autoSelect === 'true';
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
            label,
            roles_json: JSON.stringify(roles),
            instruction,
            auto_select: autoSelect ? 1 : 0,
            uploaded_by: request.webSession.discordUserId,
        });

        await this.forget(evicted);
        return toReferenceImageDto(saved);
    }

    update(
        request: AuthenticatedRequest,
        id: string,
        body: UpdateReferenceImageDto,
    ): ReferenceImageDto {
        this.assertCanWrite(request);
        const existing = referenceImageRepository.getById(request.campaignId!, id);
        if (!existing) throw new NotFoundException('No such reference image');
        let roles: ReferenceRole[];
        let instruction: string | null;
        // The note is what tells one picture from another in a list of six, so
        // it is correctable here rather than only at upload. Left out of the
        // body it keeps its current value; sent as null it is cleared.
        let label: string | null;
        try {
            roles = normalizeReferenceRoles(body.roles);
            instruction = normalizeReferenceInstruction(body.instruction);
            label = body.label === undefined ? existing.label : normalizeReferenceLabel(body.label);
        } catch (error) {
            if (error instanceof ReferenceContractError) throw new BadRequestException(error.message);
            throw error;
        }
        const updated = referenceImageRepository.updateMetadata(request.campaignId!, id, {
            label,
            roles_json: JSON.stringify(roles),
            instruction,
            auto_select: body.auto_select === undefined
                ? existing.auto_select
                : body.auto_select ? 1 : 0,
        });
        return toReferenceImageDto(updated!);
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

    /** Deletes one-time inputs once the provider no longer needs their bytes. */
    async releaseScratch(campaignId: number, manifest: ReferenceManifestEntry[]): Promise<void> {
        for (const reference of manifest) {
            if (!reference.id.startsWith('scratch:')) continue;
            const id = reference.id.slice('scratch:'.length);
            const row = scratchReferenceRepository.getById(campaignId, id);
            if (!row) continue;
            try {
                await this.storage.delete(row.object_key);
                scratchReferenceRepository.remove(campaignId, id);
            } catch (error) {
                // Preserve the row so the janitor retains a pointer it can use
                // to retry deletion after the object store recovers.
                log.warn(`Could not release one-time reference ${row.object_key}: ${(error as Error).message}`);
            }
        }
    }

    private resolveMetadata(
        campaignId: number,
        id: string,
        allowAttachedScratch: boolean,
    ): Pick<ReferenceManifestEntry, 'scope' | 'label' | 'roles' | 'instruction'> | null {
        const [kind, key] = id.split(':', 2);
        if (!key) return null;

        if (kind === 'reference') {
            const row = referenceImageRepository.getById(campaignId, key);
            return row ? {
                scope: row.scope,
                label: row.label,
                roles: parseStoredReferenceRoles(row.roles_json, defaultReferenceRoles(row.scope)),
                instruction: row.instruction,
            } : null;
        }
        if (kind === 'media') {
            const row = entityMediaRepository.getById(campaignId, key);
            return row ? {
                scope: 'entity',
                label: row.alt_text,
                roles: parseStoredReferenceRoles(row.reference_roles_json, defaultReferenceRoles('entity')),
                instruction: row.reference_instruction,
            } : null;
        }
        if (kind === 'scratch') {
            const row = scratchReferenceRepository.getById(campaignId, key);
            if (!row || row.expires_at <= Date.now() || (!allowAttachedScratch && row.job_id !== null)) return null;
            return {
                scope: 'scratch',
                label: row.label,
                roles: parseStoredReferenceRoles(row.roles_json, defaultReferenceRoles('scratch')),
                instruction: row.instruction,
            };
        }
        return null;
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
            log.warn(`Reference image unreadable: ${(error as Error).message}`);
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
        roles: parseStoredReferenceRoles(row.roles_json, defaultReferenceRoles(row.scope)),
        instruction: row.instruction,
        auto_select: row.auto_select === 1,
        created_at: row.created_at,
    };
}
