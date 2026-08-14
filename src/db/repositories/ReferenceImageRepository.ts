import { randomUUID } from 'crypto';
import { db } from '../client';
import type { ReferenceImageEntry, ReferenceScope } from '../types';

/**
 * The pictures handed to the image model alongside the prompt.
 *
 * Stored defaults say what each picture may contribute. Per-job priority is
 * explicit in the immutable generation manifest rather than inferred here.
 */

export type NewReferenceImage = Omit<
    ReferenceImageEntry,
    'id' | 'created_at' | 'roles_json' | 'instruction' | 'auto_select'
> & Partial<Pick<ReferenceImageEntry, 'roles_json' | 'instruction' | 'auto_select'>>;

/** How many references one entity may accumulate before the oldest is dropped. */
export const MAX_REFERENCES_PER_SCOPE = 6;

export const referenceImageRepository = {
    listForScope(campaignId: number, scope: ReferenceScope, scopeKey: string): ReferenceImageEntry[] {
        return db.prepare(`
            SELECT * FROM reference_image
            WHERE campaign_id = ? AND scope = ? AND scope_key = ?
            ORDER BY created_at ASC
        `).all(campaignId, scope, scopeKey) as ReferenceImageEntry[];
    },

    getById(campaignId: number, id: string): ReferenceImageEntry | null {
        return (
            db.prepare('SELECT * FROM reference_image WHERE campaign_id = ? AND id = ?')
                .get(campaignId, id) as ReferenceImageEntry | undefined
        ) ?? null;
    },

    /**
     * Adds one, and returns whatever had to make room for it.
     *
     * The caller deletes the returned objects from storage: a row removed here
     * with its bytes left behind would be an orphan nobody can reach or bill.
     */
    add(entry: NewReferenceImage): { saved: ReferenceImageEntry; evicted: ReferenceImageEntry[] } {
        return db.transaction(() => {
            const id = randomUUID();
            db.prepare(`
                INSERT INTO reference_image (
                    id, campaign_id, scope, scope_key, object_key, mime_type,
                    width, height, size_bytes, label, roles_json, instruction,
                    auto_select, uploaded_by, created_at
                ) VALUES (
                    @id, @campaign_id, @scope, @scope_key, @object_key, @mime_type,
                    @width, @height, @size_bytes, @label, @roles_json, @instruction,
                    @auto_select, @uploaded_by, @created_at
                )
            `).run({
                roles_json: null,
                instruction: null,
                auto_select: 1,
                ...entry,
                id,
                created_at: Date.now(),
            });

            const existing = referenceImageRepository.listForScope(
                entry.campaign_id,
                entry.scope,
                entry.scope_key,
            );
            const evicted = existing.slice(0, Math.max(0, existing.length - MAX_REFERENCES_PER_SCOPE));
            for (const row of evicted) {
                db.prepare('DELETE FROM reference_image WHERE id = ?').run(row.id);
            }

            return {
                saved: referenceImageRepository.getById(entry.campaign_id, id)!,
                evicted,
            };
        })();
    },

    /**
     * Replaces the single reference an entity keeps of itself.
     *
     * An entity carries exactly one: the portrait currently on its sheet. Piling
     * up every portrait it ever had would drag old faces into a new drawing.
     */
    replaceEntityReference(entry: NewReferenceImage): ReferenceImageEntry[] {
        return db.transaction(() => {
            const previous = referenceImageRepository.listForScope(
                entry.campaign_id,
                'entity',
                entry.scope_key,
            );
            for (const row of previous) {
                db.prepare('DELETE FROM reference_image WHERE id = ?').run(row.id);
            }
            db.prepare(`
                INSERT INTO reference_image (
                    id, campaign_id, scope, scope_key, object_key, mime_type,
                    width, height, size_bytes, label, roles_json, instruction,
                    auto_select, uploaded_by, created_at
                ) VALUES (
                    @id, @campaign_id, @scope, @scope_key, @object_key, @mime_type,
                    @width, @height, @size_bytes, @label, @roles_json, @instruction,
                    @auto_select, @uploaded_by, @created_at
                )
            `).run({
                roles_json: null,
                instruction: null,
                auto_select: 1,
                ...entry,
                id: randomUUID(),
                scope: 'entity',
                created_at: Date.now(),
            });
            return previous;
        })();
    },

    remove(campaignId: number, id: string): ReferenceImageEntry | null {
        return db.transaction(() => {
            const existing = referenceImageRepository.getById(campaignId, id);
            if (!existing) return null;
            db.prepare('DELETE FROM reference_image WHERE id = ?').run(id);
            return existing;
        })();
    },

    updateMetadata(
        campaignId: number,
        id: string,
        fields: Pick<ReferenceImageEntry, 'label' | 'roles_json' | 'instruction' | 'auto_select'>,
    ): ReferenceImageEntry | null {
        db.prepare(`
            UPDATE reference_image
            SET label = ?, roles_json = ?, instruction = ?, auto_select = ?
            WHERE campaign_id = ? AND id = ?
        `).run(fields.label, fields.roles_json, fields.instruction, fields.auto_select, campaignId, id);
        return referenceImageRepository.getById(campaignId, id);
    },
};

/** The key an entity's own reference is filed under. */
export function entityScopeKey(entityType: string, entityKey: string): string {
    return `${entityType}:${entityKey}`;
}
