/**
 * Bard RAG Ingest - Functions for ingesting data into RAG
 */

import {
    insertKnowledgeFragment,
    getNpcEntry,
    createEntityRef,
    getSessionCampaignId,
    deleteSessionKnowledge,
    getSessionStartTime,
    getNpcIdByName,
    knowledgeRepository
} from '../../db';
import {
    ollamaEmbedClient,
    EMBEDDING_MODEL_OLLAMA,
    EMBEDDING_BATCH_SIZE
} from '../config';
import { monitor } from '../../monitor';
import { SummaryResponse } from '../types';
import { processInBatches } from '../helpers';

/**
 * Ingestion generica nel RAG (per snapshot autorevoli)
 */
export async function ingestGenericEvent(
    campaignId: number,
    sessionId: string,
    content: string,
    npcs: string[],
    microLoc: string,
    timestamp?: number
): Promise<void> {
    const startAI = Date.now();

    try {
        const resp = await ollamaEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OLLAMA,
            input: content
        });
        monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
        insertKnowledgeFragment(
            campaignId,
            sessionId,
            content,
            resp.data[0].embedding,
            EMBEDDING_MODEL_OLLAMA,
            timestamp || Date.now(),
            null,
            microLoc,
            npcs
        );
    } catch (err: any) {
        console.error('[RAG] Errore embedding Ollama:', err.message);
        monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, true);
    }

    console.log(`[RAG] Evento generico indicizzato in ${Date.now() - startAI}ms`);
}

/**
 * Indicizza un evento biografico nel RAG
 */
export async function ingestBioEvent(
    campaignId: number,
    sessionId: string,
    charName: string,
    event: string,
    type: string,
    timestamp?: number
) {
    const content = `[BIOGRAFIA ${charName}] [${type}] ${event}`;
    await ingestGenericEvent(campaignId, sessionId, content, [charName], 'BIOGRAPHY', timestamp);
}

/**
 * Indicizza un evento mondiale nel RAG
 */
export async function ingestWorldEvent(
    campaignId: number,
    sessionId: string,
    event: string,
    type: string,
    timestamp?: number
) {
    const content = `[CRONACA MONDIALE] [${type}] ${event}`;
    await ingestGenericEvent(campaignId, sessionId, content, [], 'WORLD', timestamp);
}

/**
 * Indicizza un oggetto importante nel RAG
 */
export async function ingestLootEvent(
    campaignId: number,
    sessionId: string,
    item: string | { name: string; quantity?: number; description?: string },
    timestamp?: number
) {
    let content: string;
    if (typeof item === 'string') {
        content = `[BOTTINO] ${item}`;
    } else {
        content = `[BOTTINO] ${item.name}`;
        if (item.quantity && item.quantity > 1) content += ` (x${item.quantity})`;
        if (item.description) content += `: ${item.description}`;
    }
    await ingestGenericEvent(campaignId, sessionId, content, [], 'LOOT', timestamp);
}

/**
 * RAG: INGESTION POST-SUMMARY (usa dati Analista)
 */
export async function ingestSessionComplete(
    sessionId: string,
    summaryResult: SummaryResponse
): Promise<void> {
    const campaignId = getSessionCampaignId(sessionId);
    if (!campaignId) {
        console.warn(`[RAG] ⚠️ Sessione ${sessionId} senza campagna. Salto ingestione.`);
        return;
    }

    const textToIngest = summaryResult.narrative || summaryResult.summary || '';
    if (textToIngest.length < 100) {
        console.warn(`[RAG] ⚠️ Testo troppo corto per ingestione (${textToIngest.length} chars)`);
        return;
    }

    console.log(`[RAG] 🧠 Ingestione POST-SUMMARY per sessione ${sessionId}...`);
    console.log(`[RAG] 📊 Metadati Analista: ${summaryResult.present_npcs?.length || 0} NPC, ${summaryResult.location_updates?.length || 0} luoghi`);

    const startTime = getSessionStartTime(sessionId) || Date.now();

    const npcEntityRefs: string[] = [];
    if (summaryResult.present_npcs?.length) {
        for (const npcName of summaryResult.present_npcs) {
            const npcId = getNpcIdByName(campaignId, npcName);
            if (npcId) npcEntityRefs.push(createEntityRef('npc', npcId));
        }
    }

    let mainMacro: string | null = null;
    let mainMicro: string | null = null;
    if (summaryResult.location_updates?.length) {
        mainMacro = summaryResult.location_updates[0].macro || null;
        mainMicro = summaryResult.location_updates[0].micro || null;
    }

    const CHUNK_SIZE = 1500;
    const OVERLAP = 300;

    const chunks: Array<{
        text: string;
        timestamp: number;
        macro: string | null;
        micro: string | null;
        npcs: string[];
        entityRefs: string[];
    }> = [];

    let i = 0;
    while (i < textToIngest.length) {
        let end = Math.min(i + CHUNK_SIZE, textToIngest.length);
        if (end < textToIngest.length) {
            const lastPeriod = textToIngest.lastIndexOf('.', end);
            const lastNewLine = textToIngest.lastIndexOf('\n', end);
            const breakPoint = Math.max(lastPeriod, lastNewLine);
            if (breakPoint > i + (CHUNK_SIZE * 0.5)) end = breakPoint + 1;
        }

        const chunkText = textToIngest.substring(i, end).trim();

        if (chunkText.length > 50) {
            // NEW: Append Known Entities Metadata to the text (visible to LLM/Search)
            // This allows searching for "Leosin" and finding "Leosin [#abc12]"
            let enrichedText = chunkText;
            const contextAdditions: string[] = [];

            if (summaryResult.present_npcs && summaryResult.present_npcs.length > 0) {
                // Find NPCs mentioned in this chunk (approximate)
                const mentionedNpcs = summaryResult.present_npcs.filter(name =>
                    chunkText.toLowerCase().includes(name.toLowerCase())
                );

                for (const npcName of mentionedNpcs) {
                    const npc = getNpcEntry(campaignId, npcName);
                    if (npc && npc.short_id) {
                        contextAdditions.push(`${npc.name} [#${npc.short_id}]`);
                    }
                }
            }

            if (contextAdditions.length > 0) {
                enrichedText += `\n\n[ENTITIES: ${contextAdditions.join(', ')}]`;
            }

            chunks.push({
                text: enrichedText,
                timestamp: startTime,
                macro: mainMacro,
                micro: mainMicro,
                npcs: summaryResult.present_npcs || [],
                entityRefs: npcEntityRefs
            });
        }

        if (end >= textToIngest.length) break;
        i = end - OVERLAP;
    }

    console.log(`[RAG] 📦 Creati ${chunks.length} chunks (${CHUNK_SIZE} chars, ${OVERLAP} overlap)`);

    // Collect all successful embeddings first, then atomically replace in DB
    const successfulFragments: Array<{
        campaignId: number;
        content: string;
        embedding: number[];
        startTimestamp: number;
        macro: string | null;
        micro: string | null;
        npcs: string[];
        entityRefs: string[];
    }> = [];
    let failedCount = 0;

    await processInBatches(chunks, EMBEDDING_BATCH_SIZE, async (chunk, _idx) => {
        const startAI = Date.now();
        try {
            const resp = await ollamaEmbedClient.embeddings.create({
                model: EMBEDDING_MODEL_OLLAMA,
                input: chunk.text
            });
            monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
            successfulFragments.push({
                campaignId,
                content: chunk.text,
                embedding: resp.data[0].embedding,
                startTimestamp: chunk.timestamp,
                macro: chunk.macro,
                micro: chunk.micro,
                npcs: chunk.npcs,
                entityRefs: chunk.entityRefs || []
            });
        } catch (err: any) {
            failedCount++;
            console.error(`[RAG] Errore embedding chunk:`, err.message);
            monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, true);
        }
    }, `Ingestione RAG (${chunks.length} chunks)`);

    if (failedCount > 0) {
        console.warn(`[RAG] ⚠️ ${failedCount}/${chunks.length} chunks falliti durante l'embedding`);
    }

    // Atomic replace: delete old + insert new in a single transaction
    if (successfulFragments.length > 0) {
        knowledgeRepository.replaceSessionKnowledge(sessionId, EMBEDDING_MODEL_OLLAMA, successfulFragments);
        console.log(`[RAG] ✅ ${successfulFragments.length} frammenti salvati atomicamente nel DB`);
    } else {
        console.warn(`[RAG] ⚠️ Nessun frammento salvato (tutti i chunks falliti)`);
    }
}
