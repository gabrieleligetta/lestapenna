/**
 * Bard Sync - Artifact: sync towards the RAG with bio regeneration.
 * Single card builder + shared batch loop (see entitySync.ts).
 */

import { getArtifactByName, clearArtifactDirtyFlag, getDirtyArtifacts } from '../../db';
import { artifactRepository } from '../../db/repositories/ArtifactRepository';
import { ingestEntitySnapshot } from '../rag';
import { generateBio } from '../bio';
import { syncDirtyInBatches, formatHistoryEvents, RAG_PRIORITY_FOOTER } from './entitySync';

function buildArtifactRagContent(artifact: any, bio: string): string {
    let ragContent = `[[SCHEDA ARTEFATTO UFFICIALE: ${artifact.name}]]\n`;
    ragContent += `DESCRIZIONE COMPLETA: ${bio}\n`;
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
    return ragContent + RAG_PRIORITY_FOOTER;
}

async function ingestArtifact(campaignId: number, artifact: any, bio: string): Promise<void> {
    await ingestEntitySnapshot(campaignId, 'ARTIFACT_UPDATE', buildArtifactRagContent(artifact, bio), [artifact.name], 'ARTIFACT');
    clearArtifactDirtyFlag(campaignId, artifact.name);
}

/**
 * Syncs a single artifact into the RAG.
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

    const history = artifactRepository.getArtifactHistory(campaignId, artifactName);

    // generateBio already persists the description (see bio.ts, ARTIFACT branch)
    const newBio = await generateBio('ARTIFACT', {
        campaignId,
        name: artifactName,
        currentDesc: artifact.description || '',
        manualDescription: (artifact as any).manual_description || undefined
    }, history);

    await ingestArtifact(campaignId, artifact, newBio);
    console.log(`[Sync] Artefatto ${artifactName} sincronizzato.`);
}

/**
 * Batch sync of every dirty artifact.
 */
export async function syncAllDirtyArtifacts(campaignId: number): Promise<number> {
    const dirty = getDirtyArtifacts(campaignId);
    if (dirty.length === 0) return 0;

    console.log(`[Sync] 📥 Inizio sync per ${dirty.length} artefatti...`);

    return syncDirtyInBatches(dirty, 'ARTIFACT',
        (artifact: any) => ({
            entity: artifact,
            name: artifact.name,
            context: {
                name: artifact.name,
                campaignId,
                currentDesc: artifact.description || '',
                manualDescription: (artifact as any).manual_description || undefined
            },
            history: formatHistoryEvents(artifactRepository.getArtifactHistory(campaignId, artifact.name) as any) || 'Nessun evento.'
        }),
        async (artifact: any, newDesc: string) => {
            artifactRepository.updateArtifactDescription(campaignId, artifact.name, newDesc);
            await ingestArtifact(campaignId, artifact, newDesc);
            console.log(`[Sync] ✅ Artefatto ${artifact.name} sincronizzato.`);
        }
    );
}
