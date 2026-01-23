/**
 * Reporter Types
 */

import { SessionMetrics } from '../monitor';

export interface RecipientConfig {
    envVarName: string;
    fallbackEnvVar?: string;
}

export interface AggregatedCostByPhase {
    phase: string;
    models: string[];          // Tutti i modelli usati in questa fase
    providers: Set<string>;    // Provider usati
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUSD: number;
}

export interface ArchiveResult {
    raw: string;
    cleaned: string;
    summary?: string;
}
