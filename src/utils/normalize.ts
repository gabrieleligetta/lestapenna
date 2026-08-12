import { reconcileNpcName } from '../bard'; // Assuming bard exports this

/**
 * Cleans a name by removing bracketed text and extra spaces.
 * Example: "Pari (guardiano)" -> "Pari"
 */
function cleanName(name: string): string {
    if (!name) return name;
    return name.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
}

export async function normalizeSummaryNames(campaignId: any, result: any): Promise<any> {
    console.log(`[Reconcile] 🔄 Avvio normalizzazione nomi pre-validazione...`);

    // 1. Pre-clear names (Parentheses stripping)
    if (result.npc_events) result.npc_events.forEach((e: any) => e.name = cleanName(e.name));
    if (result.npc_dossier_updates) result.npc_dossier_updates.forEach((u: any) => u.name = cleanName(u.name));
    if (result.present_npcs) result.present_npcs = result.present_npcs.map((n: string) => cleanName(n));
    if (result.npc_locations) result.npc_locations.forEach((l: any) => l.name = cleanName(l.name));
    if (result.character_growth) result.character_growth.forEach((e: any) => e.name = cleanName(e.name));
    // Also add monsters when present in the result (even though normalizeSummaryNames is historically for NPCs/PCs)
    if (result.monsters) result.monsters.forEach((m: any) => m.name = cleanName(m.name));
    // 🆕 Artifact Events
    if (result.artifact_events) result.artifact_events.forEach((e: any) => e.name = cleanName(e.name));

    const nameMap = new Map<string, string>();
    const playerCharacters = new Set<string>();
    const namesToCheck = new Set<string>();

    // 2. Collect every potential name (already cleaned)
    if (result.npc_events) result.npc_events.forEach((e: any) => namesToCheck.add(e.name));
    if (result.npc_dossier_updates) result.npc_dossier_updates.forEach((e: any) => namesToCheck.add(e.name));
    if (result.present_npcs) result.present_npcs.forEach((n: string) => namesToCheck.add(n));
    if (result.npc_locations) result.npc_locations.forEach((l: any) => namesToCheck.add(l.name));
    if (result.character_growth) result.character_growth.forEach((e: any) => namesToCheck.add(e.name));

    // 3. Resolve every name against the DB
    for (const name of namesToCheck) {
        if (!name) continue;

        // Look for a description to give context (when available in the dossier updates)
        const update = result.npc_dossier_updates?.find((u: any) => u.name === name);
        const desc = update?.description || "";

        // Riconciliazione (Fuzzy + AI)
        const match = await reconcileNpcName(campaignId, name, desc);

        if (match?.isPlayerCharacter) {
            playerCharacters.add(name);
            continue;
        }

        if (match && match.canonicalName !== name) {
            nameMap.set(name, match.canonicalName);
            console.log(`[Reconcile] 🔄 Mappa correttiva: "${name}" -> "${match.canonicalName}"`);
        }
    }

    if (nameMap.size === 0 && playerCharacters.size === 0) {
        console.log(`[Reconcile] ✨ Nessuna correzione necessaria o nomi già canonici.`);
        return result;
    }

    // 4. Apply the remaining substitutions
    const replace = (n: string) => nameMap.get(n) || n;

    if (result.npc_events) {
        result.npc_events = result.npc_events
            .filter((e: any) => !playerCharacters.has(e.name))
            .map((e: any) => ({ ...e, name: replace(e.name) }));
    }
    if (result.npc_dossier_updates) {
        result.npc_dossier_updates = result.npc_dossier_updates
            .filter((e: any) => !playerCharacters.has(e.name))
            .map((e: any) => ({ ...e, name: replace(e.name) }));
    }
    if (result.present_npcs) {
        result.present_npcs = result.present_npcs
            .filter((n: string) => !playerCharacters.has(n))
            .map((n: string) => replace(n));
    }
    if (result.npc_locations) {
        result.npc_locations = result.npc_locations
            .filter((l: any) => !playerCharacters.has(l.name))
            .map((l: any) => ({ ...l, name: replace(l.name) }));
    }
    if (result.character_growth) {
        result.character_growth.forEach((e: any) => e.name = replace(e.name));
    }

    console.log(`[Reconcile] ✅ Nomi normalizzati nel summary.`);
    return result;
}
