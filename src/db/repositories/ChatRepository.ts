import { db } from '../client';

export const chatRepository = {
    /**
     * `guildId`/`userId` are optional only because rows written before they
     * existed have neither. New rows must carry both: without them the exchange
     * cannot be erased on request, and this table holds what people actually
     * typed.
     */
    addChatMessage: (
        channelId: string,
        role: 'user' | 'assistant',
        content: string,
        guildId?: string,
        userId?: string,
    ) => {
        db.prepare(
            'INSERT INTO chat_history (channel_id, role, content, timestamp, guild_id, user_id) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(channelId, role, content, Date.now(), guildId ?? null, userId ?? null);
    },

    getChatHistory: (channelId: string, limit: number = 10): { role: 'user' | 'assistant', content: string }[] => {
        return db.prepare('SELECT role, content FROM chat_history WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?').all(channelId, limit).reverse() as { role: 'user' | 'assistant', content: string }[];
    }
};
