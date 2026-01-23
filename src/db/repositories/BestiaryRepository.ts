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
        details?: MonsterDetails
    ): void => {
        // Sanitize
        const safeDesc = details?.description ?
            ((typeof details.description === 'object') ? JSON.stringify(details.description) : String(details.description))
            : null;

        const safeAbilities = details?.abilities ? JSON.stringify(details.abilities) : null;
        const safeWeaknesses = details?.weaknesses ? JSON.stringify(details.weaknesses) : null;
        const safeResistances = details?.resistances ? JSON.stringify(details.resistances) : null;
        const safeNotes = details?.notes ? String(details.notes) : null;

        // Logica Upsert Complessa:
        // Se non esiste, inserisci.
        // Se esiste, aggiorna solo se i nuovi valori sono "migliori" o aggiuntivi? 
        // Per ora facciamo overwrite dei campi non-nulli e COALESCE per mantenere i vecchi.

        /*
           Nota: unique index idx_bestiary_unique ON bestiary(campaign_id, name, session_id) 
           Questo indice include session_id. Quindi possiamo avere lo stesso mostro in sessioni diverse!
           È corretto? Sì, vogliamo tracciare che "Goblin" sono stati visti in Sessione 1 e Sessione 5.
           MA `listMonsters` raggruppa? No.
           Se vogliamo un "Global Entry" per il mostro, forse dovremmo avere session_id NULL?
           
           Se sessionId è fornito, stiamo registrando un INCONTRO specifico.
           Se vogliamo aggiornare il "template" globale del mostro, forse dovremmo usare una logica diversa.
           
           Per ora seguiamo la logica originale:
           Se session_id C'È, inseriamo un record specifico per quella sessione (o lo aggiorniamo).
        */

        db.prepare(`
            INSERT INTO bestiary (
                campaign_id, name, status, count, session_id, last_seen,
                description, abilities, weaknesses, resistances, notes, first_session_id
            )
            VALUES (
                $campaignId, $name, $status, $count, $sessionId, $timestamp,
                $desc, $abil, $weak, $res, $notes, $sessionId
            )
            ON CONFLICT(campaign_id, name, session_id) WHERE session_id IS NOT NULL
            DO UPDATE SET 
                status = $status,
                count = COALESCE($count, count),
                last_seen = $timestamp,
                description = COALESCE($desc, description),
                abilities = COALESCE($abil, abilities),
                weaknesses = COALESCE($weak, weaknesses),
                resistances = COALESCE($res, resistances),
                notes = COALESCE($notes, notes)
        `).run({
            campaignId,
            name,
            status,
            count: count || null,
            sessionId: sessionId || null,
            timestamp: Date.now(),
            desc: safeDesc,
            abil: safeAbilities,
            weak: safeWeaknesses,
            res: safeResistances,
            notes: safeNotes
        });

        console.log(`[Bestiary] 👹 Mostro tracciato: ${name} (Session: ${sessionId})`);
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
    }
};
