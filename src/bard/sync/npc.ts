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
    const manualDesc = (npc as any).manual_description;
    let finalBio: string;

    // Se esiste manual_description, usala direttamente (anche se vuota) invece dell'AI
    if (manualDesc !== null && manualDesc !== undefined) {
        finalBio = manualDesc;
        console.log(`[Sync] ${npcName}: Usando manual_description (${finalBio.length} chars)`);
    } else {
        // Solo se non c'è manual_description, genera con AI
        finalBio = await generateBio('NPC', {
            name: npcName,
            role: npc.role || 'Sconosciuto',
            currentDesc: npc.description || ''
        }, history);
    }

    updateNpcEntry(campaignId, npcName, finalBio, npc.role || undefined);
    deleteNpcRagSummary(campaignId, npcName);

    if (finalBio.length > 100) {
        const ragContent = `[[SCHEDA UFFICIALE: ${npcName}]]
RUOLO: ${npc.role || 'Sconosciuto'}
STATO: ${npc.status || 'Sconosciuto'}
BIOGRAFIA COMPLETA: ${finalBio}

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
    return finalBio;
}

/**
 * Batch sync di tutti gli NPC dirty
 */
/**
 * Batch sync di tutti gli NPC dirty
 */
/**
 * Batch sync di tutti gli NPC dirty
 */
export async function syncAllDirtyNpcs(campaignId: number): Promise<number> {
    const dirtyNpcs = getDirtyNpcs(campaignId);

    if (dirtyNpcs.length === 0) {
        console.log('[Sync] Nessun NPC da sincronizzare.');
        return 0;
    }

    console.log(`[Sync] 📥 Inizio sync per ${dirtyNpcs.length} NPC...`);

    // Process ALL in Batches (AI handles manual guidance)
    if (dirtyNpcs.length > 0) {
        // Import batch generator
        const { generateBioBatch } = await import('../bio');

        const BATCH_SIZE = 5;
        for (let i = 0; i < dirtyNpcs.length; i += BATCH_SIZE) {
            const batch = dirtyNpcs.slice(i, i + BATCH_SIZE);

            // Prepare payload
            const batchInput = [];
            for (const npc of batch) {
                const history = getNpcHistory(campaignId, npc.name);
                const historyEvents = history.map(h => `[${h.event_type}] ${h.description}`).slice(-20).join('\n');

                batchInput.push({
                    name: npc.name,
                    context: {
                        name: npc.name,
                        role: npc.role || 'Sconosciuto',
                        currentDesc: npc.description || '',
                        manualDescription: npc.manual_description || undefined // 🆕 Pass manual description
                    },
                    history: historyEvents
                });
            }

            // Call AI
            const results = await generateBioBatch('NPC', batchInput);

            // Apply results
            for (const input of batchInput) {
                const newDesc = results[input.name] || input.context.currentDesc; // Fallback
                const originalNpc = batch.find(n => n.name === input.name);
                if (originalNpc) {
                    await finalizeNpcSync(campaignId, input.name, originalNpc.role || 'Sconosciuto', originalNpc.status || 'Sconosciuto', newDesc);
                }
            }
        }
    }

    return dirtyNpcs.length;
}

/**
 * Common Finalizer for NPC Sync
 */
async function finalizeNpcSync(campaignId: number, npcName: string, role: string, status: string, description: string) {
    updateNpcEntry(campaignId, npcName, description, role);
    deleteNpcRagSummary(campaignId, npcName);

    if (description.length > 50) {
        const ragContent = `[[SCHEDA UFFICIALE: ${npcName}]]
RUOLO: ${role}
STATO: ${status}
BIOGRAFIA COMPLETA: ${description}

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
    console.log(`[Sync] ✅ ${npcName} sincronizzato.`);
}


/**
 * Sync manuale di un dossier NPC specifico (Compatibilità Legacy)
 */
export async function syncNpcDossier(campaignId: number, npcName: string, description: string, role: string | null, status: string | null) {
    const content = `DOSSIER NPC: ${npcName}. RUOLO: ${role || 'Sconosciuto'}. STATO: ${status || 'Sconosciuto'}. DESCRIZIONE: ${description}`;
    console.log(`[RAG] 🔄 Sync Dossier per ${npcName}...`);
    await ingestGenericEvent(campaignId, 'DOSSIER_SYNC', content, [npcName], 'DOSSIER');
}
