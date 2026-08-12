/**
 * Bard Sync - NPC: sync of the dossier towards the RAG with bio regeneration.
 * Single card builder + shared batch loop (see entitySync.ts).
 */

import { getNpcEntry, updateNpcEntry, clearNpcDirtyFlag, getDirtyNpcs, deleteNpcRagSummary, getNpcHistory } from '../../db';
import { ingestEntitySnapshot, ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';
import { syncDirtyInBatches, formatHistoryEvents, RAG_PRIORITY_FOOTER } from './entitySync';

function buildNpcRagContent(npcName: string, role: string, status: string, bio: string): string {
    return `[[SCHEDA UFFICIALE: ${npcName}]]
RUOLO: ${role}
STATO: ${status}
BIOGRAFIA COMPLETA: ${bio}
${RAG_PRIORITY_FOOTER}`;
}

/**
 * Updates the dossier, replaces the RAG card (only above `minBioLength`,
 * so stub biographies are not ingested) and clears the dirty flag.
 */
async function finalizeNpcSync(
    campaignId: number,
    npcName: string,
    role: string,
    status: string,
    description: string,
    minBioLength: number
): Promise<void> {
    updateNpcEntry(campaignId, npcName, description, role);

    if (description.length > minBioLength) {
        await ingestEntitySnapshot(
            campaignId,
            'DOSSIER_UPDATE',
            buildNpcRagContent(npcName, role, status, description),
            [npcName],
            'DOSSIER'
        );
    } else {
        deleteNpcRagSummary(campaignId, npcName);
    }

    clearNpcDirtyFlag(campaignId, npcName);
}

/**
 * Syncs the NPC dossier (LAZY - only when needed).
 */
export async function syncNpcDossierIfNeeded(
    campaignId: number,
    npcName: string,
    force: boolean = false
): Promise<string | null> {
    const npc = getNpcEntry(campaignId, npcName);
    if (!npc) return null;

    const needsSync = (npc as any).rag_sync_needed === 1;
    if (!force && !needsSync) {
        console.log(`[Sync] ${npcName} gia sincronizzato, skip.`);
        return npc.description;
    }

    console.log(`[Sync] Avvio sync per ${npcName}...`);

    const history = getNpcHistory(campaignId, npcName);

    // When a manual_description exists, use it directly (even when empty) instead of the AI:
    // the DM's manual data must never be rewritten by regeneration.
    const manualDesc = (npc as any).manual_description;
    let finalBio: string;
    if (manualDesc !== null && manualDesc !== undefined) {
        finalBio = manualDesc;
        console.log(`[Sync] ${npcName}: Usando manual_description (${finalBio.length} chars)`);
    } else {
        finalBio = await generateBio('NPC', {
            name: npcName,
            role: npc.role || 'Sconosciuto',
            currentDesc: npc.description || ''
        }, history);
    }

    // Historical threshold of the single path: 100 chars (the batch uses 50)
    await finalizeNpcSync(campaignId, npcName, npc.role || 'Sconosciuto', npc.status || 'Sconosciuto', finalBio, 100);

    console.log(`[Sync] ${npcName} sincronizzato.`);
    return finalBio;
}

/**
 * Batch sync of every dirty NPC.
 */
export async function syncAllDirtyNpcs(campaignId: number): Promise<number> {
    const dirtyNpcs = getDirtyNpcs(campaignId);

    if (dirtyNpcs.length === 0) {
        console.log('[Sync] Nessun NPC da sincronizzare.');
        return 0;
    }

    console.log(`[Sync] 📥 Inizio sync per ${dirtyNpcs.length} NPC...`);

    return syncDirtyInBatches(dirtyNpcs, 'NPC',
        (npc: any) => ({
            entity: npc,
            name: npc.name,
            context: {
                name: npc.name,
                role: npc.role || 'Sconosciuto',
                currentDesc: npc.description || '',
                manualDescription: npc.manual_description || undefined
            },
            history: formatHistoryEvents(getNpcHistory(campaignId, npc.name) as any)
        }),
        async (npc: any, newDesc: string) => {
            await finalizeNpcSync(campaignId, npc.name, npc.role || 'Sconosciuto', npc.status || 'Sconosciuto', newDesc, 50);
            console.log(`[Sync] ✅ ${npc.name} sincronizzato.`);
        }
    );
}

/**
 * Sync manuale di un dossier NPC specifico (Compatibilità Legacy).
 */
export async function syncNpcDossier(campaignId: number, npcName: string, description: string, role: string | null, status: string | null) {
    const content = `DOSSIER NPC: ${npcName}. RUOLO: ${role || 'Sconosciuto'}. STATO: ${status || 'Sconosciuto'}. DESCRIZIONE: ${description}`;
    console.log(`[RAG] 🔄 Sync Dossier per ${npcName}...`);
    await ingestGenericEvent(campaignId, 'DOSSIER_SYNC', content, [npcName], 'DOSSIER');
}
