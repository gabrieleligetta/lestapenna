/**
 * Bard Reconciliation - NPC name reconciliation
 */

import { listNpcs } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinSimilarity, containsSubstring } from '../helpers';
import { searchKnowledge } from '../rag';
import {
    AI_CONFIRM_SAME_PERSON_EXTENDED_PROMPT,
    AI_CONFIRM_SAME_PERSON_PROMPT,
    SMART_MERGE_PROMPT
} from '../prompts';

/**
 * Versione POTENZIATA: Chiede all'AI se due nomi sono la stessa persona usando RAG + Fonetica
 */
async function aiConfirmSamePersonExtended(
    campaignId: number,
    newName: string,
    newDescription: string,
    candidateName: string,
    candidateDescription: string
): Promise<boolean> {

    const ragQuery = `Chi è ${newName}? ${newDescription}`;
    const ragContext = await searchKnowledge(campaignId, ragQuery, 2);

    const relevantFragments = ragContext.filter(f =>
        f.toLowerCase().includes(candidateName.toLowerCase())
    );

    const ragContextText = relevantFragments.length > 0
        ? `\nMEMORIA STORICA RILEVANTE:\n${relevantFragments.join('\n')}`
        : "";

    const prompt = AI_CONFIRM_SAME_PERSON_EXTENDED_PROMPT(newName, newDescription, candidateName, candidateDescription, ragContextText);

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Chiede all'AI se due nomi si riferiscono alla stessa persona.
 */
export async function aiConfirmSamePerson(name1: string, name2: string, context: string = ""): Promise<boolean> {
    const prompt = AI_CONFIRM_SAME_PERSON_PROMPT(name1, name2, context);

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il nome canonico se esiste un NPC simile nel dossier.
 */
export async function reconcileNpcName(
    campaignId: number,
    newName: string,
    newDescription: string = ""
): Promise<{ canonicalName: string; existingNpc: any } | null> {
    const existingNpcs = listNpcs(campaignId);
    if (existingNpcs.length === 0) return null;

    const newNameLower = newName.toLowerCase().trim();

    const exactMatch = existingNpcs.find((n: any) => n.name.toLowerCase() === newNameLower);
    if (exactMatch) return null;

    const candidates: Array<{ npc: any; similarity: number; reason: string }> = [];

    for (const npc of existingNpcs) {
        const existingName = npc.name;
        const similarity = levenshteinSimilarity(newName, existingName);

        const minLen = Math.min(newName.length, existingName.length);
        const threshold = minLen < 6 ? 0.7 : 0.6;

        if (similarity >= threshold) {
            candidates.push({ npc, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        if (containsSubstring(newName, existingName)) {
            candidates.push({ npc, similarity: 0.8, reason: 'substring_match' });
            continue;
        }

        const newParts = newName.toLowerCase().split(/\s+/);
        const existingParts = existingName.toLowerCase().split(/\s+/);

        for (const np of newParts) {
            for (const ep of existingParts) {
                if (np.length > 3 && ep.length > 3 && levenshteinSimilarity(np, ep) > 0.8) {
                    candidates.push({ npc, similarity: 0.75, reason: `part_match: ${np}≈${ep}` });
                }
            }
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);
    const bestCandidate = candidates[0];

    console.log(`[Reconcile] 🔍 "${newName}" simile a "${bestCandidate.npc.name}" (${bestCandidate.reason}). Avvio Deep Check (RAG)...`);

    const isSame = await aiConfirmSamePersonExtended(
        campaignId,
        newName,
        newDescription,
        bestCandidate.npc.name,
        bestCandidate.npc.description || ""
    );

    if (isSame) {
        console.log(`[Reconcile] ✅ CONFERMATO: "${newName}" = "${bestCandidate.npc.name}"`);
        return { canonicalName: bestCandidate.npc.name, existingNpc: bestCandidate.npc };
    } else {
        console.log(`[Reconcile] ❌ "${newName}" ≠ "${bestCandidate.npc.name}"`);
    }

    return null;
}

/**
 * Pre-deduplica un batch di NPC updates PRIMA di salvarli.
 */
export async function deduplicateNpcBatch(
    npcs: Array<{ name: string; description: string; role?: string; status?: string }>
): Promise<Array<{ name: string; description: string; role?: string; status?: string }>> {
    if (npcs.length <= 1) return npcs;

    const result: Array<{ name: string; description: string; role?: string; status?: string }> = [];
    const processed = new Set<number>();

    for (let i = 0; i < npcs.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...npcs[i] };
        processed.add(i);

        for (let j = i + 1; j < npcs.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged.name, npcs[j].name);
            const hasSubstring = containsSubstring(merged.name, npcs[j].name);

            if (similarity > 0.7 || hasSubstring) {
                const isSame = await aiConfirmSamePerson(merged.name, npcs[j].name);

                if (isSame) {
                    console.log(`[Batch Dedup] 🔄 "${npcs[j].name}" → "${merged.name}"`);
                    if (npcs[j].name.length > merged.name.length) {
                        merged.name = npcs[j].name;
                    }
                    if (npcs[j].description && npcs[j].description !== merged.description) {
                        merged.description = `${merged.description} ${npcs[j].description}`;
                    }
                    merged.role = merged.role || npcs[j].role;
                    merged.status = merged.status || npcs[j].status;

                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < npcs.length) {
        console.log(`[Batch Dedup] ✅ Ridotti ${npcs.length} NPC a ${result.length}`);
    }

    return result;
}

/**
 * Unisce due biografie/descrizioni in modo intelligente mantenendo i dettagli unici.
 */
export async function smartMergeBios(bio1: string, bio2: string): Promise<string> {
    if (!bio1) return bio2;
    if (!bio2) return bio1;
    if (bio1 === bio2) return bio1;

    const prompt = SMART_MERGE_PROMPT(bio1, bio2);

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }]
        });
        return response.choices[0].message.content || bio1 + "\n" + bio2;
    } catch (e) {
        console.error("Error smart merging bios:", e);
        return bio1 + "\n" + bio2;
    }
}

/**
 * Compatibility wrapper for IdentityGuard
 */
export async function resolveIdentityCandidate(campaignId: number, name: string, description: string) {
    const result = await reconcileNpcName(campaignId, name, description);
    if (result) {
        return { match: result.canonicalName, confidence: 1.0 };
    }
    return { match: null, confidence: 0 };
}

