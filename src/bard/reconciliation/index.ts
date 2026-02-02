/**
 * Bard Reconciliation Index - Re-exports all reconciliation functions
 */

// ============================================
// NEW: Batch Reconciliation System (Recommended)
// Single LLM call for all entities - much more efficient!
// ============================================
export {
    buildEntityIndex,
    normalizeForIndex,
    extractTrigrams,
    trigramSimilarity,
    localMatch,
    isPlayerCharacter,
    type EntityIndex,
    type IndexedEntity,
    type MatchCandidate,
    type MatchResult
} from './entityIndex';

export {
    batchReconcile,
    reconcileNpcs,
    reconcileLocations,
    reconcileFactions,
    reconcileArtifacts,
    type EntityToReconcile,
    type ReconciliationResult,
    type ReconciliationContext
} from './batchReconciler';

// ============================================
// LEGACY: Individual reconciliation functions
// (Still available for backward compatibility)
// ============================================
export {
    aiConfirmSamePerson,
    reconcileNpcName,
    deduplicateNpcBatch,
    smartMergeBios,
    resolveIdentityCandidate
} from './npc';

export {
    reconcileLocationName,
    deduplicateLocationBatch,
    aiConfirmSameLocation,
    normalizeLocationNames
} from './location';

export {
    reconcileMonsterName,
    deduplicateMonsterBatch
} from './monster';

export {
    reconcileItemName,
    deduplicateItemBatch
} from './item';

export {
    reconcileQuestTitle,
    deduplicateQuestBatch
} from './quest';
