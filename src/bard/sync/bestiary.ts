/**
 * Bard Sync - Bestiary: sync towards the RAG with bio regeneration.
 * Single card builder + shared batch loop (see entitySync.ts).
 */

import { getMonsterByName, clearBestiaryDirtyFlag, getDirtyBestiaryEntries } from '../../db';
import { bestiaryRepository } from '../../db/repositories/BestiaryRepository';
import { ingestEntitySnapshot } from '../rag';
import { generateBio } from '../bio';
import { syncDirtyInBatches, formatHistoryEvents, RAG_PRIORITY_FOOTER } from './entitySync';

/** Appends a "LABEL: a, b" line when the monster's JSON-array field is not empty. */
function appendJsonArrayLine(label: string, json: string | null | undefined): string {
    if (!json) return '';
    try {
        const values = JSON.parse(json);
        if (Array.isArray(values) && values.length > 0) return `${label}: ${values.join(', ')}\n`;
    } catch { /* json malformato: skip */ }
    return '';
}

function buildBestiaryRagContent(monster: any, bio: string): string {
    let ragContent = `[[SCHEDA BESTIARIO UFFICIALE: ${monster.name}]]\n`;
    if (bio) ragContent += `DOSSIER ECOLOGICO: ${bio}\n`;
    if (monster.status) ragContent += `STATO: ${monster.status}\n`;
    ragContent += appendJsonArrayLine('ABILITÀ', monster.abilities);
    ragContent += appendJsonArrayLine('DEBOLEZZE', monster.weaknesses);
    ragContent += appendJsonArrayLine('RESISTENZE', monster.resistances);
    return ragContent + RAG_PRIORITY_FOOTER;
}

async function ingestMonster(campaignId: number, monster: any, bio: string): Promise<void> {
    await ingestEntitySnapshot(campaignId, 'BESTIARY_UPDATE', buildBestiaryRagContent(monster, bio), [monster.name], 'BESTIARY');
    clearBestiaryDirtyFlag(campaignId, monster.name);
}

/**
 * Syncs a single bestiary entry into the RAG (with bio regeneration).
 */
export async function syncBestiaryEntryIfNeeded(
    campaignId: number,
    monsterName: string,
    force: boolean = false
): Promise<void> {
    const monster = getMonsterByName(campaignId, monsterName);
    if (!monster) return;

    const needsSync = (monster as any).rag_sync_needed === 1;
    if (!force && !needsSync) return;

    console.log(`[Sync] Avvio sync Bestiario per ${monsterName}...`);

    const history = bestiaryRepository.getBestiaryHistory(campaignId, monsterName)
        .map((h: any) => ({ description: h.description, event_type: h.event_type }));

    // generateBio already persists the description (see bio.ts, MONSTER branch)
    const newBio = await generateBio('MONSTER', {
        campaignId,
        name: monsterName,
        currentDesc: monster.description || '',
        manualDescription: (monster as any).manual_description || undefined
    }, history);

    await ingestMonster(campaignId, monster, newBio);
    console.log(`[Sync] Bestiario ${monsterName} sincronizzato.`);
}

/**
 * Batch sync of every dirty monster.
 */
export async function syncAllDirtyBestiary(campaignId: number): Promise<number> {
    const dirty = getDirtyBestiaryEntries(campaignId);
    if (dirty.length === 0) return 0;

    console.log(`[Sync] 📥 Inizio sync per ${dirty.length} voci Bestiario...`);

    return syncDirtyInBatches(dirty, 'MONSTER',
        (m: any) => {
            const historyEvents = formatHistoryEvents(bestiaryRepository.getBestiaryHistory(campaignId, m.name) as any);

            // With no history, the known extended details act as minimal context for the bio
            const extInfo = [];
            if (m.abilities) extInfo.push(`Abilità: ${m.abilities}`);
            if (m.weaknesses) extInfo.push(`Debolezze: ${m.weaknesses}`);

            return {
                entity: m,
                name: m.name,
                context: {
                    name: m.name,
                    role: m.status || 'Sconosciuto',
                    campaignId,
                    currentDesc: m.description || '',
                    manualDescription: (m as any).manual_description || undefined
                },
                history: historyEvents || (extInfo.length > 0 ? `Dettagli noti: ${extInfo.join('; ')}` : 'Nessun evento.')
            };
        },
        async (m: any, newDesc: string) => {
            bestiaryRepository.updateBestiaryDescription(campaignId, m.name, newDesc);
            await ingestMonster(campaignId, m, newDesc);
            console.log(`[Sync] ✅ Bestiario ${m.name} sincronizzato.`);
        }
    );
}
