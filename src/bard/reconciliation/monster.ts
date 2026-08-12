/**
 * Bard reconciliation - Monster (bestiary): spec for the generic factory
 * (see entityReconciler.ts). Public exports unchanged.
 */

import { listAllMonsters } from '../../db';
import { AI_CONFIRM_SAME_MONSTER_PROMPT, AI_CONFIRM_SAME_MONSTER_SEMANTIC_PROMPT } from '../prompts';
import { aiConfirmSameEntity } from './semantic';
import { createNameReconciler, createBatchDeduper } from './entityReconciler';

type MonsterInput = {
    name: string;
    status?: string;
    description?: string;
    abilities?: string[];
    weaknesses?: string[];
    resistances?: string[];
};

const reconcile = createNameReconciler<any>({
    label: 'Monster Reconcile',
    listEntities: listAllMonsters,
    getName: m => m.name,
    getDescription: m => m.description || '',
    // Short names (goblin, orc…) need more similarity to become candidates.
    nameThreshold: (a, b) => Math.min(a.length, b.length) < 6 ? 0.7 : 0.6,
    substringScore: 0.8,
    semanticFragmentType: 'BESTIARY_UPDATE',
    // VERY conservative: it is for unique creatures named differently,
    // not for different specimens of the same species.
    semanticThreshold: 0.78,
    confirmNamePrompt: AI_CONFIRM_SAME_MONSTER_PROMPT,
    confirmSemanticPrompt: AI_CONFIRM_SAME_MONSTER_SEMANTIC_PROMPT,
    passDescriptionToNameConfirm: true,
});

/**
 * Finds the canonical name when a similar monster exists in the bestiary.
 */
export async function reconcileMonsterName(
    campaignId: number,
    newName: string,
    newDescription: string = ''
): Promise<{ canonicalName: string; existingMonster: any } | null> {
    const match = await reconcile(campaignId, newName, newDescription);
    return match ? { canonicalName: match.canonicalName, existingMonster: match.existing } : null;
}

/**
 * Pre-deduplica un batch di mostri.
 */
export const deduplicateMonsterBatch = createBatchDeduper<MonsterInput>({
    label: 'Monster Batch Dedup',
    getKey: m => m.name,
    threshold: 0.7,
    confirm: (a, b) => aiConfirmSameEntity(AI_CONFIRM_SAME_MONSTER_PROMPT(a, b, ''), 'Monster Reconcile'),
    merge: (merged, other) => {
        if (other.name.length > merged.name.length) merged.name = other.name;
        merged.description = merged.description || other.description;
        merged.abilities = [...new Set([...(merged.abilities || []), ...(other.abilities || [])])];
        merged.weaknesses = [...new Set([...(merged.weaknesses || []), ...(other.weaknesses || [])])];
        merged.resistances = [...new Set([...(merged.resistances || []), ...(other.resistances || [])])];
        if (other.status === 'DEFEATED') merged.status = 'DEFEATED'; // the defeated state is "sticky"
    },
});
