import { db } from '../client';
import { getByShortId, resolveEntityId, getHistoryByEntity, listEntities, countEntities, ListOptions } from './shared';
import { BestiaryEntry, MonsterDetails } from '../types';
import { generateShortId } from '../utils/idGenerator';

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

        // Variants logic: when originalName differs from name, it is a variant.
        // We store it as a JSON array ["Variant Name"].
        let variantsJson = null;
        if (originalName && originalName.toLowerCase() !== name.toLowerCase()) {
            variantsJson = JSON.stringify([originalName]);
        }

        // Check if exists to determine if we need a new short_id
        const existing = bestiaryRepository.getMonsterByName(campaignId, name);
        const shortId = existing?.short_id || generateShortId('bestiary');

        db.prepare(`
            INSERT INTO bestiary (
                campaign_id, name, status, session_id, last_seen,
                description, abilities, weaknesses, resistances, notes, variants, first_session_id, rag_sync_needed, is_manual, short_id, manual_description
            )
            VALUES (
                $campaignId, $name, $status, $sessionId, $timestamp,
                $desc, $abil, $weak, $res, $notes, $variants, $sessionId, 1, $isManual, $shortId, CASE WHEN $isManual = 1 THEN $desc ELSE NULL END
            )
            ON CONFLICT(campaign_id, name)
            DO UPDATE SET
                status = $status,
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
                is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END,
                manual_description = CASE WHEN $isManual = 1 THEN $desc ELSE manual_description END
        `).run({
            campaignId,
            name,
            status,
            sessionId: sessionId || null,
            timestamp: timestamp || Date.now(),
            desc: safeDesc,
            abil: safeAbilities,
            weak: safeWeaknesses,
            res: safeResistances,
            notes: safeNotes,
            variants: variantsJson,
            isManual: isManual ? 1 : 0,
            shortId
        });

        const variantInfo = (originalName && originalName.toLowerCase() !== name.toLowerCase())
            ? ` (Var: ${originalName})`
            : '';
        console.log(`[Bestiary] 👹 Mostro tracciato/aggiornato: ${name}${variantInfo} [#${shortId}]`);
    },

    listAllMonsters: (campaignId: number): BestiaryEntry[] => {
        return db.prepare(`
            SELECT * FROM bestiary 
            WHERE campaign_id = ? 
            ORDER BY name ASC
        `).all(campaignId) as BestiaryEntry[];
    },

    getMonsterByName: (campaignId: number, name: string): BestiaryEntry | null => {
        // Look for the most recent entry for this monster
        return db.prepare(`
            SELECT * FROM bestiary 
            WHERE campaign_id = ? AND lower(name) = lower(?)
            ORDER BY last_seen DESC
            LIMIT 1
        `).get(campaignId, name) as BestiaryEntry | null;
    },

    getMonsterByShortId: (campaignId: number, shortId: string): BestiaryEntry | null =>
        getByShortId<BestiaryEntry>('bestiary', campaignId, shortId, { orderBy: 'last_seen DESC' }),

    mergeMonsters: (
        campaignId: number,
        oldName: string,
        newName: string,
        mergedDescription?: string
    ): boolean => {
        const source = bestiaryRepository.getMonsterByName(campaignId, oldName);
        const target = bestiaryRepository.getMonsterByName(campaignId, newName); // It may not exist, in which case we simply rename

        if (!source) return false;

        db.transaction(() => {
            // If the target already exists, merge the data into it and delete the source
            // But careful: there can be MULTIPLE rows for oldName (different sessions).

            // 1. Rename ALL rows of oldName to newName
            //    This may cause UNIQUE conflicts if newName already exists in the same session.

            const sources = db.prepare(`SELECT * FROM bestiary WHERE campaign_id = ? AND lower(name) = lower(?)`).all(campaignId, oldName) as BestiaryEntry[];
            const sourceIds = sources.map(s => s.id);

            for (const s of sources) {
                // For each source entry, check whether a target entry already exists for the same session
                const conflict = db.prepare(`
                    SELECT id, abilities, weaknesses, resistances, description, notes 
                    FROM bestiary 
                    WHERE campaign_id = ? AND lower(name) = lower(?) AND session_id = ?
                `).get(campaignId, newName, s.session_id) as BestiaryEntry | undefined;

                if (conflict) {
                    // Smart merge of the data
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

                    // Delete the source, now merged
                    db.prepare(`DELETE FROM bestiary WHERE id = ?`).run(s.id);
                } else {
                    // No conflict for this session: simply rename
                    db.prepare(`UPDATE bestiary SET name = ? WHERE id = ?`).run(newName, s.id);
                    // If there is a merged description, use it
                    if (mergedDescription) {
                        db.prepare(`UPDATE bestiary SET description = ? WHERE id = ?`).run(mergedDescription, s.id);
                    }
                }
            }

            // Move history (name + entity_id → the target's canonical id, the way
            // getHistoryByEntity will resolve it; also covers the ids of deleted sources)
            const targetId = resolveEntityId('bestiary', 'name', campaignId, newName);
            const idPlaceholders = sourceIds.map(() => '?').join(',');
            db.prepare(`
                UPDATE bestiary_history
                SET monster_name = ?, entity_id = ?
                WHERE campaign_id = ?
                  AND (entity_id IN (${idPlaceholders || 'NULL'})
                       OR (entity_id IS NULL AND lower(monster_name) = lower(?)))
            `).run(newName, targetId, campaignId, ...sourceIds, oldName);
        })();

        console.log(`[Bestiary] 🔀 Merged: ${oldName} -> ${newName}`);
        return true;
    },

    // Returns the unique entries (by name), taking the most recent one.
    // The GROUP BY name must be passed to the count as well, otherwise the total counts
    // duplicate rows and pagination promises pages that do not exist.
    listMonsters: (campaignId: number, limit: number = 20, offset: number = 0, opts: ListOptions = {}): BestiaryEntry[] =>
        listEntities<BestiaryEntry>(
            'bestiary',
            'id, short_id, name, status, MAX(last_seen) as last_seen, session_id',
            campaignId,
            'last_seen DESC',
            { limit, offset, ...opts },
            'name',
        ),

    // GROUP BY name, matching listMonsters: counting rows instead of distinct
    // names would promise pages of duplicates that the list never returns.
    countMonsters: (campaignId: number, opts: ListOptions = {}): number =>
        countEntities('bestiary', campaignId, opts, 'name'),

    getSessionMonsters: (sessionId: string): BestiaryEntry[] => {
        return db.prepare(`
            SELECT * FROM bestiary WHERE session_id = ?
        `).all(sessionId) as BestiaryEntry[];
    },

    addBestiaryEvent: (campaignId: number, name: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        const entityId = resolveEntityId('bestiary', 'name', campaignId, name);
        db.prepare(`
            INSERT INTO bestiary_history (campaign_id, monster_name, session_id, description, event_type, timestamp, is_manual, entity_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, name, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0, entityId);
    },

    getBestiaryHistory: (campaignId: number, name: string): any[] => {
        return getHistoryByEntity('bestiary_history', 'monster_name', 'bestiary', 'name', campaignId, name);
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
    },

    deleteMonster: (campaignId: number, name: string): boolean => {
        const res = db.prepare('DELETE FROM bestiary WHERE campaign_id = ? AND lower(name) = lower(?)').run(campaignId, name);
        // Also delete history?
        if (res.changes > 0) {
            db.prepare('DELETE FROM bestiary_history WHERE campaign_id = ? AND lower(monster_name) = lower(?)').run(campaignId, name);
        }
        return res.changes > 0;
    },

    updateBestiaryFields: (
        campaignId: number,
        name: string,
        fields: Partial<{
            status: string;
            description: string;
            abilities: string[];
            weaknesses: string[];
            resistances: string[];
            notes: string;
            name: string;
        }>,
        isManual: boolean = false
    ): boolean => {
        const monster = bestiaryRepository.getMonsterByName(campaignId, name);
        if (!monster) return false;

        const updates: string[] = [];
        const params: any = { id: monster.id };

        if (fields.status !== undefined) {
            updates.push('status = $status');
            params.status = fields.status;
        }
        if (fields.description !== undefined) {
            updates.push('description = $description');
            params.description = fields.description;
        }
        if (fields.abilities !== undefined) {
            updates.push('abilities = $abilities');
            params.abilities = JSON.stringify(fields.abilities);
        }
        if (fields.weaknesses !== undefined) {
            updates.push('weaknesses = $weaknesses');
            params.weaknesses = JSON.stringify(fields.weaknesses);
        }
        if (fields.resistances !== undefined) {
            updates.push('resistances = $resistances');
            params.resistances = JSON.stringify(fields.resistances);
        }
        if (fields.notes !== undefined) {
            updates.push('notes = $notes');
            params.notes = fields.notes;
        }
        if (fields.name !== undefined) {
            updates.push('name = $newName');
            params.newName = fields.name;
        }

        if (updates.length === 0) return false;

        updates.push('rag_sync_needed = 1');
        updates.push('last_seen = $timestamp');
        params.timestamp = Date.now();
        if (isManual) updates.push('is_manual = 1');

        if (fields.description && isManual) {
            updates.push('manual_description = $description');
        }

        // Note: this updates the MOST RECENT entry found by getMonsterByName if they are per session.
        // In this system, bestiary entries are somewhat per-session but grouped.
        db.prepare(`UPDATE bestiary SET ${updates.join(', ')} WHERE id = $id`).run(params);
        return true;
    }
};
