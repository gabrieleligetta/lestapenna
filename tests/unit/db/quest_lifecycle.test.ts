import {
    QuestStatus,
    db,
    normalizeQuestStatus,
    normalizeQuestType,
    questLifecycleRepository,
    questRepository,
    sessionRepository,
} from '../../../src/db';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { knowledgeRepository } from '../../../src/db/repositories/KnowledgeRepository';

describe('Quest lifecycle canonical contract', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = campaignRepository.createCampaign(
            `quest-lifecycle-${Date.now()}`,
            'Quest lifecycle tests',
        );
    });

    afterAll(() => {
        campaignRepository.deleteCampaign(campaignId);
    });

    test('normalizes legacy inputs but persists only the four canonical statuses and two types', () => {
        expect(normalizeQuestStatus('in corso')).toBe(QuestStatus.IN_PROGRESS);
        expect(normalizeQuestStatus('done')).toBe(QuestStatus.COMPLETED);
        expect(normalizeQuestStatus('FALLITA')).toBe(QuestStatus.FAILED);
        expect(normalizeQuestType('minor')).toBe('MINOR');
        expect(normalizeQuestType('side')).toBeNull();

        expect(() => db.prepare(`
            INSERT INTO quests (
                campaign_id, title, description, status, type, created_at, last_updated, short_id
            ) VALUES (?, ?, '', 'IN CORSO', 'MAJOR', ?, ?, ?)
        `).run(campaignId, 'Invalid enum quest', Date.now(), Date.now(), 'bad01'))
            .toThrow(/invalid quest status/i);
    });

    test('AI transitions are ID-first, preserve manual content and cannot reopen a terminal quest', () => {
        const quest = questRepository.createManualQuest(campaignId, {
            title: 'The Imperial Audience',
            description: 'DM-authored description',
            status: QuestStatus.IN_PROGRESS,
            type: 'MAJOR',
        });

        const completed = questRepository.applyAiStatusByShortId(
            campaignId,
            quest.short_id!,
            QuestStatus.COMPLETED,
            'session-completion',
            'The audience concluded and the objective was achieved.',
        )!;
        expect(completed.status).toBe(QuestStatus.COMPLETED);
        expect(completed.description).toBe('DM-authored description');
        expect((completed as any).manual_description).toBe('DM-authored description');
        expect((completed as any).is_manual).toBe(1);

        const stillCompleted = questRepository.applyAiStatusByShortId(
            campaignId,
            quest.short_id!,
            QuestStatus.IN_PROGRESS,
            'session-regression',
            'A later mention must not reopen it.',
        )!;
        expect(stillCompleted.status).toBe(QuestStatus.COMPLETED);
    });

    test('replaying the same session cannot recreate or reapply its lifecycle decision', () => {
        const sessionId = `quest-lifecycle-replay-${Date.now()}`;
        sessionRepository.createSession(sessionId, 'quest-lifecycle-tests', campaignId);
        const quest = questRepository.createManualQuest(campaignId, {
            title: 'Idempotent transition',
            status: QuestStatus.IN_PROGRESS,
            type: 'MAJOR',
        });
        const input = {
            campaignId,
            questId: quest.id,
            sessionId,
            proposedAction: 'STATUS_CHANGE' as const,
            proposedTitle: quest.title,
            proposedStatus: QuestStatus.COMPLETED,
            proposedType: 'MAJOR' as const,
            evidence: 'The exact objective was achieved.',
            confidence: 'HIGH' as const,
        };
        const first = questLifecycleRepository.createSuggestion(input);
        questLifecycleRepository.resolveSuggestion(campaignId, first.id, 'APPLIED');
        const replay = questLifecycleRepository.createSuggestion(input);

        expect(replay.id).toBe(first.id);
        expect(replay.status).toBe('APPLIED');
        expect(questLifecycleRepository.listSuggestions(campaignId, 'ALL')
            .filter(row => row.session_id === sessionId)).toHaveLength(1);
    });

    test('hard delete removes the quest, history, lifecycle proposals and official RAG card', () => {
        const quest = questRepository.createManualQuest(campaignId, {
            title: 'Quest to purge',
            description: 'Temporary',
            status: QuestStatus.OPEN,
            type: 'MINOR',
        });
        questLifecycleRepository.createSuggestion({
            campaignId,
            questId: quest.id,
            proposedAction: 'STATUS_CHANGE',
            proposedTitle: quest.title,
            proposedDescription: 'Historical proposal',
            proposedStatus: QuestStatus.FAILED,
            proposedType: 'MINOR',
            evidence: 'The objective became impossible.',
            confidence: 'MEDIUM',
        });
        knowledgeRepository.insertKnowledgeFragment(
            campaignId,
            'QUEST_UPDATE',
            `[[SCHEDA QUEST UFFICIALE: ${quest.title}]]\nTemporary`,
            [0.1, 0.2],
            'test-model',
        );

        expect(questRepository.deleteQuest(quest.id)).toBe(true);
        expect(questRepository.getQuestByShortId(campaignId, quest.short_id!)).toBeNull();
        expect(db.prepare(
            'SELECT COUNT(*) AS count FROM quest_history WHERE campaign_id = ? AND entity_id = ?',
        ).get(campaignId, quest.id)).toEqual({ count: 0 });
        expect(questLifecycleRepository.listSuggestions(campaignId, 'ALL'))
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ quest_id: quest.id })]));
        expect(db.prepare(`
            SELECT COUNT(*) AS count FROM knowledge_fragments
            WHERE campaign_id = ? AND session_id = 'QUEST_UPDATE' AND INSTR(content, ?) > 0
        `).get(campaignId, `: ${quest.title}]]`)).toEqual({ count: 0 });
    });
});
