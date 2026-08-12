import { db } from '../client';
import {
    SessionNavigation,
    SessionNavigationItem,
    SessionNote,
    SessionParticipant,
    SessionSummary,
} from '../types';

export const sessionRepository = {
    getAvailableSessions: (guildId?: string, campaignId?: number, limit: number = 5, offset: number = 0): SessionSummary[] => {
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
            LIMIT ? OFFSET ?
        `;

        // SQLite treats -1 as no limit, but 0 as 0 rows.
        if (limit <= 0) limit = -1;
        params.push(limit, offset);

        return db.prepare(sql).all(...params) as SessionSummary[];
    },

    getExplicitSessionNumber: (sessionId: string): number | null => {
        const row = db.prepare('SELECT session_number FROM sessions WHERE session_id = ?').get(sessionId) as { session_number: number } | undefined;
        return row ? row.session_number : null;
    },

    /** A campaign's latest session (by session_number), or null when there is none. */
    getLatestSessionId: (campaignId: number): string | null => {
        const row = db.prepare(`
            SELECT session_id FROM sessions
            WHERE campaign_id = ? AND session_number IS NOT NULL
            ORDER BY session_number DESC LIMIT 1
        `).get(campaignId) as { session_id: string } | undefined;
        return row ? row.session_id : null;
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

    belongsToCampaign: (sessionId: string, campaignId: number): boolean => {
        return Boolean(
            db.prepare('SELECT 1 FROM sessions WHERE session_id = ? AND campaign_id = ?').get(sessionId, campaignId),
        );
    },

    /**
     * Previous/next available chronicles in their reading order.
     *
     * Explicit session numbers are authoritative. Legacy sessions without one
     * follow numbered sessions and are ordered by their first processed
     * recording, with session_id as a deterministic final tie-breaker.
     */
    getSessionNavigation: (campaignId: number, sessionId: string): SessionNavigation => {
        const rows = db.prepare(`
            SELECT
                r.session_id,
                MIN(r.timestamp) AS start_time,
                s.session_number,
                s.title
            FROM recordings r
            INNER JOIN sessions s ON s.session_id = r.session_id
            WHERE s.campaign_id = ? AND r.status = 'PROCESSED'
            GROUP BY r.session_id
            ORDER BY
                CASE WHEN s.session_number IS NULL THEN 1 ELSE 0 END ASC,
                s.session_number ASC,
                start_time ASC,
                r.session_id ASC
        `).all(campaignId) as SessionNavigationItem[];

        const index = rows.findIndex((row) => row.session_id === sessionId);
        if (index < 0) return { previous: null, next: null };

        return {
            previous: index > 0 ? rows[index - 1] : null,
            next: index < rows.length - 1 ? rows[index + 1] : null,
        };
    },

    /**
     * Unique speakers in first-seen order. The immutable recording snapshot is
     * preferred; old recordings fall back to the campaign's current character.
     */
    getSessionParticipants: (sessionId: string): SessionParticipant[] => {
        return db.prepare(`
            SELECT
                r.user_id,
                COALESCE(
                    (
                        SELECT snapshot.character_name_snapshot
                        FROM recordings snapshot
                        WHERE snapshot.session_id = r.session_id
                          AND snapshot.user_id = r.user_id
                          AND snapshot.character_name_snapshot IS NOT NULL
                        ORDER BY snapshot.timestamp ASC, snapshot.id ASC
                        LIMIT 1
                    ),
                    ch.character_name
                ) AS character_name
            FROM recordings r
            INNER JOIN sessions s ON s.session_id = r.session_id
            LEFT JOIN characters ch
              ON ch.campaign_id = s.campaign_id
             AND ch.user_id = r.user_id
            WHERE r.session_id = ? AND r.user_id IS NOT NULL
            GROUP BY r.user_id
            ORDER BY MIN(r.timestamp) ASC, MIN(r.id) ASC
        `).all(sessionId) as SessionParticipant[];
    },

    getSessionGuildId: (sessionId: string): string | undefined => {
        const row = db.prepare('SELECT guild_id FROM sessions WHERE session_id = ?').get(sessionId) as { guild_id: string } | undefined;
        return row ? row.guild_id : undefined;
    },

    // 🆕 Audio files lost or skipped during the mix (see sessionMixer.ts), if any.
    getAudioMixWarning: (sessionId: string): { filename: string, reason: string }[] | null => {
        const row = db.prepare('SELECT audio_mix_warning FROM sessions WHERE session_id = ?').get(sessionId) as { audio_mix_warning: string | null } | undefined;
        if (!row?.audio_mix_warning) return null;
        try {
            return JSON.parse(row.audio_mix_warning);
        } catch {
            return null;
        }
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
        db.prepare(`DELETE FROM quest_lifecycle_suggestions WHERE session_id = ?`).run(sessionId);
    },

    addSessionLog: (sessionId: string, content: string): void => {
        db.prepare('INSERT INTO session_logs (session_id, content) VALUES (?, ?)').run(sessionId, content);
    },

    getSessionLog: (sessionId: string): string[] => {
        const rows = db.prepare('SELECT content FROM session_logs WHERE session_id = ? ORDER BY id ASC').all(sessionId) as { content: string }[];
        return rows.map(r => r.content);
    },

    saveSessionAIOutput: (sessionId: string, analystData: any, summaryData: any): void => {
        db.prepare(`
            UPDATE sessions 
            SET analyst_data = ?, 
                summary_data = ?, 
                last_generated_at = ? 
            WHERE session_id = ?
        `).run(
            JSON.stringify(analystData),
            JSON.stringify(summaryData),
            Date.now(),
            sessionId
        );
    },

    getSessionAIOutput: (sessionId: string): { analystData: any, summaryData: any, lastGeneratedAt: number } | null => {
        const row = db.prepare(`
            SELECT analyst_data, summary_data, last_generated_at 
            FROM sessions 
            WHERE session_id = ?
        `).get(sessionId) as { analyst_data: string, summary_data: string, last_generated_at: number } | undefined;

        if (row && row.analyst_data && row.summary_data) {
            try {
                return {
                    analystData: JSON.parse(row.analyst_data),
                    summaryData: JSON.parse(row.summary_data),
                    lastGeneratedAt: row.last_generated_at
                };
            } catch (e) {
                console.error(`[DB] Failed to parse session AI output for ${sessionId}:`, e);
                return null;
            }
        }
        return null;
    }
};
