/**
 * Bard reconciliation - Quest: spec for the generic factory
 * (see entityReconciler.ts). Public exports unchanged.
 */

import { listAllQuests } from '../../db';
import { AI_CONFIRM_SAME_QUEST_PROMPT, AI_CONFIRM_SAME_QUEST_SEMANTIC_PROMPT } from '../prompts';
import { aiConfirmSameEntity } from './semantic';
import { createNameReconciler, createBatchDeduper } from './entityReconciler';

type QuestInput = { title: string; status?: string };

const reconcile = createNameReconciler<any>({
    label: 'Quest Reconcile',
    listEntities: listAllQuests,
    getName: q => q.title,
    getDescription: q => q.description || '',
    nameThreshold: () => 0.6,
    substringScore: 0.7,
    semanticFragmentType: 'QUEST_UPDATE',
    confirmNamePrompt: AI_CONFIRM_SAME_QUEST_PROMPT,
    confirmSemanticPrompt: AI_CONFIRM_SAME_QUEST_SEMANTIC_PROMPT,
});

/**
 * Finds the canonical title when a similar quest exists.
 * `newDescription` enables the semantic fallback (quest titles drift a lot:
 * same mission, different titles → matching on the name alone is nearly useless).
 */
export async function reconcileQuestTitle(
    campaignId: number,
    newTitle: string,
    newDescription: string = ''
): Promise<{ canonicalTitle: string; existingQuest: any } | null> {
    const match = await reconcile(campaignId, newTitle, newDescription);
    return match ? { canonicalTitle: match.canonicalName, existingQuest: match.existing } : null;
}

/**
 * Pre-deduplica un batch di quest.
 */
export const deduplicateQuestBatch = createBatchDeduper<QuestInput>({
    label: 'Quest Batch Dedup',
    getKey: q => q.title,
    threshold: 0.6,
    confirm: (a, b) => aiConfirmSameEntity(AI_CONFIRM_SAME_QUEST_PROMPT(a, b, ''), 'Quest Reconcile'),
    merge: (merged, other) => {
        if (other.title.length > merged.title.length) merged.title = other.title;
        merged.status = merged.status || other.status;
    },
});
