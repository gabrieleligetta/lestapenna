/**
 * Bard Module - Re-exports all public functions
 * 
 * This is the main entry point for the bard module.
 * Import from './bard' to get all functions.
 */

// Types
export * from './types';

// Config
export {
    // Providers
    TRANSCRIPTION_PROVIDER,
    METADATA_PROVIDER,
    MAP_PROVIDER,
    SUMMARY_PROVIDER,
    ANALYST_PROVIDER,
    CHAT_PROVIDER,
    EMBEDDING_PROVIDER,
    NARRATIVE_FILTER_PROVIDER,
    // Models
    TRANSCRIPTION_MODEL,
    METADATA_MODEL,
    MAP_MODEL,
    SUMMARY_MODEL,
    ANALYST_MODEL,
    CHAT_MODEL,
    NARRATIVE_FILTER_MODEL,
    EMBEDDING_MODEL_OLLAMA,
    // Clients
    getTranscriptionClient,
    getMetadataClient,
    getMapClient,
    getSummaryClient,
    getAnalystClient,
    getChatClient,
    getNarrativeFilterClient,
    ollamaEmbedClient,
    // Constants
    TRANSCRIPTION_CONCURRENCY,
    MAP_CONCURRENCY,
    EMBEDDING_BATCH_SIZE,
    NARRATIVE_BATCH_SIZE,
    MAX_CHUNK_SIZE,
    CHUNK_OVERLAP
} from './config';

// Helpers
export {
    normalizeStringList,
    splitTextInChunks,
    withRetry,
    processInBatches,
    cosineSimilarity,
    levenshteinSimilarity,
    containsSubstring,
    escapeRegex,
    cleanEntityName
} from './helpers';

// Validation
export { validateBatch } from './validation';

// Transcription
export { correctTextOnly, correctTranscription } from './transcription';

// Summary
export * from './summary';

// RAG
export * from './rag';

// Sync
export * from './sync';

// Reconciliation
export * from './reconciliation';

// Manifesto
export * from './manifesto';


