import { db } from '../client';

export type AskRole = 'user' | 'assistant';

export interface AskConversation {
    id: number;
    campaign_id: number;
    user_id: string;
    title: string;
    shared: number;
    created_at: number;
    updated_at: number;
}

export interface AskConversationSummary extends AskConversation {
    message_count: number;
}

export interface AskMessage {
    id: number;
    conversation_id: number;
    role: AskRole;
    content: string;
    created_at: number;
    cost_usd: number | null;
    cost_eur: number | null;
    provider: string | null;
    model: string | null;
}

export interface AppendExchangeInput {
    conversationId: number;
    question: string;
    answer: string;
    costUsd: number | null;
    costEur: number | null;
    provider: string | null;
    model: string | null;
}

export const CONVERSATION_TITLE_MAX_CHARS = 60;

/**
 * Title derived from the first question: no AI call.
 *
 * Generating it with the model would be a second billable action on the user's
 * provider account, for marginal value over the truncated first question —
 * which is already what the user recognizes in the list.
 */
export function deriveConversationTitle(question: string): string {
    const flat = question.replace(/\s+/g, ' ').trim();
    if (flat.length === 0) return '…';
    if (flat.length <= CONVERSATION_TITLE_MAX_CHARS) return flat;
    const cut = flat.slice(0, CONVERSATION_TITLE_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > CONVERSATION_TITLE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const appendExchangeTransaction = db.transaction((input: AppendExchangeInput): AskMessage => {
    const now = Date.now();
    const insertMessage = db.prepare(`
        INSERT INTO ask_messages (
            conversation_id, role, content, created_at,
            cost_usd, cost_eur, provider, model
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMessage.run(input.conversationId, 'user', input.question, now, null, null, null, null);
    const assistant = insertMessage.run(
        input.conversationId, 'assistant', input.answer, now,
        input.costUsd, input.costEur, input.provider, input.model,
    );

    // The title is fixed at the first exchange and never rewritten: a manual
    // rename must not be overwritten by subsequent questions.
    db.prepare(`
        UPDATE ask_conversations
        SET updated_at = ?,
            title = CASE
                WHEN title = '' THEN ?
                ELSE title
            END
        WHERE id = ?
    `).run(now, deriveConversationTitle(input.question), input.conversationId);

    return db.prepare('SELECT * FROM ask_messages WHERE id = ?')
        .get(assistant.lastInsertRowid) as AskMessage;
});

/**
 * Conversations between a user and the Bardo, per campaign.
 *
 * Separate from `chat_history` (which stays exclusive to the bot): that one is
 * keyed on the Discord channel and knows nothing about campaign, user or
 * thread. Here we also need explicit sharing with the table and per-exchange
 * telemetry.
 */
export const askConversationRepository = {
    /** The title starts empty: the first `appendExchange` sets it. */
    create: (campaignId: number, userId: string, title = ''): AskConversation => {
        const now = Date.now();
        const result = db.prepare(`
            INSERT INTO ask_conversations (campaign_id, user_id, title, shared, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)
        `).run(campaignId, userId, title, now, now);
        return db.prepare('SELECT * FROM ask_conversations WHERE id = ?')
            .get(result.lastInsertRowid) as AskConversation;
    },

    get: (conversationId: number): AskConversation | null => {
        return (db.prepare('SELECT * FROM ask_conversations WHERE id = ?')
            .get(conversationId) as AskConversation | undefined) ?? null;
    },

    /** Your own conversations plus the ones other members have shared. */
    listVisible: (campaignId: number, userId: string, limit: number, offset: number): AskConversationSummary[] => {
        return db.prepare(`
            SELECT c.*, (SELECT COUNT(*) FROM ask_messages m WHERE m.conversation_id = c.id) AS message_count
            FROM ask_conversations c
            WHERE c.campaign_id = ? AND (c.user_id = ? OR c.shared = 1)
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT ? OFFSET ?
        `).all(campaignId, userId, limit, offset) as AskConversationSummary[];
    },

    countVisible: (campaignId: number, userId: string): number => {
        const row = db.prepare(`
            SELECT COUNT(*) AS count FROM ask_conversations
            WHERE campaign_id = ? AND (user_id = ? OR shared = 1)
        `).get(campaignId, userId) as { count: number };
        return row.count;
    },

    countMessages: (conversationId: number): number => {
        const row = db.prepare('SELECT COUNT(*) AS count FROM ask_messages WHERE conversation_id = ?')
            .get(conversationId) as { count: number };
        return row.count;
    },

    getMessages: (conversationId: number): AskMessage[] => {
        return db.prepare(
            'SELECT * FROM ask_messages WHERE conversation_id = ? ORDER BY id ASC',
        ).all(conversationId) as AskMessage[];
    },

    /** The latest turns in the format `askBard` expects, in chronological order. */
    getRecentTurns: (conversationId: number, limit = 6): { role: AskRole; content: string }[] => {
        return (db.prepare(
            'SELECT role, content FROM ask_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
        ).all(conversationId, limit) as { role: AskRole; content: string }[]).reverse();
    },

    appendExchange: (input: AppendExchangeInput): AskMessage => appendExchangeTransaction(input),

    rename: (conversationId: number, title: string): boolean => {
        return db.prepare('UPDATE ask_conversations SET title = ?, updated_at = ? WHERE id = ?')
            .run(title, Date.now(), conversationId).changes > 0;
    },

    setShared: (conversationId: number, shared: boolean): boolean => {
        return db.prepare('UPDATE ask_conversations SET shared = ?, updated_at = ? WHERE id = ?')
            .run(shared ? 1 : 0, Date.now(), conversationId).changes > 0;
    },

    remove: (conversationId: number): boolean => {
        // I messaggi cadono per ON DELETE CASCADE.
        return db.prepare('DELETE FROM ask_conversations WHERE id = ?')
            .run(conversationId).changes > 0;
    },
};
