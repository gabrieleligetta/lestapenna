/**
 * Bard Reconciliation - Monster reconciliation
 */

import { listAllMonsters } from '../../db';
import { metadataClient, METADATA_MODEL } from '../config';
import { levenshteinSimilarity, containsSubstring } from '../helpers';

/**
 * Chiede all'AI se due mostri sono lo stesso tipo.
 */
async function aiConfirmSameMonster(name1: string, name2: string, context: string = ""): Promise<boolean> {
    const prompt = `Sei un esperto di D&D e creature fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${name1}" e "${name2}" sono lo STESSO tipo di mostro/creatura?

Considera che:
- I nomi potrebbero essere singolari/plurali (es. "Goblin" = "Goblins")
- Potrebbero essere varianti ortografiche (es. "Orco" = "Orchi")
- Potrebbero essere nomi parziali (es. "Scheletro" ≈ "Scheletro Guerriero")
- NON unire creature diverse (es. "Goblin" ≠ "Hobgoblin")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 5
        });
        const answer = response.choices[0].message.content?.toUpperCase().trim() || "";
        return answer.includes("SI") || answer.includes("SÌ") || answer === "YES";
    } catch (e) {
        console.error("[Monster Reconcile] ❌ Errore AI confirm:", e);
        return false;
    }
}

/**
 * Trova il nome canonico se esiste un mostro simile nel bestiario.
 */
export async function reconcileMonsterName(
    campaignId: number,
    newName: string,
    newDescription: string = ""
): Promise<{ canonicalName: string; existingMonster: any } | null> {
    const existingMonsters = listAllMonsters(campaignId);
    if (existingMonsters.length === 0) return null;

    const newNameLower = newName.toLowerCase().trim();

    const exactMatch = existingMonsters.find((m: any) => m.name.toLowerCase() === newNameLower);
    if (exactMatch) return null;

    const candidates: Array<{ monster: any; similarity: number; reason: string }> = [];

    for (const monster of existingMonsters) {
        const existingName = monster.name;
        const similarity = levenshteinSimilarity(newName, existingName);

        const minLen = Math.min(newName.length, existingName.length);
        const threshold = minLen < 6 ? 0.7 : 0.6;

        if (similarity >= threshold) {
            candidates.push({ monster, similarity, reason: `levenshtein=${similarity.toFixed(2)}` });
            continue;
        }

        if (containsSubstring(newName, existingName)) {
            candidates.push({ monster, similarity: 0.8, reason: 'substring_match' });
        }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.similarity - a.similarity);

    for (const candidate of candidates.slice(0, 3)) {
        console.log(`[Monster Reconcile] 🔍 "${newName}" simile a "${candidate.monster.name}" (${candidate.reason}). Chiedo conferma AI...`);

        const isSame = await aiConfirmSameMonster(newName, candidate.monster.name, newDescription);

        if (isSame) {
            console.log(`[Monster Reconcile] ✅ CONFERMATO: "${newName}" = "${candidate.monster.name}"`);
            return { canonicalName: candidate.monster.name, existingMonster: candidate.monster };
        } else {
            console.log(`[Monster Reconcile] ❌ "${newName}" ≠ "${candidate.monster.name}"`);
        }
    }

    return null;
}

/**
 * Pre-deduplica un batch di mostri.
 */
export async function deduplicateMonsterBatch(
    monsters: Array<{ name: string; status?: string; count?: string; description?: string; abilities?: string[]; weaknesses?: string[]; resistances?: string[] }>
): Promise<Array<{ name: string; status?: string; count?: string; description?: string; abilities?: string[]; weaknesses?: string[]; resistances?: string[] }>> {
    if (monsters.length <= 1) return monsters;

    const result: typeof monsters = [];
    const processed = new Set<number>();

    for (let i = 0; i < monsters.length; i++) {
        if (processed.has(i)) continue;

        let merged = { ...monsters[i] };
        processed.add(i);

        for (let j = i + 1; j < monsters.length; j++) {
            if (processed.has(j)) continue;

            const similarity = levenshteinSimilarity(merged.name, monsters[j].name);
            const hasSubstring = containsSubstring(merged.name, monsters[j].name);

            if (similarity > 0.7 || hasSubstring) {
                const isSame = await aiConfirmSameMonster(merged.name, monsters[j].name);

                if (isSame) {
                    console.log(`[Monster Batch Dedup] 🔄 "${monsters[j].name}" → "${merged.name}"`);
                    if (monsters[j].name.length > merged.name.length) {
                        merged.name = monsters[j].name;
                    }
                    merged.description = merged.description || monsters[j].description;
                    merged.abilities = [...new Set([...(merged.abilities || []), ...(monsters[j].abilities || [])])];
                    merged.weaknesses = [...new Set([...(merged.weaknesses || []), ...(monsters[j].weaknesses || [])])];
                    merged.resistances = [...new Set([...(merged.resistances || []), ...(monsters[j].resistances || [])])];
                    if (monsters[j].status === 'DEFEATED') merged.status = 'DEFEATED';
                    processed.add(j);
                }
            }
        }

        result.push(merged);
    }

    if (result.length < monsters.length) {
        console.log(`[Monster Batch Dedup] ✅ Ridotti ${monsters.length} mostri a ${result.length}`);
    }

    return result;
}
