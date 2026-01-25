import { db } from '../client';
import { InventoryItem } from '../types';

export const inventoryRepository = {
    addLoot: (campaignId: number, itemName: string, qty: number = 1, sessionId?: string, description?: string) => {
        // Normalizing name
        const cleanName = itemName.trim();

        // Check if exists
        const existing = db.prepare('SELECT id, quantity, description FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)')
            .get(campaignId, cleanName) as { id: number, quantity: number, description: string | null } | undefined;

        if (existing) {
            const finalDesc = description ? (existing.description ? existing.description + '\n' + description : description) : existing.description;
            // Legacy Parity: Update session_id to current one if provided (or keep existing if null, but usually we want to track latest touch or first? Legacy used COALESCE(session_id, ?), implying keep original if set? Or set if null?)
            // Legacy: session_id = COALESCE(session_id, ?)
            // This means: if session_id is NULL, set it to new one. If it IS set, KEEP it (track origin).
            db.prepare('UPDATE inventory SET quantity = quantity + ?, last_updated = ?, description = ?, session_id = COALESCE(session_id, ?) WHERE id = ?')
                .run(qty, Date.now(), finalDesc, sessionId || null, existing.id);
        } else {
            db.prepare('INSERT INTO inventory (campaign_id, item_name, quantity, acquired_at, last_updated, session_id, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(campaignId, cleanName, qty, Date.now(), Date.now(), sessionId || null, description || null);
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
                db.prepare('UPDATE inventory SET quantity = ?, last_updated = ? WHERE id = ?')
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

    addInventoryEvent: (campaignId: number, itemName: string, sessionId: string, description: string, type: string) => {
        db.prepare(`
            INSERT INTO inventory_history (campaign_id, item_name, session_id, description, event_type, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(campaignId, itemName, sessionId, description, type, Date.now());
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
    }
};
