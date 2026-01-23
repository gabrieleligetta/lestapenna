/**
 * Bard Reconciliation - Quest reconciliation
 */

import { listAllQuests } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinSimilarity, containsSubstring } from '../helpers';
import { AI_CONFIRM_SAME_QUEST_PROMPT } from '../prompts';

/**
 * Chiede all'AI se due quest sono la stessa missione.
 */
async function aiConfirmSameQuest(title1: string, title2: string, context: string = ""): Promise<boolean> {
    const prompt = AI_CONFIRM_SAME_QUEST_PROMPT(title1, title2, context);

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Quest Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il titolo canonico se esiste una quest simile.
 */
export async function reconcileQuestTitle(
    campaignId: number,
    newTitle: string
): Promise<{ canonicalTitle: string; existingQuest: any } | null> {
    const existingQuests = listAllQuests(campaignId);
    if (existingQuests.length === 0) return null;

    const newTitleLower = newTitle.toLowerCase().trim();

    const exactMatch = existingQuests.find((q: any) => q.title.toLowerCase() === newTitleLower);
    if (exactMatch) return null;

    const candidates: Array<{ quest: any; similarity: number; reason: string }> = [];

    for (const quest of existingQuests) {
        const existingTitle = quest.title;
        const similarity = levenshteinSimilarity(newTitle, existingTitle);

        if (similarity >= 0.6) {
            candidates.push({ quest, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        if (containsSubstring(newTitle, existingTitle)) {
            candidates.push({ quest, similarity: 0.7, reason: 'substring_match' });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    for (const candidate of candidates.slice(0, 3)) {
        console.log(`[Quest Reconcile] 🔍 "${newTitle}" simile a "${candidate.quest.title}" (${candidate.reason}). Chiedo conferma AI...`);

        const isSame = await aiConfirmSameQuest(newTitle, candidate.quest.title);

        if (isSame) {
            console.log(`[Quest Reconcile] ✅ CONFERMATO: "${newTitle}" = "${candidate.quest.title}"`);
            return { canonicalTitle: candidate.quest.title, existingQuest: candidate.quest };
        } else {
            console.log(`[Quest Reconcile] ❌ "${newTitle}" ≠ "${candidate.quest.title}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di quest.
 */
export async function deduplicateQuestBatch(
    quests: Array<{ title: string; status?: string }>
): Promise<Array<{ title: string; status?: string }>> {
    if (quests.length <= 1) return quests;

    const result: typeof quests = [];
    const processed = new Set<number>();

    for (let i = 0; i < quests.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...quests[i] };
        processed.add(i);

        for (let j = i + 1; j < quests.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged.title, quests[j].title);
            const hasSubstring = containsSubstring(merged.title, quests[j].title);

            if (similarity > 0.6 || hasSubstring) {
                const isSame = await aiConfirmSameQuest(merged.title, quests[j].title);

                if (isSame) {
                    console.log(`[Quest Batch Dedup] 🔄 "${quests[j].title}" → "${merged.title}"`);
                    if (quests[j].title.length > merged.title.length) {
                        merged.title = quests[j].title;
                    }
                    merged.status = merged.status || quests[j].status;
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < quests.length) {
        console.log(`[Quest Batch Dedup] ✅ Ridotti ${quests.length} quest a ${result.length}`);
    }

    return result;
}
