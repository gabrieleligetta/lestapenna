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
    addQuest: (campaignId: number, title: string, sessionId?: string) => {
        // 0. Guard against undefined/null title
        if (!title) {
            console.warn(`[Quest] ⚠️ Tentativo di aggiungere quest senza titolo. Ignoro.`);
            return;
        }

        // 1. Pulisci il titolo
        const cleanedTitle = cleanQuestTitle(title);

        // 2. Controllo duplicati (Fuzzy)
        const openQuests = questRepository.getOpenQuests(campaignId);

        for (const q of openQuests) {
            const sim = calculateSimilarity(q.title.toLowerCase(), cleanedTitle.toLowerCase());
            if (sim > 0.85) {
                console.log(`[Quest] ⚠️ Quest simile trovata "${q.title}" (~${Math.round(sim * 100)}%). Ignoro nuova: "${cleanedTitle}"`);
                return; // Skip duplicate
            }
        }

        db.prepare('INSERT INTO quests (campaign_id, title, session_id, created_at, last_updated) VALUES (?, ?, ?, ?, ?)')
            .run(campaignId, cleanedTitle, sessionId || null, Date.now(), Date.now());

        console.log(`[Quest] 🆕 Nuova Quest: ${cleanedTitle}`);
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

    getOpenQuests: (campaignId: number): Quest[] => {
        return db.prepare("SELECT * FROM quests WHERE campaign_id = ? AND status = 'OPEN'").all(campaignId) as Quest[];
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
                db.prepare('UPDATE quests SET title = ?, last_updated = ? WHERE id = ?')
                    .run(newTitle, Date.now(), source.id);
            }
        })();

        console.log(`[Quest] 🔀 Merge/Rename: ${oldTitle} -> ${newTitle}`);
        return true;
    }
};
