/**
 * Bard Sync - Faction synchronization functions
 */

import {
    factionRepository,
    npcRepository,
    locationRepository
} from '../../db';
import { ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';

/**
 * Sincronizza una Fazione nel RAG (LAZY - solo se necessario)
 */
export async function syncFactionEntryIfNeeded(
    campaignId: number,
    factionName: string,
    force: boolean = false
): Promise<string | null> {
    const faction = factionRepository.getFaction(campaignId, factionName);
    if (!faction) return null;

    const needsSync = faction.rag_sync_needed === 1;
    if (!force && !needsSync) {
        console.log(`[Sync] Fazione "${factionName}" già sincronizzata, skip.`);
        return faction.description;
    }

    console.log(`[Sync] Avvio sync per fazione "${factionName}"...`);

    // 1. Get History
    const history = factionRepository.getFactionHistory(campaignId, factionName);

    // 2. Generate Bio using unified service (Historical Memory)
    const newBio = await generateBio('FACTION', {
        campaignId,
        name: factionName,
        currentDesc: faction.description || '',
        manualDescription: (faction as any).manual_description || undefined // 🆕 Passa la descrizione manuale
    }, history);

    // 3. Build RAG content
    const members = factionRepository.countFactionMembers(faction.id);
    const reputation = factionRepository.getFactionReputation(campaignId, faction.id);

    // Use the NEW generated bio as the description
    let ragContent = `[[SCHEDA FAZIONE UFFICIALE: ${factionName}]]
TIPO: ${faction.type}
STATO: ${faction.status}
REPUTAZIONE CON IL PARTY: ${reputation}
MEMBRI: ${members.npcs} NPC, ${members.pcs} PG, ${members.locations} Luoghi affiliati
DESCRIZIONE COMPLETA: ${newBio}

(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    // 4. Ingest into RAG
    await ingestGenericEvent(
        campaignId,
        'FACTION_UPDATE',
        ragContent,
        [factionName],
        'FACTION'
    );

    // 5. Clear dirty flag
    factionRepository.clearFactionDirtyFlag(campaignId, factionName);

    console.log(`[Sync] Fazione "${factionName}" sincronizzata.`);
    return newBio;
}

/**
 * Batch sync di tutte le fazioni dirty
 */
export async function syncAllDirtyFactions(campaignId: number): Promise<number> {
    const dirtyFactions = factionRepository.getDirtyFactions(campaignId);

    if (dirtyFactions.length === 0) {
        console.log('[Sync] Nessuna fazione da sincronizzare.');
        return 0;
    }

    console.log(`[Sync] Sincronizzazione batch di ${dirtyFactions.length} fazioni...`);

    for (const faction of dirtyFactions) {
        try {
            await syncFactionEntryIfNeeded(campaignId, faction.name, true);
        } catch (e) {
            console.error(`[Sync] Errore sync fazione "${faction.name}":`, e);
        }
    }

    return dirtyFactions.length;
}

/**
 * Sync manuale di una fazione (senza bio generation)
 */
export async function syncFaction(
    campaignId: number,
    factionName: string,
    description: string,
    type: string
): Promise<void> {
    const content = `FAZIONE: ${factionName}. TIPO: ${type}. DESCRIZIONE: ${description}`;
    console.log(`[RAG] 🔄 Sync Fazione "${factionName}"...`);
    await ingestGenericEvent(campaignId, 'FACTION_SYNC', content, [factionName], 'FACTION');
}
