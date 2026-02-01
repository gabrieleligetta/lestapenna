/**
 * Bard Sync - Artifact synchronization functions
 */

import { getArtifactByName, clearArtifactDirtyFlag, getDirtyArtifacts } from '../../db';
import { ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';

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

    // 1. Fetch History
    const { artifactRepository } = await import('../../db/repositories/ArtifactRepository');
    const history = artifactRepository.getArtifactHistory(campaignId, artifactName);

    // 2. Generate Bio (Historical Memory)
    const newBio = await generateBio('ARTIFACT', {
        campaignId,
        name: artifactName,
        currentDesc: artifact.description || '',
        manualDescription: (artifact as any).manual_description || undefined // 🆕 Passa la descrizione manuale
    }, history);


    // 3. Build RAG content
    let ragContent = `[[SCHEDA ARTEFATTO UFFICIALE: ${artifactName}]]\n`;
    ragContent += `DESCRIZIONE COMPLETA: ${newBio}\n`;
    if (artifact.effects) ragContent += `EFFETTI CONOSCIUTI: ${artifact.effects}\n`;
    if (artifact.status) ragContent += `STATO: ${artifact.status}\n`;
    if (artifact.is_cursed) {
        ragContent += `MALEDETTO: Sì\n`;
        if (artifact.curse_description) ragContent += `MALEDIZIONE: ${artifact.curse_description}\n`;
    }
    if (artifact.owner_name) ragContent += `POSSESSORE ATTUALE: ${artifact.owner_name} (${artifact.owner_type})\n`;
    if (artifact.location_macro || artifact.location_micro) {
        ragContent += `POSIZIONE: ${artifact.location_macro || ''} ${artifact.location_micro ? '- ' + artifact.location_micro : ''}\n`;
    }

    ragContent += `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    // 4. Ingest into RAG
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
