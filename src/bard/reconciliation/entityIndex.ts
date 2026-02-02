/**
 * Entity Index - Fast local matching with trigram indexing
 * Provides O(1) exact match and fast fuzzy matching without API calls
 */

import {
    getAllNpcs,
    listAtlasEntries,
    factionRepository,
    getCampaignCharacters
} from '../../db';
import { levenshteinSimilarity } from '../helpers';

// ============================================
// TYPES
// ============================================

export interface IndexedEntity {
    id: number;
    shortId?: string;
    name: string;
    normalizedName: string;
    trigrams: Set<string>;
    type: 'npc' | 'location' | 'faction' | 'artifact';
    // Extra fields per type
    macro?: string;         // For locations
    micro?: string;         // For locations
    role?: string;          // For NPCs
    description?: string;
    aliases?: string[];     // Known aliases
}

export interface EntityIndex {
    npcs: Map<string, IndexedEntity>;           // key = normalized name
    locations: Map<string, IndexedEntity>;      // key = "macro|micro" normalized
    factions: Map<string, IndexedEntity>;
    artifacts: Map<string, IndexedEntity>;
    playerCharacters: Set<string>;              // normalized PC names
    // Trigram inverted index for fast fuzzy lookup
    trigramIndex: Map<string, Set<string>>;     // trigram -> entity keys
}

export interface MatchCandidate {
    entity: IndexedEntity;
    score: number;
    reason: string;
}

export interface MatchResult {
    matched: boolean;
    candidate?: IndexedEntity;
    score: number;
    reason: string;
    isPlayerCharacter?: boolean;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Normalize a string for matching: lowercase, remove accents, trim
 */
export function normalizeForIndex(str: string): string {
    return str
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')  // Remove accents
        .replace(/[^a-z0-9\s]/g, '')       // Remove special chars
        .replace(/\s+/g, ' ');             // Normalize spaces
}

/**
 * Extract trigrams from a string
 */
export function extractTrigrams(str: string): Set<string> {
    const normalized = normalizeForIndex(str);
    const trigrams = new Set<string>();

    // Add padding for edge trigrams
    const padded = `  ${normalized}  `;

    for (let i = 0; i < padded.length - 2; i++) {
        trigrams.add(padded.substring(i, i + 3));
    }

    return trigrams;
}

/**
 * Calculate Jaccard similarity between two trigram sets
 */
export function trigramSimilarity(set1: Set<string>, set2: Set<string>): number {
    if (set1.size === 0 || set2.size === 0) return 0;

    let intersection = 0;
    for (const t of set1) {
        if (set2.has(t)) intersection++;
    }

    const union = set1.size + set2.size - intersection;
    return intersection / union;
}

// ============================================
// INDEX BUILDING
// ============================================

/**
 * Build the entity index for a campaign
 * Call this once at the start of reconciliation, not per-entity
 */
export function buildEntityIndex(campaignId: number): EntityIndex {
    console.log(`[EntityIndex] 🏗️ Building index for campaign ${campaignId}...`);
    const startTime = Date.now();

    const index: EntityIndex = {
        npcs: new Map(),
        locations: new Map(),
        factions: new Map(),
        artifacts: new Map(),
        playerCharacters: new Set(),
        trigramIndex: new Map()
    };

    // 1. Index Player Characters (for exclusion)
    const characters = getCampaignCharacters(campaignId);
    for (const char of characters) {
        if (char.character_name) {
            index.playerCharacters.add(normalizeForIndex(char.character_name));
        }
    }

    // 2. Index NPCs
    const npcs = getAllNpcs(campaignId);
    for (const npc of npcs) {
        const normalized = normalizeForIndex(npc.name);
        const trigrams = extractTrigrams(npc.name);

        const entity: IndexedEntity = {
            id: npc.id,
            shortId: npc.short_id || undefined,
            name: npc.name,
            normalizedName: normalized,
            trigrams,
            type: 'npc',
            role: npc.role || undefined,
            description: npc.description || undefined
        };

        index.npcs.set(normalized, entity);
        addToTrigramIndex(index.trigramIndex, trigrams, `npc:${normalized}`);
    }

    // 3. Index Locations
    const locations = listAtlasEntries(campaignId);
    for (const loc of locations) {
        const key = `${normalizeForIndex(loc.macro_location)}|${normalizeForIndex(loc.micro_location)}`;
        const fullName = `${loc.macro_location} - ${loc.micro_location}`;
        const trigrams = extractTrigrams(fullName);

        const entity: IndexedEntity = {
            id: loc.id,
            shortId: loc.short_id,
            name: fullName,
            normalizedName: key,
            trigrams,
            type: 'location',
            macro: loc.macro_location,
            micro: loc.micro_location,
            description: loc.description
        };

        index.locations.set(key, entity);
        addToTrigramIndex(index.trigramIndex, trigrams, `loc:${key}`);

        // Also index by micro name alone for partial matching
        const microNormalized = normalizeForIndex(loc.micro_location);
        addToTrigramIndex(index.trigramIndex, extractTrigrams(loc.micro_location), `loc:${key}`);
    }

    // 4. Index Factions
    const factions = factionRepository.listFactions(campaignId);
    for (const faction of factions) {
        const normalized = normalizeForIndex(faction.name);
        const trigrams = extractTrigrams(faction.name);

        const entity: IndexedEntity = {
            id: faction.id,
            shortId: faction.short_id || undefined,
            name: faction.name,
            normalizedName: normalized,
            trigrams,
            type: 'faction',
            description: faction.description || undefined
        };

        index.factions.set(normalized, entity);
        addToTrigramIndex(index.trigramIndex, trigrams, `faction:${normalized}`);
    }

    // 5. Index Artifacts (if available)
    try {
        const { listArtifacts } = require('../../db');
        const artifacts = listArtifacts(campaignId);
        for (const artifact of artifacts) {
            const normalized = normalizeForIndex(artifact.name);
            const trigrams = extractTrigrams(artifact.name);

            const entity: IndexedEntity = {
                id: artifact.id,
                shortId: artifact.short_id,
                name: artifact.name,
                normalizedName: normalized,
                trigrams,
                type: 'artifact',
                description: artifact.description
            };

            index.artifacts.set(normalized, entity);
            addToTrigramIndex(index.trigramIndex, trigrams, `artifact:${normalized}`);
        }
    } catch (e) {
        // Artifacts table might not exist
    }

    const elapsed = Date.now() - startTime;
    console.log(`[EntityIndex] ✅ Index built in ${elapsed}ms: ${index.npcs.size} NPCs, ${index.locations.size} locations, ${index.factions.size} factions, ${index.artifacts.size} artifacts, ${index.playerCharacters.size} PCs`);

    return index;
}

function addToTrigramIndex(trigramIndex: Map<string, Set<string>>, trigrams: Set<string>, entityKey: string) {
    for (const trigram of trigrams) {
        if (!trigramIndex.has(trigram)) {
            trigramIndex.set(trigram, new Set());
        }
        trigramIndex.get(trigram)!.add(entityKey);
    }
}

// ============================================
// LOCAL MATCHING (NO API CALLS)
// ============================================

/**
 * Fast local matching using the pre-built index
 * Returns candidates sorted by score
 */
export function localMatch(
    index: EntityIndex,
    name: string,
    type: 'npc' | 'location' | 'faction' | 'artifact',
    context?: { currentMacro?: string; currentMicro?: string }
): MatchCandidate[] {
    const normalized = normalizeForIndex(name);
    const queryTrigrams = extractTrigrams(name);
    const candidates: MatchCandidate[] = [];

    // Get the appropriate entity map
    const entityMap = type === 'npc' ? index.npcs :
                      type === 'location' ? index.locations :
                      type === 'faction' ? index.factions :
                      index.artifacts;

    // 1. Exact match (instant)
    if (entityMap.has(normalized)) {
        return [{
            entity: entityMap.get(normalized)!,
            score: 1.0,
            reason: 'exact_match'
        }];
    }

    // 2. For locations, try context-aware matching
    if (type === 'location' && context?.currentMacro) {
        // Extract micro part from input (handle " - Micro" format)
        let microPart = name;
        if (name.includes(' - ')) {
            microPart = name.split(' - ').pop() || name;
        } else if (name.startsWith(' - ')) {
            microPart = name.substring(3);
        }

        const microNormalized = normalizeForIndex(microPart);
        const macroNormalized = normalizeForIndex(context.currentMacro);

        // Look for location in current macro context
        const contextKey = `${macroNormalized}|${microNormalized}`;
        if (entityMap.has(contextKey)) {
            return [{
                entity: entityMap.get(contextKey)!,
                score: 0.98,
                reason: 'context_match'
            }];
        }

        // Fuzzy match within current macro
        for (const [key, entity] of entityMap) {
            if (key.startsWith(macroNormalized + '|')) {
                const entityMicro = key.split('|')[1];
                const sim = levenshteinSimilarity(microNormalized, entityMicro);
                if (sim >= 0.7) {
                    candidates.push({
                        entity,
                        score: sim * 0.95, // Boost for being in current macro
                        reason: 'context_fuzzy'
                    });
                }
            }
        }
    }

    // 3. Trigram-based candidate retrieval
    const candidateKeys = new Set<string>();
    const prefix = type === 'npc' ? 'npc:' :
                   type === 'location' ? 'loc:' :
                   type === 'faction' ? 'faction:' :
                   'artifact:';

    for (const trigram of queryTrigrams) {
        const keys = index.trigramIndex.get(trigram);
        if (keys) {
            for (const key of keys) {
                if (key.startsWith(prefix)) {
                    candidateKeys.add(key.substring(prefix.length));
                }
            }
        }
    }

    // 4. Score candidates
    for (const key of candidateKeys) {
        const entity = entityMap.get(key);
        if (!entity) continue;

        // Skip if already added via context matching
        if (candidates.some(c => c.entity.id === entity.id)) continue;

        // Trigram similarity
        const trigramScore = trigramSimilarity(queryTrigrams, entity.trigrams);

        // Levenshtein similarity
        const levScore = levenshteinSimilarity(normalized, entity.normalizedName);

        // Combined score (weighted average)
        const combinedScore = (trigramScore * 0.4 + levScore * 0.6);

        if (combinedScore >= 0.5) {
            candidates.push({
                entity,
                score: combinedScore,
                reason: `trigram=${trigramScore.toFixed(2)},lev=${levScore.toFixed(2)}`
            });
        }
    }

    // 5. First-char typo detection for NPCs
    if (type === 'npc' && normalized.length >= 4) {
        for (const [key, entity] of entityMap) {
            if (candidates.some(c => c.entity.id === entity.id)) continue;

            if (key.length === normalized.length &&
                key.slice(1) === normalized.slice(1)) {
                candidates.push({
                    entity,
                    score: 0.95,
                    reason: 'first_char_typo'
                });
            }
        }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, 5); // Return top 5
}

/**
 * Check if a name matches a player character
 */
export function isPlayerCharacter(index: EntityIndex, name: string): boolean {
    const normalized = normalizeForIndex(name);

    // Exact match
    if (index.playerCharacters.has(normalized)) return true;

    // Fuzzy match for typos
    for (const pcName of index.playerCharacters) {
        const sim = levenshteinSimilarity(normalized, pcName);
        if (sim >= 0.75) return true;

        // First-char typo
        if (normalized.length >= 4 && pcName.length === normalized.length &&
            normalized.slice(1) === pcName.slice(1)) {
            return true;
        }
    }

    return false;
}
