import { db } from '../connection';

const setConfig = (key: string, value: string): void => {
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
};

const getConfig = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
};

export const getGuildConfig = (guildId: string, key: string): string | null => {
    return getConfig(`${guildId}_${key}`);
};

export const setGuildConfig = (guildId: string, key: string, value: string): void => {
    setConfig(`${guildId}_${key}`, value);
};
