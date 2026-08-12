/**
 * Bard Reconciliation - NPC name reconciliation
 */

import { getAllNpcs, getCampaignCharacters, getNpcHistory, npcRepository } from '../../db';
import { getReconcileClient } from '../config';
import { levenshteinDistance, levenshteinSimilarity, containsSubstring, stripPrefix, safeJsonParse } from '../helpers';
import { generateJson, generateText } from '../llm/generate';
import { searchKnowledge } from '../rag/search';
import {
    AI_CONFIRM_SAME_PERSON_EXTENDED_PROMPT,
    AI_CONFIRM_SAME_PERSON_PROMPT,
    AI_CONFIRM_SAME_ENTITY_SEMANTIC_PROMPT,
    SMART_MERGE_PROMPT
} from '../prompts';
import { semanticShortlist, parseSchedaName, aiConfirmSameEntity } from './semantic';

// ============================================
// SEMANTIC RECONCILIATION (embedding-based) — see reconciliation/semantic.ts
// ============================================
// Catches the cases name matching CANNOT see: the same identity under different
// labels (title vs proper name, e.g. "Vescovo" → "Theophile Deschamps").

/**
 * NPC semantic shortlist: compares the new NPC's description with the vectors of the existing
 * dossiers (fragments 'DOSSIER_UPDATE') and maps the keys onto the current NPC dossiers.
 */
async function semanticNpcShortlist(
    campaignId: number,
    newDescription: string,
    existingNpcs: any[]
): Promise<Array<{ npc: any; similarity: number; reason: string }>> {
    const hits = await semanticShortlist(campaignId, newDescription, 'DOSSIER_UPDATE', f => parseSchedaName(f.content));
    const npcByName = new Map(existingNpcs.map(n => [n.name.toLowerCase(), n]));
    const out: Array<{ npc: any; similarity: number; reason: string }> = [];
    for (const hit of hits) {
        const npc = npcByName.get(hit.key.toLowerCase());
        if (npc) out.push({ npc, similarity: hit.similarity, reason: 'semantic_match' });
    }
    return out;
}

/** SEMANTIC "same identity" confirmation based on the descriptions (not on the name). */
async function aiConfirmSameEntitySemantic(
    newName: string,
    newDescription: string,
    candidateName: string,
    candidateDescription: string
): Promise<boolean> {
    return aiConfirmSameEntity(
        AI_CONFIRM_SAME_ENTITY_SEMANTIC_PROMPT(newName, newDescription, candidateName, candidateDescription),
        'NPC Reconcile'
    );
}

async function aiConfirmSameNpcByEvents(
    campaignId: number,
    newName: string,
    newDescription: string,
    candidateName: string,
    candidateDescription: string
): Promise<boolean> {
    const candidateHistory = getNpcHistory(campaignId, candidateName)
        .slice(-12)
        .map((h: any) => `[${h.event_type || h.type || 'EVENT'}] ${h.description || h.event || ''}`)
        .filter(Boolean)
        .join('\n');

    let ragContext = '';
    try {
        const fragments = await searchKnowledge(
            campaignId,
            `${newName} ${candidateName} ${newDescription}`.substring(0, 1000),
            6
        );
        ragContext = fragments.map((f, i) => `RAG ${i + 1}: ${f.substring(0, 900)}`).join('\n\n');
    } catch (e: any) {
        console.warn(`[NPC Reconcile] ⚠️ RAG non disponibile per confronto eventi: ${e?.message || e}`);
    }

    const prompt = `You must decide whether two references indicate THE SAME NPC in a D&D campaign.
Do not rely on the name alone. Compare the EVENTS: actions, items given/received, scenes, place, narrative role.

NEW REFERENCE:
Name: ${newName}
Current event/description: ${newDescription || 'N/A'}

EXISTING CANDIDATE:
Canonical name: ${candidateName}
Dossier: ${candidateDescription || 'N/A'}
DB history:
${candidateHistory || 'N/A'}

Relevant historical RAG:
${ragContext || 'N/A'}

Rules:
- If both describe the same distinctive scene/action, they are the same NPC even under different names or titles.
- Example: "elderly fortune teller" and "Old Man of the Tarots" are the same if both deal in tarots/divination and give away or use a deck.
- If they only share a generic role or atmosphere, they are NOT the same.

Answer ONLY with JSON:
{"same":true|false,"confidence":0.0-1.0,"reason":"short motivation based on the events"}`;

    try {
        const ai = await generateJson({
            route: await getReconcileClient(),
            label: 'reconcile',
            system: 'You are an NPC identity reconciler. Compare events and answer only with JSON.',
            prompt,
            maxTokensNative: 1000,
            reasoningEffort: 'low'
        });
        const parsed: any = ai.parsed;
        const same = parsed?.same === true && Number(parsed?.confidence || 0) >= 0.72;
        console.log(`[NPC Reconcile] 🧾 Event overlap "${newName}" vs "${candidateName}": ${same ? 'MATCH' : 'NO'} (${parsed?.confidence ?? 'n/a'}) ${parsed?.reason || ''}`);
        return same;
    } catch (e: any) {
        console.error(`[NPC Reconcile] ❌ Errore event-overlap confirm:`, e);
        return false;
    }
}

/**
 * ENHANCED version: asks the AI whether two names are the same person using RAG + phonetics
 */
async function aiConfirmSamePersonExtended(
    campaignId: number,
    newName: string,
    newDescription: string,
    candidateName: string,
    candidateDescription: string
): Promise<boolean> {
    const prompt = AI_CONFIRM_SAME_PERSON_EXTENDED_PROMPT(newName, newDescription, candidateName, candidateDescription, "");

    try {
        const ai = await generateText({
            route: await getReconcileClient(),
            label: 'reconcile',
            system: 'Answer only YES or NO.',
            prompt,
            maxTokens: 5,
            reasoningEffort: 'low'
        });
        const answer = ai.content.toUpperCase().trim();
        return answer.includes("YES") || answer.includes("SI") || answer.includes("SÌ");
    } catch (e) {
        console.error("[Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Asks the AI whether two names refer to the same person.
 */
export async function aiConfirmSamePerson(name1: string, name2: string, context: string = ""): Promise<boolean> {
    const prompt = AI_CONFIRM_SAME_PERSON_PROMPT(name1, name2, context);

    try {
        const ai = await generateText({
            route: await getReconcileClient(),
            label: 'reconcile',
            system: 'Answer only YES or NO.',
            prompt,
            maxTokens: 5,
            reasoningEffort: 'low'
        });
        const answer = ai.content.toUpperCase().trim();
        return answer.includes("YES") || answer.includes("SI") || answer.includes("SÌ");
    } catch (e) {
        console.error("[Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Finds the canonical name when a similar NPC exists in the dossier.
 * @param playerCharacters - Optional list of PC names to exclude (they are not NPCs)
 */
export async function reconcileNpcName(
    campaignId: number,
    newName: string,
    newDescription: string = "",
    playerCharacters: string[] = []
): Promise<{ canonicalName: string; existingNpc: any; isPlayerCharacter?: boolean; confidence?: number } | null> {
    // -1. PC Check (Highest Priority) - Skip if this is a player character
    const effectivePlayerCharacters = playerCharacters.length > 0
        ? playerCharacters
        : getCampaignCharacters(campaignId)
            .map((c: any) => c.character_name)
            .filter(Boolean);

    if (effectivePlayerCharacters.length > 0) {
        const newNameLower = newName.toLowerCase().trim();
        const pcMatch = effectivePlayerCharacters.find(p => p.toLowerCase().trim() === newNameLower);

        if (pcMatch) {
            console.log(`[Reconcile] 🎮 "${newName}" è un PG (match esatto) - SKIP`);
            return { canonicalName: pcMatch, existingNpc: null, isPlayerCharacter: true };
        }
    }

    // 0. ID Match (Highest Priority)
    // Look for patterns like [#abc12] or plain #abc12 if needed, but the standard format is [#id]
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
    const newNameComparable = stripPrefix(newNameLower).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const exactMatch = existingNpcs.find((n: any) => n.name.toLowerCase() === newNameLower);
    if (exactMatch) {
        console.log(`[Reconcile] ✅ Match esatto (case-insensitive): "${newName}" = "${exactMatch.name}"`);
        return { canonicalName: exactMatch.name, existingNpc: exactMatch, confidence: 1.0 };
    }

    const articleInsensitiveMatch = existingNpcs.find((n: any) =>
        stripPrefix(n.name.toLowerCase().trim()).normalize('NFD').replace(/[\u0300-\u036f]/g, '') === newNameComparable
    );
    if (articleInsensitiveMatch) {
        console.log(`[Reconcile] ✅ Match esatto senza articolo: "${newName}" = "${articleInsensitiveMatch.name}"`);
        return { canonicalName: articleInsensitiveMatch.name, existingNpc: articleInsensitiveMatch, confidence: 1.0 };
    }

    const newNameClean = newNameComparable;
    const candidates: Array<{ npc: any; similarity: number; reason: string }> = [];

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
            // Check that the prefix is followed by a space, to avoid "Leo" in "Leonidas" (unless it is the whole name)
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

    // 4. Description cross-check (alias detection, zero API cost)
    // Only when no good string candidates found. Checks if the new name appears in an
    // existing NPC's description ("nota come La Strega"), or vice versa.
    if (candidates.filter(c => c.similarity > 0.5).length === 0 && newDescription && newDescription.length > 15) {
        const descLower = newDescription.toLowerCase();
        for (const npc of existingNpcs) {
            if (candidates.some(c => c.npc.name === npc.name)) continue;
            if (npc.description?.toLowerCase().includes(newNameLower) ||
                npc.description?.toLowerCase().includes(newNameComparable)) {
                candidates.push({ npc, similarity: 0.87, reason: 'desc_mentions_query' });
            } else if (descLower.includes(npc.name.toLowerCase())) {
                candidates.push({ npc, similarity: 0.84, reason: 'query_desc_mentions_entity' });
            }
        }
    }

    // 5. Semantic cross-check (embedding-based) — catches identities with different names
    // (title vs proper name). It ALWAYS runs when there is a description, EXCEPT when a
    // strong syntactic auto-merge match already exists (cheap path, no embedding/AI).
    const SYNTACTIC_AUTO_MERGE_REASONS = [
        'exact_match', 'first_char_typo', 'typo_dist_1',
        'strong_prefix_match', 'substring_prefix_match', 'full_token_overlap'
    ];
    const hasStrongSyntactic = candidates.some(c =>
        c.similarity >= 0.90 && SYNTACTIC_AUTO_MERGE_REASONS.some(r => c.reason.includes(r))
    );
    if (!hasStrongSyntactic && newDescription && newDescription.length > 30) {
        const semantic = await semanticNpcShortlist(campaignId, newDescription, existingNpcs);
        for (const s of semantic) {
            if (!candidates.some(c => c.npc.name === s.npc.name)) {
                console.log(`[Reconcile] 🧠 Candidato semantico: "${newName}" ~ "${s.npc.name}" (cosine=${s.similarity.toFixed(2)})`);
                candidates.push(s);
            }
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

    // Reasons that ALWAYS need AI confirmation
    const ALWAYS_AI_CHECK_REASONS = [
        'substring_contained_only',
        'partial_token_overlap',
        'desc_mentions_query',
        'query_desc_mentions_entity',
        'semantic_match'
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

        // The semantic candidates (different names, same identity) use the prompt based on the
        // DESCRIPTIONS; the others use the phonetic prompt (name typos/aliases).
        let isSame = candidate.reason === 'semantic_match'
            ? await aiConfirmSameEntitySemantic(
                newName,
                newDescription,
                candidate.npc.name,
                candidate.npc.description || ""
            )
            : await aiConfirmSamePersonExtended(
                campaignId,
                newName,
                newDescription,
                candidate.npc.name,
                candidate.npc.description || ""
            );

        if (!isSame && ['semantic_match', 'desc_mentions_query', 'query_desc_mentions_entity', 'partial_token_overlap'].some(r => candidate.reason.includes(r))) {
            isSame = await aiConfirmSameNpcByEvents(
                campaignId,
                newName,
                newDescription,
                candidate.npc.name,
                candidate.npc.description || ""
            );
        }

        if (isSame) {
            // Blend original similarity with AI boost, capped below auto-merge threshold
            const aiConfidence = Math.min(0.94, candidate.similarity + 0.15);
            console.log(`[Reconcile] ✅ CONFERMATO: "${newName}" = "${candidate.npc.name}" (sim=${candidate.similarity.toFixed(2)} → confidence=${aiConfidence.toFixed(2)})`);
            return { canonicalName: candidate.npc.name, existingNpc: candidate.npc, confidence: aiConfidence };
        } else {
            console.log(`[Reconcile] ❌ Rifiutato: "${candidate.npc.name}"`);
        }
    }

    return null;
}

/**
 * Pre-dedupes a batch of NPC updates BEFORE saving them.
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
        const ai = await generateText({
            route: await getReconcileClient(),
            label: 'reconcile',
            system: 'Merge the two biographies keeping only supported facts. Write the merged description in the SAME language as the input descriptions. Answer only with the final text.',
            prompt,
            maxTokensNative: 1200,
            reasoningEffort: 'low'
        });
        return ai.content || bio1 + "\n" + bio2;
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
 *  - 0.65–0.94: AI-confirmed (min(0.94, similarity + 0.15))
 */
export async function resolveIdentityCandidate(campaignId: number, name: string, description: string) {
    const result = await reconcileNpcName(campaignId, name, description);
    if (result) {
        return { match: result.canonicalName, confidence: result.confidence ?? 1.0 };
    }
    return { match: null, confidence: 0 };
}
