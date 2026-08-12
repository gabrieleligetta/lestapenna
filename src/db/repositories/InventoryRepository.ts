import { db } from '../client';
import { getByShortId, resolveEntityId, getHistoryByEntity } from './shared';
import { INVENTORY_CATEGORIES, InventoryCategory, InventoryItem } from '../types';
import { generateShortId } from '../utils/idGenerator';
import { guessInventoryCategory } from '../../utils/inventoryCategory';

export type InventoryWithArtifactInfo = InventoryItem & {
    is_artifact: boolean;
    /** Internal join key used for bulk media lookup; never projected to clients. */
    artifact_id: number | null;
    artifact_status: string | null;
    artifact_short_id: string | null;
    is_cursed: boolean | null;
    artifact_description: string | null;
};

function mapInventoryWithArtifactInfo(item: any): InventoryWithArtifactInfo {
    return {
        ...item,
        is_artifact: item.is_artifact === 1,
        is_cursed: item.is_cursed == null ? null : item.is_cursed === 1,
    };
}

export const inventoryRepository = {
    addLoot: (campaignId: number, itemName: string, qty: number = 1, sessionId?: string, description?: string, isManual: boolean = false, timestamp?: number, aiCategory?: InventoryCategory) => {
        // Normalizing name
        const cleanName = itemName.trim();

        // Check if exists
        const existing = db.prepare('SELECT id, quantity, description FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)')
            .get(campaignId, cleanName) as { id: number, quantity: number, description: string | null } | undefined;

        if (existing) {
            const finalDesc = description ? (existing.description ? existing.description + '\n' + description : description) : existing.description;
            // Legacy Parity: Update session_id to current one if provided
            // Use named params for cleaner update of is_manual
            db.prepare(`
                UPDATE inventory 
                SET quantity = quantity + $qty, 
                    last_updated = $timestamp, 
                    description = $desc, 
                    session_id = COALESCE(session_id, $sessionId), 
                    rag_sync_needed = 1,
                    is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END,
                    manual_description = CASE WHEN $isManual = 1 THEN $desc ELSE manual_description END
                WHERE id = $id
            `).run({
                qty,
                timestamp: timestamp || Date.now(),
                desc: finalDesc,
                sessionId: sessionId || null,
                id: existing.id,
                isManual: isManual ? 1 : 0
            });
        } else {
            const shortId = generateShortId('inventory');
            const category = aiCategory && (INVENTORY_CATEGORIES as readonly string[]).includes(aiCategory)
                ? aiCategory
                : guessInventoryCategory(cleanName, description);
            db.prepare(`
                INSERT INTO inventory (campaign_id, item_name, quantity, acquired_at, last_updated, session_id, description, rag_sync_needed, is_manual, short_id, manual_description, category)
                VALUES ($campaignId, $name, $qty, $timestamp, $timestamp, $sessionId, $desc, 1, $isManual, $shortId, CASE WHEN $isManual = 1 THEN $desc ELSE NULL END, $category)
            `).run({
                campaignId,
                name: cleanName,
                qty,
                timestamp: timestamp || Date.now(),
                sessionId: sessionId || null,
                desc: description || null,
                isManual: isManual ? 1 : 0,
                shortId,
                category
            });
            console.log(`[Inventory] 📦 Nuovo oggetto: ${cleanName} [#${shortId}]`);
        }
    },

    removeLoot: (campaignId: number, itemName: string, qty: number = 1): boolean => {
        // Legacy Parity: Use LIKE for looser matching (e.g. "pozione" matches "Pozione di Guarigione")
        const existing = db.prepare('SELECT id, quantity FROM inventory WHERE campaign_id = ? AND lower(item_name) LIKE lower(?)')
            .get(campaignId, `%${itemName}%`) as { id: number, quantity: number } | undefined;

        if (existing) {
            const newQty = Math.max(0, existing.quantity - qty);
            if (newQty === 0) {
                db.prepare('DELETE FROM inventory WHERE id = ?').run(existing.id);
            } else {
                db.prepare('UPDATE inventory SET quantity = ?, last_updated = ?, rag_sync_needed = 1 WHERE id = ?')
                    .run(newQty, Date.now(), existing.id);
            }
            return true;
        }
        return false;
    },

    /**
     * Deletes the item by exact name, whatever its quantity.
     *
     * Different from `removeLoot`, which is the game's "consumption": LIKE match
     * and quantity decrement. Here we need the outright deletion of the entity,
     * used by the web CRUD where the user is deleting the record, not spending
     * the item.
     */
    deleteInventoryItem: (campaignId: number, itemName: string): boolean => {
        const result = db.prepare(
            'DELETE FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)'
        ).run(campaignId, itemName);
        return result.changes > 0;
    },

    deleteInventoryHistory: (campaignId: number, itemName: string): boolean => {
        const result = db.prepare('DELETE FROM inventory_history WHERE campaign_id = ? AND lower(item_name) = lower(?)').run(campaignId, itemName);
        return result.changes > 0;
    },

    getInventory: (campaignId: number, limit: number = 20, offset: number = 0): InventoryItem[] => {
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? AND quantity > 0 ORDER BY item_name LIMIT ? OFFSET ?').all(campaignId, limit, offset) as InventoryItem[];
    },

    countInventory: (campaignId: number, category?: InventoryCategory): number => {
        const categoryClause = category ? ' AND category = ?' : '';
        const params = category ? [campaignId, category] : [campaignId];
        const result = db.prepare(
            `SELECT COUNT(*) as count FROM inventory WHERE campaign_id = ? AND quantity > 0${categoryClause}`,
        ).get(...params) as { count: number };
        return result.count;
    },

    getSessionInventory: (sessionId: string): any[] => {
        return db.prepare('SELECT * FROM inventory WHERE session_id = ?').all(sessionId);
    },

    getSessionInventoryWithArtifactInfo: (sessionId: string): InventoryWithArtifactInfo[] => {
        const items = db.prepare(`
            SELECT
                i.*,
                CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END as is_artifact,
                a.id as artifact_id,
                a.status as artifact_status,
                a.short_id as artifact_short_id,
                a.is_cursed,
                a.description as artifact_description
            FROM inventory i
            LEFT JOIN artifacts a ON i.campaign_id = a.campaign_id
                AND lower(i.item_name) = lower(a.name)
            WHERE i.session_id = ?
            ORDER BY i.item_name
        `).all(sessionId);
        return items.map(mapInventoryWithArtifactInfo);
    },

    listAllInventory: (campaignId: number): InventoryItem[] => {
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? ORDER BY item_name').all(campaignId) as InventoryItem[];
    },

    getInventoryItemByName: (campaignId: number, itemName: string): InventoryItem | null => {
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)').get(campaignId, itemName) as InventoryItem | null;
    },

    getInventoryItemByShortId: (campaignId: number, shortId: string): InventoryItem | null =>
        getByShortId<InventoryItem>('inventory', campaignId, shortId),

    updateInventoryCategory: (
        campaignId: number,
        shortId: string,
        category: InventoryCategory,
    ): boolean => {
        const item = inventoryRepository.getInventoryItemByShortId(campaignId, shortId);
        if (!item) return false;
        const result = db.prepare(`
            UPDATE inventory
            SET category = ?, last_updated = ?
            WHERE id = ?
        `).run(category, Date.now(), item.id);
        return result.changes > 0;
    },

    mergeInventoryItems: (
        campaignId: number,
        oldName: string,
        newName: string
    ): boolean => {
        const source = inventoryRepository.getInventoryItemByName(campaignId, oldName);
        if (!source) return false;

        const target = inventoryRepository.getInventoryItemByName(campaignId, newName);

        db.transaction(() => {
            if (target) {
                // Merge quantities
                const totalQty = source.quantity + target.quantity;
                const newDesc = (target.description ? target.description + '\n' : '') + (source.description || '');
                const newNotes = (target.notes ? target.notes + '\n' : '') + (source.notes || '');
                // Preserve an explicit classification when the merge target is
                // still on the default bucket.
                const category = target.category === 'OTHER' ? source.category : target.category;

                db.prepare(`
                    UPDATE inventory 
                    SET quantity = ?, description = ?, notes = ?, category = ?, last_updated = ?, rag_sync_needed = 1
                    WHERE id = ?
                `).run(totalQty, newDesc.trim() || null, newNotes.trim() || null, category, Date.now(), target.id);

                db.prepare('DELETE FROM inventory WHERE id = ?').run(source.id);
            } else {
                // Rename
                db.prepare('UPDATE inventory SET item_name = ?, last_updated = ?, rag_sync_needed = 1 WHERE id = ?')
                    .run(newName, Date.now(), source.id);
            }

            // History follows the merge/rename (it used to be orphaned on the old name)
            const historyTargetId = target ? target.id : source.id;
            db.prepare(`
                UPDATE inventory_history
                SET item_name = ?, entity_id = ?
                WHERE campaign_id = ?
                  AND (entity_id = ? OR (entity_id IS NULL AND lower(item_name) = lower(?)))
            `).run(newName, historyTargetId, campaignId, source.id, oldName);
        })();

        console.log(`[Inventory] 🔀 Merged: ${oldName} -> ${newName}`);
        return true;
    },

    addInventoryEvent: (campaignId: number, itemName: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        const entityId = resolveEntityId('inventory', 'item_name', campaignId, itemName);
        db.prepare(`
            INSERT INTO inventory_history (campaign_id, item_name, session_id, description, event_type, timestamp, is_manual, entity_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, itemName, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0, entityId);
    },

    getInventoryHistory: (campaignId: number, itemName: string): any[] => {
        return getHistoryByEntity('inventory_history', 'item_name', 'inventory', 'item_name', campaignId, itemName);
    },

    updateInventoryDescription: (campaignId: number, itemName: string, description: string) => {
        db.prepare(`
            UPDATE inventory 
            SET description = ?, rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(item_name) = lower(?)
        `).run(description, campaignId, itemName);
    },

    markInventoryDirty: (campaignId: number, itemName: string) => {
        db.prepare('UPDATE inventory SET rag_sync_needed = 1 WHERE campaign_id = ? AND lower(item_name) = lower(?)').run(campaignId, itemName);
    },

    getDirtyInventoryItems: (campaignId: number): InventoryItem[] => {
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? AND rag_sync_needed = 1').all(campaignId) as InventoryItem[];
    },

    clearInventoryDirtyFlag: (campaignId: number, itemName: string) => {
        db.prepare('UPDATE inventory SET rag_sync_needed = 0 WHERE campaign_id = ? AND lower(item_name) = lower(?)').run(campaignId, itemName);
    },

    updateInventoryFields: (
        campaignId: number,
        itemName: string,
        fields: Partial<{
            quantity: number;
            description: string;
            notes: string;
            item_name: string;
        }>,
        isManual: boolean = false
    ): boolean => {
        const item = inventoryRepository.getInventoryItemByName(campaignId, itemName);
        if (!item) return false;

        const updates: string[] = [];
        const params: any = { id: item.id };

        if (fields.quantity !== undefined) {
            updates.push('quantity = $quantity');
            params.quantity = fields.quantity;
        }
        if (fields.description !== undefined) {
            updates.push('description = $description');
            params.description = fields.description;
        }
        if (fields.notes !== undefined) {
            updates.push('notes = $notes');
            params.notes = fields.notes;
        }
        if (fields.item_name !== undefined) {
            updates.push('item_name = $itemName');
            params.itemName = fields.item_name;
        }

        if (updates.length === 0) return false;

        updates.push('rag_sync_needed = 1');
        updates.push('last_updated = $timestamp');
        params.timestamp = Date.now();
        if (isManual) updates.push('is_manual = 1');
        if (fields.description && isManual) {
            updates.push('manual_description = $description');
        }

        db.prepare(`UPDATE inventory SET ${updates.join(', ')} WHERE id = $id`).run(params);
        return true;
    },

    /**
     * Returns the inventory with information about linked artifacts
     * LEFT JOINs artifacts to identify which items are artifacts
     */
    getInventoryWithArtifactInfo: (
        campaignId: number,
        limit: number = 20,
        offset: number = 0,
        category?: InventoryCategory,
    ): InventoryWithArtifactInfo[] => {
        const categoryClause = category ? ' AND i.category = ?' : '';
        const params: Array<number | string> = category
            ? [campaignId, category, limit, offset]
            : [campaignId, limit, offset];
        const items = db.prepare(`
            SELECT
                i.*,
                CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END as is_artifact,
                a.id as artifact_id,
                a.status as artifact_status,
                a.short_id as artifact_short_id,
                a.is_cursed,
                a.description as artifact_description
            FROM inventory i
            LEFT JOIN artifacts a ON i.campaign_id = a.campaign_id
                AND lower(i.item_name) = lower(a.name)
            WHERE i.campaign_id = ? AND i.quantity > 0${categoryClause}
            ORDER BY i.item_name
            LIMIT ? OFFSET ?
        `).all(...params);

        return items.map(mapInventoryWithArtifactInfo);
    },

    /**
     * The full inventory list, with the artifact info
     */
    listAllInventoryWithArtifacts: (campaignId: number): InventoryWithArtifactInfo[] => {
        const items = db.prepare(`
            SELECT
                i.*,
                CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END as is_artifact,
                a.id as artifact_id,
                a.status as artifact_status,
                a.short_id as artifact_short_id,
                a.is_cursed,
                a.description as artifact_description
            FROM inventory i
            LEFT JOIN artifacts a ON i.campaign_id = a.campaign_id
                AND lower(i.item_name) = lower(a.name)
            WHERE i.campaign_id = ?
            ORDER BY i.item_name
        `).all(campaignId);

        return items.map(mapInventoryWithArtifactInfo);
    },

    /**
     * Returns a single item with its artifact information
     */
    getInventoryItemWithArtifactInfo: (campaignId: number, itemName: string): InventoryWithArtifactInfo | null => {
        const item = db.prepare(`
            SELECT
                i.*,
                CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END as is_artifact,
                a.id as artifact_id,
                a.status as artifact_status,
                a.short_id as artifact_short_id,
                a.is_cursed,
                a.description as artifact_description
            FROM inventory i
            LEFT JOIN artifacts a ON i.campaign_id = a.campaign_id
                AND lower(i.item_name) = lower(a.name)
            WHERE i.campaign_id = ? AND lower(i.item_name) = lower(?)
        `).get(campaignId, itemName) as any;

        if (!item) return null;

        return mapInventoryWithArtifactInfo(item);
    },

    getInventoryItemWithArtifactInfoByShortId: (
        campaignId: number,
        shortId: string,
    ): InventoryWithArtifactInfo | null => {
        const cleanId = shortId.trim().replace(/^#/, '').toLowerCase();
        const item = db.prepare(`
            SELECT
                i.*,
                CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END as is_artifact,
                a.id as artifact_id,
                a.status as artifact_status,
                a.short_id as artifact_short_id,
                a.is_cursed,
                a.description as artifact_description
            FROM inventory i
            LEFT JOIN artifacts a ON i.campaign_id = a.campaign_id
                AND lower(i.item_name) = lower(a.name)
            WHERE i.campaign_id = ? AND lower(i.short_id) = ?
            LIMIT 1
        `).get(campaignId, cleanId);

        return item ? mapInventoryWithArtifactInfo(item) : null;
    },
};
