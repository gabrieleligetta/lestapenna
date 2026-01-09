import { db } from '../connection';
import { UserProfile, NpcEntry, Quest, InventoryItem } from '../types';
import { getCampaignById } from './campaign';

// --- FUNZIONI PERSONAGGI (CONTEXT AWARE) ---

export const getUserProfile = (userId: string, campaignId: number): UserProfile => {
    const row = db.prepare('SELECT character_name, race, class, description FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId) as UserProfile | undefined;
    return row || { character_name: null, race: null, class: null, description: null };
};

export const getUserName = (userId: string, campaignId: number): string | null => {
    const p = getUserProfile(userId, campaignId);
    return p.character_name;
};

export const getCampaignCharacters = (campaignId: number): UserProfile[] & { user_id: string }[] => {
    return db.prepare('SELECT user_id, character_name, race, class, description FROM characters WHERE campaign_id = ?').all(campaignId) as UserProfile[] & { user_id: string }[];
};

export const updateUserCharacter = (userId: string, campaignId: number, field: 'character_name' | 'race' | 'class' | 'description', value: string): void => {
    const exists = db.prepare('SELECT 1 FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaignId);

    if (exists) {
        db.prepare(`UPDATE characters SET ${field} = ? WHERE user_id = ? AND campaign_id = ?`).run(value, userId, campaignId);
    } else {
        db.prepare('INSERT INTO characters (user_id, campaign_id) VALUES (?, ?)').run(userId, campaignId);
        db.prepare(`UPDATE characters SET ${field} = ? WHERE user_id = ? AND campaign_id = ?`).run(value, userId, campaignId);
    }
};

export const deleteUserCharacter = (userId: string, campaignId: number) => {
    db.prepare('DELETE FROM characters WHERE user_id = ? AND campaign_id = ?').run(userId, campaignId);
};

// --- FUNZIONI DOSSIER NPC ---

export const updateNpcEntry = (campaignId: number, name: string, description: string, role?: string, status?: string) => {
    // Sanitize: Force string if object is passed
    const safeDesc = (typeof description === 'object') ? JSON.stringify(description) : String(description);

    // Upsert intelligente
    db.prepare(`
        INSERT INTO npc_dossier (campaign_id, name, description, role, status, last_updated)
        VALUES ($campaignId, $name, $description, $role, $status, CURRENT_TIMESTAMP)
        ON CONFLICT(campaign_id, name) 
        DO UPDATE SET 
            description = CASE WHEN $description IS NOT NULL THEN $description ELSE description END,
            role = CASE WHEN $role IS NOT NULL THEN $role ELSE role END,
            status = CASE WHEN $status IS NOT NULL THEN $status ELSE status END,
            last_updated = CURRENT_TIMESTAMP
    `).run({ campaignId, name, description: safeDesc, role: role || null, status: status || null });

    console.log(`[Dossier] 👤 Aggiornato NPC: ${name}`);
};

export const getNpcEntry = (campaignId: number, name: string): NpcEntry | undefined => {
    return db.prepare(`
        SELECT * FROM npc_dossier 
        WHERE campaign_id = ? AND lower(name) = lower(?)
    `).get(campaignId, name) as NpcEntry | undefined;
};

export const listNpcs = (campaignId: number, limit: number = 10): NpcEntry[] => {
    return db.prepare(`
        SELECT * FROM npc_dossier 
        WHERE campaign_id = ? 
        ORDER BY last_updated DESC 
        LIMIT ?
    `).all(campaignId, limit) as NpcEntry[];
};

export const findNpcDossierByName = (campaignId: number, nameQuery: string): NpcEntry[] => {
    // Cerca NPC il cui nome è contenuto nella query dell'utente
    // Es. Query: "Chi è Grog?" -> Trova record con name="Grog"
    // Usiamo LIKE con % per trovare occorrenze parziali
    return db.prepare(`
        SELECT * FROM npc_dossier 
        WHERE campaign_id = ? AND ? LIKE '%' || name || '%'
    `).all(campaignId, nameQuery) as NpcEntry[];
};

// --- FUNZIONI QUESTS ---

export const addQuest = (campaignId: number, title: string) => {
    // Evitiamo duplicati identici
    const exists = db.prepare("SELECT id FROM quests WHERE campaign_id = ? AND title = ?").get(campaignId, title);
    if (!exists) {
        db.prepare("INSERT INTO quests (campaign_id, title, status, created_at, last_updated) VALUES (?, ?, 'OPEN', ?, ?)").run(campaignId, title, Date.now(), Date.now());
        console.log(`[Quest] 🗺️ Nuova quest aggiunta: ${title}`);
    }
};

export const updateQuestStatus = (campaignId: number, titlePart: string, status: 'COMPLETED' | 'FAILED' | 'OPEN') => {
    db.prepare("UPDATE quests SET status = ?, last_updated = ? WHERE campaign_id = ? AND title LIKE ?").run(status, Date.now(), campaignId, `%${titlePart}%`);
    console.log(`[Quest] 📝 Stato aggiornato a ${status} per quest simile a: ${titlePart}`);
};

export const getOpenQuests = (campaignId: number): Quest[] => {
    return db.prepare("SELECT * FROM quests WHERE campaign_id = ? AND status = 'OPEN' ORDER BY created_at DESC").all(campaignId) as Quest[];
};

// --- FUNZIONI INVENTORY ---

export const addLoot = (campaignId: number, itemName: string, qty: number = 1) => {
    // Cerca se esiste già (case insensitive)
    const existing = db.prepare("SELECT id, quantity FROM inventory WHERE campaign_id = ? AND lower(item_name) = lower(?)").get(campaignId, itemName) as {id: number, quantity: number} | undefined;

    if (existing) {
        db.prepare("UPDATE inventory SET quantity = quantity + ?, last_updated = ? WHERE id = ?").run(qty, Date.now(), existing.id);
    } else {
        db.prepare("INSERT INTO inventory (campaign_id, item_name, quantity, acquired_at, last_updated) VALUES (?, ?, ?, ?, ?)").run(campaignId, itemName, qty, Date.now(), Date.now());
    }
    console.log(`[Loot] 💰 Aggiunto: ${itemName} (x${qty})`);
};

export const removeLoot = (campaignId: number, itemName: string, qty: number = 1) => {
    const existing = db.prepare("SELECT id, quantity FROM inventory WHERE campaign_id = ? AND lower(item_name) LIKE lower(?)").get(campaignId, `%${itemName}%`) as {id: number, quantity: number} | undefined;

    if (existing) {
        const newQty = existing.quantity - qty;
        if (newQty <= 0) {
            db.prepare("DELETE FROM inventory WHERE id = ?").run(existing.id);
        } else {
            db.prepare("UPDATE inventory SET quantity = ?, last_updated = ? WHERE id = ?").run(newQty, Date.now(), existing.id);
        }
        console.log(`[Loot] 📉 Rimosso: ${itemName} (x${qty})`);
        return true;
    }
    return false;
};

export const getInventory = (campaignId: number): InventoryItem[] => {
    return db.prepare("SELECT * FROM inventory WHERE campaign_id = ? ORDER BY item_name ASC").all(campaignId) as InventoryItem[];
};

// --- FUNZIONI STORIA PERSONAGGI ---

export const addCharacterEvent = (campaignId: number, charName: string, sessionId: string, description: string, type: string) => {
    db.prepare(`
        INSERT INTO character_history (campaign_id, character_name, session_id, event_type, description, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, charName, sessionId, type, description, Date.now());
    console.log(`[Bio] 📜 Aggiunto evento per ${charName}: [${type}]`);
};

export const getCharacterHistory = (campaignId: number, charName: string): { description: string, event_type: string, session_id: string }[] => {
    // Recupera la storia in ordine cronologico (basato sull'ID inserimento che segue la cronologia sessioni)
    return db.prepare(`
        SELECT description, event_type, session_id 
        FROM character_history 
        WHERE campaign_id = ? AND lower(character_name) = lower(?)
        ORDER BY id ASC
    `).all(campaignId, charName) as any[];
};

// --- FUNZIONI STORIA NPC ---

export const addNpcEvent = (campaignId: number, npcName: string, sessionId: string, description: string, type: string) => {
    db.prepare(`
        INSERT INTO npc_history (campaign_id, npc_name, session_id, event_type, description, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, npcName, sessionId, type, description, Date.now());
    console.log(`[Bio NPC] 📜 Aggiunto evento per ${npcName}: [${type}]`);
};

export const getNpcHistory = (campaignId: number, npcName: string): { description: string, event_type: string, session_id: string }[] => {
    return db.prepare(`
        SELECT description, event_type, session_id 
        FROM npc_history 
        WHERE campaign_id = ? AND lower(npc_name) = lower(?)
        ORDER BY id ASC
    `).all(campaignId, npcName) as any[];
};

// --- FUNZIONI STORIA DEL MONDO ---

export const addWorldEvent = (campaignId: number, sessionId: string | null, description: string, type: string, year?: number) => {
    // Se l'anno non è passato, prova a prendere quello corrente della campagna
    let eventYear = year;
    if (eventYear === undefined) {
        const camp = getCampaignById(campaignId);
        eventYear = camp?.current_year || 0;
    }

    db.prepare(`
        INSERT INTO world_history (campaign_id, session_id, event_type, description, timestamp, year)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(campaignId, sessionId, type, description, Date.now(), eventYear);
    console.log(`[World] 🌍 Aggiunto evento globale: [${type}] Anno: ${eventYear}`);
};

export const getWorldTimeline = (campaignId: number): { description: string, event_type: string, session_id: string, session_number?: number, year: number }[] => {
    // Join con la tabella sessions per avere il numero sessione se disponibile
    // ORDINAMENTO PER ANNO (year)
    return db.prepare(`
        SELECT w.description, w.event_type, w.session_id, w.year, s.session_number
        FROM world_history w
        LEFT JOIN sessions s ON w.session_id = s.session_id
        WHERE w.campaign_id = ?
        ORDER BY w.year ASC, w.id ASC
    `).all(campaignId) as any[];
};
