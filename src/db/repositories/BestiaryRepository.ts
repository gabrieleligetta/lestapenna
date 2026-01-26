import { db } from '../client';
import { BestiaryEntry, MonsterDetails } from '../types';

// Helper per unire JSON arrays
const mergeJsonArrays = (json1: string | null, json2: string | null): string | null => {
    let arr1: string[] = [];
    let arr2: string[] = [];

    try { if (json1) arr1 = JSON.parse(json1); } catch (e) { }
    try { if (json2) arr2 = JSON.parse(json2); } catch (e) { }

    const set = new Set([...arr1, ...arr2]);
    return JSON.stringify(Array.from(set));
};

export const bestiaryRepository = {
    upsertMonster: (
        campaignId: number,
        name: string,
        status: string,
        count?: string,
        sessionId?: string,
        details?: MonsterDetails,
        originalName?: string,
        isManual: boolean = false,
        timestamp?: number
    ): void => {
        // Sanitize
        const safeDesc = details?.description ?
            ((typeof details.description === 'object') ? JSON.stringify(details.description) : String(details.description))
            : null;

        const safeAbilities = details?.abilities ? JSON.stringify(details.abilities) : null;
        const safeWeaknesses = details?.weaknesses ? JSON.stringify(details.weaknesses) : null;
        const safeResistances = details?.resistances ? JSON.stringify(details.resistances) : null;
        const safeNotes = details?.notes ? String(details.notes) : null;

        // Variants logic: se originalName è diverso da name, è una variante.
        // Inseriamo come array JSON ["Nome Variante"].
        let variantsJson = null;
        if (originalName && originalName.toLowerCase() !== name.toLowerCase()) {
            variantsJson = JSON.stringify([originalName]);
        }

        // Logic Upsert Globale:
        // Index: idx_bestiary_unique_global (campaign_id, name)
        // Se esiste, aggiorniamo last_seen, session_id (ultimo incontro), e mergiamo le varianti.

        db.prepare(`
            INSERT INTO bestiary (
                campaign_id, name, status, count, session_id, last_seen,
                description, abilities, weaknesses, resistances, notes, variants, first_session_id, rag_sync_needed, is_manual
            )
            VALUES (
                $campaignId, $name, $status, $count, $sessionId, $timestamp,
                $desc, $abil, $weak, $res, $notes, $variants, $sessionId, 1, $isManual
            )
            ON CONFLICT(campaign_id, name)
            DO UPDATE SET 
                status = $status,
                count = COALESCE($count, count),
                session_id = $sessionId, -- Aggiorna all'ultima sessione
                last_seen = $timestamp,
                description = COALESCE($desc, description),
                abilities = COALESCE($abil, abilities),
                weaknesses = COALESCE($weak, weaknesses),
                resistances = COALESCE($res, resistances),
                notes = COALESCE($notes, notes),
                -- Merge variants: appende la nuova variante se non esiste
                variants = CASE 
                    WHEN $variants IS NOT NULL THEN 
                        (
                            SELECT json_group_array(DISTINCT value)
                            FROM (
                                SELECT value FROM json_each(COALESCE(variants, '[]'))
                                UNION
                                SELECT value FROM json_each($variants)
                            )
                        )
                    ELSE variants
                END,
                rag_sync_needed = 1,
                is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END
        `).run({
            campaignId,
            name,
            status,
            count: count || null,
            sessionId: sessionId || null,
            timestamp: timestamp || Date.now(),
            desc: safeDesc,
            abil: safeAbilities,
            weak: safeWeaknesses,
            res: safeResistances,
            notes: safeNotes,
            variants: variantsJson,
            isManual: isManual ? 1 : 0
        });

        console.log(`[Bestiary] 👹 Mostro tracciato/aggiornato: ${name} (Var: ${originalName || '-'})`);
    },

    listAllMonsters: (campaignId: number): BestiaryEntry[] => {
        return db.prepare(`
            SELECT * FROM bestiary 
            WHERE campaign_id = ? 
            ORDER BY name ASC
        `).all(campaignId) as BestiaryEntry[];
    },

    getMonsterByName: (campaignId: number, name: string): BestiaryEntry | null => {
        // Cerca l'entrata più recente per questo mostro
        return db.prepare(`
            SELECT * FROM bestiary 
            WHERE campaign_id = ? AND lower(name) = lower(?)
            ORDER BY last_seen DESC
            LIMIT 1
        `).get(campaignId, name) as BestiaryEntry | null;
    },

    mergeMonsters: (
        campaignId: number,
        oldName: string,
        newName: string,
        mergedDescription?: string
    ): boolean => {
        const source = bestiaryRepository.getMonsterByName(campaignId, oldName);
        const target = bestiaryRepository.getMonsterByName(campaignId, newName); // Potrebbe non esistere, in tal caso rinominiamo e basta

        if (!source) return false;

        db.transaction(() => {
            // Se target esiste già, uniamo i dati nel target ed eliminiamo source
            // Ma attenzione: ci possono essere MULTIPLE righe per oldName (sessioni diverse).

            // 1. Aggiorniamo TUTTE le righe di oldName in newName
            //    Questo potrebbe causare conflitti UNIQUE se newName esiste già nella stessa sessione.

            const sources = db.prepare(`SELECT * FROM bestiary WHERE campaign_id = ? AND lower(name) = lower(?)`).all(campaignId, oldName) as BestiaryEntry[];

            for (const s of sources) {
                // Per ogni entry source, vediamo se esiste già una entry target per la stessa sessione
                const conflict = db.prepare(`
                    SELECT id, abilities, weaknesses, resistances, description, notes 
                    FROM bestiary 
                    WHERE campaign_id = ? AND lower(name) = lower(?) AND session_id = ?
                `).get(campaignId, newName, s.session_id) as BestiaryEntry | undefined;

                if (conflict) {
                    // Merge intelligente dei dati
                    const newAbil = mergeJsonArrays(conflict.abilities, s.abilities);
                    const newWeak = mergeJsonArrays(conflict.weaknesses, s.weaknesses);
                    const newRes = mergeJsonArrays(conflict.resistances, s.resistances);
                    const newDesc = mergedDescription || (conflict.description ? conflict.description : s.description);
                    const newNotes = (conflict.notes || '') + '\n' + (s.notes || '');

                    db.prepare(`
                        UPDATE bestiary 
                        SET abilities = ?, weaknesses = ?, resistances = ?, description = ?, notes = ?
                        WHERE id = ?
                    `).run(newAbil, newWeak, newRes, newDesc, newNotes, conflict.id);

                    // Elimina la source poiché fusa
                    db.prepare(`DELETE FROM bestiary WHERE id = ?`).run(s.id);
                } else {
                    // Nessun conflitto per questa sessione: rinomina semplicemente
                    db.prepare(`UPDATE bestiary SET name = ? WHERE id = ?`).run(newName, s.id);
                    // Se c'è una descrizione mergiata, usala
                    if (mergedDescription) {
                        db.prepare(`UPDATE bestiary SET description = ? WHERE id = ?`).run(mergedDescription, s.id);
                    }
                }
            }
        })();

        console.log(`[Bestiary] 🔀 Merged: ${oldName} -> ${newName}`);
        return true;
    },

    listMonsters: (campaignId: number, limit: number = 20): BestiaryEntry[] => {
        // Ritorna le entrate uniche (per nome), prendendo la più recente
        return db.prepare(`
            SELECT id, name, status, count, MAX(last_seen) as last_seen, session_id
            FROM bestiary
            WHERE campaign_id = ?
            GROUP BY name
            ORDER BY last_seen DESC
            LIMIT ?
        `).all(campaignId, limit) as BestiaryEntry[];
    },

    getSessionMonsters: (sessionId: string): BestiaryEntry[] => {
        return db.prepare(`
            SELECT * FROM bestiary WHERE session_id = ?
        `).all(sessionId) as BestiaryEntry[];
    },

    addBestiaryEvent: (campaignId: number, name: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        db.prepare(`
            INSERT INTO bestiary_history (campaign_id, monster_name, session_id, description, event_type, timestamp, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, name, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0);
    },

    getBestiaryHistory: (campaignId: number, name: string): any[] => {
        return db.prepare(`
            SELECT * FROM bestiary_history 
            WHERE campaign_id = ? AND lower(monster_name) = lower(?)
            ORDER BY timestamp ASC
        `).all(campaignId, name);
    },

    updateBestiaryDescription: (campaignId: number, name: string, description: string) => {
        // Update the main description (and sets dirty = 0 because this comes from bio generator?)
        // Actually BioGenerator usually sets dirty=1 to trigger RAG sync.
        // Let's stick to pattern: Update Desc -> Dirty=1 -> RAG Sync -> Dirty=0.
        db.prepare(`
            UPDATE bestiary 
            SET description = ?, rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).run(description, campaignId, name);
        // Note: Bestiary rows are PER SESSION in the current design (unique idx on session_id).
        // If we want a GLOBAL description, we should update ALL rows for that monster? 
        // OR we should have a "Canonical" entry with session_id = NULL?
        // The implementation plan implies a global entity.
        // Current Bestiary schema: unique per session.
        // `getMonsterByName` gets the MOST RECENT.
        // If we update description, we probably want to update the MOST RECENT one or all?
        // Let's update ALL for now to keep them consistent, or just the latest?
        // Updating all is safer for "Knowledge".
        db.prepare(`
            UPDATE bestiary 
            SET description = ?, rag_sync_needed = 1
            WHERE campaign_id = ? AND lower(name) = lower(?)
        `).run(description, campaignId, name);
    },

    markBestiaryDirty: (campaignId: number, name: string) => {
        db.prepare('UPDATE bestiary SET rag_sync_needed = 1 WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
    },

    getDirtyBestiaryEntries: (campaignId: number): BestiaryEntry[] => {
        // Group by name to avoid duplicates
        return db.prepare('SELECT * FROM bestiary WHERE campaign_id = ? AND rag_sync_needed = 1 GROUP BY name').all(campaignId) as BestiaryEntry[];
    },

    clearBestiaryDirtyFlag: (campaignId: number, name: string) => {
        db.prepare('UPDATE bestiary SET rag_sync_needed = 0 WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
    }
};
