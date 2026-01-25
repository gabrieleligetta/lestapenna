import { reconcileNpcName } from '../bard'; // Assuming bard exports this

/**
 * Pulisce un nome rimuovendo testo tra parentesi e spazi extra.
 * Esempio: "Pari (guardiano)" -> "Pari"
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
    if (result.character_growth) result.character_growth.forEach((e: any) => e.name = cleanName(e.name));
    // Aggiungiamo anche mostri se presenti nel result (anche se normalizeSummaryNames è storicamente per NPC/PG)
    if (result.monsters) result.monsters.forEach((m: any) => m.name = cleanName(m.name));

    const nameMap = new Map<string, string>();
    const namesToCheck = new Set<string>();

    // 2. Raccogli tutti i nomi potenziali (già puliti)
    if (result.npc_events) result.npc_events.forEach((e: any) => namesToCheck.add(e.name));
    if (result.npc_dossier_updates) result.npc_dossier_updates.forEach((e: any) => namesToCheck.add(e.name));
    if (result.present_npcs) result.present_npcs.forEach((n: string) => namesToCheck.add(n));
    if (result.character_growth) result.character_growth.forEach((e: any) => namesToCheck.add(e.name));

    // 3. Risolvi ogni nome contro il DB
    for (const name of namesToCheck) {
        if (!name) continue;

        // Cerca una descrizione per il contesto (se disponibile nei dossier updates)
        const update = result.npc_dossier_updates?.find((u: any) => u.name === name);
        const desc = update?.description || "";

        // Riconciliazione (Fuzzy + AI)
        const match = await reconcileNpcName(campaignId, name, desc);

        if (match && match.canonicalName !== name) {
            nameMap.set(name, match.canonicalName);
            console.log(`[Reconcile] 🔄 Mappa correttiva: "${name}" -> "${match.canonicalName}"`);
        }
    }

    if (nameMap.size === 0) {
        console.log(`[Reconcile] ✨ Nessuna correzione necessaria o nomi già canonici.`);
        return result;
    }

    // 4. Applica le sostituzioni rimaste
    const replace = (n: string) => nameMap.get(n) || n;

    if (result.npc_events) {
        result.npc_events.forEach((e: any) => e.name = replace(e.name));
    }
    if (result.npc_dossier_updates) {
        result.npc_dossier_updates.forEach((e: any) => e.name = replace(e.name));
    }
    if (result.present_npcs) {
        result.present_npcs = result.present_npcs.map((n: string) => replace(n));
    }
    if (result.character_growth) {
        result.character_growth.forEach((e: any) => e.name = replace(e.name));
    }

    console.log(`[Reconcile] ✅ Nomi normalizzati nel summary.`);
    return result;
}

