/**
 * Batch Reconciler - Single LLM call for all ambiguous entity matches
 * Replaces multiple individual AI confirmation calls with one batch call
 */

import { getReconcileClient } from '../config';
import { generateJson } from '../llm/generate';
import {
    EntityType,
    EntityIndex,
    IndexedEntity,
    MatchCandidate,
    localMatch,
    isPlayerCharacter,
    normalizeForIndex,
    getAllEntitiesOfType
} from './entityIndex';

// ============================================
// TYPES
// ============================================

export interface EntityToReconcile {
    name: string;
    type: EntityType;
    description?: string;
    macro?: string;  // For locations
    micro?: string;  // For locations
}

export interface ReconciliationResult {
    originalName: string;
    type: EntityType;
    matched: boolean;
    matchedEntity?: IndexedEntity;
    isNew: boolean;
    isPlayerCharacter: boolean;
    confidence: number;
    reason: string;
}

export interface ReconciliationContext {
    currentMacro?: string;
    currentMicro?: string;
    sessionContext?: string;
}

// ============================================
// BATCH RECONCILIATION
// ============================================

/**
 * Main entry point: Reconcile a batch of entities efficiently
 *
 * Phase 1: Fast local matching (no API calls)
 * Phase 2: Single batch LLM call for ambiguous cases
 */
export async function batchReconcile(
    index: EntityIndex,
    entities: EntityToReconcile[],
    context: ReconciliationContext = {}
): Promise<ReconciliationResult[]> {
    console.log(`[BatchReconcile] 🚀 Processing ${entities.length} entities...`);
    const startTime = Date.now();

    const results: ReconciliationResult[] = [];
    const ambiguousCases: Array<{
        entity: EntityToReconcile;
        candidates: MatchCandidate[];
        index: number;
    }> = [];
    // Full-scan: no string match found but entity has a description → ask AI against entire dossier
    const ALIAS_TYPES: EntityType[] = ['npc', 'faction', 'location'];
    const fullScanCases: Array<{
        entity: EntityToReconcile;
        pool: IndexedEntity[];
        index: number;
    }> = [];

    // ========================================
    // PHASE 1: Fast Local Matching
    // ========================================
    console.log(`[BatchReconcile] ⚡ Phase 1: Local matching...`);

    for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];

        // 1. Check if it's a player character (skip)
        if (isPlayerCharacter(index, entity.name)) {
            console.log(`[BatchReconcile] 🎮 Skipping PC: "${entity.name}"`);
            results.push({
                originalName: entity.name,
                type: entity.type,
                matched: false,
                isNew: false,
                isPlayerCharacter: true,
                confidence: 1.0,
                reason: 'player_character'
            });
            continue;
        }

        // 2. Try local matching (includes description cross-check)
        const candidates = localMatch(index, entity.name, entity.type, {
            currentMacro: context.currentMacro || entity.macro,
            currentMicro: context.currentMicro || entity.micro,
            description: entity.description
        });

        if (candidates.length === 0) {
            // No string match at all. If entity has a description and type supports aliases,
            // queue a full-scan (AI checks entire dossier). Otherwise mark as new.
            if (ALIAS_TYPES.includes(entity.type) && entity.description && entity.description.length > 20) {
                const pool = getAllEntitiesOfType(index, entity.type).slice(0, 40);
                if (pool.length > 0) {
                    fullScanCases.push({ entity, pool, index: i });
                    results.push({ originalName: entity.name, type: entity.type, matched: false, isNew: true, isPlayerCharacter: false, confidence: 0, reason: 'pending_full_scan' });
                    continue;
                }
            }
            results.push({ originalName: entity.name, type: entity.type, matched: false, isNew: true, isPlayerCharacter: false, confidence: 1.0, reason: 'no_candidates' });
            continue;
        }

        const topCandidate = candidates[0];

        // Reasons that are SAFE to auto-merge (syntactic matches only)
        const SAFE_AUTO_MERGE_REASONS = [
            'exact_match',
            'context_match',
            'first_char_typo'
        ];

        const isSafeReason = SAFE_AUTO_MERGE_REASONS.some(r => topCandidate.reason.includes(r));

        // High confidence match - accept without AI ONLY if it's a safe reason
        if (topCandidate.score >= 0.92 && isSafeReason) {
            console.log(`[BatchReconcile] ⚡ AUTO: "${entity.name}" → "${topCandidate.entity.name}" (${topCandidate.score.toFixed(2)}, ${topCandidate.reason})`);
            results.push({
                originalName: entity.name,
                type: entity.type,
                matched: true,
                matchedEntity: topCandidate.entity,
                isNew: false,
                isPlayerCharacter: false,
                confidence: topCandidate.score,
                reason: `auto_${topCandidate.reason}`
            });
            continue;
        }

        // Low confidence - definitely new (unless it's a description-based hint, which is already >= 0.84)
        if (topCandidate.score < 0.5) {
            results.push({ originalName: entity.name, type: entity.type, matched: false, isNew: true, isPlayerCharacter: false, confidence: 1 - topCandidate.score, reason: 'low_similarity' });
            continue;
        }

        // Ambiguous case (0.5 <= score < 0.92) — needs AI confirmation
        ambiguousCases.push({ entity, candidates: candidates.slice(0, 3), index: i });
        results.push({ originalName: entity.name, type: entity.type, matched: false, isNew: true, isPlayerCharacter: false, confidence: 0, reason: 'pending_ai' });
    }

    const localMatched = results.filter(r => r.matched && r.reason.startsWith('auto_')).length;
    const pcSkipped = results.filter(r => r.isPlayerCharacter).length;
    const newEntities = results.filter(r => r.isNew && r.reason === 'no_candidates').length;
    console.log(`[BatchReconcile] ⚡ Phase 1 complete: ${localMatched} auto-matched, ${pcSkipped} PCs skipped, ${newEntities} new, ${ambiguousCases.length} ambiguous, ${fullScanCases.length} full-scan`);

    // ========================================
    // PHASE 2a: Batch AI Confirmation (ambiguous candidates)
    // ========================================
    if (ambiguousCases.length > 0) {
        console.log(`[BatchReconcile] 🧠 Phase 2a: Batch AI confirmation for ${ambiguousCases.length} cases...`);

        const aiResults = await batchAIConfirm(ambiguousCases, context);

        for (let i = 0; i < ambiguousCases.length; i++) {
            const { index: resultIndex } = ambiguousCases[i];
            const aiResult = aiResults[i];

            if (aiResult.matched && aiResult.matchedEntity) {
                console.log(`[BatchReconcile] ✅ AI: "${aiResult.originalName}" → "${aiResult.matchedEntity.name}"`);
            } else {
                console.log(`[BatchReconcile] 🆕 AI: "${aiResult.originalName}" is NEW`);
            }

            results[resultIndex] = aiResult;
        }
    }

    // ========================================
    // PHASE 2b: Full-scan AI (no string match, check entire dossier)
    // ========================================
    if (fullScanCases.length > 0) {
        console.log(`[BatchReconcile] 🔭 Phase 2b: Full-scan AI for ${fullScanCases.length} unmatched entities...`);

        const fullScanResults = await batchFullScanAI(fullScanCases, context);

        for (let i = 0; i < fullScanCases.length; i++) {
            const { index: resultIndex } = fullScanCases[i];
            const aiResult = fullScanResults[i];

            if (aiResult.matched && aiResult.matchedEntity) {
                console.log(`[BatchReconcile] ✅ Full-scan: "${aiResult.originalName}" → "${aiResult.matchedEntity.name}"`);
            } else {
                console.log(`[BatchReconcile] 🆕 Full-scan: "${aiResult.originalName}" is NEW`);
            }

            results[resultIndex] = aiResult;
        }
    }

    const elapsed = Date.now() - startTime;
    const finalMatched = results.filter(r => r.matched).length;
    console.log(`[BatchReconcile] ✅ Complete in ${elapsed}ms: ${finalMatched}/${entities.length} matched`);

    return results;
}

// ============================================
// BATCH AI CONFIRMATION
// ============================================

async function batchAIConfirm(
    cases: Array<{ entity: EntityToReconcile; candidates: MatchCandidate[]; index: number }>,
    context: ReconciliationContext
): Promise<ReconciliationResult[]> {
    const prompt = buildBatchPrompt(cases, context);

    try {
        const ai = await generateJson({
            route: await getReconcileClient(),
            label: 'reconcile',
            system: "You are a D&D expert. Answer ONLY with valid JSON.",
            prompt,
            maxTokensNative: 6000,
            reasoningEffort: 'low'
        });
        const parsed: any = ai.parsed || { matches: [] };

        return parseAIResponse(cases, parsed);
    } catch (e) {
        console.error('[BatchReconcile] ❌ AI call failed:', e);
        // Fallback: treat all as new
        return cases.map(c => ({
            originalName: c.entity.name,
            type: c.entity.type,
            matched: false,
            isNew: true,
            isPlayerCharacter: false,
            confidence: 0.5,
            reason: 'ai_error'
        }));
    }
}

function buildBatchPrompt(
    cases: Array<{ entity: EntityToReconcile; candidates: MatchCandidate[] }>,
    context: ReconciliationContext
): string {
    let prompt = `You are an entity reconciliation system for D&D.

**SESSION CONTEXT:**
${context.currentMacro ? `- Current location: ${context.currentMacro}${context.currentMicro ? ` - ${context.currentMicro}` : ''}` : '- Location: unknown'}
${context.sessionContext || ''}

**TASK:**
For each new entity, determine whether it matches one of the existing entities listed as candidates.

**RULES:**
1. Audio transcription errors are COMMON for phonetic variants: "Siri"="Ciri", "Fainar"="Sainar", "Leo Sin"="Leosin"
2. For LOCATIONS: If the macro is missing but the micro EXACTLY matches a place in the current context, it is a MATCH
3. For NPCs: "Viktor" is NOT "Viktor's Brother" - they are DIFFERENT people!
4. Famous D&D names (Bahamut, Vecna, Tiamat, Asmodeus, etc.) are UNIQUE entities - do NOT confuse them with local NPCs!
5. If the names are not phonetic variants of the SAME name, mark as NEW
6. When in DOUBT, mark as NEW - duplicates are better than merging different entities!
7. "Imperial Palace" is NOT "Central Palace" - they are DIFFERENT places even though both are palaces!

**ENTITIES TO RECONCILE:**
`;

    cases.forEach((c, i) => {
        const typeLabel = c.entity.type.toUpperCase();
        prompt += `\n${i + 1}. [${typeLabel}] "${c.entity.name}"`;
        if (c.entity.description) prompt += ` - ${c.entity.description.substring(0, 100)}`;
        prompt += `\n   CANDIDATES:`;
        c.candidates.forEach((cand, j) => {
            prompt += `\n   ${String.fromCharCode(65 + j)}. "${cand.entity.name}" (score: ${cand.score.toFixed(2)})`;
            if (cand.entity.description) prompt += ` - ${cand.entity.description.substring(0, 80)}`;
        });
    });

    prompt += `

**JSON OUTPUT:**
{
  "matches": [
    {"index": 1, "match": "A"},  // If it matches candidate A
    {"index": 2, "match": null}, // If it is a new entity
    ...
  ]
}

Answer ONLY with valid JSON.`;

    return prompt;
}

function parseAIResponse(
    cases: Array<{ entity: EntityToReconcile; candidates: MatchCandidate[] }>,
    parsed: { matches?: Array<{ index: number; match: string | null }> }
): ReconciliationResult[] {
    const results: ReconciliationResult[] = [];

    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const aiMatch = parsed.matches?.find(m => m.index === i + 1);

        if (aiMatch?.match) {
            // Convert "A", "B", "C" to index 0, 1, 2
            const candidateIndex = aiMatch.match.charCodeAt(0) - 65;
            const matchedCandidate = c.candidates[candidateIndex];

            if (matchedCandidate) {
                results.push({
                    originalName: c.entity.name,
                    type: c.entity.type,
                    matched: true,
                    matchedEntity: matchedCandidate.entity,
                    isNew: false,
                    isPlayerCharacter: false,
                    confidence: matchedCandidate.score,
                    reason: 'ai_confirmed'
                });
                continue;
            }
        }

        // No match or invalid response
        results.push({
            originalName: c.entity.name,
            type: c.entity.type,
            matched: false,
            isNew: true,
            isPlayerCharacter: false,
            confidence: 0.8,
            reason: 'ai_new'
        });
    }

    return results;
}

// ============================================
// FULL-SCAN AI (alias detection against entire dossier)
// ============================================

async function batchFullScanAI(
    cases: Array<{ entity: EntityToReconcile; pool: IndexedEntity[]; index: number }>,
    context: ReconciliationContext
): Promise<ReconciliationResult[]> {
    // Build a single prompt listing all entities to search + the unmatched ones
    let prompt = `You are an alias identification system for D&D.
These entities found no matches through text search.
Check whether any of them could be an alias (nickname, title, variant) of an entity in the dossier.

${context.currentMacro ? `Current location: ${context.currentMacro}` : ''}
${context.sessionContext || ''}

RULES:
1. Look only for CERTAIN aliases (same character, same place). When in doubt: null.
2. A nickname like "The Witch" can be the healer "Ivonne" if the descriptions agree.
3. Do NOT merge entities just because they are co-present in a scene.

`;

    // Group by type to keep the prompt compact
    const byType = new Map<EntityType, typeof cases>();
    for (const c of cases) {
        if (!byType.has(c.entity.type)) byType.set(c.entity.type, []);
        byType.get(c.entity.type)!.push(c);
    }

    const entityLetterMap = new Map<string, { caseIdx: number; entity: EntityToReconcile; pool: IndexedEntity[] }>();
    let letterCode = 65; // 'A'
    const dossierIndexMap = new Map<EntityType, IndexedEntity[]>();

    for (const [type, typeCases] of byType) {
        const pool = typeCases[0].pool;
        dossierIndexMap.set(type, pool);

        prompt += `DOSSIER ${type.toUpperCase()}:\n`;
        pool.forEach((e, i) => {
            prompt += `  ${i + 1}. ${e.name}${e.shortId ? ` [#${e.shortId}]` : ''}`;
            if (e.description) prompt += `: ${e.description.substring(0, 80)}`;
            prompt += '\n';
        });

        prompt += `\nUNKNOWN ENTITIES [${type.toUpperCase()}]:\n`;
        for (const c of typeCases) {
            const letter = String.fromCharCode(letterCode++);
            entityLetterMap.set(letter, { caseIdx: cases.indexOf(c), entity: c.entity, pool });
            prompt += `  ${letter}. "${c.entity.name}"`;
            if (c.entity.description) prompt += ` — ${c.entity.description.substring(0, 100)}`;
            prompt += '\n';
        }
        prompt += '\n';
    }

    prompt += `RESPONSE JSON:
{
  "matches": [
    {"entity": "A", "dossierIndex": 1},
    {"entity": "B", "dossierIndex": null}
  ]
}
Use the number from the dossier (1-based) or null. Answer ONLY with valid JSON.`;

    try {
        const ai = await generateJson({
            route: await getReconcileClient(),
            label: 'reconcile',
            system: 'You are a D&D expert. Answer ONLY with valid JSON.',
            prompt,
            maxTokensNative: 10000,
            reasoningEffort: 'low'
        });
        const parsed: any = ai.parsed || { matches: [] };

        return cases.map((c, i) => {
            const letter = Array.from(entityLetterMap.entries()).find(([, v]) => v.caseIdx === i)?.[0];
            const aiMatch = (parsed.matches as Array<{ entity: string; dossierIndex: number | null }>)
                ?.find(m => m.entity === letter);

            if (aiMatch?.dossierIndex != null) {
                const matchedEntity = c.pool[aiMatch.dossierIndex - 1];
                if (matchedEntity) {
                    return { originalName: c.entity.name, type: c.entity.type, matched: true, matchedEntity, isNew: false, isPlayerCharacter: false, confidence: 0.85, reason: 'full_scan_ai' };
                }
            }
            return { originalName: c.entity.name, type: c.entity.type, matched: false, isNew: true, isPlayerCharacter: false, confidence: 0.8, reason: 'full_scan_new' };
        });
    } catch (e) {
        console.error('[BatchReconcile] ❌ Full-scan AI call failed:', e);
        return cases.map(c => ({ originalName: c.entity.name, type: c.entity.type, matched: false, isNew: true, isPlayerCharacter: false, confidence: 0.5, reason: 'ai_error' }));
    }
}

// ============================================
// CONVENIENCE WRAPPERS
// ============================================

/**
 * Reconcile a list of NPC names
 */
export async function reconcileNpcs(
    index: EntityIndex,
    names: string[],
    context: ReconciliationContext = {}
): Promise<Map<string, ReconciliationResult>> {
    const entities: EntityToReconcile[] = names.map(name => ({
        name,
        type: 'npc' as const
    }));

    const results = await batchReconcile(index, entities, context);

    const resultMap = new Map<string, ReconciliationResult>();
    for (let i = 0; i < names.length; i++) {
        resultMap.set(names[i], results[i]);
    }

    return resultMap;
}

/**
 * Reconcile a list of locations
 */
export async function reconcileLocations(
    index: EntityIndex,
    locations: Array<{ macro: string; micro: string }>,
    context: ReconciliationContext = {}
): Promise<Map<string, ReconciliationResult>> {
    const entities: EntityToReconcile[] = locations.map(loc => ({
        name: `${loc.macro} - ${loc.micro}`,
        type: 'location' as const,
        macro: loc.macro,
        micro: loc.micro
    }));

    const results = await batchReconcile(index, entities, context);

    const resultMap = new Map<string, ReconciliationResult>();
    for (let i = 0; i < locations.length; i++) {
        const key = `${locations[i].macro}|${locations[i].micro}`;
        resultMap.set(key, results[i]);
    }

    return resultMap;
}

/**
 * Reconcile a list of faction names
 */
export async function reconcileFactions(
    index: EntityIndex,
    names: string[],
    context: ReconciliationContext = {}
): Promise<Map<string, ReconciliationResult>> {
    const entities: EntityToReconcile[] = names.map(name => ({
        name,
        type: 'faction' as const
    }));

    const results = await batchReconcile(index, entities, context);

    const resultMap = new Map<string, ReconciliationResult>();
    for (let i = 0; i < names.length; i++) {
        resultMap.set(names[i], results[i]);
    }

    return resultMap;
}

/**
 * Reconcile a list of artifact names
 */
export async function reconcileArtifacts(
    index: EntityIndex,
    names: string[],
    context: ReconciliationContext = {}
): Promise<Map<string, ReconciliationResult>> {
    const entities: EntityToReconcile[] = names.map(name => ({
        name,
        type: 'artifact' as const
    }));

    const results = await batchReconcile(index, entities, context);

    const resultMap = new Map<string, ReconciliationResult>();
    for (let i = 0; i < names.length; i++) {
        resultMap.set(names[i], results[i]);
    }

    return resultMap;
}

/**
 * Reconcile a list of inventory items
 */
export async function reconcileItems(
    index: EntityIndex,
    items: Array<{ name: string; description?: string }>,
    context: ReconciliationContext = {}
): Promise<Map<string, ReconciliationResult>> {
    const entities: EntityToReconcile[] = items.map(item => ({
        name: item.name,
        type: 'item' as const,
        description: item.description
    }));

    const results = await batchReconcile(index, entities, context);

    const resultMap = new Map<string, ReconciliationResult>();
    for (let i = 0; i < items.length; i++) {
        resultMap.set(items[i].name, results[i]);
    }

    return resultMap;
}

/**
 * Reconcile a list of quest titles
 */
export async function reconcileQuests(
    index: EntityIndex,
    quests: Array<{ title: string; description?: string }>,
    context: ReconciliationContext = {}
): Promise<Map<string, ReconciliationResult>> {
    const entities: EntityToReconcile[] = quests.map(q => ({
        name: q.title,
        type: 'quest' as const,
        description: q.description
    }));

    const results = await batchReconcile(index, entities, context);

    const resultMap = new Map<string, ReconciliationResult>();
    for (let i = 0; i < quests.length; i++) {
        resultMap.set(quests[i].title, results[i]);
    }

    return resultMap;
}

/**
 * Reconcile a list of monster names
 */
export async function reconcileMonsters(
    index: EntityIndex,
    names: string[],
    context: ReconciliationContext = {}
): Promise<Map<string, ReconciliationResult>> {
    const entities: EntityToReconcile[] = names.map(name => ({
        name,
        type: 'monster' as const
    }));

    const results = await batchReconcile(index, entities, context);

    const resultMap = new Map<string, ReconciliationResult>();
    for (let i = 0; i < names.length; i++) {
        resultMap.set(names[i], results[i]);
    }

    return resultMap;
}
