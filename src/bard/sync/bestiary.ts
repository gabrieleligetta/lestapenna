/**
 * Bard Sync - Bestiary synchronization functions
 */

import { getMonsterByName, clearBestiaryDirtyFlag, getDirtyBestiaryEntries, deleteBestiaryRagSummary } from '../../db';
import { ingestGenericEvent } from '../rag';
import { generateBio } from '../bio';

/**
 * Sincronizza Monster Entry nel RAG (con rigenerazione bio)
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

    // 1. Fetch History and Generate Bio
    const { bestiaryRepository } = await import('../../db/repositories/BestiaryRepository');
    const history = bestiaryRepository.getBestiaryHistory(campaignId, monsterName);
    const simpleHistory = history.map((h: any) => ({ description: h.description, event_type: h.event_type }));

    const newBio = await generateBio('MONSTER', {
        campaignId,
        name: monsterName,
        currentDesc: monster.description || '',
        manualDescription: (monster as any).manual_description || undefined // 🆕 Passa la descrizione manuale
    }, simpleHistory);

    // 2. Build RAG content
    let ragContent = `[[SCHEDA BESTIARIO UFFICIALE: ${monsterName}]]\n`;
    if (newBio) ragContent += `DOSSIER ECOLOGICO: ${newBio}\n`;
    if (monster.count) ragContent += `QUANTITÀ/DETTAGLI: ${monster.count}\n`;
    if (monster.status) ragContent += `STATO: ${monster.status}\n`;

    // Extended attributes
    if (monster.abilities) {
        try {
            const abils = JSON.parse(monster.abilities);
            if (abils.length > 0) ragContent += `ABILITÀ: ${abils.join(', ')}\n`;
        } catch (e) { }
    }
    if (monster.weaknesses) {
        try {
            const weaks = JSON.parse(monster.weaknesses);
            if (weaks.length > 0) ragContent += `DEBOLEZZE: ${weaks.join(', ')}\n`;
        } catch (e) { }
    }
    if (monster.resistances) {
        try {
            const res = JSON.parse(monster.resistances);
            if (res.length > 0) ragContent += `RESISTENZE: ${res.join(', ')}\n`;
        } catch (e) { }
    }

    ragContent += `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    await ingestGenericEvent(
        campaignId,
        'BESTIARY_UPDATE',
        ragContent,
        [monsterName],
        'BESTIARY'
    );

    clearBestiaryDirtyFlag(campaignId, monsterName);
    console.log(`[Sync] Bestiario ${monsterName} sincronizzato.`);
}

/**
 * Batch sync di tutti i mostri dirty
 */
/**
 * Batch sync di tutti i mostri dirty
 */
export async function syncAllDirtyBestiary(campaignId: number): Promise<number> {
    const dirty = getDirtyBestiaryEntries(campaignId);

    if (dirty.length === 0) return 0;

    console.log(`[Sync] 📥 Inizio sync per ${dirty.length} voci Bestiario...`);

    if (dirty.length > 0) {
        const { generateBioBatch } = await import('../bio');
        const { bestiaryRepository } = await import('../../db/repositories/BestiaryRepository');
        const BATCH_SIZE = 5;

        for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
            const batch = dirty.slice(i, i + BATCH_SIZE);

            const batchInput = [];
            for (const m of batch) {
                const history = bestiaryRepository.getBestiaryHistory(campaignId, m.name);
                const historyEvents = history.map((h: any) => `[${h.event_type}] ${h.description}`).slice(-20).join('\n');

                // Get extended info for context
                const extInfo = [];
                if (m.abilities) extInfo.push(`Abilità: ${m.abilities}`);
                if (m.weaknesses) extInfo.push(`Debolezze: ${m.weaknesses}`);

                batchInput.push({
                    name: m.name,
                    context: {
                        name: m.name,
                        role: m.status || 'Sconosciuto',
                        campaignId,
                        currentDesc: m.description || '',
                        manualDescription: (m as any).manual_description || undefined
                    },
                    history: historyEvents || (extInfo.length > 0 ? `Dettagli noti: ${extInfo.join('; ')}` : "Nessun evento.")
                });
            }

            const results = await generateBioBatch('MONSTER', batchInput);

            for (const input of batchInput) {
                const newDesc = results[input.name] || input.context.currentDesc;
                const original = batch.find(m => m.name === input.name);

                if (original) {
                    await finalizeBestiarySync(campaignId, original, newDesc);
                }
            }
        }
    }

    return dirty.length;
}

async function finalizeBestiarySync(campaignId: number, monster: any, newDesc: string) {
    const { bestiaryRepository } = await import('../../db/repositories/BestiaryRepository');

    // Update DB
    bestiaryRepository.updateBestiaryDescription(campaignId, monster.name, newDesc);

    // Build RAG Content
    let ragContent = `[[SCHEDA BESTIARIO UFFICIALE: ${monster.name}]]\n`;
    if (newDesc) ragContent += `DOSSIER ECOLOGICO: ${newDesc}\n`;
    if (monster.count) ragContent += `QUANTITÀ/DETTAGLI: ${monster.count}\n`;
    if (monster.status) ragContent += `STATO: ${monster.status}\n`;

    // Extended attributes
    if (monster.abilities) {
        try {
            const abils = JSON.parse(monster.abilities);
            if (abils.length > 0) ragContent += `ABILITÀ: ${abils.join(', ')}\n`;
        } catch (e) { }
    }
    if (monster.weaknesses) {
        try {
            const weaks = JSON.parse(monster.weaknesses);
            if (weaks.length > 0) ragContent += `DEBOLEZZE: ${weaks.join(', ')}\n`;
        } catch (e) { }
    }
    if (monster.resistances) {
        try {
            const res = JSON.parse(monster.resistances);
            if (res.length > 0) ragContent += `RESISTENZE: ${res.join(', ')}\n`;
        } catch (e) { }
    }

    ragContent += `\n(Questa scheda ufficiale ha priorità su informazioni frammentarie precedenti)`;

    // Ingest
    await ingestGenericEvent(
        campaignId,
        'BESTIARY_UPDATE',
        ragContent,
        [monster.name],
        'BESTIARY'
    );

    // Clear flag
    clearBestiaryDirtyFlag(campaignId, monster.name);
    console.log(`[Sync] ✅ Bestiario ${monster.name} sincronizzato.`);
}
