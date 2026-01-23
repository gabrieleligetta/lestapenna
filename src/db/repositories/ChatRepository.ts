import { db } from '../client';

export const chatRepository = {
    addChatMessage: (channelId: string, role: 'user' | 'assistant', content: string) => {
        db.prepare('INSERT INTO chat_history (channel_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(channelId, role, content, Date.now());
    },

    getChatHistory: (channelId: string, limit: number = 10): { role: 'user' | 'assistant', content: string }[] => {
        return db.prepare('SELECT role, content FROM chat_history WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?').all(channelId, limit).reverse() as { role: 'user' | 'assistant', content: string }[];
    }
};
