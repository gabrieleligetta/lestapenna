import { db } from '../client';
import { Quest } from '../types';

// Helper per calcolare la distanza di Levenshtein (Fuzzy Match)
const levenshteinDistance = (a: string, b: string): number => {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
};

const calculateSimilarity = (a: string, b: string): number => {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / parseFloat(String(longer.length));
};

// Helper per pulire il titolo della quest dai suffissi di stato
const cleanQuestTitle = (title: string): string => {
    return title.replace(/\s*\[(COMPLETED|FAILED|OPEN|SUCCEEDED|DONE)\]\s*$/i, '').trim();
};

export const questRepository = {
    addQuest: (campaignId: number, title: string, sessionId?: string, description?: string, status: string = 'OPEN', type: string = 'MAJOR', isManual: boolean = false, timestamp?: number) => {
        // 0. Guard against undefined/null title
        if (!title) {
            console.warn(`[Quest] ⚠️ Tentativo di aggiungere quest senza titolo. Ignoro.`);
            return;
        }

        // 1. Pulisci il titolo
        const cleanedTitle = cleanQuestTitle(title);

        // 2. Controllo duplicati (Fuzzy)
        const openQuests = questRepository.getOpenQuests(campaignId);
        let existingId: number | null = null;

        for (const q of openQuests) {
            const sim = calculateSimilarity(q.title.toLowerCase(), cleanedTitle.toLowerCase());
            if (sim > 0.85) {
                console.log(`[Quest] ⚠️ Quest simile trovata "${q.title}" (~${Math.round(sim * 100)}%). Aggiorno esistente.`);
                existingId = q.id;
                break;
            }
        }

        if (existingId) {
            // Update existing quest with smart merge
            const current = db.prepare('SELECT description, status FROM quests WHERE id = ?').get(existingId) as { description: string, status: string };

            let finalDesc = current.description;
            if (description && description.trim().length > 0) {
                if (!finalDesc) {
                    finalDesc = description;
                } else if (!finalDesc.includes(description) && !description.includes(finalDesc)) {
                    // Check fuzzy similarity to avoid appending same thing phrased differently? 
                    // For now, simpler check + append if different.
                    // Maybe check if it's just a status update formatted as desc?
                    finalDesc = `${finalDesc}\n\n[Aggiornamento] ${description}`;
                }
            }

            // Determine new status based on precedence
            // Precedence: (COMPLETED | FAILED | SUCCEEDED | DONE) > (IN_PROGRESS) > (OPEN)
            // If current is Final, don't revert to OPEN.
            const isFinal = (s: string) => ['COMPLETED', 'FAILED', 'SUCCEEDED', 'DONE'].includes(s.toUpperCase());
            const currentStatus = current.status || 'OPEN';
            const newStatus = status || 'OPEN';

            let finalStatus = currentStatus;

            if (isFinal(newStatus)) {
                finalStatus = newStatus; // Always accept new Final status
            } else if (!isFinal(currentStatus)) {
                finalStatus = newStatus; // Update if current is NOT final (e.g. Open -> In Progress)
            }
            // Else: Current is Final, New is Open/InProgress -> Keep Current (Final)

            db.prepare(`
                UPDATE quests 
                SET description = $description, 
                    status = $status, 
                    last_updated = $timestamp, 
                    rag_sync_needed = 1,
                    is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END
                WHERE id = $id
            `).run({
                description: finalDesc,
                status: finalStatus,
                timestamp: timestamp || Date.now(),
                id: existingId,
                isManual: isManual ? 1 : 0
            });
            console.log(`[Quest] 🔄 Aggiornata Quest: ${cleanedTitle} (Status: ${currentStatus} -> ${finalStatus})`);
        } else {
            // Insert new quest
            db.prepare(`
                INSERT INTO quests (campaign_id, title, session_id, description, status, type, created_at, last_updated, rag_sync_needed, is_manual) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            `).run(campaignId, cleanedTitle, sessionId || null, description || null, status, type, timestamp || Date.now(), timestamp || Date.now(), isManual ? 1 : 0);
            console.log(`[Quest] 🆕 Nuova Quest (${type}): ${cleanedTitle}`);
        }
    },

    getSessionQuests: (sessionId: string): any[] => {
        return db.prepare('SELECT * FROM quests WHERE session_id = ?').all(sessionId);
    },

    updateQuestStatus: (campaignId: number, titlePart: string, status: 'COMPLETED' | 'FAILED' | 'OPEN') => {
        // Find match with LIKE
        const result = db.prepare(`
            UPDATE quests 
            SET status = ?, last_updated = ? 
            WHERE campaign_id = ? AND lower(title) LIKE lower(?)
        `).run(status, Date.now(), campaignId, `%${titlePart}%`);

        if (result.changes > 0) {
            console.log(`[Quest] ✅ Status aggiornato: "${titlePart}" -> ${status}`);
        }
    },

    updateQuestStatusById: (questId: number, status: 'COMPLETED' | 'FAILED' | 'OPEN'): boolean => {
        const result = db.prepare(`
            UPDATE quests 
            SET status = ?, last_updated = ? 
            WHERE id = ?
        `).run(status, Date.now(), questId);
        return result.changes > 0;
    },

    deleteQuest: (questId: number): boolean => {
        const result = db.prepare('DELETE FROM quests WHERE id = ?').run(questId);
        return result.changes > 0;
    },

    deleteQuestHistory: (campaignId: number, title: string): boolean => {
        const result = db.prepare('DELETE FROM quest_history WHERE campaign_id = ? AND lower(quest_title) = lower(?)').run(campaignId, title);
        return result.changes > 0;
    },

    getOpenQuests: (campaignId: number, limit: number = 20, offset: number = 0): Quest[] => {
        return db.prepare("SELECT * FROM quests WHERE campaign_id = ? AND status = 'OPEN' LIMIT ? OFFSET ?").all(campaignId, limit, offset) as Quest[];
    },

    countOpenQuests: (campaignId: number): number => {
        const result = db.prepare("SELECT COUNT(*) as count FROM quests WHERE campaign_id = ? AND status = 'OPEN'").get(campaignId) as { count: number };
        return result.count;
    },

    listAllQuests: (campaignId: number): Quest[] => {
        return db.prepare('SELECT * FROM quests WHERE campaign_id = ? ORDER BY last_updated DESC').all(campaignId) as Quest[];
    },

    getQuestByTitle: (campaignId: number, title: string): Quest | null => {
        return db.prepare('SELECT * FROM quests WHERE campaign_id = ? AND lower(title) = lower(?)').get(campaignId, title) as Quest | null;
    },

    mergeQuests: (
        campaignId: number,
        oldTitle: string,
        newTitle: string
    ): boolean => {
        const source = questRepository.getQuestByTitle(campaignId, oldTitle);
        if (!source) return false;

        const target = questRepository.getQuestByTitle(campaignId, newTitle);

        db.transaction(() => {
            if (target) {
                // Merge: Delete source, keep target
                db.prepare('DELETE FROM quests WHERE id = ?').run(source.id);
            } else {
                // Rename
                db.prepare('UPDATE quests SET title = ?, last_updated = ?, rag_sync_needed = 1 WHERE id = ?')
                    .run(newTitle, Date.now(), source.id);
            }
        })();

        console.log(`[Quest] 🔀 Merge/Rename: ${oldTitle} -> ${newTitle}`);
        return true;
    },
    addQuestEvent: (campaignId: number, title: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        db.prepare(`
            INSERT INTO quest_history (campaign_id, quest_title, session_id, description, event_type, timestamp, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, title, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0);
    },

    getQuestHistory: (campaignId: number, title: string): any[] => {
        return db.prepare(`
            SELECT * FROM quest_history 
            WHERE campaign_id = ? AND lower(quest_title) = lower(?)
            ORDER BY timestamp ASC
        `).all(campaignId, title);
    },

    updateQuestDescription: (campaignId: number, title: string, description: string) => {
        db.prepare(`
            UPDATE quests 
            SET description = ?, rag_sync_needed = 1, last_updated = ?
            WHERE campaign_id = ? AND lower(title) = lower(?)
        `).run(description, Date.now(), campaignId, title);
    },

    markQuestDirty: (campaignId: number, title: string) => {
        db.prepare('UPDATE quests SET rag_sync_needed = 1 WHERE campaign_id = ? AND lower(title) = lower(?)').run(campaignId, title);
    },

    getDirtyQuests: (campaignId: number): Quest[] => {
        return db.prepare('SELECT * FROM quests WHERE campaign_id = ? AND rag_sync_needed = 1').all(campaignId) as Quest[];
    },

    clearQuestDirtyFlag: (campaignId: number, title: string) => {
        db.prepare('UPDATE quests SET rag_sync_needed = 0 WHERE campaign_id = ? AND lower(title) = lower(?)').run(campaignId, title);
    }
};
