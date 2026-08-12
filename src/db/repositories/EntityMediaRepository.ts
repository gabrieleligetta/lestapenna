import { db } from '../client';
import type { EntityMediaEntry, EntityMediaType } from '../types';

export interface EntityMediaRef {
    entityType: EntityMediaType;
    entityKey: string;
}

export type NewEntityMedia = Omit<EntityMediaEntry, 'created_at' | 'updated_at' | 'is_primary'>;

/** How many pictures one entity may hold. Enough for a gallery, short of a folder. */
export const MAX_IMAGES_PER_ENTITY = 12;

function refKey(entityType: EntityMediaType, entityKey: string): string {
    return `${entityType}:${entityKey}`;
}

export const entityMediaRepository = {
    getById(campaignId: number, id: string): EntityMediaEntry | null {
        return (
            db.prepare('SELECT * FROM entity_media WHERE campaign_id = ? AND id = ?').get(campaignId, id) as
                | EntityMediaEntry
                | undefined
        ) ?? null;
    },

    /** The picture the sheet shows. Falls back to the oldest if none is marked. */
    getForEntity(campaignId: number, entityType: EntityMediaType, entityKey: string): EntityMediaEntry | null {
        return (
            db.prepare(`
                SELECT * FROM entity_media
                WHERE campaign_id = ? AND entity_type = ? AND entity_key = ?
                ORDER BY is_primary DESC, created_at ASC
                LIMIT 1
            `).get(campaignId, entityType, entityKey) as EntityMediaEntry | undefined
        ) ?? null;
    },

    /** Every picture of one entity, the main one first. */
    listForEntity(campaignId: number, entityType: EntityMediaType, entityKey: string): EntityMediaEntry[] {
        return db.prepare(`
            SELECT * FROM entity_media
            WHERE campaign_id = ? AND entity_type = ? AND entity_key = ?
            ORDER BY is_primary DESC, created_at ASC
        `).all(campaignId, entityType, entityKey) as EntityMediaEntry[];
    },

    /**
     * Resolves a page/session worth of images in one query. Callers pass only
     * canonical, server-resolved keys; no user input is interpolated into SQL.
     *
     * One row per entity — the main picture — because this feeds lists and
     * cards, which show one thumbnail each.
     */
    getForEntities(campaignId: number, refs: EntityMediaRef[]): Map<string, EntityMediaEntry> {
        const unique = [...new Map(refs.map((ref) => [refKey(ref.entityType, ref.entityKey), ref])).values()];
        if (unique.length === 0) return new Map();
        if (unique.length > 500) throw new Error('Too many entity media references');

        const clauses = unique.map(() => '(entity_type = ? AND entity_key = ?)').join(' OR ');
        const params = unique.flatMap((ref) => [ref.entityType, ref.entityKey]);
        const rows = db.prepare(
            `SELECT * FROM entity_media WHERE campaign_id = ? AND (${clauses})
             ORDER BY is_primary DESC, created_at ASC`,
        ).all(campaignId, ...params) as EntityMediaEntry[];

        const byEntity = new Map<string, EntityMediaEntry>();
        for (const row of rows) {
            const key = refKey(row.entity_type, row.entity_key);
            if (!byEntity.has(key)) byEntity.set(key, row);
        }
        return byEntity;
    },

    /**
     * Adds a picture to an entity's gallery, after its objects are durable.
     *
     * It **adds**. Replacing was the old behaviour, when an entity could hold
     * one picture, and it meant a generated portrait quietly destroyed an
     * uploaded one — the wrong way round, since the uploaded one is the more
     * deliberate statement of what a character looks like.
     *
     * The first picture an entity gets is its main one. Later ones are not
     * promoted: which picture represents a character is a decision, not a
     * side-effect of being newest.
     *
     * Returns any row evicted by the ceiling, so its objects can be swept.
     */
    add(entry: NewEntityMedia): EntityMediaEntry[] {
        return db.transaction(() => {
            const existing = entityMediaRepository.listForEntity(
                entry.campaign_id,
                entry.entity_type,
                entry.entity_key,
            );
            const now = Date.now();
            db.prepare(`
                INSERT INTO entity_media (
                    id, campaign_id, entity_type, entity_key,
                    display_object_key, thumbnail_object_key,
                    width, height, size_bytes, focal_x, focal_y, alt_text,
                    source, generation_mode, generation_prompt, generation_user_prompt,
                    is_primary, uploaded_by, created_at, updated_at
                ) VALUES (
                    @id, @campaign_id, @entity_type, @entity_key,
                    @display_object_key, @thumbnail_object_key,
                    @width, @height, @size_bytes, @focal_x, @focal_y, @alt_text,
                    @source, @generation_mode, @generation_prompt, @generation_user_prompt,
                    @is_primary, @uploaded_by, @created_at, @updated_at
            )`).run({
                ...entry,
                is_primary: existing.length === 0 ? 1 : 0,
                created_at: now,
                updated_at: now,
            });

            // Oldest first, and never the main one: the picture the sheet shows
            // is not something a ceiling should take away.
            const evictable = [...existing, ]
                .filter(row => row.is_primary !== 1)
                .sort((a, b) => a.created_at - b.created_at);
            const overflow = existing.length + 1 - MAX_IMAGES_PER_ENTITY;
            const evicted = overflow > 0 ? evictable.slice(0, overflow) : [];
            for (const row of evicted) {
                db.prepare('DELETE FROM entity_media WHERE id = ?').run(row.id);
            }
            return evicted;
        })();
    },

    /** Promotes one picture to the one the sheet shows. */
    setPrimary(campaignId: number, id: string): EntityMediaEntry | null {
        return db.transaction(() => {
            const row = entityMediaRepository.getById(campaignId, id);
            if (!row) return null;
            db.prepare(`
                UPDATE entity_media SET is_primary = 0, updated_at = ?
                WHERE campaign_id = ? AND entity_type = ? AND entity_key = ?
            `).run(Date.now(), campaignId, row.entity_type, row.entity_key);
            db.prepare('UPDATE entity_media SET is_primary = 1, updated_at = ? WHERE id = ?')
                .run(Date.now(), id);
            return entityMediaRepository.getById(campaignId, id);
        })();
    },

    /**
     * Removes one picture, handing the main role on if it held it.
     *
     * An entity left with pictures but no main one would render as though it
     * had none.
     */
    deleteById(campaignId: number, id: string): EntityMediaEntry | null {
        return db.transaction(() => {
            const row = entityMediaRepository.getById(campaignId, id);
            if (!row) return null;
            db.prepare('DELETE FROM entity_media WHERE id = ?').run(id);
            if (row.is_primary === 1) {
                const next = entityMediaRepository.getForEntity(campaignId, row.entity_type, row.entity_key);
                if (next) {
                    db.prepare('UPDATE entity_media SET is_primary = 1 WHERE id = ?').run(next.id);
                }
            }
            return row;
        })();
    },

    updatePresentation(
        campaignId: number,
        id: string,
        fields: Partial<Pick<EntityMediaEntry, 'focal_x' | 'focal_y' | 'alt_text'>>,
    ): EntityMediaEntry | null {
        const assignments: string[] = [];
        const params: Record<string, unknown> = { campaignId, id, updatedAt: Date.now() };
        if (fields.focal_x !== undefined) {
            assignments.push('focal_x = @focalX');
            params.focalX = fields.focal_x;
        }
        if (fields.focal_y !== undefined) {
            assignments.push('focal_y = @focalY');
            params.focalY = fields.focal_y;
        }
        if (fields.alt_text !== undefined) {
            assignments.push('alt_text = @altText');
            params.altText = fields.alt_text;
        }
        if (assignments.length === 0) return entityMediaRepository.getById(campaignId, id);

        db.prepare(`
            UPDATE entity_media
            SET ${assignments.join(', ')}, updated_at = @updatedAt
            WHERE campaign_id = @campaignId AND id = @id
        `).run(params);
        return entityMediaRepository.getById(campaignId, id);
    },

    /** Every picture of an entity, for a cascade deletion. */
    deleteForEntity(campaignId: number, entityType: EntityMediaType, entityKey: string): EntityMediaEntry[] {
        return db.transaction(() => {
            const existing = entityMediaRepository.listForEntity(campaignId, entityType, entityKey);
            if (existing.length === 0) return [];
            db.prepare(
                'DELETE FROM entity_media WHERE campaign_id = ? AND entity_type = ? AND entity_key = ?',
            ).run(campaignId, entityType, entityKey);
            return existing;
        })();
    },
};

export function entityMediaRefKey(entityType: EntityMediaType, entityKey: string): string {
    return refKey(entityType, entityKey);
}
