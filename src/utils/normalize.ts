import { reconcileNpcName } from '../bard'; // Assuming bard exports this

export async function normalizeSummaryNames(campaignId: any, result: any): Promise<any> {
    console.log(`[Reconcile] 🔄 Avvio normalizzazione nomi pre-validazione...`);
    const nameMap = new Map<string, string>();
    const namesToCheck = new Set<string>();

    // 1. Raccogli tutti i nomi potenziali
    if (result.npc_events) result.npc_events.forEach((e: any) => namesToCheck.add(e.name));
    if (result.npc_dossier_updates) result.npc_dossier_updates.forEach((e: any) => namesToCheck.add(e.name));
    if (result.present_npcs) result.present_npcs.forEach((n: string) => namesToCheck.add(n));
    // A volte i PG finiscono qui per errore, controlliamo anche loro
    if (result.character_growth) result.character_growth.forEach((e: any) => namesToCheck.add(e.name));

    // 2. Risolvi ogni nome contro il DB
    for (const name of namesToCheck) {
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
        console.log(`[Reconcile] ✨ Nessuna correzione necessaria.`);
        return result;
    }

    // 3. Applica le sostituzioni
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
