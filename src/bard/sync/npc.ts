/**
 * Bard Sync - NPC synchronization functions
 */

import { getNpcEntry, updateNpcEntry, clearNpcDirtyFlag, getDirtyNpcs, deleteNpcRagSummary, getNpcHistory } from '../../db';
import { ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';

/**
 * Sincronizza NPC Dossier (LAZY - solo se necessario)
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

    // 1. Fetch History
    const history = getNpcHistory(campaignId, npcName);

    // 2. Generate Bio using unified service
    const newBio = await generateBio('NPC', {
        name: npcName,
        role: npc.role || 'Sconosciuto',
        currentDesc: npc.description || '',
        manualDescription: (npc as any).manual_description || undefined // 🆕 Passa la descrizione manuale come guida
    }, history);

    updateNpcEntry(campaignId, npcName, newBio, npc.role || undefined);
    deleteNpcRagSummary(campaignId, npcName);

    if (newBio.length > 100) {
        const ragContent = `[[SCHEDA UFFICIALE: ${npcName}]]
RUOLO: ${npc.role || 'Sconosciuto'}
STATO: ${npc.status || 'Sconosciuto'}
BIOGRAFIA COMPLETA: ${newBio}

(Questa scheda ufficiale ha priorita su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'DOSSIER_UPDATE',
            ragContent,
            [npcName],
            'DOSSIER'
        );
    }

    clearNpcDirtyFlag(campaignId, npcName);

    console.log(`[Sync] ${npcName} sincronizzato.`);
    return newBio;
}

/**
 * Batch sync di tutti gli NPC dirty
 */
export async function syncAllDirtyNpcs(campaignId: number): Promise<number> {
    const dirtyNpcs = getDirtyNpcs(campaignId);

    if (dirtyNpcs.length === 0) {
        console.log('[Sync] Nessun NPC da sincronizzare.');
        return 0;
    }

    console.log(`[Sync] Sincronizzazione batch di ${dirtyNpcs.length} NPC...`);

    for (const npc of dirtyNpcs) {
        try {
            await syncNpcDossierIfNeeded(campaignId, npc.name, true);
        } catch (e) {
            console.error(`[Sync] Errore sync ${npc.name}:`, e);
        }
    }

    return dirtyNpcs.length;
}


/**
 * Sync manuale di un dossier NPC specifico (Compatibilità Legacy)
 */
export async function syncNpcDossier(campaignId: number, npcName: string, description: string, role: string | null, status: string | null) {
    const content = `DOSSIER NPC: ${npcName}. RUOLO: ${role || 'Sconosciuto'}. STATO: ${status || 'Sconosciuto'}. DESCRIZIONE: ${description}`;
    console.log(`[RAG] 🔄 Sync Dossier per ${npcName}...`);
    await ingestGenericEvent(campaignId, 'DOSSIER_SYNC', content, [npcName], 'DOSSIER');
}
