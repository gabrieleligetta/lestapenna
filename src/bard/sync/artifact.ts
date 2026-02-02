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
/**
 * Batch sync di tutti gli artefatti dirty
 */
export async function syncAllDirtyArtifacts(campaignId: number): Promise<number> {
    const dirty = getDirtyArtifacts(campaignId);

    if (dirty.length === 0) return 0;

    console.log(`[Sync] 📥 Inizio sync per ${dirty.length} artefatti...`);

    if (dirty.length > 0) {
        const { generateBioBatch } = await import('../bio');
        const { artifactRepository } = await import('../../db/repositories/ArtifactRepository');
        const BATCH_SIZE = 5;

        for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
            const batch = dirty.slice(i, i + BATCH_SIZE);

            const batchInput = [];
            for (const artifact of batch) {
                const history = artifactRepository.getArtifactHistory(campaignId, artifact.name);
                const historyEvents = history.map((h: any) => `[${h.event_type}] ${h.description}`).slice(-20).join('\n');

                batchInput.push({
                    name: artifact.name,
                    context: {
                        name: artifact.name,
                        campaignId,
                        currentDesc: artifact.description || '',
                        manualDescription: (artifact as any).manual_description || undefined
                    },
                    history: historyEvents || "Nessun evento."
                });
            }

            const results = await generateBioBatch('ARTIFACT', batchInput);

            for (const input of batchInput) {
                const newDesc = results[input.name] || input.context.currentDesc;
                const original = batch.find(a => a.name === input.name);
                if (original) {
                    await finalizeArtifactSync(campaignId, original, newDesc);
                }
            }
        }
    }

    return dirty.length;
}

async function finalizeArtifactSync(campaignId: number, artifact: any, newDesc: string) {
    const { artifactRepository } = await import('../../db/repositories/ArtifactRepository');

    // Update DB
    artifactRepository.updateArtifactDescription(campaignId, artifact.name, newDesc);

    // Build RAG content
    let ragContent = `[[SCHEDA ARTEFATTO UFFICIALE: ${artifact.name}]]\n`;
    ragContent += `DESCRIZIONE COMPLETA: ${newDesc}\n`;
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

    // Ingest into RAG
    await ingestGenericEvent(
        campaignId,
        'ARTIFACT_UPDATE',
        ragContent,
        [artifact.name],
        'ARTIFACT'
    );

    clearArtifactDirtyFlag(campaignId, artifact.name);
    console.log(`[Sync] ✅ Artefatto ${artifact.name} sincronizzato.`);
}
