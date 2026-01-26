/**
 * Bard Reconciliation - NPC name reconciliation
 */

import { getAllNpcs } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinSimilarity, containsSubstring, stripPrefix } from '../helpers';
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
    const existingNpcs = getAllNpcs(campaignId);
    if (existingNpcs.length === 0) return null;

    const newNameLower = newName.toLowerCase().trim();

    const exactMatch = existingNpcs.find((n: any) => n.name.toLowerCase() === newNameLower);
    if (exactMatch) {
        console.log(`[Reconcile] ✅ Match esatto (case-insensitive): "${newName}" = "${exactMatch.name}"`);
        return { canonicalName: exactMatch.name, existingNpc: exactMatch };
    }

    const newNameClean = stripPrefix(newName.toLowerCase());
    const candidates: Array<{ npc: any; similarity: number; reason: string }> = [];

    for (const npc of existingNpcs) {
        const existingName = npc.name;
        const existingNameClean = stripPrefix(existingName.toLowerCase());

        // 1. Clean Levenshtein
        const similarity = levenshteinSimilarity(newNameClean, existingNameClean);
        const minLen = Math.min(newNameClean.length, existingNameClean.length);
        const threshold = minLen < 6 ? 0.75 : 0.65; // Slightly stricter for short names

        if (similarity >= threshold) {
            candidates.push({ npc, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        // 2. Substring Match (Boosted)
        if (containsSubstring(newName, existingName)) {
            candidates.push({ npc, similarity: 0.85, reason: 'substring_match' });
            continue;
        }

        // 3. Significant Token Overlap (Boosted for multi-word names)
        const stopWords = ['del', 'della', 'dei', 'di', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'uno'];
        const newParts = newName.toLowerCase().split(/\s+/).filter(p => p.length > 2 && !stopWords.includes(p));
        const existingParts = existingName.toLowerCase().split(/\s+/).filter(p => p.length > 2 && !stopWords.includes(p));

        let matchCount = 0;
        for (const np of newParts) {
            for (const ep of existingParts) {
                if (levenshteinSimilarity(np, ep) > 0.85) {
                    matchCount++;
                }
            }
        }

        if (matchCount > 0) {
            // If all significant parts of shorter name match, high confidence
            const minParts = Math.min(newParts.length, existingParts.length);
            if (matchCount >= minParts) {
                // Perfect overlap of significant tokens
                const bonus = (newParts.length === existingParts.length) ? 0.15 : 0.05;
                candidates.push({ npc, similarity: 0.85 + bonus, reason: `full_token_overlap (${matchCount}/${minParts})` });
            } else if (matchCount >= 1 && minParts >= 2) {
                // Partial overlap
                candidates.push({ npc, similarity: 0.6 + (0.1 * matchCount), reason: `partial_token_overlap (${matchCount})` });
            }
        }
    }

    // 4. NEW: Semantic/RAG Candidate Discovery (If string matching is weak)
    // If we have very few high-quality candidates, use RAG to find who this description talks about
    if (candidates.filter(c => c.similarity > 0.8).length === 0) {
        console.log(`[Reconcile] 🧠 Ricerca candidati semantici (RAG) per "${newName}"...`);
        try {
            // Search for context about this new person
            const ragQuery = `Chi è ${newName}? ${newDescription}`;
            const ragContext = await searchKnowledge(campaignId, ragQuery, 3); // Get top 3 chunks

            // Extract potential names from RAG chunks by checking our known NPC list against the found text
            // This is "inverse search" - check if any KNOWN npc is mentioned in the RAG text
            for (const npc of existingNpcs) {
                // Skip if already in candidates
                if (candidates.some(c => c.npc.name === npc.name)) continue;

                // Check if this NPC is mentioned in the retrieved context
                const foundInContext = ragContext.some(chunk => chunk.toLowerCase().includes(npc.name.toLowerCase()));

                if (foundInContext) {
                    candidates.push({ npc, similarity: 0.75, reason: 'rag_context_match' });
                }
            }
        } catch (e) {
            console.error(`[Reconcile] ⚠️ Error during RAG candidate search:`, e);
        }
    }

    if (candidates.length === 0) return null;

    // Sort by similarity descending
    candidates.sort((a, b) => b.similarity - a.similarity);

    // Consider TOP 3 Candidates (not just 1)
    const topCandidates = candidates.slice(0, 3);
    console.log(`[Reconcile] 🔍 "${newName}" vs ${topCandidates.length} candidati: ${topCandidates.map(c => `${c.npc.name}(${c.similarity.toFixed(2)})`).join(', ')}`);

    for (const candidate of topCandidates) {
        // SUPER-MATCH: If similarity is extremely high, accept immediately without AI
        if (candidate.similarity >= 0.90) {
            console.log(`[Reconcile] ⚡ AUTO-MERGE (High Sim): "${newName}" → "${candidate.npc.name}" (${candidate.reason})`);
            return { canonicalName: candidate.npc.name, existingNpc: candidate.npc };
        }

        console.log(`[Reconcile] 🤔 Checking candidate: "${candidate.npc.name}" (${candidate.reason})...`);

        const isSame = await aiConfirmSamePersonExtended(
            campaignId,
            newName,
            newDescription,
            candidate.npc.name,
            candidate.npc.description || ""
        );

        if (isSame) {
            console.log(`[Reconcile] ✅ CONFERMATO: "${newName}" = "${candidate.npc.name}"`);
            return { canonicalName: candidate.npc.name, existingNpc: candidate.npc };
        } else {
            console.log(`[Reconcile] ❌ Rifiutato: "${candidate.npc.name}"`);
        }
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

