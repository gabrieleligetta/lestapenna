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
    getNpcIdByName
} from '../../db';
import {
    openaiEmbedClient,
    ollamaEmbedClient,
    EMBEDDING_MODEL_OPENAI,
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
    microLoc: string
): Promise<void> {
    const promises: any[] = [];
    const startAI = Date.now();

    // OpenAI Embedding
    promises.push(
        openaiEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OPENAI,
            input: content
        })
            .then(resp => {
                const inputTokens = resp.usage?.prompt_tokens || 0;
                monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, inputTokens, 0, 0, Date.now() - startAI, false);
                return { provider: 'openai', data: resp.data[0].embedding };
            })
            .catch(err => {
                console.error('[RAG] Errore embedding OpenAI:', err.message);
                monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, 0, 0, 0, Date.now() - startAI, true);
                return { provider: 'openai', error: err.message };
            })
    );

    // Ollama Embedding
    promises.push(
        ollamaEmbedClient.embeddings.create({
            model: EMBEDDING_MODEL_OLLAMA,
            input: content
        })
            .then(resp => {
                monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
                return { provider: 'ollama', data: resp.data[0].embedding };
            })
            .catch(err => {
                console.error('[RAG] Errore embedding Ollama:', err.message);
                monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, true);
                return { provider: 'ollama', error: err.message };
            })
    );

    const results = await Promise.allSettled(promises);

    for (const res of results) {
        if (res.status === 'fulfilled') {
            const val = res.value as any;
            if (!val.error) {
                insertKnowledgeFragment(
                    campaignId,
                    sessionId,
                    content,
                    val.data,
                    val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                    Date.now(),
                    null,
                    microLoc,
                    npcs
                );
            }
        }
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
    type: string
) {
    const content = `[BIOGRAFIA ${charName}] [${type}] ${event}`;
    await ingestGenericEvent(campaignId, sessionId, content, [charName], 'BIOGRAPHY');
}

/**
 * Indicizza un evento mondiale nel RAG
 */
export async function ingestWorldEvent(
    campaignId: number,
    sessionId: string,
    event: string,
    type: string
) {
    const content = `[CRONACA MONDIALE] [${type}] ${event}`;
    await ingestGenericEvent(campaignId, sessionId, content, [], 'WORLD');
}

/**
 * Indicizza un oggetto importante nel RAG
 */
export async function ingestLootEvent(
    campaignId: number,
    sessionId: string,
    itemDescription: string
) {
    const content = `[BOTTINO] ${itemDescription}`;
    await ingestGenericEvent(campaignId, sessionId, content, [], 'LOOT');
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

    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OPENAI);
    deleteSessionKnowledge(sessionId, EMBEDDING_MODEL_OLLAMA);

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
            chunks.push({
                text: chunkText,
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

    await processInBatches(chunks, EMBEDDING_BATCH_SIZE, async (chunk, idx) => {
        const promises: any[] = [];
        const startAI = Date.now();

        // OpenAI Task
        promises.push(
            openaiEmbedClient.embeddings.create({
                model: EMBEDDING_MODEL_OPENAI,
                input: chunk.text
            })
                .then(resp => {
                    const inputTokens = resp.usage?.prompt_tokens || 0;
                    monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, inputTokens, 0, 0, Date.now() - startAI, false);
                    return { provider: 'openai', data: resp.data[0].embedding };
                })
                .catch(err => {
                    monitor.logAIRequestWithCost('embeddings', 'openai', EMBEDDING_MODEL_OPENAI, 0, 0, 0, Date.now() - startAI, true);
                    return { provider: 'openai', error: err.message };
                })
        );

        // Ollama Task
        promises.push(
            ollamaEmbedClient.embeddings.create({
                model: EMBEDDING_MODEL_OLLAMA,
                input: chunk.text
            })
                .then(resp => {
                    monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, false);
                    return { provider: 'ollama', data: resp.data[0].embedding };
                })
                .catch(err => {
                    monitor.logAIRequestWithCost('embeddings', 'ollama', EMBEDDING_MODEL_OLLAMA, 0, 0, 0, Date.now() - startAI, true);
                    return { provider: 'ollama', error: err.message };
                })
        );

        const results = await Promise.allSettled(promises);

        for (const res of results) {
            if (res.status === 'fulfilled') {
                const val = res.value as any;
                if (!val.error) {
                    insertKnowledgeFragment(
                        campaignId, sessionId, chunk.text,
                        val.data,
                        val.provider === 'openai' ? EMBEDDING_MODEL_OPENAI : EMBEDDING_MODEL_OLLAMA,
                        chunk.timestamp,
                        chunk.macro,
                        chunk.micro,
                        chunk.npcs,
                        chunk.entityRefs || []
                    );
                }
            }
        }
    }, `Ingestione RAG (${chunks.length} chunks)`);
}
