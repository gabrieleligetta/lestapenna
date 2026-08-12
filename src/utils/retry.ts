/**
 * Retry with exponential backoff. Extracted from bard/helpers.ts (it was generic, with no
 * bard-specific dependencies) to be reusable outside the AI layer too, e.g. for the network
 * calls to Oracle Object Storage in services/backup.ts.
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000, label?: string): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        if (retries <= 0) throw err;

        // 🆕 optional label: without it, in the middle of several concurrent operations
        // (e.g. parallel uploads to Oracle) these logs were indistinguishable — you could
        // not tell WHICH operation was failing/retrying.
        const context = label ? ` [${label}]` : '';
        if (err.status === 429) {
            const jitter = Math.random() * 1000;
            console.warn(`[Retry]${context} 🛑 Rate Limit. Attesa forzata di ${(delay * 2 + jitter) / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay * 2 + jitter));
        } else {
            console.warn(`[Retry]${context} ⚠️ ${err.message || err}. Tentativi rimasti: ${retries}. Riprovo tra ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return withRetry(fn, retries - 1, delay * 2, label);
    }
}
