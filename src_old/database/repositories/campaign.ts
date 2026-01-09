import { db } from '../connection';
import { Campaign, LocationState, CampaignSnapshot } from '../types';
import { getCampaignCharacters } from './character';

export const createCampaign = (guildId: string, name: string): number => {
    const info = db.prepare('INSERT INTO campaigns (guild_id, name, created_at) VALUES (?, ?, ?)').run(guildId, name, Date.now());
    return info.lastInsertRowid as number;
};

export const getCampaigns = (guildId: string): Campaign[] => {
    return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) as Campaign[];
};

export const getActiveCampaign = (guildId: string): Campaign | undefined => {
    return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? AND is_active = 1').get(guildId) as Campaign | undefined;
};

export const setActiveCampaign = (guildId: string, campaignId: number): void => {
    db.transaction(() => {
        db.prepare('UPDATE campaigns SET is_active = 0 WHERE guild_id = ?').run(guildId);
        db.prepare('UPDATE campaigns SET is_active = 1 WHERE id = ? AND guild_id = ?').run(campaignId, guildId);
    })();
};

export const updateCampaignLocation = (guildId: string, location: string): void => {
    const campaign = getActiveCampaign(guildId);
    if (campaign) {
        db.transaction(() => {
            db.prepare('UPDATE campaigns SET current_location = ? WHERE id = ?').run(location, campaign.id);
            db.prepare('INSERT INTO location_history (campaign_id, location, timestamp) VALUES (?, ?, ?)').run(campaign.id, location, Date.now());
        })();
    }
};

export const setCampaignYear = (campaignId: number, year: number): void => {
    db.prepare('UPDATE campaigns SET current_year = ? WHERE id = ?').run(year, campaignId);
    console.log(`[DB] 📅 Anno campagna ${campaignId} impostato a: ${year}`);
};

export const getCampaignById = (id: number): Campaign | undefined => {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined;
};

export const deleteCampaign = (campaignId: number) => {
    // 1. Trova sessioni
    const sessions = db.prepare('SELECT session_id FROM sessions WHERE campaign_id = ?').all(campaignId) as { session_id: string }[];

    // 2. Elimina registrazioni e sessioni
    const deleteRec = db.prepare('DELETE FROM recordings WHERE session_id = ?');
    const deleteSess = db.prepare('DELETE FROM sessions WHERE session_id = ?');
    const deleteNotes = db.prepare('DELETE FROM session_notes WHERE session_id = ?');

    for (const s of sessions) {
        deleteRec.run(s.session_id);
        deleteNotes.run(s.session_id);
        deleteSess.run(s.session_id);
    }

    // --- NUOVO: PULIZIA MANUALE TABELLE ORFANE ---
    db.prepare('DELETE FROM location_atlas WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM location_history WHERE campaign_id = ?').run(campaignId);
    try { db.prepare('DELETE FROM npc_dossier WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM quests WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM inventory WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM character_history WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM npc_history WHERE campaign_id = ?').run(campaignId); } catch(e) {}
    try { db.prepare('DELETE FROM world_history WHERE campaign_id = ?').run(campaignId); } catch(e) {}

    // 3. Elimina campagna (Cascade farà il resto per characters e knowledge, ma meglio essere sicuri sopra)
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);

    console.log(`[DB] Campagna ${campaignId} e tutti i dati correlati (Atlante, Storia, NPC, Quest, Loot) eliminati.`);
};

// --- NUOVE FUNZIONI LUOGO (MACRO/MICRO) ---

export const updateLocation = (campaignId: number, macro: string | null, micro: string | null, sessionId?: string): void => {
    // 1. Aggiorna lo stato corrente della campagna
    const current = getCampaignLocationById(campaignId);

    // Se è identico, non facciamo nulla (evita spam nella history)
    if (current && current.macro === macro && current.micro === micro) return;

    const stmt = db.prepare(`
        UPDATE campaigns 
        SET current_macro_location = COALESCE(?, current_macro_location), 
            current_micro_location = ? 
        WHERE id = ?
    `);
    // Nota: Micro può essere resettato, Macro tendiamo a mantenerlo se non specificato
    stmt.run(macro, micro, campaignId);

    // 2. Aggiungi alla cronologia
    let legacyLocation = "Sconosciuto";
    if (macro && micro) legacyLocation = `${macro} | ${micro}`;
    else if (macro) legacyLocation = macro;
    else if (micro) legacyLocation = micro;

    const historyStmt = db.prepare(`
        INSERT INTO location_history (campaign_id, location, macro_location, micro_location, session_date, timestamp, session_id)
        VALUES (?, ?, ?, ?, date('now'), ?, ?)
    `);
    historyStmt.run(campaignId, legacyLocation, macro, micro, Date.now(), sessionId || null);

    console.log(`[DB] 🗺️ Luogo aggiornato: [${macro}] - (${micro})`);
};

export const getCampaignLocation = (guildId: string): LocationState | null => {
    const row = db.prepare(`
        SELECT current_macro_location as macro, current_micro_location as micro 
        FROM campaigns 
        WHERE guild_id = ? AND is_active = 1
    `).get(guildId) as LocationState | undefined;
    return row || null;
};

export const getCampaignLocationById = (campaignId: number): LocationState | null => {
    const row = db.prepare(`
        SELECT current_macro_location as macro, current_micro_location as micro 
        FROM campaigns 
        WHERE id = ?
    `).get(campaignId) as LocationState | undefined;
    return row || null;
};

export const getLocationHistory = (guildId: string) => {
    return db.prepare(`
        SELECT h.macro_location, h.micro_location, h.timestamp, h.session_date 
        FROM location_history h
        JOIN campaigns c ON h.campaign_id = c.id
        WHERE c.guild_id = ? AND c.is_active = 1
        ORDER BY h.timestamp DESC
        LIMIT 20
    `).all(guildId);
};

// --- FUNZIONI ATLANTE (MEMORIA LUOGHI) ---

export const getAtlasEntry = (campaignId: number, macro: string, micro: string): string | null => {
    // Normalizziamo le stringhe per evitare duplicati "Taverna" vs "taverna"
    const row = db.prepare(`
        SELECT description FROM location_atlas 
        WHERE campaign_id = ? 
        AND lower(macro_location) = lower(?) 
        AND lower(micro_location) = lower(?)
    `).get(campaignId, macro, micro) as { description: string } | undefined;

    return row ? row.description : null;
};

export const updateAtlasEntry = (campaignId: number, macro: string, micro: string, newDescription: string) => {
    // Sanitize: Force string if object is passed (AI hallucination fix)
    const safeDesc = (typeof newDescription === 'object') ? JSON.stringify(newDescription) : String(newDescription);

    // Upsert: Inserisci o Aggiorna se esiste
    db.prepare(`
        INSERT INTO location_atlas (campaign_id, macro_location, micro_location, description, last_updated)
        VALUES ($campaignId, $macro, $micro, $desc, CURRENT_TIMESTAMP)
        ON CONFLICT(campaign_id, macro_location, micro_location) 
        DO UPDATE SET description = $desc, last_updated = CURRENT_TIMESTAMP
    `).run({ campaignId, macro, micro, desc: safeDesc });

    console.log(`[Atlas] 📖 Aggiornata voce per: ${macro} - ${micro}`);
};

// --- FUNZIONI SNAPSHOT (TOTAL RECALL) ---

export const getCampaignSnapshot = (campaignId: number): CampaignSnapshot => {
    // 1. Recupera i Personaggi
    const characters = getCampaignCharacters(campaignId);
    const pc_context = characters.map(c => `- ${c.character_name} (${c.class})`).join('\n');

    // 2. Recupera le Quest aperte
    const quests = db.prepare(`SELECT title FROM quests WHERE campaign_id = ? AND status = 'OPEN'`).all(campaignId) as any[];
    const quest_context = quests.map(q => q.title).join(', ');

    // 3. Recupera Luogo e descrizione Atlante
    const locRow = db.prepare(`SELECT current_macro_location as macro, current_micro_location as micro FROM campaigns WHERE id = ?`).get(campaignId) as any;

    let atlasDesc = null;
    let location_context = "Sconosciuto.";

    if (locRow) {
        const atlas = db.prepare(`SELECT description FROM location_atlas WHERE campaign_id = ? AND macro_location = ? AND micro_location = ?`)
            .get(campaignId, locRow.macro, locRow.micro) as any;
        atlasDesc = atlas?.description || null;
        location_context = `${locRow.macro || '?'} - ${locRow.micro || '?'}`;
    }

    return {
        characters,
        quests,
        location: locRow ? { macro: locRow.macro, micro: locRow.micro } : null,
        atlasDesc,
        pc_context,
        quest_context,
        location_context
    };
};
