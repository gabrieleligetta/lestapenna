import { db } from '../connection';
import { KnowledgeFragment } from '../types';

// --- FUNZIONI KNOWLEDGE BASE (RAG) ---

export const insertKnowledgeFragment = (campaignId: number, sessionId: string, content: string, embedding: number[], model: string, startTimestamp: number = 0, macro: string | null = null, micro: string | null = null, npcs: string[] = []) => {
    const npcString = npcs.join(',');
    db.prepare(`
        INSERT INTO knowledge_fragments (campaign_id, session_id, content, embedding_json, embedding_model, vector_dimension, start_timestamp, created_at, macro_location, micro_location, associated_npcs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(campaignId, sessionId, content, JSON.stringify(embedding), model, embedding.length, startTimestamp, Date.now(), macro, micro, npcString);
};

export const getKnowledgeFragments = (campaignId: number, model: string): KnowledgeFragment[] => {
    return db.prepare(`
        SELECT * FROM knowledge_fragments
        WHERE campaign_id = ? AND embedding_model = ?
        ORDER BY start_timestamp ASC
    `).all(campaignId, model) as KnowledgeFragment[];
};

export const deleteSessionKnowledge = (sessionId: string, model: string) => {
    db.prepare(`DELETE FROM knowledge_fragments WHERE session_id = ? AND embedding_model = ?`).run(sessionId, model);
};

// --- FUNZIONI CHAT HISTORY ---

export const addChatMessage = (channelId: string, role: 'user' | 'assistant', content: string) => {
    db.prepare('INSERT INTO chat_history (channel_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(channelId, role, content, Date.now());
};

export const getChatHistory = (channelId: string, limit: number = 10): { role: 'user' | 'assistant', content: string }[] => {
    const rows = db.prepare('SELECT role, content FROM chat_history WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?').all(channelId, limit) as { role: 'user' | 'assistant', content: string }[];
    return rows.reverse();
};
