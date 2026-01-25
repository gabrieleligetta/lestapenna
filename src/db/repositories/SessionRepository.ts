import { db } from '../client';
import { SessionSummary, SessionNote } from '../types';

export const sessionRepository = {
    getAvailableSessions: (guildId?: string, campaignId?: number, limit: number = 5): SessionSummary[] => {
        let sql = `
            SELECT 
                r.session_id, 
                MIN(r.timestamp) as start_time, 
                COUNT(*) as fragments,
                c.name as campaign_name,
                s.session_number,
                s.title
            FROM recordings r
            LEFT JOIN sessions s ON r.session_id = s.session_id
            LEFT JOIN campaigns c ON s.campaign_id = c.id
            WHERE r.status = 'PROCESSED'
        `;
        const params: any[] = [];

        const whereClauses = ["r.status = 'PROCESSED'"];

        if (campaignId) {
            whereClauses.push("s.campaign_id = ?");
            params.push(campaignId);
        } else if (guildId) {
            whereClauses.push("(c.guild_id = ? OR c.guild_id IS NULL)");
            params.push(guildId);
        }

        sql = `
            SELECT 
                r.session_id, 
                MIN(r.timestamp) as start_time, 
                COUNT(*) as fragments,
                c.name as campaign_name,
                s.campaign_id,
                s.session_number,
                s.title
            FROM recordings r
            LEFT JOIN sessions s ON r.session_id = s.session_id
            LEFT JOIN campaigns c ON s.campaign_id = c.id
            WHERE ${whereClauses.join(' AND ')}
            GROUP BY r.session_id
            ORDER BY start_time DESC
            LIMIT ?
        `;

        // SQLite treats -1 as no limit, but 0 as 0 rows.
        if (limit <= 0) limit = -1;
        params.push(limit);

        return db.prepare(sql).all(...params) as SessionSummary[];
    },

    getExplicitSessionNumber: (sessionId: string): number | null => {
        const row = db.prepare('SELECT session_number FROM sessions WHERE session_id = ?').get(sessionId) as { session_number: number } | undefined;
        return row ? row.session_number : null;
    },

    setSessionNumber: (sessionId: string, num: number): boolean => {
        const exists = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
        if (exists) {
            db.prepare('UPDATE sessions SET session_number = ? WHERE session_id = ?').run(num, sessionId);
            return true;
        }
        return false;
    },

    updateSessionTitle: (sessionId: string, title: string): void => {
        db.prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run(title, sessionId);
    },

    createSession: (sessionId: string, guildId: string, campaignId: number): void => {
        db.prepare(`
            INSERT OR IGNORE INTO sessions (session_id, guild_id, campaign_id)
            VALUES (?, ?, ?)
        `).run(sessionId, guildId, campaignId);
    },

    getSessionAuthor: (sessionId: string): string | null => {
        const row = db.prepare('SELECT user_id FROM recordings WHERE session_id = ? LIMIT 1').get(sessionId) as { user_id: string } | undefined;
        return row ? row.user_id : null;
    },

    getSessionStartTime: (sessionId: string): number | null => {
        const row = db.prepare('SELECT MIN(timestamp) as start FROM recordings WHERE session_id = ?').get(sessionId) as { start: number } | undefined;
        return row ? row.start : null;
    },

    getSessionCampaignId: (sessionId: string): number | undefined => {
        const row = db.prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as { campaign_id: number } | undefined;
        return row ? row.campaign_id : undefined;
    },

    findSessionByTimestamp: (timestamp: number): string | null => {
        const row = db.prepare(`
            SELECT session_id FROM recordings 
            ORDER BY ABS(timestamp - ?) ASC 
            LIMIT 1
        `).get(timestamp) as { session_id: string } | undefined;

        if (row) {
            const rec = db.prepare('SELECT timestamp FROM recordings WHERE session_id = ? LIMIT 1').get(row.session_id) as { timestamp: number };
            // If diff > 12 hours, ignore
            if (Math.abs(rec.timestamp - timestamp) > 12 * 3600 * 1000) return null;
            return row.session_id;
        }
        return null;
    },

    addSessionNote: (sessionId: string, user_id: string, content: string, timestamp: number) => {
        db.prepare(`
            INSERT INTO session_notes (session_id, user_id, content, timestamp, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(sessionId, user_id, content, timestamp, Date.now());
    },

    getSessionNotes: (sessionId: string): SessionNote[] => {
        return db.prepare('SELECT * FROM session_notes WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as SessionNote[];
    },

    clearSessionDerivedData: (sessionId: string): void => {
        const tables = [
            'character_history',
            'npc_history',
            'world_history',
            'location_history',
            'quests',
            'inventory',
            'bestiary'
        ];

        for (const table of tables) {
            db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
        }

        // Also clear logs
        db.prepare(`DELETE FROM session_logs WHERE session_id = ?`).run(sessionId);
    },

    addSessionLog: (sessionId: string, content: string): void => {
        db.prepare('INSERT INTO session_logs (session_id, content) VALUES (?, ?)').run(sessionId, content);
    },

    getSessionLog: (sessionId: string): string[] => {
        const rows = db.prepare('SELECT content FROM session_logs WHERE session_id = ? ORDER BY id ASC').all(sessionId) as { content: string }[];
        return rows.map(r => r.content);
    }
};
