import { db } from '../client';

export const worldRepository = {
    addWorldEvent: (campaignId: number, sessionId: string | null, description: string, type: string, year?: number, isManual: boolean = false, timestamp?: number) => {
        // Fallback year? Current year from campaign?
        // Let's make year optional and fetch from campaign if not provided, or default to 0
        let effectiveYear = year;
        if (effectiveYear === undefined) {
            const camp = db.prepare('SELECT current_year FROM campaigns WHERE id = ?').get(campaignId) as { current_year: number } | undefined;
            effectiveYear = camp?.current_year || 0;
        }

        if (sessionId) {
            // Check for potential duplicates in the same session
            const existingEvents = db.prepare(`
                SELECT description FROM world_history 
                WHERE campaign_id = ? AND session_id = ?
            `).all(campaignId, sessionId) as { description: string }[];

            const isDuplicate = existingEvents.some(e => {
                // Check if description is very similar or contained
                return e.description.includes(description) || description.includes(e.description);
            });

            if (isDuplicate) {
                console.log(`[World] ⚠️ Evento duplicato ignorato per sessione ${sessionId}`);
                return;
            }
        }

        db.prepare(`
            INSERT INTO world_history (campaign_id, session_id, description, event_type, timestamp, year, rag_sync_needed, is_manual)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `).run(campaignId, sessionId, description, type, timestamp || Date.now(), effectiveYear, isManual ? 1 : 0);
    },

    getWorldTimeline: (campaignId: number): any[] => {
        return db.prepare(`
            SELECT * FROM world_history 
            WHERE campaign_id = ? 
            ORDER BY year ASC, timestamp ASC
        `).all(campaignId);
    },

    deleteWorldEvent: (id: number): boolean => {
        const result = db.prepare('DELETE FROM world_history WHERE id = ?').run(id);
        return result.changes > 0;
    },

    getDirtyWorldEvents: (campaignId: number): any[] => {
        return db.prepare('SELECT * FROM world_history WHERE campaign_id = ? AND rag_sync_needed = 1').all(campaignId);
    },

    clearWorldEventDirtyFlag: (id: number) => {
        db.prepare('UPDATE world_history SET rag_sync_needed = 0 WHERE id = ?').run(id);
    }
};
