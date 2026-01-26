/**
 * Bard Reconciliation - Location reconciliation
 */

import { listAllAtlasEntries } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinSimilarity, containsSubstring, stripPrefix } from '../helpers';
import { searchKnowledge } from '../rag';
import { AI_CONFIRM_SAME_LOCATION_EXTENDED_PROMPT, AI_CONFIRM_SAME_LOCATION_PROMPT } from '../prompts';

/**
 * Normalizza i nomi location rimuovendo prefissi duplicati.
 */
export function normalizeLocationNames(macro: string, micro: string): { macro: string; micro: string } {
    if (micro.startsWith(macro + " - ")) {
        micro = micro.substring(macro.length + 3);
    }
    return { macro, micro };
}

/**
 * Calcola la similarità tra due luoghi (combinando macro e micro).
 */
function locationSimilarity(
    loc1: { macro: string; micro: string },
    loc2: { macro: string; micro: string }
): { score: number; reason: string } {
    const macroSim = levenshteinSimilarity(loc1.macro, loc2.macro);
    const microSim = levenshteinSimilarity(loc1.micro, loc2.micro);

    if (macroSim > 0.95) {
        if (microSim > 0.6) {
            return { score: microSim, reason: `same_macro, micro_sim=${microSim.toFixed(2)}` };
        }
        if (containsSubstring(loc1.micro, loc2.micro)) {
            return { score: 0.8, reason: 'same_macro, micro_substring' };
        }
    }

    // NEW: If micro location is significantly unique/identical (e.g. "Paludi dei Morti"), treat as high match
    // independently of Macro (which might be "Paludi" vs "Regione Nerithar")
    if (microSim > 0.95) {
        return { score: 0.9, reason: `same_micro_exact` };
    }

    if (microSim > 0.8 && macroSim > 0.5) {
        return { score: (macroSim + microSim) / 2, reason: `high_micro_sim=${microSim.toFixed(2)}` };
    }

    const combined = (macroSim * 0.4) + (microSim * 0.6);
    if (combined > 0.6) {
        return { score: combined, reason: `combined=${combined.toFixed(2)}` };
    }

    return { score: 0, reason: 'no_match' };
}

/**
 * Versione POTENZIATA: Chiede all'AI se due luoghi sono lo stesso posto usando RAG + Fonetica
 */
async function aiConfirmSameLocationExtended(
    campaignId: number,
    newMacro: string,
    newMicro: string,
    newDescription: string,
    candidateMacro: string,
    candidateMicro: string,
    candidateDescription: string
): Promise<boolean> {

    const ragQuery = `Cosa sappiamo di ${newMacro} - ${newMicro}? ${newDescription}`;
    const ragContext = await searchKnowledge(campaignId, ragQuery, 2);

    const relevantFragments = ragContext.filter(f =>
        f.toLowerCase().includes(candidateMicro.toLowerCase())
    );

    const ragContextText = relevantFragments.length > 0
        ? `\nMEMORIA STORICA RILEVANTE:\n${relevantFragments.join('\n')}`
        : "";

    const prompt = AI_CONFIRM_SAME_LOCATION_EXTENDED_PROMPT(newMacro, newMicro, newDescription, candidateMacro, candidateMicro, candidateDescription, ragContextText);

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Loc Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Chiede all'AI se due luoghi si riferiscono allo stesso posto.
 */
export async function aiConfirmSameLocation(
    loc1: { macro: string; micro: string },
    loc2: { macro: string; micro: string },
    context: string = ""
): Promise<boolean> {
    const prompt = AI_CONFIRM_SAME_LOCATION_PROMPT(loc1.macro, loc1.micro, loc2.macro, loc2.micro, context);

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Loc Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il nome canonico se esiste un luogo simile nell'atlante.
 */
export async function reconcileLocationName(
    campaignId: number,
    newMacro: string,
    newMicro: string,
    newDescription: string = ""
): Promise<{ canonicalMacro: string; canonicalMicro: string; existingEntry: any } | null> {
    const existingLocations = listAllAtlasEntries(campaignId);
    if (existingLocations.length === 0) return null;

    const normalized = normalizeLocationNames(newMacro, newMicro);
    newMacro = normalized.macro;
    newMicro = normalized.micro;

    // Remove articles/prefixes for cleaner fuzzy match
    const newMacroClean = stripPrefix(newMacro.toLowerCase());
    const newMicroClean = stripPrefix(newMicro.toLowerCase());

    const exactMatch = existingLocations.find((loc: any) =>
        loc.macro_location.toLowerCase() === newMacro.toLowerCase() &&
        loc.micro_location.toLowerCase() === newMicro.toLowerCase()
    );
    if (exactMatch) {
        console.log(`[Location Reconcile] ✅ Match esatto (case-insensitive): "${newMacro} - ${newMicro}" = "${exactMatch.macro_location} - ${exactMatch.micro_location}"`);
        return {
            canonicalMacro: exactMatch.macro_location,
            canonicalMicro: exactMatch.micro_location,
            existingEntry: exactMatch
        };
    }

    const candidates: Array<{ entry: any; similarity: number; reason: string }> = [];

    for (const entry of existingLocations) {
        // Use clean versions for similarity
        const entryMacroClean = stripPrefix(entry.macro_location.toLowerCase());
        const entryMicroClean = stripPrefix(entry.micro_location.toLowerCase());

        let { score, reason } = locationSimilarity(
            { macro: newMacroClean, micro: newMicroClean },
            { macro: entryMacroClean, micro: entryMicroClean }
        );

        // Boost scoring slightly for clean matches or fallback to raw
        if (score < 0.6) {
            const rawSim = locationSimilarity(
                { macro: newMacro, micro: newMicro },
                { macro: entry.macro_location, micro: entry.micro_location }
            );
            if (rawSim.score > score) {
                score = rawSim.score;
                reason = rawSim.reason;
            }
        }

        if (score > 0.55) {
            candidates.push({ entry, similarity: score, reason });
        } else {
            // 4. NEW: Full Path Similarity (Handle different splitting)
            // e.g. "Region - City" | "District" vs "Region" | "City - District"
            const fullPathEntry = `${entryMacroClean} - ${entryMicroClean}`;
            const fullPathNew = `${newMacroClean} - ${newMicroClean}`;

            const fullSim = levenshteinSimilarity(fullPathNew, fullPathEntry);

            // Check also "Micro" ONLY vs "Micro"
            // Sometimes Macro is totally different or missing but Micro is unique enough?
            // Not sure, let's stick to full path for now.

            if (fullSim > 0.85) {
                candidates.push({ entry, similarity: fullSim, reason: `full_path_sim=${fullSim.toFixed(2)}` });
            }
        }
    }

    // 5. NEW: Semantic/RAG Candidate Discovery (If string matching is weak)
    if (candidates.filter(c => c.similarity > 0.8).length === 0) {
        console.log(`[Location Reconcile] 🧠 Ricerca candidati semantici (RAG) per "${newMacro} - ${newMicro}"...`);
        try {
            const ragQuery = `Cosa sappiamo di ${newMacro} - ${newMicro}? ${newDescription}`;
            const ragContext = await searchKnowledge(campaignId, ragQuery, 3);

            for (const entry of existingLocations) {
                // Skip if already a candidate
                if (candidates.some(c => c.entry.id === entry.id)) continue;

                const fullPath = `${entry.macro_location} ${entry.micro_location}`.toLowerCase();
                // Check if this Location is mentioned in the retrieved context
                const foundInContext = ragContext.some(chunk => chunk.toLowerCase().includes(entry.micro_location.toLowerCase()) || chunk.toLowerCase().includes(entry.macro_location.toLowerCase()));

                if (foundInContext) {
                    // Lower confidence than direct match, but enough to trigger AI check
                    candidates.push({ entry, similarity: 0.7, reason: 'rag_context_match' });
                }
            }
        } catch (e) {
            console.error(`[Location Reconcile] ⚠️ Error during RAG candidate search:`, e);
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    // Check Top 3 Candidates
    const topCandidates = candidates.slice(0, 3);
    console.log(`[Location Reconcile] 🔍 "${newMacro} - ${newMicro}" vs ${topCandidates.length} candidati: ${topCandidates.map(c => `${c.entry.macro_location}-${c.entry.micro_location}(${c.similarity.toFixed(2)})`).join(', ')}`);

    for (const candidate of topCandidates) {
        console.log(`[Location Reconcile] 🤔 Checking candidate: "${candidate.entry.macro_location} - ${candidate.entry.micro_location}" (${candidate.reason})...`);

        const isSame = await aiConfirmSameLocationExtended(
            campaignId,
            newMacro,
            newMicro,
            newDescription,
            candidate.entry.macro_location,
            candidate.entry.micro_location,
            candidate.entry.description || ""
        );

        if (isSame) {
            console.log(`[Location Reconcile] ✅ CONFERMATO: "${newMacro} - ${newMicro}" = "${candidate.entry.macro_location} - ${candidate.entry.micro_location}"`);
            return {
                canonicalMacro: candidate.entry.macro_location,
                canonicalMicro: candidate.entry.micro_location,
                existingEntry: candidate.entry
            };
        } else {
            console.log(`[Location Reconcile] ❌ Rifiutato: "${candidate.entry.macro_location} - ${candidate.entry.micro_location}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di location updates PRIMA di salvarli.
 */
export async function deduplicateLocationBatch(
    locations: Array<{ macro: string; micro: string; description?: string }>
): Promise<Array<{ macro: string; micro: string; description?: string }>> {
    if (locations.length <= 1) return locations;

    const result: Array<{ macro: string; micro: string; description?: string }> = [];
    const processed = new Set<number>();

    for (let i = 0; i < locations.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...locations[i] };
        processed.add(i);

        for (let j = i + 1; j < locations.length; j++) {
            if (processed.has(j)) continue;

            const { score } = locationSimilarity(
                { macro: merged.macro, micro: merged.micro },
                { macro: locations[j].macro, micro: locations[j].micro }
            );

            if (score > 0.6) {
                const isSame = await aiConfirmSameLocation(
                    { macro: merged.macro, micro: merged.micro },
                    { macro: locations[j].macro, micro: locations[j].micro }
                );

                if (isSame) {
                    console.log(`[Location Batch Dedup] 🔄 "${locations[j].macro} - ${locations[j].micro}" → "${merged.macro} - ${merged.micro}"`);
                    const mergedFull = `${merged.macro} - ${merged.micro}`;
                    const jFull = `${locations[j].macro} - ${locations[j].micro}`;
                    if (jFull.length > mergedFull.length) {
                        merged.macro = locations[j].macro;
                        merged.micro = locations[j].micro;
                    }
                    if (locations[j].description && locations[j].description !== merged.description) {
                        merged.description = `${merged.description || ''} ${locations[j].description}`.trim();
                    }
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < locations.length) {
        console.log(`[Location Batch Dedup] ✅ Ridotti ${locations.length} luoghi a ${result.length}`);
    }

    return result;
}
