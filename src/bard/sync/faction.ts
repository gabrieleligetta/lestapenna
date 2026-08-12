/**
 * Bard Sync - Faction: sync towards the RAG with bio regeneration.
 * Single card builder + shared batch loop (see entitySync.ts).
 */

import { factionRepository } from '../../db';
import { ingestEntitySnapshot, ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';
import { syncDirtyInBatches, formatHistoryEvents, RAG_PRIORITY_FOOTER } from './entitySync';

function buildFactionRagContent(campaignId: number, faction: any, bio: string): string {
    const members = factionRepository.countFactionMembers(faction.id);
    const reputation = factionRepository.getFactionReputation(campaignId, faction.id);

    return `[[SCHEDA FAZIONE UFFICIALE: ${faction.name}]]
TIPO: ${faction.type}
STATO: ${faction.status}
REPUTAZIONE CON IL PARTY: ${reputation}
MEMBRI: ${members.npcs} NPC, ${members.pcs} PG, ${members.locations} Luoghi affiliati
DESCRIZIONE COMPLETA: ${bio}
${RAG_PRIORITY_FOOTER}`;
}

async function ingestFaction(campaignId: number, faction: any, bio: string): Promise<void> {
    await ingestEntitySnapshot(campaignId, 'FACTION_UPDATE', buildFactionRagContent(campaignId, faction, bio), [faction.name], 'FACTION');
    factionRepository.clearFactionDirtyFlag(campaignId, faction.name);
}

/**
 * Syncs a Faction into the RAG (LAZY - only when needed).
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

    const history = factionRepository.getFactionHistory(campaignId, factionName);

    // generateBio already persists the description (see bio.ts, FACTION branch)
    const newBio = await generateBio('FACTION', {
        campaignId,
        name: factionName,
        currentDesc: faction.description || '',
        manualDescription: (faction as any).manual_description || undefined
    }, history);

    await ingestFaction(campaignId, faction, newBio);
    console.log(`[Sync] Fazione "${factionName}" sincronizzata.`);
    return newBio;
}

/**
 * Batch sync of every dirty faction.
 */
export async function syncAllDirtyFactions(campaignId: number): Promise<number> {
    const dirtyFactions = factionRepository.getDirtyFactions(campaignId);

    if (dirtyFactions.length === 0) {
        console.log('[Sync] Nessuna fazione da sincronizzare.');
        return 0;
    }

    console.log(`[Sync] 📥 Inizio sync per ${dirtyFactions.length} fazioni...`);

    return syncDirtyInBatches(dirtyFactions, 'FACTION',
        (faction: any) => ({
            entity: faction,
            name: faction.name,
            context: {
                name: faction.name,
                campaignId,
                currentDesc: faction.description || '',
                manualDescription: (faction as any).manual_description || undefined
            },
            history: formatHistoryEvents(factionRepository.getFactionHistory(campaignId, faction.name) as any)
        }),
        async (faction: any, newDesc: string) => {
            factionRepository.updateFaction(campaignId, faction.name, { description: newDesc }, false);
            await ingestFaction(campaignId, faction, newDesc);
            console.log(`[Sync] ✅ Fazione "${faction.name}" sincronizzata.`);
        }
    );
}

/**
 * Manual sync of a faction (without bio generation).
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
