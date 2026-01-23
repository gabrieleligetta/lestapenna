import { db } from '../client';

export const configRepository = {
    setConfig: (key: string, value: string): void => {
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
    },

    getConfig: (key: string): string | null => {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
        return row ? row.value : null;
    },

    getGuildConfig: (guildId: string, key: string): string | null => {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(`${guildId}_${key}`) as { value: string } | undefined;
        return row ? row.value : null;
    },

    setGuildConfig: (guildId: string, key: string, value: string): void => {
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(`${guildId}_${key}`, value);
    }
};
