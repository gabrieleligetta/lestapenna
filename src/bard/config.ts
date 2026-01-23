/**
 * Bard Config - AI providers, models, clients, and constants
 */

import OpenAI from 'openai';
import { config } from '../config';

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Crea un client OpenAI (Ollama o Cloud)
 */
export function createClient(provider: 'ollama' | 'openai'): OpenAI {
    if (provider === 'ollama') {
        return new OpenAI({
            baseURL: config.ai.ollama.baseUrl,
            apiKey: 'ollama',
            timeout: 1800 * 1000,
        });
    }

    return new OpenAI({
        apiKey: config.ai.openAi.apiKey,
        project: config.ai.openAi.projectId,
        timeout: 1800 * 1000,
    });
}

// ============================================
// PROVIDER CONFIGURATION (Granular)
// ============================================

export const TRANSCRIPTION_PROVIDER = config.ai.phases.transcription.provider;
export const METADATA_PROVIDER = config.ai.phases.metadata.provider;
export const MAP_PROVIDER = config.ai.phases.map.provider;
export const SUMMARY_PROVIDER = config.ai.phases.summary.provider;
export const ANALYST_PROVIDER = config.ai.phases.analyst.provider;
export const CHAT_PROVIDER = config.ai.phases.chat.provider;
export const EMBEDDING_PROVIDER = config.ai.embeddingProvider;
export const NARRATIVE_FILTER_PROVIDER = config.ai.phases.narrativeFilter.provider;

// ============================================
// MODEL CONFIGURATION (Granular)
// ============================================

export const TRANSCRIPTION_MODEL = TRANSCRIPTION_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.transcription.model;
export const METADATA_MODEL = METADATA_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.metadata.model;
export const MAP_MODEL = MAP_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.map.model;
export const SUMMARY_MODEL = SUMMARY_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.summary.model;
export const ANALYST_MODEL = ANALYST_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.analyst.model;
export const CHAT_MODEL = CHAT_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.chat.model;
export const NARRATIVE_FILTER_MODEL = NARRATIVE_FILTER_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.narrativeFilter.model;

export const EMBEDDING_MODEL_OPENAI = 'text-embedding-3-small';
export const EMBEDDING_MODEL_OLLAMA = 'nomic-embed-text';

// ============================================
// CLIENT CONFIGURATION
// ============================================

export const transcriptionClient = createClient(TRANSCRIPTION_PROVIDER);
export const metadataClient = createClient(METADATA_PROVIDER);
export const mapClient = createClient(MAP_PROVIDER);
export const summaryClient = createClient(SUMMARY_PROVIDER);
export const analystClient = createClient(ANALYST_PROVIDER);
export const chatClient = createClient(CHAT_PROVIDER);
export const narrativeFilterClient = createClient(NARRATIVE_FILTER_PROVIDER);

// --- CLIENT DEDICATI PER EMBEDDING (DOPPIO) ---
export const openaiEmbedClient = new OpenAI({
    apiKey: config.ai.openAi.apiKey,
    project: config.ai.openAi.projectId,
});

export const ollamaEmbedClient = new OpenAI({
    baseURL: config.ai.ollama.baseUrl,
    apiKey: 'ollama',
});

// ============================================
// CONCURRENCY LIMITS
// ============================================

export const TRANSCRIPTION_CONCURRENCY = TRANSCRIPTION_PROVIDER === 'ollama' ? 1 : 5;
export const MAP_CONCURRENCY = MAP_PROVIDER === 'ollama' ? 1 : 5;
export const EMBEDDING_BATCH_SIZE = EMBEDDING_PROVIDER === 'ollama' ? 1 : 5;
export const NARRATIVE_BATCH_SIZE = config.features.narrativeBatchSize;


// ============================================
// CHUNK SIZE (Dynamic based on MAP_PROVIDER)
// ============================================

export const MAX_CHUNK_SIZE = MAP_PROVIDER === 'ollama' ? 15000 : 800000;
export const CHUNK_OVERLAP = MAP_PROVIDER === 'ollama' ? 1000 : 5000;

// ============================================
// DEBUG LOG (Startup)
// ============================================

console.log('\n🎭 BARDO AI - CONFIG GRANULARE');
console.log(`Correzione:  ${TRANSCRIPTION_PROVIDER.padEnd(8)} → ${TRANSCRIPTION_MODEL.padEnd(20)}`);
console.log(`Metadati:    ${METADATA_PROVIDER.padEnd(8)} → ${METADATA_MODEL.padEnd(20)}`);
console.log(`Map:         ${MAP_PROVIDER.padEnd(8)} → ${MAP_MODEL.padEnd(20)}`);
console.log(`Analyst:     ${ANALYST_PROVIDER.padEnd(8)} → ${ANALYST_MODEL.padEnd(20)} (estrazione dati)`);
console.log(`Summary:     ${SUMMARY_PROVIDER.padEnd(8)} → ${SUMMARY_MODEL.padEnd(20)} (narrazione)`);
console.log(`Chat/RAG:    ${CHAT_PROVIDER.padEnd(8)} → ${CHAT_MODEL.padEnd(20)}`);
console.log(`NarrFilter:  ${NARRATIVE_FILTER_PROVIDER.padEnd(8)} → ${NARRATIVE_FILTER_MODEL.padEnd(20)} (batch: ${NARRATIVE_BATCH_SIZE})`);
console.log(`Embeddings:  DOPPIO      → OpenAI (${EMBEDDING_MODEL_OPENAI}) + Ollama (${EMBEDDING_MODEL_OLLAMA})`);
