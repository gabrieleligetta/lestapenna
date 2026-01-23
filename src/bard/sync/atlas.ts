/**
 * Bard Sync - Atlas synchronization functions
 */

import { getAtlasEntryFull, clearAtlasDirtyFlag, getDirtyAtlasEntries, deleteAtlasRagSummary } from '../../db';
import { ingestGenericEvent } from '../rag';

/**
 * Sincronizza una voce Atlas nel RAG (LAZY - solo se necessario)
 */
export async function syncAtlasEntryIfNeeded(
    campaignId: number,
    macro: string,
    micro: string,
    force: boolean = false
): Promise<string | null> {

    const entry = getAtlasEntryFull(campaignId, macro, micro);
    if (!entry) return null;

    const needsSync = (entry as any).rag_sync_needed === 1;
    if (!force && !needsSync) {
        console.log(`[Sync Atlas] ${macro} - ${micro} gia sincronizzato, skip.`);
        return entry.description;
    }

    console.log(`[Sync Atlas] Avvio sync per ${macro} - ${micro}...`);

    deleteAtlasRagSummary(campaignId, macro, micro);

    if (entry.description && entry.description.length > 50) {
        const locationKey = `${macro}|${micro}`;
        const ragContent = `[[SCHEDA LUOGO UFFICIALE: ${macro} - ${micro}]]
MACRO REGIONE: ${macro}
LUOGO SPECIFICO: ${micro}
DESCRIZIONE COMPLETA: ${entry.description}
CHIAVE: ${locationKey}

(Questa scheda ufficiale del luogo ha priorita su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'ATLAS_UPDATE',
            ragContent,
            [],
            'ATLAS'
        );
    }

    clearAtlasDirtyFlag(campaignId, macro, micro);

    console.log(`[Sync Atlas] ${macro} - ${micro} sincronizzato.`);
    return entry.description;
}

/**
 * Batch sync di tutti i luoghi dirty
 */
export async function syncAllDirtyAtlas(campaignId: number): Promise<number> {
    const dirtyEntries = getDirtyAtlasEntries(campaignId);

    if (dirtyEntries.length === 0) {
        console.log('[Sync Atlas] Nessun luogo da sincronizzare.');
        return 0;
    }

    console.log(`[Sync Atlas] Sincronizzazione batch di ${dirtyEntries.length} luoghi...`);

    for (const entry of dirtyEntries) {
        try {
            await syncAtlasEntryIfNeeded(campaignId, entry.macro_location, entry.micro_location, true);
        } catch (e) {
            console.error(`[Sync Atlas] Errore sync ${entry.macro_location} - ${entry.micro_location}:`, e);
        }
    }

    return dirtyEntries.length;
}
