import { db } from '../client';
import { InventoryItem } from '../types';
import { generateShortId } from '../utils/idGenerator';

export const inventoryRepository = {
    addLoot: (campaignId: number, itemName: string, qty: number = 1, sessionId?: string, description?: string, isManual: boolean = false, timestamp?: number) => {
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
                    is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END
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
            db.prepare(`
                INSERT INTO inventory (campaign_id, item_name, quantity, acquired_at, last_updated, session_id, description, rag_sync_needed, is_manual, short_id) 
                VALUES ($campaignId, $name, $qty, $timestamp, $timestamp, $sessionId, $desc, 1, $isManual, $shortId)
            `).run({
                campaignId,
                name: cleanName,
                qty,
                timestamp: timestamp || Date.now(),
                sessionId: sessionId || null,
                desc: description || null,
                isManual: isManual ? 1 : 0,
                shortId
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

    deleteInventoryHistory: (campaignId: number, itemName: string): boolean => {
        const result = db.prepare('DELETE FROM inventory_history WHERE campaign_id = ? AND lower(item_name) = lower(?)').run(campaignId, itemName);
        return result.changes > 0;
    },

    getInventory: (campaignId: number, limit: number = 20, offset: number = 0): InventoryItem[] => {
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? AND quantity > 0 ORDER BY item_name LIMIT ? OFFSET ?').all(campaignId, limit, offset) as InventoryItem[];
    },

    countInventory: (campaignId: number): number => {
        const result = db.prepare('SELECT COUNT(*) as count FROM inventory WHERE campaign_id = ? AND quantity > 0').get(campaignId) as { count: number };
        return result.count;
    },

    getSessionInventory: (sessionId: string): any[] => {
        return db.prepare('SELECT * FROM inventory WHERE session_id = ?').all(sessionId);
    },

    listAllInventory: (campaignId: number): InventoryItem[] => {
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? ORDER BY item_name').all(campaignId) as InventoryItem[];
    },

    getInventoryItemByName: (campaignId: number, itemName: string): InventoryItem | null => {
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)').get(campaignId, itemName) as InventoryItem | null;
    },

    getInventoryItemByShortId: (campaignId: number, shortId: string): InventoryItem | null => {
        const cleanId = shortId.startsWith('#') ? shortId.substring(1) : shortId;
        return db.prepare('SELECT * FROM inventory WHERE campaign_id = ? AND short_id = ?').get(campaignId, cleanId) as InventoryItem | null;
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

                db.prepare(`
                    UPDATE inventory 
                    SET quantity = ?, description = ?, notes = ?, last_updated = ?, rag_sync_needed = 1
                    WHERE id = ?
                `).run(totalQty, newDesc.trim() || null, newNotes.trim() || null, Date.now(), target.id);

                db.prepare('DELETE FROM inventory WHERE id = ?').run(source.id);
            } else {
                // Rename
                db.prepare('UPDATE inventory SET item_name = ?, last_updated = ?, rag_sync_needed = 1 WHERE id = ?')
                    .run(newName, Date.now(), source.id);
            }
        })();

        console.log(`[Inventory] 🔀 Merged: ${oldName} -> ${newName}`);
        return true;
    },

    addInventoryEvent: (campaignId: number, itemName: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        db.prepare(`
            INSERT INTO inventory_history (campaign_id, item_name, session_id, description, event_type, timestamp, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, itemName, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0);
    },

    getInventoryHistory: (campaignId: number, itemName: string): any[] => {
        return db.prepare(`
            SELECT * FROM inventory_history 
            WHERE campaign_id = ? AND lower(item_name) = lower(?)
            ORDER BY timestamp ASC
        `).all(campaignId, itemName);
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

        db.prepare(`UPDATE inventory SET ${updates.join(', ')} WHERE id = $id`).run(params);
        return true;
    }
};
