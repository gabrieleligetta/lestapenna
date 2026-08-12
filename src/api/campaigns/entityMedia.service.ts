import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { AuthenticatedRequest } from '../auth/types';
import {
    artifactRepository,
    characterRepository,
    entityMediaRepository,
    locationRepository,
    npcRepository,
} from '../../db';
import {
    entityMediaRefKey,
    type EntityMediaRef,
} from '../../db/repositories/EntityMediaRepository';
import {
    ENTITY_MEDIA_TYPES,
    type EntityMediaEntry,
    type EntityMediaSource,
    type EntityMediaType,
    type ImageGenerationMode,
} from '../../db/types';
import { EntityMediaStorage, type EntityMediaReadResult } from '../../services/entityMediaStorage';
import { canWriteCampaign } from '../../services/campaignAccess';
import { logger } from '../../utils/logger';
import { transformImageVariants } from '../../utils/imageTransform';
import { toEntityImageDto, type EntityImageDto, type UpdateEntityImageDto } from './dto/media.dto';

const log = logger('EntityMedia');

export interface ResolvedMediaEntity {
    entityType: EntityMediaType;
    /** Internal row id for regular entities; Discord user id for characters. */
    entityKey: string;
}

export interface ImageUploadPresentation {
    focalX?: number;
    focalY?: number;
    altText?: string | null;
}

/**
 * Where a picture came from, stored alongside it.
 *
 * It travels through `upload()` rather than through a second write path, so a
 * generated portrait goes through exactly the same validation, transcoding,
 * atomic object swap and orphan cleanup as an uploaded one. The alternative — a
 * parallel "save a generated image" method — would be the same forty lines with
 * one field different, and the two would drift.
 *
 * It is also decided **by the server**, never sent by the client: a browser that
 * could claim `source: 'upload'` for a generated image would defeat the guard
 * that exists to protect what a person put there by hand.
 */
export interface ImageProvenance {
    source: EntityMediaSource;
    mode?: ImageGenerationMode | null;
    /** What actually reached the provider. */
    prompt?: string | null;
    /** What the person typed, kept verbatim so it can be shown back and edited. */
    userPrompt?: string | null;
}

const UPLOADED_BY_HAND: ImageProvenance = { source: 'upload' };

interface TransformedImage {
    display: Buffer;
    thumbnail: Buffer;
    width: number;
    height: number;
}

function validateFocalPoint(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new BadRequestException(`${field} must be a number between 0 and 100`);
    }
    return value;
}

function validateAltText(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') throw new BadRequestException('altText must be a string or null');
    const normalized = value.trim();
    if (normalized.length > 300) throw new BadRequestException('altText must not exceed 300 characters');
    return normalized || null;
}

@Injectable()
export class EntityMediaService {
    private readonly storage = new EntityMediaStorage();

    resolveEntity(campaignId: number, rawType: string, entityId: string): ResolvedMediaEntity {
        if (!ENTITY_MEDIA_TYPES.includes(rawType as EntityMediaType)) {
            throw new BadRequestException(`entityType must be one of: ${ENTITY_MEDIA_TYPES.join(', ')}`);
        }
        const entityType = rawType as EntityMediaType;

        if (entityType === 'npc') {
            const entity = npcRepository.getNpcByShortId(campaignId, entityId);
            if (!entity) throw new NotFoundException('NPC not found');
            return { entityType, entityKey: String(entity.id) };
        }
        if (entityType === 'location') {
            const entity = locationRepository.getAtlasEntryByShortId(campaignId, entityId);
            if (!entity) throw new NotFoundException('Location not found');
            return { entityType, entityKey: String(entity.id) };
        }
        if (entityType === 'artifact') {
            const entity = artifactRepository.getArtifactByShortId(campaignId, entityId);
            if (!entity) throw new NotFoundException('Artifact not found');
            return { entityType, entityKey: String(entity.id) };
        }

        if (characterRepository.getCharacterRowId(entityId, campaignId) === null) {
            throw new NotFoundException('Character not found');
        }
        return { entityType, entityKey: entityId };
    }

    /**
     * Whether pictures can be stored at all on this instance.
     *
     * Exposed so generation can refuse **before** paying a provider for an image
     * there would be nowhere to put.
     */
    storageEnabled(): boolean {
        return this.storage.isEnabled();
    }

    assertCanWrite(request: AuthenticatedRequest, entity: ResolvedMediaEntity): void {
        // Same rule as the rest of the CRUD: an NPC's image is campaign content,
        // not a server setting.
        const canWrite = canWriteCampaign(request.campaignId!, request.webSession.discordUserId, {
            guildCanManage: request.guildAccess?.canManage ?? false,
        });
        if (canWrite) return;
        // Your own portrait stays editable even if you are not at the table.
        if (entity.entityType === 'character' && request.webSession.discordUserId === entity.entityKey) return;
        throw new ForbiddenException('You must be part of this campaign to change this image');
    }

    private validatePresentation(input: ImageUploadPresentation | UpdateEntityImageDto) {
        return {
            focalX: validateFocalPoint(input.focalX, 'focalX'),
            focalY: validateFocalPoint(input.focalY, 'focalY'),
            altText: validateAltText(input.altText),
        };
    }

    private async transform(input: Buffer): Promise<TransformedImage> {
        const variants = await transformImageVariants(input);
        return {
            display: variants.display,
            thumbnail: variants.thumbnail,
            width: variants.width,
            height: variants.height,
        };
    }

    async upload(
        request: AuthenticatedRequest,
        rawType: string,
        entityId: string,
        input: Buffer,
        presentation: ImageUploadPresentation,
        provenance: ImageProvenance = UPLOADED_BY_HAND,
    ): Promise<EntityImageDto> {
        const campaignId = request.campaignId!;
        const entity = this.resolveEntity(campaignId, rawType, entityId);
        this.assertCanWrite(request, entity);
        if (!this.storage.isEnabled()) {
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }
        const validated = this.validatePresentation(presentation);
        const transformed = await this.transform(input);

        const id = randomUUID();
        const prefix = `media/${request.guildAccess!.guildId}/${campaignId}/${entity.entityType}/${id}`;
        const displayKey = `${prefix}/display.webp`;
        const thumbnailKey = `${prefix}/thumbnail.webp`;
        let displayStored = false;
        let thumbnailStored = false;

        try {
            await this.storage.put(displayKey, transformed.display);
            displayStored = true;
            await this.storage.put(thumbnailKey, transformed.thumbnail);
            thumbnailStored = true;

            const evicted = entityMediaRepository.add({
                id,
                campaign_id: campaignId,
                entity_type: entity.entityType,
                entity_key: entity.entityKey,
                display_object_key: displayKey,
                thumbnail_object_key: thumbnailKey,
                width: transformed.width,
                height: transformed.height,
                size_bytes: transformed.display.length + transformed.thumbnail.length,
                focal_x: validated.focalX ?? 50,
                focal_y: validated.focalY ?? 50,
                alt_text: validated.altText ?? null,
                source: provenance.source,
                generation_mode: provenance.mode ?? null,
                generation_prompt: provenance.prompt ?? null,
                generation_user_prompt: provenance.userPrompt ?? null,
                uploaded_by: request.webSession.discordUserId,
            });

            for (const row of evicted) {
                await this.deleteObjectsBestEffort(row);
            }

            return toEntityImageDto(entityMediaRepository.getById(campaignId, id)!);
        } catch (error) {
            if (thumbnailStored) await this.storage.delete(thumbnailKey).catch(() => undefined);
            if (displayStored) await this.storage.delete(displayKey).catch(() => undefined);
            throw error;
        }
    }

    update(
        request: AuthenticatedRequest,
        mediaId: string,
        input: UpdateEntityImageDto,
    ): EntityImageDto {
        const campaignId = request.campaignId!;
        const row = entityMediaRepository.getById(campaignId, mediaId);
        if (!row) throw new NotFoundException('Entity image not found');
        this.assertCanWrite(request, { entityType: row.entity_type, entityKey: row.entity_key });
        const fields = this.validatePresentation(input);
        const updated = entityMediaRepository.updatePresentation(campaignId, mediaId, {
            focal_x: fields.focalX,
            focal_y: fields.focalY,
            alt_text: fields.altText,
        });
        return toEntityImageDto(updated!);
    }

    /** Removes every picture of an entity. */
    async delete(request: AuthenticatedRequest, rawType: string, entityId: string): Promise<void> {
        const campaignId = request.campaignId!;
        const entity = this.resolveEntity(campaignId, rawType, entityId);
        this.assertCanWrite(request, entity);
        if (!this.storage.isEnabled()) {
            // Keep metadata intact if we cannot complete the object lifecycle:
            // deleting only the DB row would make the private object unreachable.
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }
        const deleted = entityMediaRepository.deleteForEntity(campaignId, entity.entityType, entity.entityKey);
        for (const row of deleted) await this.deleteObjectsBestEffort(row);
    }

    /** Removes one picture from the gallery. */
    async deleteOne(request: AuthenticatedRequest, mediaId: string): Promise<void> {
        const campaignId = request.campaignId!;
        const row = entityMediaRepository.getById(campaignId, mediaId);
        if (!row) throw new NotFoundException('Entity image not found');
        this.assertCanWrite(request, { entityType: row.entity_type, entityKey: row.entity_key });
        if (!this.storage.isEnabled()) {
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }
        const deleted = entityMediaRepository.deleteById(campaignId, mediaId);
        if (deleted) await this.deleteObjectsBestEffort(deleted);
    }

    /** Chooses which picture the sheet shows. */
    setPrimary(request: AuthenticatedRequest, mediaId: string): EntityImageDto {
        const campaignId = request.campaignId!;
        const row = entityMediaRepository.getById(campaignId, mediaId);
        if (!row) throw new NotFoundException('Entity image not found');
        this.assertCanWrite(request, { entityType: row.entity_type, entityKey: row.entity_key });
        return toEntityImageDto(entityMediaRepository.setPrimary(campaignId, mediaId)!);
    }

    /** Every picture of one entity, the main one first. */
    listImages(request: AuthenticatedRequest, rawType: string, entityId: string): EntityImageDto[] {
        const campaignId = request.campaignId!;
        const entity = this.resolveEntity(campaignId, rawType, entityId);
        return entityMediaRepository
            .listForEntity(campaignId, entity.entityType, entity.entityKey)
            .map(toEntityImageDto);
    }

    async read(campaignId: number, mediaId: string, variant: string): Promise<EntityMediaReadResult | null> {
        if (!this.storage.isEnabled()) {
            throw new ServiceUnavailableException('Entity media storage is not configured');
        }
        if (variant !== 'thumbnail' && variant !== 'display') {
            throw new NotFoundException('Image variant not found');
        }
        const row = entityMediaRepository.getById(campaignId, mediaId);
        if (!row) throw new NotFoundException('Entity image not found');
        return this.storage.read(
            variant === 'thumbnail' ? row.thumbnail_object_key : row.display_object_key,
        );
    }

    getImage(campaignId: number, entityType: EntityMediaType, entityKey: string): EntityImageDto | null {
        const row = entityMediaRepository.getForEntity(campaignId, entityType, entityKey);
        return row ? toEntityImageDto(row) : null;
    }

    getImages(campaignId: number, refs: EntityMediaRef[]): Map<string, EntityImageDto> {
        const rows = entityMediaRepository.getForEntities(campaignId, refs);
        return new Map([...rows].map(([key, row]) => [key, toEntityImageDto(row)]));
    }

    imageFromMap(
        images: Map<string, EntityImageDto>,
        entityType: EntityMediaType,
        entityKey: string,
    ): EntityImageDto | null {
        return images.get(entityMediaRefKey(entityType, entityKey)) ?? null;
    }

    /**
     * Deletes the objects already orphaned by a metadata row removed elsewhere.
     *
     * The cascade deletion of an entity removes the `entity_media` row inside
     * its DB transaction, where there cannot be a network call: the object keys
     * arrive here after the commit. Best-effort by construction — the entity is
     * already gone, and a storage error must not turn a successful deletion into
     * a 500.
     */
    async deleteOrphanedObjects(objectKeys: string[]): Promise<void> {
        if (objectKeys.length === 0 || !this.storage.isEnabled()) return;
        const results = await Promise.allSettled(objectKeys.map((key) => this.storage.delete(key)));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                log.error(
                    `Orphaned media object after entity deletion: ${objectKeys[index]}`,
                    result.reason as Error,
                );
            }
        });
    }

    private async deleteObjectsBestEffort(row: EntityMediaEntry): Promise<void> {
        const results = await Promise.allSettled([
            this.storage.delete(row.display_object_key),
            this.storage.delete(row.thumbnail_object_key),
        ]);
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                const key = index === 0 ? row.display_object_key : row.thumbnail_object_key;
                log.error(`Orphaned media object after metadata lifecycle change: ${key}`, result.reason as Error);
            }
        });
    }
}
