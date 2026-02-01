/**
 * Bard Sync - Atlas synchronization functions
 */

import { getAtlasEntryFull, clearAtlasDirtyFlag, getDirtyAtlasEntries, deleteAtlasRagSummary, getAtlasHistory, updateAtlasEntry } from '../../db';
import { ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';

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
    const needsSync = entry ? (entry as any).rag_sync_needed === 1 : false;

    // Se non esiste, non possiamo syncare nulla (o dovremmo crearlo?)
    // Per ora assumiamo che entry esista o che stiamo facendo force update.
    // Ma se viene chiamato da atlasCommand, entry potrebbe esistere.

    // Force: rigenera descrizione dalla storia
    if (force || needsSync) {
        console.log(`[Sync Atlas] 🔄 Rigenerazione Bio per ${macro} - ${micro}...`);

        // 1. Fetch History
        const history = getAtlasHistory(campaignId, macro, micro);

        // 2. Generate Bio
        const newDesc = await generateBio('LOCATION', {
            name: `${macro} - ${micro}`,
            macro: macro,
            micro: micro,
            campaignId,
            currentDesc: entry?.description || "",
            manualDescription: (entry as any).manual_description || undefined // 🆕 Passa la descrizione manuale
        }, history);

        // 3. Update DB
        // Nota: updateAtlasEntry aggiorna e setta rag_sync_needed=1, ma qui stiamo facendo il sync.
        // Quindi dobbiamo aggiornare la descrizione E poi resettare il flag, O aggiornare senza flag.
        // updateAtlasEntry setta flag=1. 
        // Possiamo usare una funzione DB diretta o accettare che sia dirty per il RAG ingest successivo?
        // Il flusso originale faceva: ingest RAG -> clear flag.
        // Qui stiamo aggiornando la SOURCE (description) prima di ingest.

        // Update Description
        updateAtlasEntry(campaignId, macro, micro, newDesc);

        // Ingest RAG (ora che la descrizione è aggiornata)
        deleteAtlasRagSummary(campaignId, macro, micro);

        if (newDesc && newDesc.length > 50) {
            const locationKey = `${macro}|${micro}`;
            const ragContent = `[[SCHEDA LUOGO UFFICIALE: ${macro} - ${micro}]]
MACRO REGIONE: ${macro}
LUOGO SPECIFICO: ${micro}
DESCRIZIONE COMPLETA: ${newDesc}
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
        console.log(`[Sync Atlas] ✅ ${macro} - ${micro} rigenerato e sincronizzato.`);
        return newDesc;
    }

    return entry?.description || null;
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
