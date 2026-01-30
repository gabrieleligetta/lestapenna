/**
 * Bard Sync - Faction synchronization functions
 */

import {
    factionRepository,
    npcRepository,
    locationRepository
} from '../../db';
import { ingestGenericEvent } from '../rag';

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

    // 1. Get members and reputation
    const members = factionRepository.countFactionMembers(faction.id);
    const reputation = factionRepository.getFactionReputation(campaignId, faction.id);
    const history = factionRepository.getFactionHistory(campaignId, factionName);

    // 2. Build RAG content
    let ragContent = `[[SCHEDA FAZIONE: ${factionName}]]
TIPO: ${faction.type}
STATO: ${faction.status}
REPUTAZIONE CON IL PARTY: ${reputation}
MEMBRI: ${members.npcs} NPC, ${members.pcs} PG, ${members.locations} Luoghi affiliati
`;

    if (faction.description) {
        ragContent += `DESCRIZIONE: ${faction.description}\n`;
    }

    // Add recent history (max 5 events)
    if (history.length > 0) {
        ragContent += `\nEVENTI RECENTI:\n`;
        history.slice(-5).forEach(h => {
            ragContent += `- [${h.event_type}] ${h.description}\n`;
        });
    }

    ragContent += `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    // 3. Ingest into RAG
    await ingestGenericEvent(
        campaignId,
        'FACTION_UPDATE',
        ragContent,
        [factionName],
        'FACTION'
    );

    // 4. Clear dirty flag
    factionRepository.clearFactionDirtyFlag(campaignId, factionName);

    console.log(`[Sync] Fazione "${factionName}" sincronizzata.`);
    return faction.description;
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
