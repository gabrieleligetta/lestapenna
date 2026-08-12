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
    models: string[];          // Every model used in this phase
    providers: Set<string>;    // Provider usati
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUSD: number;
    costEUR: number | null;
}

export interface ArchiveResult {
    raw: string;
    cleaned: string;
    summary?: string;
}
