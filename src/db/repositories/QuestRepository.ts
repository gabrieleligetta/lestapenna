import { db } from '../client';
import { getByShortId, resolveEntityId, getHistoryByEntity } from './shared';
import {
    normalizeQuestStatus,
    normalizeQuestType,
    Quest,
    QuestStatus,
    QuestType
} from '../types';
import { generateShortId } from '../utils/idGenerator';
import { knowledgeRepository } from './KnowledgeRepository';

const requireQuestStatus = (value: unknown, fallback?: QuestStatus): QuestStatus => {
    const normalized = normalizeQuestStatus(value);
    if (normalized) return normalized;
    if (fallback) return fallback;
    throw new Error(`Invalid quest status: ${String(value)}`);
};

const requireQuestType = (value: unknown, fallback?: QuestType): QuestType => {
    const normalized = normalizeQuestType(value);
    if (normalized) return normalized;
    if (fallback) return fallback;
    throw new Error(`Invalid quest type: ${String(value)}`);
};

// Helper per calcolare la distanza di Levenshtein (Fuzzy Match)
const levenshteinDistance = (a: string, b: string): number => {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
};

const calculateSimilarity = (a: string, b: string): number => {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / parseFloat(String(longer.length));
};

// Helper that strips the status suffixes from a quest title
const cleanQuestTitle = (title: string): string => {
    return title.replace(/\s*\[(COMPLETED|FAILED|OPEN|SUCCEEDED|DONE)\]\s*$/i, '').trim();
};

export const questRepository = {
    addQuest: (campaignId: number, title: string, sessionId?: string, description?: string, status: string = 'OPEN', type: string = 'MAJOR', isManual: boolean = false, timestamp?: number) => {
        // 0. Guard against undefined/null title
        if (!title) {
            console.warn(`[Quest] ⚠️ Tentativo di aggiungere quest senza titolo. Ignoro.`);
            return;
        }

        // 1. Clean up the title
        const cleanedTitle = cleanQuestTitle(title);
        const canonicalStatus = requireQuestStatus(status, QuestStatus.OPEN);
        const canonicalType = requireQuestType(type, 'MAJOR');

        // 2. Controllo duplicati (Fuzzy)
        const openQuests = questRepository.getOpenQuests(campaignId);
        let existingId: number | null = null;

        for (const q of openQuests) {
            const sim = calculateSimilarity(q.title.toLowerCase(), cleanedTitle.toLowerCase());
            if (sim > 0.85) {
                console.log(`[Quest] ⚠️ Quest simile trovata "${q.title}" (~${Math.round(sim * 100)}%). Aggiorno esistente.`);
                existingId = q.id;
                break;
            }
        }

        if (existingId) {
            // Update existing quest with smart merge
            const current = db.prepare('SELECT description, status FROM quests WHERE id = ?').get(existingId) as { description: string, status: string };

            let finalDesc = current.description;
            if (description && description.trim().length > 0) {
                if (!finalDesc) {
                    finalDesc = description;
                } else if (!finalDesc.includes(description) && !description.includes(finalDesc)) {
                    // Check fuzzy similarity to avoid appending same thing phrased differently? 
                    // For now, simpler check + append if different.
                    // Maybe check if it's just a status update formatted as desc?
                    finalDesc = `${finalDesc}\n\n[Aggiornamento] ${description}`;
                }
            }

            // Determine new status based on precedence
            // Precedence: (COMPLETED | FAILED) > (IN_PROGRESS) > (OPEN)
            // If current is Final, don't revert to active.
            const isFinal = (s: string) =>
                s === QuestStatus.COMPLETED || s === QuestStatus.FAILED;
            const currentStatus = current.status || QuestStatus.OPEN;
            const newStatus = canonicalStatus;

            let finalStatus = currentStatus;

            if (isFinal(newStatus)) {
                finalStatus = newStatus; // Always accept new Final status
            } else if (!isFinal(currentStatus)) {
                // Precedence among non-final: IN_PROGRESS > OPEN
                if (newStatus === QuestStatus.IN_PROGRESS || currentStatus === QuestStatus.OPEN) {
                    finalStatus = newStatus;
                }
            }
            // Else: Current is Final, New is active -> Keep Current (Final)

            db.prepare(`
                UPDATE quests 
                SET description = $description, 
                    status = $status, 
                    last_updated = $timestamp, 
                    rag_sync_needed = 1,
                    is_manual = CASE WHEN $isManual = 1 THEN 1 ELSE is_manual END,
                    manual_description = CASE WHEN $isManual = 1 THEN $description ELSE manual_description END
                WHERE id = $id
            `).run({
                description: finalDesc,
                status: finalStatus,
                timestamp: timestamp || Date.now(),
                id: existingId,
                isManual: isManual ? 1 : 0
            });
            console.log(`[Quest] 🔄 Aggiornata Quest: ${cleanedTitle} (Status: ${currentStatus} -> ${finalStatus})`);
        } else {
            // Insert new quest
            const shortId = generateShortId('quests');
            db.prepare(`
                INSERT INTO quests (campaign_id, title, session_id, description, status, type, created_at, last_updated, rag_sync_needed, is_manual, short_id, manual_description) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            `).run(campaignId, cleanedTitle, sessionId || null, description || null, canonicalStatus, canonicalType, timestamp || Date.now(), timestamp || Date.now(), isManual ? 1 : 0, shortId, isManual ? (description || null) : null);
            console.log(`[Quest] 🆕 Nuova Quest (${canonicalType}): ${cleanedTitle} [#${shortId}]`);
        }
    },

    createManualQuest: (
        campaignId: number,
        input: { title: string; description?: string | null; status: QuestStatus; type: QuestType; sessionId?: string | null }
    ): Quest => {
        const title = cleanQuestTitle(input.title || '').trim();
        if (!title) throw new Error('Quest title is required');
        const status = requireQuestStatus(input.status);
        const type = requireQuestType(input.type);
        const duplicate = db.prepare(
            'SELECT 1 FROM quests WHERE campaign_id = ? AND lower(title) = lower(?)'
        ).get(campaignId, title);
        if (duplicate) throw new Error('A quest with this title already exists');

        const now = Date.now();
        const shortId = generateShortId('quests');
        const description = input.description?.trim() || null;
        const result = db.prepare(`
            INSERT INTO quests (
                campaign_id, title, description, status, type, created_at, last_updated,
                session_id, rag_sync_needed, is_manual, short_id, manual_description
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
        `).run(campaignId, title, description, status, type, now, now, input.sessionId || null, shortId, description);
        const id = Number(result.lastInsertRowid);
        questRepository.addQuestEvent(
            campaignId,
            title,
            input.sessionId || '',
            description || `Quest creata manualmente con stato ${status}.`,
            'CREATED',
            true,
            now
        );
        return db.prepare('SELECT * FROM quests WHERE id = ?').get(id) as Quest;
    },

    getSessionQuests: (sessionId: string): any[] => {
        return db.prepare('SELECT * FROM quests WHERE session_id = ?').all(sessionId);
    },

    updateQuestStatus: (campaignId: number, titlePart: string, status: string) => {
        const canonicalStatus = requireQuestStatus(status);
        // Find match with LIKE
        const result = db.prepare(`
            UPDATE quests 
            SET status = ?, last_updated = ? 
            WHERE campaign_id = ? AND lower(title) LIKE lower(?)
        `).run(canonicalStatus, Date.now(), campaignId, `%${titlePart}%`);

        if (result.changes > 0) {
            console.log(`[Quest] ✅ Status aggiornato: "${titlePart}" -> ${canonicalStatus}`);
        }
    },

    updateQuestStatusById: (questId: number, status: string): boolean => {
        const canonicalStatus = requireQuestStatus(status);
        const result = db.prepare(`
            UPDATE quests 
            SET status = ?, last_updated = ?, rag_sync_needed = 1
            WHERE id = ?
        `).run(canonicalStatus, Date.now(), questId);
        return result.changes > 0;
    },

    applyAiStatusByShortId: (
        campaignId: number,
        shortId: string,
        status: QuestStatus,
        sessionId: string,
        description: string,
        timestamp?: number
    ): Quest | null => {
        const quest = questRepository.getQuestByShortId(campaignId, shortId);
        if (!quest) return null;
        const canonicalStatus = requireQuestStatus(status);
        const currentStatus = requireQuestStatus(quest.status, QuestStatus.OPEN);
        const isFinal = (value: QuestStatus) =>
            value === QuestStatus.COMPLETED || value === QuestStatus.FAILED;
        if (isFinal(currentStatus) && canonicalStatus !== currentStatus) return quest;

        const now = timestamp || Date.now();
        db.transaction(() => {
            db.prepare(`
                UPDATE quests
                SET status = ?, last_updated = ?, rag_sync_needed = 1
                WHERE id = ?
            `).run(canonicalStatus, now, quest.id);
            questRepository.addQuestEvent(
                campaignId,
                quest.title,
                sessionId,
                description || `Stato aggiornato a ${canonicalStatus}.`,
                canonicalStatus === QuestStatus.COMPLETED
                    ? 'COMPLETED'
                    : canonicalStatus === QuestStatus.FAILED
                        ? 'FAILED'
                        : 'PROGRESS',
                false,
                now
            );
        })();
        return db.prepare('SELECT * FROM quests WHERE id = ?').get(quest.id) as Quest;
    },

    updateQuestByShortId: (
        campaignId: number,
        shortId: string,
        fields: { title: string; description?: string | null; status: QuestStatus; type: QuestType; sessionId?: string | null }
    ): Quest | null => {
        const quest = questRepository.getQuestByShortId(campaignId, shortId);
        if (!quest) return null;
        const title = cleanQuestTitle(fields.title || '').trim();
        if (!title) throw new Error('Quest title is required');
        const status = requireQuestStatus(fields.status);
        const type = requireQuestType(fields.type);
        const duplicate = db.prepare(
            'SELECT 1 FROM quests WHERE campaign_id = ? AND lower(title) = lower(?) AND id <> ?'
        ).get(campaignId, title, quest.id);
        if (duplicate) throw new Error('A quest with this title already exists');

        const now = Date.now();
        const description = fields.description?.trim() || null;
        db.transaction(() => {
            db.prepare(`
                UPDATE quests
                SET title = ?, description = ?, status = ?, type = ?, session_id = COALESCE(?, session_id),
                    last_updated = ?, rag_sync_needed = 1, is_manual = 1, manual_description = ?
                WHERE id = ?
            `).run(title, description, status, type, fields.sessionId || null, now, description, quest.id);
            db.prepare(`
                UPDATE quest_history SET quest_title = ?
                WHERE campaign_id = ? AND (entity_id = ? OR (entity_id IS NULL AND lower(quest_title) = lower(?)))
            `).run(title, campaignId, quest.id, quest.title);
            questRepository.addQuestEvent(
                campaignId,
                title,
                fields.sessionId || '',
                description || `Quest aggiornata manualmente con stato ${status}.`,
                'MANUAL_UPDATE',
                true,
                now
            );
            if (title !== quest.title) {
                knowledgeRepository.deleteQuestRagSummary(campaignId, quest.title);
            }
        })();
        return db.prepare('SELECT * FROM quests WHERE id = ?').get(quest.id) as Quest;
    },

    updateQuestFields: (questId: number, fields: Partial<Quest>): boolean => {
        const normalizedFields: Partial<Quest> = { ...fields };
        if (fields.status !== undefined) normalizedFields.status = requireQuestStatus(fields.status);
        if (fields.type !== undefined) normalizedFields.type = requireQuestType(fields.type);
        const keys = Object.keys(normalizedFields).filter(k => k !== 'id');
        if (keys.length === 0) return false;

        let sets = keys.map(k => `${k} = ?`).join(', ');
        const values = keys.map(k => (normalizedFields as any)[k]);

        if ((normalizedFields as any).description && (normalizedFields as any).is_manual) {
            const desc = (normalizedFields as any).description;
            sets += `, manual_description = ?`;
            values.push(desc);
        }
        values.push(Date.now()); // last_updated
        values.push(questId);

        const result = db.prepare(`
            UPDATE quests 
            SET ${sets}, last_updated = ?, rag_sync_needed = 1 
            WHERE id = ?
        `).run(...values);
        return result.changes > 0;
    },

    deleteQuest: (questId: number): boolean => {
        const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId) as Quest | undefined;
        if (!quest) return false;
        let changes = 0;
        db.transaction(() => {
            knowledgeRepository.deleteQuestRagSummary(quest.campaign_id, quest.title);
            db.prepare('DELETE FROM quest_lifecycle_suggestions WHERE campaign_id = ? AND quest_id = ?')
                .run(quest.campaign_id, quest.id);
            db.prepare(`
                DELETE FROM quest_history
                WHERE campaign_id = ? AND (entity_id = ? OR (entity_id IS NULL AND lower(quest_title) = lower(?)))
            `).run(quest.campaign_id, quest.id, quest.title);
            changes = db.prepare('DELETE FROM quests WHERE id = ?').run(quest.id).changes;
        })();
        return changes > 0;
    },

    deleteQuestHistory: (campaignId: number, title: string): boolean => {
        const result = db.prepare('DELETE FROM quest_history WHERE campaign_id = ? AND lower(quest_title) = lower(?)').run(campaignId, title);
        return result.changes > 0;
    },

    getOpenQuests: (campaignId: number, limit: number = 20, offset: number = 0): Quest[] => {
        return db.prepare(`SELECT * FROM quests WHERE campaign_id = ? AND status IN ('OPEN', 'IN_PROGRESS') LIMIT ? OFFSET ?`).all(campaignId, limit, offset) as Quest[];
    },

    countOpenQuests: (campaignId: number): number => {
        const result = db.prepare(`SELECT COUNT(*) as count FROM quests WHERE campaign_id = ? AND status IN ('OPEN', 'IN_PROGRESS')`).get(campaignId) as { count: number };
        return result.count;
    },

    getQuestsByStatus: (campaignId: number, status: string, limit: number = 20, offset: number = 0): Quest[] => {
        const s = status.toUpperCase();
        if (s === 'ALL') {
            return db.prepare('SELECT * FROM quests WHERE campaign_id = ? ORDER BY last_updated DESC LIMIT ? OFFSET ?').all(campaignId, limit, offset) as Quest[];
        }
        if (s === 'ACTIVE' || s === 'APERTE') {
            return questRepository.getOpenQuests(campaignId, limit, offset);
        }
        if (s === 'CLOSED' || s === 'CHIUSE') {
            return db.prepare(`SELECT * FROM quests WHERE campaign_id = ? AND status IN ('COMPLETED', 'FAILED') ORDER BY last_updated DESC LIMIT ? OFFSET ?`).all(campaignId, limit, offset) as Quest[];
        }
        return db.prepare('SELECT * FROM quests WHERE campaign_id = ? AND status = ? ORDER BY last_updated DESC LIMIT ? OFFSET ?').all(campaignId, s, limit, offset) as Quest[];
    },

    countQuestsByStatus: (campaignId: number, status: string): number => {
        const s = status.toUpperCase();
        if (s === 'ALL') {
            const result = db.prepare('SELECT COUNT(*) as count FROM quests WHERE campaign_id = ?').get(campaignId) as { count: number };
            return result.count;
        }
        if (s === 'ACTIVE' || s === 'APERTE') {
            return questRepository.countOpenQuests(campaignId);
        }
        if (s === 'CLOSED' || s === 'CHIUSE') {
            const result = db.prepare(`SELECT COUNT(*) as count FROM quests WHERE campaign_id = ? AND status IN ('COMPLETED', 'FAILED')`).get(campaignId) as { count: number };
            return result.count;
        }
        const result = db.prepare('SELECT COUNT(*) as count FROM quests WHERE campaign_id = ? AND status = ?').get(campaignId, s) as { count: number };
        return result.count;
    },

    listAllQuests: (campaignId: number): Quest[] => {
        return db.prepare('SELECT * FROM quests WHERE campaign_id = ? ORDER BY last_updated DESC').all(campaignId) as Quest[];
    },

    getQuestByTitle: (campaignId: number, title: string): Quest | null => {
        return db.prepare('SELECT * FROM quests WHERE campaign_id = ? AND lower(title) = lower(?)')
            .get(campaignId, title) as Quest | undefined ?? null;
    },

    getQuestById: (campaignId: number, questId: number): Quest | null =>
        db.prepare('SELECT * FROM quests WHERE campaign_id = ? AND id = ?')
            .get(campaignId, questId) as Quest | undefined ?? null,

    getQuestByShortId: (campaignId: number, shortId: string): Quest | null =>
        getByShortId<Quest>('quests', campaignId, shortId) ?? null,

    mergeQuests: (
        campaignId: number,
        oldTitle: string,
        newTitle: string,
        mergedDescription?: string
    ): boolean => {
        const source = questRepository.getQuestByTitle(campaignId, oldTitle);
        if (!source) return false;

        const target = questRepository.getQuestByTitle(campaignId, newTitle);

        db.transaction(() => {
            if (target) {
                // Merge: Delete source, keep target
                db.prepare('DELETE FROM quests WHERE id = ?').run(source.id);

                if (mergedDescription) {
                    db.prepare('UPDATE quests SET description = ?, last_updated = ?, rag_sync_needed = 1 WHERE id = ?')
                        .run(mergedDescription, Date.now(), target.id);
                }
            } else {
                // Rename
                db.prepare('UPDATE quests SET title = ?, last_updated = ?, rag_sync_needed = 1 WHERE id = ?')
                    .run(newTitle, Date.now(), source.id);

                if (mergedDescription) {
                    db.prepare('UPDATE quests SET description = ?, last_updated = ?, rag_sync_needed = 1 WHERE id = ?')
                        .run(mergedDescription, Date.now(), source.id);
                }
            }

            // Move history (name + entity_id: follows the merge/rename target)
            const historyTargetId = target ? target.id : source.id;
            db.prepare(`
                UPDATE quest_history
                SET quest_title = ?, entity_id = ?
                WHERE campaign_id = ?
                  AND (entity_id = ? OR (entity_id IS NULL AND lower(quest_title) = lower(?)))
            `).run(newTitle, historyTargetId, campaignId, source.id, oldTitle);
        })();

        console.log(`[Quest] 🔀 Merge/Rename: ${oldTitle} -> ${newTitle}`);
        return true;
    },
    addQuestEvent: (campaignId: number, title: string, sessionId: string, description: string, type: string, isManual: boolean = false, timestamp?: number) => {
        const entityId = resolveEntityId('quests', 'title', campaignId, title);
        db.prepare(`
            INSERT INTO quest_history (campaign_id, quest_title, session_id, description, event_type, timestamp, is_manual, entity_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(campaignId, title, sessionId, description, type, timestamp || Date.now(), isManual ? 1 : 0, entityId);
    },

    getQuestHistory: (campaignId: number, title: string): any[] => {
        return getHistoryByEntity('quest_history', 'quest_title', 'quests', 'title', campaignId, title);
    },

    updateQuestDescription: (campaignId: number, title: string, description: string) => {
        db.prepare(`
            UPDATE quests 
            SET description = ?, rag_sync_needed = 1, last_updated = ?
            WHERE campaign_id = ? AND lower(title) = lower(?)
        `).run(description, Date.now(), campaignId, title);
    },

    markQuestDirty: (campaignId: number, title: string) => {
        db.prepare('UPDATE quests SET rag_sync_needed = 1 WHERE campaign_id = ? AND lower(title) = lower(?)').run(campaignId, title);
    },

    getDirtyQuests: (campaignId: number): Quest[] => {
        return db.prepare('SELECT * FROM quests WHERE campaign_id = ? AND rag_sync_needed = 1').all(campaignId) as Quest[];
    },

    clearQuestDirtyFlag: (campaignId: number, title: string) => {
        db.prepare('UPDATE quests SET rag_sync_needed = 0 WHERE campaign_id = ? AND lower(title) = lower(?)').run(campaignId, title);
    }
};
