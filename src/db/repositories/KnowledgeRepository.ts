import { db } from '../client';
import { KnowledgeFragment } from '../types';

export const knowledgeRepository = {
    insertKnowledgeFragment: (
        campaignId: number,
        sessionId: string,
        content: string,
        embedding: number[],
        model: string,
        startTimestamp: number = 0,
        macro: string | null = null,
        micro: string | null = null,
        npcs: string[] = [],
        entityRefs: string[] = [] // 🆕 Entity Refs (es. ["npc:1", "npc:2", "pc:5"])
    ) => {
        const embeddingJson = JSON.stringify(embedding);
        const npcsJson = npcs.length > 0 ? JSON.stringify(npcs) : null;
        const entityRefsStr = entityRefs.length > 0 ? entityRefs.join(',') : null;

        db.prepare(`
            INSERT INTO knowledge_fragments (
                campaign_id, session_id, content, embedding_json, embedding_model, 
                vector_dimension, start_timestamp, created_at,
                macro_location, micro_location, associated_npcs, associated_entity_ids
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            campaignId, sessionId, content, embeddingJson, model,
            embedding.length, startTimestamp, Date.now(),
            macro, micro, npcsJson, entityRefsStr
        );
    },

    getKnowledgeFragments: (campaignId: number, model: string): KnowledgeFragment[] => {
        return db.prepare(`
            SELECT * FROM knowledge_fragments 
            WHERE campaign_id = ? AND embedding_model = ?
        `).all(campaignId, model) as KnowledgeFragment[];
    },

    deleteSessionKnowledge: (sessionId: string, model: string) => {
        db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ? AND embedding_model = ?').run(sessionId, model);
    },

    migrateKnowledgeFragments: (campaignId: number, oldName: string, newName: string) => {
        // Find fragments that mention oldName in `associated_npcs` (JSON)
        // Using LIKE is an approximation, so we filter in JS
        const rows = db.prepare(`
            SELECT id, associated_npcs FROM knowledge_fragments 
            WHERE campaign_id = ? AND associated_npcs LIKE ?
        `).all(campaignId, `%${oldName}%`) as { id: number, associated_npcs: string }[];

        db.transaction(() => {
            for (const row of rows) {
                try {
                    let npcs = JSON.parse(row.associated_npcs);
                    if (Array.isArray(npcs) && npcs.includes(oldName)) {
                        npcs = npcs.map((n: string) => n === oldName ? newName : n);
                        // Deduplicate (in case newName already existed)
                        npcs = Array.from(new Set(npcs));

                        db.prepare('UPDATE knowledge_fragments SET associated_npcs = ? WHERE id = ?')
                            .run(JSON.stringify(npcs), row.id);
                    }
                } catch (e) {
                    console.error(`[Knowledge] Failed to migrate fragment ${row.id}`, e);
                }
            }
        })();
    },

    migrateRagNpcReferences: (campaignId: number, oldNpcId: number, newNpcId: number): number => {
        // Cerca sia nel nuovo formato (npc:ID) che nel vecchio (ID numerico)
        const oldRef = `npc:${oldNpcId}`;
        const newRef = `npc:${newNpcId}`; // Hardcoded logic for createEntityRef to avoid circular dependency loop if imported

        const fragments = db.prepare(`
            SELECT id, associated_npc_ids, associated_entity_ids FROM knowledge_fragments
            WHERE campaign_id = ? AND (
                associated_entity_ids LIKE '%${oldRef}%' OR
                associated_npc_ids LIKE '%${oldNpcId}%'
            )
        `).all(campaignId) as { id: number; associated_npc_ids: string | null; associated_entity_ids: string | null }[];

        let migrated = 0;
        const updateStmt = db.prepare(`UPDATE knowledge_fragments SET associated_npc_ids = ?, associated_entity_ids = ? WHERE id = ?`);

        for (const f of fragments) {
            let updatedEntityIds = f.associated_entity_ids;
            let updatedNpcIds = f.associated_npc_ids;

            // Aggiorna entity refs (nuovo formato)
            if (f.associated_entity_ids) {
                updatedEntityIds = f.associated_entity_ids
                    .split(',')
                    .map(ref => ref.trim() === oldRef ? newRef : ref.trim())
                    .filter((v, i, a) => a.indexOf(v) === i) // Rimuovi duplicati
                    .join(',');
            }

            // Aggiorna legacy npc_ids (retrocompatibilità)
            if (f.associated_npc_ids) {
                const ids = f.associated_npc_ids.split(',').map(id => parseInt(id.trim()));
                const updatedIds = ids.map(id => id === oldNpcId ? newNpcId : id);
                const uniqueIds = Array.from(new Set(updatedIds));
                updatedNpcIds = uniqueIds.join(',');
            }

            updateStmt.run(updatedNpcIds, updatedEntityIds, f.id);
            migrated++;
        }

        console.log(`[RAG] 🔄 Migrati ${migrated} frammenti da NPC #${oldNpcId} (${oldRef}) a #${newNpcId} (${newRef})`);
        return migrated;
    },

    deleteNpcRagSummary: (campaignId: number, npcName: string) => {
        // Delete previous RAG summary for this NPC
        // Filter by macro/micro to target only dossier updates
        const rows = db.prepare(`
            SELECT id, associated_npcs 
            FROM knowledge_fragments 
            WHERE campaign_id = ? 
            AND session_id = 'DOSSIER_UPDATE'
        `).all(campaignId) as { id: number, associated_npcs: string }[];

        for (const row of rows) {
            try {
                const npcs = JSON.parse(row.associated_npcs);
                if (Array.isArray(npcs) && npcs.includes(npcName)) {
                    db.prepare('DELETE FROM knowledge_fragments WHERE id = ?').run(row.id);
                }
            } catch (e) { }
        }
    },

    deleteAtlasRagSummary: (campaignId: number, macro: string, micro: string) => {
        // Delete previous RAG summary for this Location
        // Identify by session_id='ATLAS_UPDATE' and location fields
        db.prepare(`
            DELETE FROM knowledge_fragments 
            WHERE campaign_id = ? 
            AND session_id = 'ATLAS_UPDATE'
            AND macro_location = ?
            AND micro_location = ?
        `).run(campaignId, macro, micro);
    },

    deleteQuestRagSummary: (campaignId: number, title: string) => {
        // Identify by session_id='QUEST_UPDATE' and check content or title match if stored
        // Currently we store bio in content. We might need a better way to target.
        // But wait, generateBio for QUEST uses 'QUEST_UPDATE'.
        // We can check `associated_entity_ids` if we used it, or `associated_npcs` (probably not).
        // For now, let's assume we can filter by session_id='QUEST_UPDATE' and content LIKE title? 
        // Or better: we rely on how we insert them.

        // Actually, `generateBio` inserts with session_id = 'QUEST_UPDATE'.
        // But we don't strictly link it to the quest title column (there isn't one in knowledge).
        // We probably put the title in the content. 
        // Let's use a LIKE query on content as a fallback, 
        // OR better: Start using `associated_entity_ids` for these in the future.
        // For now, let's look for fragments where session_id='QUEST_UPDATE' and content starts with "**Quest: {title}**" or similar.
        // Assuming standard bio format.

        // Safer approach if we don't have IDs: 
        // Select all QUEST_UPDATE, check if content includes title.
        const rows = db.prepare(`
            SELECT id, content FROM knowledge_fragments 
            WHERE campaign_id = ? AND session_id = 'QUEST_UPDATE'
        `).all(campaignId) as { id: number, content: string }[];

        for (const row of rows) {
            if (row.content.includes(title)) {
                db.prepare('DELETE FROM knowledge_fragments WHERE id = ?').run(row.id);
            }
        }
    },

    deleteInventoryRagSummary: (campaignId: number, itemName: string) => {
        const rows = db.prepare(`
            SELECT id, content FROM knowledge_fragments 
            WHERE campaign_id = ? AND session_id = 'INVENTORY_UPDATE'
        `).all(campaignId) as { id: number, content: string }[];

        for (const row of rows) {
            if (row.content.includes(itemName)) {
                db.prepare('DELETE FROM knowledge_fragments WHERE id = ?').run(row.id);
            }
        }
    },

    deleteBestiaryRagSummary: (campaignId: number, monsterName: string) => {
        const rows = db.prepare(`
            SELECT id, content FROM knowledge_fragments 
            WHERE campaign_id = ? AND session_id = 'BESTIARY_UPDATE'
        `).all(campaignId) as { id: number, content: string }[];

        for (const row of rows) {
            if (row.content.includes(monsterName)) {
                db.prepare('DELETE FROM knowledge_fragments WHERE id = ?').run(row.id);
            }
        }
    }
};
