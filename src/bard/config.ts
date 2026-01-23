/**
 * Bard Config - AI providers, models, clients, and constants
 */

import OpenAI from 'openai';

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Determina il provider per una fase specifica
 */
export function getProvider(phaseEnvVar: string, fallbackEnvVar: string = 'AI_PROVIDER'): 'ollama' | 'openai' {
    const phase = process.env[phaseEnvVar];
    if (phase === 'ollama' || phase === 'openai') return phase;

    const fallback = process.env[fallbackEnvVar];
    if (fallback === 'ollama') return 'ollama';

    return 'openai';
}

/**
 * Ottiene il modello corretto per una fase
 */
export function getModel(
    provider: 'ollama' | 'openai',
    openAIModelEnv: string,
    openAIFallback: string,
    ollamaModel: string = process.env.OLLAMA_MODEL || 'llama3.2'
): string {
    if (provider === 'ollama') return ollamaModel;
    return process.env[openAIModelEnv] || openAIFallback;
}

/**
 * Crea un client OpenAI (Ollama o Cloud)
 */
export function createClient(provider: 'ollama' | 'openai'): OpenAI {
    if (provider === 'ollama') {
        return new OpenAI({
            baseURL: process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1',
            apiKey: 'ollama',
            timeout: 1800 * 1000,
        });
    }

    return new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || 'dummy',
        project: process.env.OPENAI_PROJECT_ID,
        timeout: 1800 * 1000,
    });
}

// ============================================
// PROVIDER CONFIGURATION (Per-Phase)
// ============================================

export const TRANSCRIPTION_PROVIDER = getProvider('TRANSCRIPTION_PROVIDER', 'AI_PROVIDER');
export const METADATA_PROVIDER = getProvider('METADATA_PROVIDER', 'AI_PROVIDER');
export const MAP_PROVIDER = getProvider('MAP_PROVIDER', 'AI_PROVIDER');
export const SUMMARY_PROVIDER = getProvider('SUMMARY_PROVIDER', 'AI_PROVIDER');
export const ANALYST_PROVIDER = getProvider('ANALYST_PROVIDER', 'METADATA_PROVIDER');
export const CHAT_PROVIDER = getProvider('CHAT_PROVIDER', 'AI_PROVIDER');
export const EMBEDDING_PROVIDER = getProvider('EMBEDDING_PROVIDER', 'AI_PROVIDER');
export const NARRATIVE_FILTER_PROVIDER = getProvider('NARRATIVE_FILTER_PROVIDER', 'AI_PROVIDER');

// ============================================
// MODEL CONFIGURATION (Per-Phase)
// ============================================

export const TRANSCRIPTION_MODEL = getModel(TRANSCRIPTION_PROVIDER, 'OPEN_AI_MODEL_TRANSCRIPTION', 'gpt-5-nano');
export const METADATA_MODEL = getModel(METADATA_PROVIDER, 'OPEN_AI_MODEL_METADATA', 'gpt-5-mini');
export const MAP_MODEL = getModel(MAP_PROVIDER, 'OPEN_AI_MODEL_MAP', 'gpt-5-mini');
export const SUMMARY_MODEL = getModel(SUMMARY_PROVIDER, 'OPEN_AI_MODEL_SUMMARY', 'gpt-5.2');
export const ANALYST_MODEL = getModel(ANALYST_PROVIDER, 'OPEN_AI_MODEL_METADATA', 'gpt-5-mini');
export const CHAT_MODEL = getModel(CHAT_PROVIDER, 'OPEN_AI_MODEL_CHAT', 'gpt-5-mini');
export const NARRATIVE_FILTER_MODEL = getModel(NARRATIVE_FILTER_PROVIDER, 'OPEN_AI_MODEL_NARRATIVE_FILTER', 'gpt-5-mini');

export const EMBEDDING_MODEL_OPENAI = 'text-embedding-3-small';
export const EMBEDDING_MODEL_OLLAMA = 'nomic-embed-text';

// ============================================
// CLIENT CONFIGURATION (Per-Phase)
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
    apiKey: process.env.OPENAI_API_KEY || 'dummy',
    project: process.env.OPENAI_PROJECT_ID,
});

export const ollamaEmbedClient = new OpenAI({
    baseURL: process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1',
    apiKey: 'ollama',
});

// ============================================
// CONCURRENCY LIMITS
// ============================================

export const TRANSCRIPTION_CONCURRENCY = TRANSCRIPTION_PROVIDER === 'ollama' ? 1 : 5;
export const MAP_CONCURRENCY = MAP_PROVIDER === 'ollama' ? 1 : 5;
export const EMBEDDING_BATCH_SIZE = EMBEDDING_PROVIDER === 'ollama' ? 1 : 5;
export const NARRATIVE_BATCH_SIZE = parseInt(process.env.NARRATIVE_BATCH_SIZE || '30', 10);

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
