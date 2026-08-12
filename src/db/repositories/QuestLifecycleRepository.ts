import { db } from '../client';
import {
    normalizeQuestStatus,
    normalizeQuestType,
    QuestLifecycleAction,
    QuestLifecycleConfidence,
    QuestLifecycleSuggestion,
    QuestStatus,
    QuestType
} from '../types';

export interface CreateQuestLifecycleSuggestionInput {
    campaignId: number;
    questId?: number | null;
    sessionId?: string | null;
    proposedAction: QuestLifecycleAction;
    proposedTitle: string;
    proposedDescription?: string | null;
    proposedStatus: QuestStatus;
    proposedType: QuestType;
    evidence: string;
    confidence: QuestLifecycleConfidence;
}

export const questLifecycleRepository = {
    createSuggestion(input: CreateQuestLifecycleSuggestionInput): QuestLifecycleSuggestion {
        const status = normalizeQuestStatus(input.proposedStatus);
        const type = normalizeQuestType(input.proposedType);
        if (!status || !type) throw new Error('Invalid quest lifecycle enum');
        const title = input.proposedTitle.trim();
        if (!title) throw new Error('Quest lifecycle title is required');

        // Session idempotency: a retry/re-ingestion of the same analysis must not
        // reapply an already accepted transition nor recreate an already ignored
        // proposal. Historical audits have a null sessionId and rely on the
        // PENDING dedupe below.
        if (input.sessionId) {
            const resolvedOrPending = db.prepare(`
                SELECT * FROM quest_lifecycle_suggestions
                WHERE campaign_id = ?
                  AND session_id = ?
                  AND proposed_action = ?
                  AND proposed_status = ?
                  AND lower(proposed_title) = lower(?)
                  AND COALESCE(quest_id, 0) = COALESCE(?, 0)
                ORDER BY id DESC LIMIT 1
            `).get(
                input.campaignId,
                input.sessionId,
                input.proposedAction,
                status,
                title,
                input.questId ?? null
            ) as QuestLifecycleSuggestion | undefined;
            if (resolvedOrPending) return resolvedOrPending;
        }

        const existing = db.prepare(`
            SELECT * FROM quest_lifecycle_suggestions
            WHERE campaign_id = ?
              AND status = 'PENDING'
              AND proposed_action = ?
              AND proposed_status = ?
              AND lower(proposed_title) = lower(?)
              AND COALESCE(quest_id, 0) = COALESCE(?, 0)
            ORDER BY id DESC LIMIT 1
        `).get(
            input.campaignId,
            input.proposedAction,
            status,
            title,
            input.questId ?? null
        ) as QuestLifecycleSuggestion | undefined;
        if (existing) return existing;

        const result = db.prepare(`
            INSERT INTO quest_lifecycle_suggestions (
                campaign_id, quest_id, session_id, proposed_action, proposed_title,
                proposed_description, proposed_status, proposed_type, evidence,
                confidence, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
        `).run(
            input.campaignId,
            input.questId ?? null,
            input.sessionId ?? null,
            input.proposedAction,
            title,
            input.proposedDescription?.trim() || null,
            status,
            type,
            input.evidence.trim(),
            input.confidence,
            Date.now()
        );
        return db.prepare('SELECT * FROM quest_lifecycle_suggestions WHERE id = ?')
            .get(Number(result.lastInsertRowid)) as QuestLifecycleSuggestion;
    },

    listSuggestions(
        campaignId: number,
        status: 'PENDING' | 'APPLIED' | 'DISMISSED' | 'ALL' = 'PENDING',
        questId?: number
    ): QuestLifecycleSuggestion[] {
        const filters = ['campaign_id = ?'];
        const values: any[] = [campaignId];
        if (status !== 'ALL') {
            filters.push('status = ?');
            values.push(status);
        }
        if (questId !== undefined) {
            filters.push('quest_id = ?');
            values.push(questId);
        }
        return db.prepare(`
            SELECT * FROM quest_lifecycle_suggestions
            WHERE ${filters.join(' AND ')}
            ORDER BY created_at DESC, id DESC
        `).all(...values) as QuestLifecycleSuggestion[];
    },

    getSuggestion(campaignId: number, id: number): QuestLifecycleSuggestion | null {
        return db.prepare(
            'SELECT * FROM quest_lifecycle_suggestions WHERE campaign_id = ? AND id = ?'
        ).get(campaignId, id) as QuestLifecycleSuggestion | null;
    },

    resolveSuggestion(
        campaignId: number,
        id: number,
        resolution: 'APPLIED' | 'DISMISSED'
    ): QuestLifecycleSuggestion | null {
        const result = db.prepare(`
            UPDATE quest_lifecycle_suggestions
            SET status = ?, resolved_at = ?
            WHERE campaign_id = ? AND id = ? AND status = 'PENDING'
        `).run(resolution, Date.now(), campaignId, id);
        if (result.changes === 0) return null;
        return questLifecycleRepository.getSuggestion(campaignId, id);
    },

    dismissPendingForQuest(campaignId: number, questId: number): number {
        return db.prepare(`
            UPDATE quest_lifecycle_suggestions
            SET status = 'DISMISSED', resolved_at = ?
            WHERE campaign_id = ? AND quest_id = ? AND status = 'PENDING'
        `).run(Date.now(), campaignId, questId).changes;
    }
};
