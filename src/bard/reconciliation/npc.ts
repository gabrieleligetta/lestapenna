/**
 * Bard Reconciliation - NPC name reconciliation
 */

import { getAllNpcs, npcRepository } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinDistance, levenshteinSimilarity, containsSubstring, stripPrefix } from '../helpers';
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
    candidateDescription: string,
    cachedContext?: string[] // NEW: Optional cached context from previous search
): Promise<boolean> {

    let ragContextText = "";

    if (cachedContext && cachedContext.length > 0) {
        // Use pre-fetched context directly (trusting the caller filter)
        ragContextText = `\nMEMORIA STORICA RILEVANTE (Context Hit):\n${cachedContext.join('\n')}`;
    } else {
        // Fallback to internal search
        const ragQuery = `Chi è ${newName}? ${newDescription}`;
        const ragContext = await searchKnowledge(campaignId, ragQuery, 2);

        const relevantFragments = ragContext.filter(f =>
            f.toLowerCase().includes(candidateName.toLowerCase())
        );

        ragContextText = relevantFragments.length > 0
            ? `\nMEMORIA STORICA RILEVANTE:\n${relevantFragments.join('\n')}`
            : "";
    }

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
 * @param playerCharacters - Lista opzionale di nomi dei PG da escludere (non sono NPC)
 */
export async function reconcileNpcName(
    campaignId: number,
    newName: string,
    newDescription: string = "",
    playerCharacters: string[] = []
): Promise<{ canonicalName: string; existingNpc: any; isPlayerCharacter?: boolean; confidence?: number } | null> {
    // -1. PC Check (Highest Priority) - Skip if this is a player character
    if (playerCharacters.length > 0) {
        const newNameLower = newName.toLowerCase().trim();
        const pcNamesLower = playerCharacters.map(n => n.toLowerCase().trim());

        for (const pcName of pcNamesLower) {
            // Exact match
            if (newNameLower === pcName) {
                console.log(`[Reconcile] 🎮 "${newName}" è un PG (match esatto) - SKIP`);
                return { canonicalName: newName, existingNpc: null, isPlayerCharacter: true };
            }

            // Levenshtein similarity for typos (e.g., "Fainar" vs "Sainar")
            const similarity = levenshteinSimilarity(newNameLower, pcName);
            if (similarity >= 0.7) {
                const pcOriginal = playerCharacters.find(p => p.toLowerCase().trim() === pcName);
                console.log(`[Reconcile] 🎮 "${newName}" sembra il PG "${pcOriginal}" (sim=${similarity.toFixed(2)}) - SKIP`);
                return { canonicalName: pcOriginal || newName, existingNpc: null, isPlayerCharacter: true };
            }

            // Substring check for partial names
            if (newNameLower.includes(pcName) || pcName.includes(newNameLower)) {
                const pcOriginal = playerCharacters.find(p => p.toLowerCase().trim() === pcName);
                console.log(`[Reconcile] 🎮 "${newName}" contiene/è contenuto in PG "${pcOriginal}" - SKIP`);
                return { canonicalName: pcOriginal || newName, existingNpc: null, isPlayerCharacter: true };
            }
        }
    }

    // 0. ID Match (Highest Priority)
    // Cerca pattern come [#abc12] o semplicemente #abc12 se necessario, ma il formato standard è [#id]
    const idMatch = newName.match(/\[#([a-zA-Z0-9]+)\]/);
    if (idMatch) {
        const shortId = idMatch[1];
        const npcById = npcRepository.getNpcByShortId(campaignId, shortId);
        if (npcById) {
            console.log(`[Reconcile] 🎯 ID Match event: ${shortId} → ${npcById.name}`);
            return { canonicalName: npcById.name, existingNpc: npcById, confidence: 1.0 };
        }
    }

    const existingNpcs = getAllNpcs(campaignId);
    if (existingNpcs.length === 0) return null;

    const newNameLower = newName.toLowerCase().trim();

    const exactMatch = existingNpcs.find((n: any) => n.name.toLowerCase() === newNameLower);
    if (exactMatch) {
        console.log(`[Reconcile] ✅ Match esatto (case-insensitive): "${newName}" = "${exactMatch.name}"`);
        return { canonicalName: exactMatch.name, existingNpc: exactMatch, confidence: 1.0 };
    }

    const newNameClean = stripPrefix(newName.toLowerCase()).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const candidates: Array<{ npc: any; similarity: number; reason: string; ragEvidence?: string[] }> = [];

    for (const npc of existingNpcs) {
        const existingName = npc.name;
        const existingNameClean = stripPrefix(existingName.toLowerCase()).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // FIX: Check Exact Levenshtein Distance for typos
        // Se distanza = 1 e lunghezza >= 4 (es. "Siri" vs "Ciri"), è quasi certamente un match
        const dist = levenshteinDistance(newNameClean, existingNameClean);

        // 🆕 Special case: First character substitution (very common in transcription errors)
        // Es. "Siri" vs "Ciri", "Fainar" vs "Sainar" - same length, only first char different
        if (newNameClean.length === existingNameClean.length &&
            newNameClean.length >= 4 &&
            newNameClean.slice(1) === existingNameClean.slice(1)) {
            console.log(`[Reconcile] 🔤 First-char typo: "${newName}" ≈ "${existingName}" (solo prima lettera diversa)`);
            candidates.push({ npc, similarity: 0.95, reason: `first_char_typo` });
            continue;
        }

        if (dist === 1 && newNameClean.length >= 4 && existingNameClean.length >= 4) {
             console.log(`[Reconcile] 🔤 Typo dist=1: "${newName}" ≈ "${existingName}"`);
             candidates.push({ npc, similarity: 0.92, reason: `typo_dist_1` });
             continue;
        }

        // 1. Clean Levenshtein
        const similarity = levenshteinSimilarity(newNameClean, existingNameClean);
        const minLen = Math.min(newNameClean.length, existingNameClean.length);
        const threshold = minLen < 6 ? 0.75 : 0.65; // Slightly stricter for short names

        if (similarity >= threshold) {
            candidates.push({ npc, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        // 1.5 Strong Prefix Match (Auto-Merge Candidate)
        // Es. "Leosin" vs "Leosin Erantar"
        const shorter = newNameClean.length < existingNameClean.length ? newNameClean : existingNameClean;
        const longer = newNameClean.length < existingNameClean.length ? existingNameClean : newNameClean;

        if (shorter.length >= 4 && longer.startsWith(shorter)) {
            // Verifica che il prefisso sia seguito da spazio per evitare "Leo" in "Leonidas" (se non è tutto il nome)
            if (longer.length === shorter.length || longer[shorter.length] === ' ') {
                // Lowered slightly to allow for more robust prefix matching
                candidates.push({ npc, similarity: 0.92, reason: 'strong_prefix_match' });
                continue;
            }
        }

        // 2. Substring Match (CAUTION: "Viktor" in "Fratello di Viktor" is NOT a match!)
        // Only treat as high-confidence if the shorter name IS the full first word (e.g., "Leosin" in "Leosin Erantar")
        if (containsSubstring(newName, existingName)) {
            const shorterLen = Math.min(newNameClean.length, existingNameClean.length);
            const longerName = newNameClean.length > existingNameClean.length ? newNameClean : existingNameClean;
            const shorterName = newNameClean.length > existingNameClean.length ? existingNameClean : newNameClean;

            // Check if shorter name is a PREFIX (first word) of the longer name
            // "Leosin" is prefix of "Leosin Erantar" ✓
            // "Viktor" is NOT prefix of "Fratello di Viktor" ✗
            const isPrefixMatch = longerName.startsWith(shorterName) &&
                (longerName.length === shorterName.length || longerName[shorterName.length] === ' ');

            if (isPrefixMatch) {
                candidates.push({ npc, similarity: 0.85, reason: 'substring_prefix_match' });
                continue;
            } else {
                // It's contained but not as a prefix - much lower confidence, needs AI check
                candidates.push({ npc, similarity: 0.55, reason: 'substring_contained_only' });
                continue;
            }
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

                // Check if this NPC is mentioned by name OR by ID in the retrieved context
                const matchingChunks = ragContext.filter(chunk => chunk.toLowerCase().includes(npc.name.toLowerCase()));
                const hasNameMatch = matchingChunks.length > 0;

                let hasShortIdMatch = false;
                if (npc.short_id) {
                    const shortIdPattern = `[#${npc.short_id}]`;
                    hasShortIdMatch = ragContext.some(chunk => chunk.includes(shortIdPattern));
                }

                if (hasNameMatch || hasShortIdMatch) {
                    // CRITICAL FIX: RAG matches should NEVER auto-merge!
                    // The fact that a RAG fragment mentions "Ciri" doesn't mean "Bahamut" = "Ciri"
                    // RAG matches are hints for AI confirmation, not high-confidence matches
                    let score = hasShortIdMatch ? 0.65 : 0.55;  // Was 0.95/0.75 - WAY too high
                    let reason = hasShortIdMatch ? 'rag_short_id_match' : 'rag_context_match';

                    // Additional validation: the RAG chunk should actually discuss the NEW name,
                    // not just randomly mention an existing NPC
                    const queryNameInChunks = ragContext.some(chunk =>
                        chunk.toLowerCase().includes(newNameLower)
                    );

                    // If the query name appears in the same chunks, slightly higher confidence
                    if (queryNameInChunks) {
                        score += 0.15; // Max becomes 0.80 for short_id + query match
                        reason += '_with_query';
                    }

                    candidates.push({
                        npc,
                        similarity: score,
                        reason,
                        ragEvidence: hasNameMatch ? matchingChunks : ragContext.filter(c => npc.short_id && c.includes(`[#${npc.short_id}]`))
                    });
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

    // Reasons that are SAFE to auto-merge (syntactic matches)
    const SAFE_AUTO_MERGE_REASONS = [
        'exact_match',
        'first_char_typo',
        'typo_dist_1',
        'strong_prefix_match',
        'substring_prefix_match',
        'full_token_overlap'
    ];

    // Reasons that ALWAYS need AI confirmation (semantic/RAG matches are unreliable)
    const ALWAYS_AI_CHECK_REASONS = [
        'rag_short_id_match',
        'rag_context_match',
        'rag_short_id_match_with_query',
        'rag_context_match_with_query',
        'substring_contained_only',
        'partial_token_overlap'
    ];

    for (const candidate of topCandidates) {
        const isSafeReason = SAFE_AUTO_MERGE_REASONS.some(r => candidate.reason.includes(r));
        const needsAICheck = ALWAYS_AI_CHECK_REASONS.some(r => candidate.reason.includes(r));

        // AUTO-MERGE: Only if high similarity AND safe reason AND NOT in blacklist
        if (candidate.similarity >= 0.90 && isSafeReason && !needsAICheck) {
            console.log(`[Reconcile] ⚡ AUTO-MERGE (High Sim + Safe): "${newName}" → "${candidate.npc.name}" (${candidate.reason})`);
            return { canonicalName: candidate.npc.name, existingNpc: candidate.npc, confidence: candidate.similarity };
        }

        // Skip very low similarity candidates
        if (candidate.similarity < 0.50) {
            console.log(`[Reconcile] ⏭️ Skip low-sim candidate: "${candidate.npc.name}" (${candidate.similarity.toFixed(2)})`);
            continue;
        }

        console.log(`[Reconcile] 🤔 AI Check needed: "${candidate.npc.name}" (${candidate.reason}, sim=${candidate.similarity.toFixed(2)})...`);

        const isSame = await aiConfirmSamePersonExtended(
            campaignId,
            newName,
            newDescription,
            candidate.npc.name,
            candidate.npc.description || "",
            candidate.ragEvidence // Pass the evidence we found!
        );

        if (isSame) {
            console.log(`[Reconcile] ✅ CONFERMATO: "${newName}" = "${candidate.npc.name}"`);
            return { canonicalName: candidate.npc.name, existingNpc: candidate.npc, confidence: 0.80 };
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
    npcs: Array<{ name: string; description: string; role?: string; status?: string; alignment_moral?: string; alignment_ethical?: string }>
): Promise<Array<{ name: string; description: string; role?: string; status?: string; alignment_moral?: string; alignment_ethical?: string }>> {
    if (npcs.length <= 1) return npcs;

    const result: Array<{ name: string; description: string; role?: string; status?: string; alignment_moral?: string; alignment_ethical?: string }> = [];
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
                    merged.alignment_moral = merged.alignment_moral || npcs[j].alignment_moral;
                    merged.alignment_ethical = merged.alignment_ethical || npcs[j].alignment_ethical;

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
export async function smartMergeBios(targetName: string, bio1: string, bio2: string): Promise<string> {
    if (!bio1) return bio2;
    if (!bio2) return bio1;
    if (bio1 === bio2) return bio1;

    const prompt = SMART_MERGE_PROMPT(targetName, bio1, bio2);

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
 * Compatibility wrapper for IdentityGuard.
 * Propagates the real confidence from reconcileNpcName:
 *  - 1.0:  exact match / ID match
 *  - 0.90–0.99: syntactic auto-merge (typo, prefix)
 *  - 0.80: AI-confirmed match
 */
export async function resolveIdentityCandidate(campaignId: number, name: string, description: string) {
    const result = await reconcileNpcName(campaignId, name, description);
    if (result) {
        return { match: result.canonicalName, confidence: result.confidence ?? 1.0 };
    }
    return { match: null, confidence: 0 };
}
