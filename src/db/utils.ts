import { EntityRef, EntityType } from './types';

// --- SISTEMA ENTITY REFS (Typed Prefixes for RAG) ---

/**
 * Crea un entity ref (es. "npc:1")
 */
export const createEntityRef = (type: EntityType, id: number): string => {
    return `${type}:${id}`;
};

/**
 * Parsa un entity ref (es. "npc:1" -> { type: 'npc', id: 1 })
 */
export const parseEntityRef = (ref: string): EntityRef | null => {
    if (!ref) return null;
    const parts = ref.split(':');
    if (parts.length !== 2) return null;

    const type = parts[0] as EntityType;
    const id = parseInt(parts[1], 10);

    if (isNaN(id)) return null;

    // Validate type (optional)
    const validTypes: EntityType[] = ['npc', 'pc', 'quest', 'loc', 'item', 'monster', 'generic'];
    if (!validTypes.includes(type)) return null;

    return { type, id };
};

/**
 * Parsa una stringa di entity refs (es. "npc:1,npc:2,pc:5")
 */
export const parseEntityRefs = (refs: string | null): EntityRef[] => {
    if (!refs) return [];
    return refs.split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(parseEntityRef)
        .filter((r): r is EntityRef => r !== null);
};

/**
 * Crea una stringa di entity refs da un array
 */
export const serializeEntityRefs = (refs: EntityRef[]): string => {
    return refs.map(r => createEntityRef(r.type, r.id)).join(',');
};

/**
 * Filtra entity refs per tipo
 */
export const filterEntityRefsByType = (refs: EntityRef[], type: EntityType): number[] => {
    return refs.filter(r => r.type === type).map(r => r.id);
};

// --- FUZZY MATCHING & HELPERS ---

export const levenshteinDistance = (a: string, b: string): number => {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
};

export const calculateSimilarity = (a: string, b: string): number => {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / parseFloat(String(longer.length));
};

export const cleanQuestTitle = (title: string): string => {
    return title.replace(/\s*\[(COMPLETED|FAILED|OPEN|SUCCEEDED|DONE)\]\s*$/i, '').trim();
};

export const mergeJsonArrays = (json1: string | null, json2: string | null): string | null => {
    let arr1: string[] = [];
    let arr2: string[] = [];

    try { if (json1) arr1 = JSON.parse(json1); } catch (e) { }
    try { if (json2) arr2 = JSON.parse(json2); } catch (e) { }

    const set = new Set([...arr1, ...arr2]);
    return JSON.stringify(Array.from(set));
};

/**
 * Migra i vecchi ID NPC (numerici) in EntityRefs (es. "1,2" -> "npc:1,npc:2")
 */
export const migrateOldNpcIds = (oldIds: string | null): string | null => {
    if (!oldIds) return null;
    // Se contiene già "npc:", assumiamo sia già migrato
    if (oldIds.includes('npc:')) return oldIds;

    const ids = oldIds.split(',').map(s => s.trim()).filter(s => s.length > 0 && !isNaN(parseInt(s)));
    if (ids.length === 0) return null;

    const refs = ids.map(id => createEntityRef('npc', parseInt(id)));
    return serializeEntityRefs(parseEntityRefs(refs.join(',')));
};
