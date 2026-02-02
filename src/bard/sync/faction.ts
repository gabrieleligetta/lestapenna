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
/**
 * Batch sync di tutte le fazioni dirty
 */
export async function syncAllDirtyFactions(campaignId: number): Promise<number> {
    const dirtyFactions = factionRepository.getDirtyFactions(campaignId);

    if (dirtyFactions.length === 0) {
        console.log('[Sync] Nessuna fazione da sincronizzare.');
        return 0;
    }

    console.log(`[Sync] 📥 Inizio sync per ${dirtyFactions.length} fazioni...`);

    // Process in Batches
    if (dirtyFactions.length > 0) {
        const { generateBioBatch } = await import('../bio');
        const BATCH_SIZE = 5;

        for (let i = 0; i < dirtyFactions.length; i += BATCH_SIZE) {
            const batch = dirtyFactions.slice(i, i + BATCH_SIZE);

            const batchInput = [];
            for (const faction of batch) {
                const history = factionRepository.getFactionHistory(campaignId, faction.name);
                const historyEvents = history.map(h => `[${h.event_type}] ${h.description}`).slice(-20).join('\n');

                batchInput.push({
                    name: faction.name,
                    context: {
                        name: faction.name,
                        campaignId,
                        currentDesc: faction.description || '',
                        manualDescription: (faction as any).manual_description || undefined
                    },
                    history: historyEvents
                });
            }

            const results = await generateBioBatch('FACTION', batchInput);

            for (const input of batchInput) {
                const newDesc = results[input.name] || input.context.currentDesc;
                const original = batch.find(f => f.name === input.name);
                if (original) {
                    await finalizeFactionSync(campaignId, original, newDesc);
                }
            }
        }
    }

    return dirtyFactions.length;
}

async function finalizeFactionSync(campaignId: number, faction: any, newDesc: string) {
    // Update DB
    factionRepository.updateFaction(campaignId, faction.name, { description: newDesc }, false);

    // Build RAG Content
    const members = factionRepository.countFactionMembers(faction.id);
    const reputation = factionRepository.getFactionReputation(campaignId, faction.id);

    const ragContent = `[[SCHEDA FAZIONE UFFICIALE: ${faction.name}]]
TIPO: ${faction.type}
STATO: ${faction.status}
REPUTAZIONE CON IL PARTY: ${reputation}
MEMBRI: ${members.npcs} NPC, ${members.pcs} PG, ${members.locations} Luoghi affiliati
DESCRIZIONE COMPLETA: ${newDesc}

(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    // Ingest
    await ingestGenericEvent(
        campaignId,
        'FACTION_UPDATE',
        ragContent,
        [faction.name],
        'FACTION'
    );

    // Clear flag
    factionRepository.clearFactionDirtyFlag(campaignId, faction.name);
    console.log(`[Sync] ✅ Fazione "${faction.name}" sincronizzata.`);
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
