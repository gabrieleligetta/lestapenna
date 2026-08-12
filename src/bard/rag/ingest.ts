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
    knowledgeRepository,
    entityProfileRepository
} from '../../db';
import { concurrencyFor } from '../config';
import {
    pinEmbeddingModel,
    resolveEmbedding,
    type ResolvedEmbedding,
} from '../ai/embeddings';
import type { AiScope } from '../ai/types';
import { scopeForCampaign } from '../ai/scope';
import { embedText, embedTexts } from '../llm/embeddings';
import { SummaryResponse } from '../types';

/**
 * The campaign's embedding model, pinning it if this is the first time.
 *
 * Pinning it at ingestion rather than at campaign creation is deliberate: at
 * creation time the table may not have configured anything yet, and freezing it
 * there would tie it to a choice made on its behalf.
 */
async function pinnedEmbeddingModel(campaignId: number, scope: AiScope): Promise<ResolvedEmbedding> {
    const resolved = await resolveEmbedding(scope);
    if (!resolved.pinned) {
        pinEmbeddingModel(campaignId, resolved.model, resolved.dimension);
    }
    return resolved;
}

/**
 * A vector of the wrong length is worse than a missing vector.
 *
 * The cosine between different spaces does not throw: it returns a number, and
 * that number would govern the search, producing arbitrary similarities. Better
 * not to insert it at all.
 */
function assertDimension(vector: number[], model: ResolvedEmbedding): void {
    if (model.dimension > 0 && vector.length !== model.dimension) {
        throw new Error(
            `EMBEDDING_DIMENSION_MISMATCH: ${model.model} ha prodotto ${vector.length} ` +
            `dimensioni invece di ${model.dimension}`,
        );
    }
}

/**
 * Generic ingestion into the RAG (for authoritative snapshots)
 */
async function ingestText(
    campaignId: number,
    sessionId: string,
    content: string,
    npcs: string[],
    microLoc: string,
    timestamp?: number,
    replaceHeader?: string,
): Promise<void> {
    const startAI = Date.now();

    try {
        const effectiveTimestamp = timestamp || Date.now();
        const indexedContent = replaceHeader
            ? knowledgeRepository.prepareEntityRagSnapshotContent(
                campaignId,
                sessionId,
                replaceHeader,
                content,
                effectiveTimestamp,
            )
            : content;
        const scope = scopeForCampaign(campaignId);
        // The model is resolved HERE and pinned: from this moment the campaign
        // has a memory in one specific vector space, and changing it later
        // would make everything it has put in there invisible.
        const embeddingModel = await pinnedEmbeddingModel(campaignId, scope);
        const embedding = await embedText(indexedContent, scope);
        assertDimension(embedding, embeddingModel);
        if (replaceHeader) {
            knowledgeRepository.replaceEntityRagSnapshot(
                campaignId,
                sessionId,
                replaceHeader,
                indexedContent,
                embedding,
                embeddingModel.model,
                effectiveTimestamp,
                null,
                microLoc,
                npcs,
            );
        } else {
            insertKnowledgeFragment(
                campaignId,
                sessionId,
                content,
                embedding,
                embeddingModel.model,
                effectiveTimestamp,
                null,
                microLoc,
                npcs,
            );
        }
    } catch (err: any) {
        console.error('[RAG] Errore embedding Ollama:', err.message);
    }

    console.log(`[RAG] Evento generico indicizzato in ${Date.now() - startAI}ms`);
}

/** Events and narrative memory are append-only. */
export async function ingestGenericEvent(
    campaignId: number,
    sessionId: string,
    content: string,
    npcs: string[],
    microLoc: string,
    timestamp?: number,
): Promise<void> {
    return ingestText(campaignId, sessionId, content, npcs, microLoc, timestamp);
}

/**
 * The *_UPDATE cards represent the current state: compute the new embedding
 * first, then atomically replace every snapshot with the same header. That way
 * an Ollama error keeps the previous card.
 */
export async function ingestEntitySnapshot(
    campaignId: number,
    sessionId: string,
    content: string,
    npcs: string[],
    microLoc: string,
    timestamp?: number,
): Promise<void> {
    const officialHeader = content.split(/\r?\n/, 1)[0]?.trim();
    if (!officialHeader?.startsWith('[[') || !officialHeader.endsWith(']]')) {
        throw new Error('Entity snapshot must start with a canonical [[...]] header');
    }
    return ingestText(
        campaignId,
        sessionId,
        content,
        npcs,
        microLoc,
        timestamp,
        officialHeader,
    );
}

/**
 * Indexes a biographical event into the RAG
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
 * Indexes a world event into the RAG
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
 * Indexes an important item into the RAG
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
 * RAG: POST-SUMMARY INGESTION (uses the Analyst's data)
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

    const textToIngest = summaryResult.summary || '';
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

    // Every subject who appeared has just acquired material this dossier does
    // not know about. It is only a flag: re-reading the campaign costs money on
    // the table's own account, so it stays a decision somebody takes, and this
    // is how they learn there is one to take.
    markAppearanceDossiersStale(campaignId, sessionId, summaryResult);

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

    // Batched embeddings: one call per batch instead of one per chunk
    // (embedTexts degrades to per-item by itself when the batch fails). The size
    // is dictated by the table's embedding provider.
    const scope = scopeForCampaign(campaignId);
    const embeddingModel = await pinnedEmbeddingModel(campaignId, scope);
    const batchSize = concurrencyFor('embedding', scope);
    for (let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize);
        const embeddings = await embedTexts(batch.map(c => c.text), scope);

        batch.forEach((chunk, i) => {
            const embedding = embeddings[i];
            if (!embedding) {
                failedCount++;
                return;
            }
            successfulFragments.push({
                campaignId,
                content: chunk.text,
                embedding,
                startTimestamp: chunk.timestamp,
                macro: chunk.macro,
                micro: chunk.micro,
                npcs: chunk.npcs,
                entityRefs: chunk.entityRefs || []
            });
        });
        console.log(`[RAG] 📦 Embedding: ${Math.min(start + batchSize, chunks.length)}/${chunks.length} chunk`);
    }

    if (failedCount > 0) {
        console.warn(`[RAG] ⚠️ ${failedCount}/${chunks.length} chunks falliti durante l'embedding`);
    }

    // Atomic replace: delete old + insert new in a single transaction
    if (successfulFragments.length > 0) {
        knowledgeRepository.replaceSessionKnowledge(sessionId, embeddingModel.model, successfulFragments);
        console.log(`[RAG] ✅ ${successfulFragments.length} frammenti salvati atomicamente nel DB`);
    } else {
        console.warn(`[RAG] ⚠️ Nessun frammento salvato (tutti i chunks falliti)`);
    }
}


/**
 * Marks the appearance dossiers of everyone who appeared as worth revisiting.
 *
 * Best effort: a failure here must not cost a session its RAG ingestion, which
 * is the thing this function is a footnote to.
 */
function markAppearanceDossiersStale(
    campaignId: number,
    sessionId: string,
    summaryResult: SummaryResponse,
): void {
    try {
        const refs: Array<{ entityType: 'npc' | 'location'; entityKey: string }> = [];

        for (const npcName of summaryResult.present_npcs ?? []) {
            const npc = getNpcEntry(campaignId, npcName);
            // Keyed by the public short id, like the dossier itself.
            if (npc?.short_id) refs.push({ entityType: 'npc', entityKey: npc.short_id });
        }

        if (refs.length === 0) return;
        const changed = entityProfileRepository.markStale(campaignId, sessionId, refs);
        if (changed > 0) {
            console.log(`[RAG] 🪶 ${changed} appearance dossier(s) marked as worth revisiting`);
        }
    } catch (error) {
        console.warn('[RAG] ⚠️ Could not mark appearance dossiers stale:', (error as Error).message);
    }
}
