/**
 * Batch Reconciler - Single LLM call for all ambiguous entity matches
 * Replaces multiple individual AI confirmation calls with one batch call
 */

import { metadataClient, METADATA_MODEL } from '../config';
import {
    EntityIndex,
    IndexedEntity,
    MatchCandidate,
    localMatch,
    isPlayerCharacter,
    normalizeForIndex
} from './entityIndex';

// ============================================
// TYPES
// ============================================

export interface EntityToReconcile {
    name: string;
    type: 'npc' | 'location' | 'faction' | 'artifact';
    description?: string;
    macro?: string;  // For locations
    micro?: string;  // For locations
}

export interface ReconciliationResult {
    originalName: string;
    type: 'npc' | 'location' | 'faction' | 'artifact';
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

        // 2. Try local matching
        const candidates = localMatch(index, entity.name, entity.type, {
            currentMacro: context.currentMacro || entity.macro,
            currentMicro: context.currentMicro || entity.micro
        });

        if (candidates.length === 0) {
            // No candidates = new entity
            results.push({
                originalName: entity.name,
                type: entity.type,
                matched: false,
                isNew: true,
                isPlayerCharacter: false,
                confidence: 1.0,
                reason: 'no_candidates'
            });
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
        // Raised threshold from 0.85 to 0.92 and require safe reason
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

        // Low confidence - definitely new
        if (topCandidate.score < 0.5) {
            results.push({
                originalName: entity.name,
                type: entity.type,
                matched: false,
                isNew: true,
                isPlayerCharacter: false,
                confidence: 1 - topCandidate.score,
                reason: 'low_similarity'
            });
            continue;
        }

        // Ambiguous case (0.5 <= score < 0.85) - needs AI confirmation
        ambiguousCases.push({
            entity,
            candidates: candidates.slice(0, 3), // Top 3 candidates
            index: i
        });

        // Placeholder - will be replaced after batch AI call
        results.push({
            originalName: entity.name,
            type: entity.type,
            matched: false,
            isNew: true,
            isPlayerCharacter: false,
            confidence: 0,
            reason: 'pending_ai'
        });
    }

    const localMatched = results.filter(r => r.matched && r.reason.startsWith('auto_')).length;
    const pcSkipped = results.filter(r => r.isPlayerCharacter).length;
    const newEntities = results.filter(r => r.isNew && r.reason !== 'pending_ai').length;
    console.log(`[BatchReconcile] ⚡ Phase 1 complete: ${localMatched} auto-matched, ${pcSkipped} PCs skipped, ${newEntities} new, ${ambiguousCases.length} ambiguous`);

    // ========================================
    // PHASE 2: Batch AI Confirmation
    // ========================================
    if (ambiguousCases.length > 0) {
        console.log(`[BatchReconcile] 🧠 Phase 2: Batch AI confirmation for ${ambiguousCases.length} cases...`);

        const aiResults = await batchAIConfirm(ambiguousCases, context);

        // Update results with AI decisions
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
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [
                { role: "system", content: "Sei un esperto di D&D. Rispondi SOLO con JSON valido." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const content = response.choices[0].message.content || '{"matches":[]}';
        const parsed = JSON.parse(content);

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
    let prompt = `Sei un sistema di riconciliazione entità per D&D.

**CONTESTO SESSIONE:**
${context.currentMacro ? `- Luogo corrente: ${context.currentMacro}${context.currentMicro ? ` - ${context.currentMicro}` : ''}` : '- Luogo: sconosciuto'}
${context.sessionContext || ''}

**COMPITO:**
Per ogni entità nuova, determina se corrisponde a una delle entità esistenti elencate come candidati.

**REGOLE:**
1. Errori di trascrizione audio sono COMUNI per varianti fonetiche: "Siri"="Ciri", "Fainar"="Sainar", "Leo Sin"="Leosin"
2. Per le LOCATION: Se manca la macro ma la micro corrisponde ESATTAMENTE a un luogo nel contesto corrente, è un MATCH
3. Per gli NPC: "Viktor" NON è "Fratello di Viktor" - sono persone DIVERSE!
4. Nomi celebri di D&D (Bahamut, Vecna, Tiamat, Asmodeus, etc.) sono entità UNICHE - NON confonderli con NPC locali!
5. Se i nomi non sono varianti fonetiche dello STESSO nome, marca come NEW
6. Nel DUBBIO, marca come NEW - è meglio avere duplicati che fondere entità diverse!
7. "Palazzo Imperiale" NON è "Palazzo Centrale" - sono luoghi DIVERSI anche se entrambi sono palazzi!

**ENTITÀ DA RICONCILIARE:**
`;

    cases.forEach((c, i) => {
        const typeLabel = c.entity.type.toUpperCase();
        prompt += `\n${i + 1}. [${typeLabel}] "${c.entity.name}"`;
        if (c.entity.description) prompt += ` - ${c.entity.description.substring(0, 100)}`;
        prompt += `\n   CANDIDATI:`;
        c.candidates.forEach((cand, j) => {
            prompt += `\n   ${String.fromCharCode(65 + j)}. "${cand.entity.name}" (score: ${cand.score.toFixed(2)})`;
            if (cand.entity.description) prompt += ` - ${cand.entity.description.substring(0, 80)}`;
        });
    });

    prompt += `

**OUTPUT JSON:**
{
  "matches": [
    {"index": 1, "match": "A"},  // Se corrisponde al candidato A
    {"index": 2, "match": null}, // Se è una nuova entità
    ...
  ]
}

Rispondi SOLO con JSON valido.`;

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
