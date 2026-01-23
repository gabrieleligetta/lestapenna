/**
 * Bard Helpers - Utility functions
 */

import { MAX_CHUNK_SIZE, CHUNK_OVERLAP } from './config';

// ============================================
// JSON PARSING & NORMALIZATION
// ============================================

/**
 * Normalizza una lista mista (stringhe/oggetti) in una lista di sole stringhe.
 */
export function normalizeStringList(list: any[]): string[] {
    if (!Array.isArray(list)) return [];

    return list.map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
            return item.name || item.nome || item.item || item.description || item.value || JSON.stringify(item);
        }
        return String(item);
    }).filter(s => s && s.trim().length > 0);
}

/**
 * Normalizza una lista mista in una lista di oggetti loot strutturati.
 * Gestisce sia stringhe che oggetti, convertendo le stringhe in {name: string}.
 */
export function normalizeLootList(list: any[]): Array<{ name: string; quantity?: number; description?: string }> {
    if (!Array.isArray(list)) return [];

    const result: Array<{ name: string; quantity?: number; description?: string }> = [];

    for (const item of list) {
        if (typeof item === 'string' && item.trim().length > 0) {
            result.push({ name: item.trim(), quantity: 1 });
        } else if (typeof item === 'object' && item !== null) {
            const name = item.name || item.nome || item.item || '';
            if (name && name.trim().length > 0) {
                result.push({
                    name: name.trim(),
                    quantity: typeof item.quantity === 'number' ? item.quantity : 1,
                    description: item.description || item.desc || undefined
                });
            }
        }
    }

    return result;
}

/**
 * Parsing JSON sicuro che non crasha
 */
export function safeJsonParse(jsonString: string): any | null {
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        return null;
    }
}


// ============================================
// TEXT PROCESSING
// ============================================

/**
 * Divide il testo in chunk
 */
export function splitTextInChunks(text: string, chunkSize: number = MAX_CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        if (i + chunkSize >= text.length) {
            chunks.push(text.substring(i));
            break;
        }
        let end = i + chunkSize;
        const lastNewLine = text.lastIndexOf('\n', end);
        const lastSpace = text.lastIndexOf(' ', end);

        if (lastNewLine > i + (chunkSize * 0.9)) end = lastNewLine;
        else if (lastSpace > i + (chunkSize * 0.9)) end = lastSpace;

        chunks.push(text.substring(i, end));
        i = end - overlap;
    }
    return chunks;
}

// ============================================
// RETRY & BATCH PROCESSING
// ============================================

/**
 * Retry con backoff esponenziale
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (retries <= 0) throw err;

        if (err.status === 429) {
            const jitter = Math.random() * 1000;
            console.warn(`[Bardo] 🛑 Rate Limit. Attesa forzata di ${(delay * 2 + jitter) / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay * 2 + jitter));
        } else {
            console.warn(`[Bardo] ⚠️ Errore API (Tentativi rimasti: ${retries}). Riprovo tra ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return withRetry(fn, retries - 1, delay * 2);
    }
}

/**
 * Batch Processing con Progress Bar Integrata
 */
export async function processInBatches<T, R>(
    items: T[],
    batchSize: number,
    fn: (item: T, index: number) => Promise<R>,
    taskName?: string
): Promise<R[]> {
    const results: R[] = [];
    const totalBatches = Math.ceil(items.length / batchSize);

    if (taskName) {
        console.log(`[Bardo] 🚀 Avvio ${taskName}: ${items.length} elementi in ${totalBatches} batch (Concorrenza: ${batchSize}).`);
    }

    let completedBatches = 0;

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map((item, batchIndex) => fn(item, i + batchIndex)));
        results.push(...batchResults);

        completedBatches++;

        if (taskName) {
            const percent = Math.round((completedBatches / totalBatches) * 100);
            const filledLen = Math.round((20 * completedBatches) / totalBatches);
            const bar = '█'.repeat(filledLen) + '░'.repeat(20 - filledLen);

            if (totalBatches < 50 || completedBatches % 5 === 0 || completedBatches === totalBatches) {
                console.log(`[Bardo] ⏳ ${taskName}: ${completedBatches}/${totalBatches} [${bar}] ${percent}%`);
            }
        }
    }

    if (taskName) console.log(`[Bardo] ✅ ${taskName} completato.`);
    return results;
}

// ============================================
// SIMILARITY FUNCTIONS
// ============================================

/**
 * Calcolo Similarità Coseno
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Calcola la distanza di Levenshtein normalizzata (0-1, dove 1 = identico)
 */
export function levenshteinSimilarity(a: string, b: string): number {
    const aLower = a.toLowerCase().trim();
    const bLower = b.toLowerCase().trim();

    if (aLower === bLower) return 1;
    if (aLower.length === 0 || bLower.length === 0) return 0;

    const matrix: number[][] = [];
    for (let i = 0; i <= aLower.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= bLower.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= aLower.length; i++) {
        for (let j = 1; j <= bLower.length; j++) {
            if (aLower[i - 1] === bLower[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    const distance = matrix[aLower.length][bLower.length];
    const maxLen = Math.max(aLower.length, bLower.length);
    return 1 - (distance / maxLen);
}

/**
 * Verifica se un nome contiene l'altro come sottostringa
 */
export function containsSubstring(name1: string, name2: string): boolean {
    const n1 = name1.toLowerCase().replace(/\s+/g, '');
    const n2 = name2.toLowerCase().replace(/\s+/g, '');
    return n1.includes(n2) || n2.includes(n1);
}

/**
 * Utility per escape regex special chars
 */
export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
