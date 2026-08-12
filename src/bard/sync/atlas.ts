/**
 * Bard Sync - Atlas: sync towards the RAG with bio regeneration.
 * Single finalize + shared batch loop (see entitySync.ts).
 */

import { getAtlasEntryFull, clearAtlasDirtyFlag, getDirtyAtlasEntries, deleteAtlasRagSummary, getAtlasHistory, updateAtlasEntry } from '../../db';
import { ingestEntitySnapshot } from '../rag';
import { generateBio } from '../bio';
import { syncDirtyInBatches, formatHistoryEvents } from './entitySync';

/**
 * Updates the description, replaces the RAG card and clears the dirty flag.
 * A single place for both paths (single and batch).
 * NB: it only ingests when the description is substantial (>50 chars) — this
 * avoids junk cards for locations just discovered with no events.
 */
async function finalizeAtlasSync(campaignId: number, macro: string, micro: string, description: string): Promise<void> {
    updateAtlasEntry(campaignId, macro, micro, description);

    if (description && description.length > 50) {
        const ragContent = `[[SCHEDA LUOGO UFFICIALE: ${macro} - ${micro}]]
MACRO REGIONE: ${macro}
LUOGO SPECIFICO: ${micro}
DESCRIZIONE COMPLETA: ${description}
CHIAVE: ${macro}|${micro}

(Questa scheda ufficiale del luogo ha priorita su informazioni frammentarie precedenti)`;

        await ingestEntitySnapshot(campaignId, 'ATLAS_UPDATE', ragContent, [], 'ATLAS');
    } else {
        deleteAtlasRagSummary(campaignId, macro, micro);
    }
    clearAtlasDirtyFlag(campaignId, macro, micro);
    console.log(`[Sync Atlas] ✅ ${macro} - ${micro} sincronizzato.`);
}

/**
 * Syncs an Atlas entry into the RAG (LAZY - only when needed).
 * Returns the description (regenerated or current).
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
    if (!force && !needsSync) return entry?.description || null;

    console.log(`[Sync Atlas] 🔄 Rigenerazione Bio per ${macro} - ${micro}...`);

    const history = getAtlasHistory(campaignId, macro, micro);

    const newDesc = await generateBio('LOCATION', {
        name: `${macro} - ${micro}`,
        macro: macro,
        micro: micro,
        campaignId,
        currentDesc: entry?.description || "",
        manualDescription: (entry as any).manual_description || undefined
    }, history);

    await finalizeAtlasSync(campaignId, macro, micro, newDesc);
    return newDesc;
}

/**
 * Batch sync of every dirty location.
 */
export async function syncAllDirtyAtlas(campaignId: number): Promise<number> {
    const dirtyEntries = getDirtyAtlasEntries(campaignId);

    if (dirtyEntries.length === 0) {
        console.log('[Sync Atlas] Nessun luogo da sincronizzare.');
        return 0;
    }

    console.log(`[Sync Atlas] 📥 Inizio sync per ${dirtyEntries.length} luoghi...`);

    return syncDirtyInBatches(dirtyEntries, 'LOCATION',
        (entry: any) => ({
            entity: entry,
            name: `${entry.macro_location} - ${entry.micro_location}`,
            context: {
                name: `${entry.macro_location} - ${entry.micro_location}`,
                macro: entry.macro_location,
                micro: entry.micro_location,
                campaignId,
                currentDesc: entry.description || "",
                manualDescription: (entry as any).manual_description || undefined
            },
            history: formatHistoryEvents(getAtlasHistory(campaignId, entry.macro_location, entry.micro_location) as any)
        }),
        (entry: any, newDesc: string) =>
            finalizeAtlasSync(campaignId, entry.macro_location, entry.micro_location, newDesc)
    );
}
