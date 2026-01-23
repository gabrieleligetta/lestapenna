/**
 * Bard Sync - Timeline synchronization functions
 */

import { getDirtyWorldEvents, clearWorldEventDirtyFlag } from '../../db';
import { ingestWorldEvent } from '../rag';

/**
 * Batch sync di tutti gli eventi timeline dirty
 */
export async function syncAllDirtyTimeline(campaignId: number): Promise<number> {
    const dirtyEvents = getDirtyWorldEvents(campaignId);

    if (dirtyEvents.length === 0) {
        console.log('[Sync Timeline] Nessun evento da sincronizzare.');
        return 0;
    }

    console.log(`[Sync Timeline] Sincronizzazione batch di ${dirtyEvents.length} eventi...`);

    for (const evt of dirtyEvents) {
        try {
            await ingestWorldEvent(campaignId, evt.session_id || 'MANUAL_ENTRY', evt.description, evt.event_type);
            clearWorldEventDirtyFlag(evt.id);
        } catch (e) {
            console.error(`[Sync Timeline] Errore sync evento #${evt.id}:`, e);
        }
    }

    return dirtyEvents.length;
}
