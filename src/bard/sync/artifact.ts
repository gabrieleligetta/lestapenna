/**
 * Bard Sync - Artifact synchronization functions
 */

import { getArtifactByName, clearArtifactDirtyFlag, getDirtyArtifacts } from '../../db';
import { ingestGenericEvent } from '../rag';

/**
 * Sincronizza un artefatto nel RAG
 */
export async function syncArtifactEntryIfNeeded(
    campaignId: number,
    artifactName: string,
    force: boolean = false
): Promise<void> {
    const artifact = getArtifactByName(campaignId, artifactName);
    if (!artifact) return;

    const needsSync = (artifact as any).rag_sync_needed === 1;
    if (!force && !needsSync) return;

    console.log(`[Sync] Avvio sync Artefatto: ${artifactName}...`);

    let ragContent = `[[ARTEFATTO: ${artifactName}]]\n`;
    if (artifact.description) ragContent += `DESCRIZIONE: ${artifact.description}\n`;
    if (artifact.effects) ragContent += `EFFETTI: ${artifact.effects}\n`;
    if (artifact.status) ragContent += `STATO: ${artifact.status}\n`;
    if (artifact.is_cursed) {
        ragContent += `MALEDETTO: Sì\n`;
        if (artifact.curse_description) ragContent += `MALEDIZIONE: ${artifact.curse_description}\n`;
    }
    if (artifact.owner_name) ragContent += `PROPRIETARIO: ${artifact.owner_name} (${artifact.owner_type})\n`;
    if (artifact.location_macro || artifact.location_micro) {
        ragContent += `POSIZIONE: ${artifact.location_macro || ''} ${artifact.location_micro ? '- ' + artifact.location_micro : ''}\n`;
    }

    await ingestGenericEvent(
        campaignId,
        'ARTIFACT_UPDATE',
        ragContent,
        [artifactName],
        'ARTIFACT'
    );

    clearArtifactDirtyFlag(campaignId, artifactName);
    console.log(`[Sync] Artefatto ${artifactName} sincronizzato.`);
}

/**
 * Batch sync di tutti gli artefatti dirty
 */
export async function syncAllDirtyArtifacts(campaignId: number): Promise<number> {
    const dirty = getDirtyArtifacts(campaignId);

    if (dirty.length === 0) return 0;

    console.log(`[Sync] Sincronizzazione batch di ${dirty.length} artefatti...`);

    for (const artifact of dirty) {
        try {
            await syncArtifactEntryIfNeeded(campaignId, artifact.name, true);
        } catch (e) {
            console.error(`[Sync] Errore sync artefatto ${artifact.name}:`, e);
        }
    }

    return dirty.length;
}
