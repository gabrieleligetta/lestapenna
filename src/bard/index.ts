/**
 * Bard Module - Re-exports all public functions
 * 
 * This is the main entry point for the bard module.
 * Import from './bard' to get all functions.
 */

// Types
export * from './types';

// Config
//
// Providers and models are no longer exportable constants: they depend on the
// table. Whoever needs them asks for a route (`get*Client(scope?)`) or just the
// phase configuration (`phaseConfigFor`), and gets what actually holds for that
// guild.
export {
    getTranscriptionClient,
    getMetadataClient,
    getMapClient,
    getSummaryClient,
    getAnalystClient,
    getChatClient,
    getNarrativeFilterClient,
    phaseConfigFor,
    chunkingFor,
    concurrencyFor,
    limitsFor
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
export { runHistoricalQuestAuditAgent } from './agent/questLifecycle';

// RAG
export * from './rag';

// Sync
export * from './sync';

// Reconciliation
export * from './reconciliation';

// Manifesto
export * from './manifesto';

