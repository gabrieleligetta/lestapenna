/**
 * Monitor - Types
 */

import type { FxSource } from '../services/aiCostTransparency';

export type MonitorProvider = 'openai' | 'gemini' | 'ollama' | 'ollama-cloud' | 'anthropic';
export type RuntimePhase = 'recording' | 'queued' | 'processing' | 'finalization' | 'other';

export interface CapacitySample {
    timestamp: number;
    role: string;
    phase: RuntimePhase;
    processCpuPercent: number;
    processRamMB: number;
    systemCpuPercent: number;
    freeRamMB: number;
    loadAverage1m: number;
    eventLoopLagMs: number;
    activeFfmpegEncoders?: number;
    activeRecordingGuilds?: number;
}

export interface CostBreakdown {
    phase: string;           // 'analyst', 'map', 'summary', 'chat', 'embeddings', 'metadata'
    provider: MonitorProvider;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;  // Per prompt caching
    costUSD: number;
    /** EUR cost frozen at session close; NULL when no reliable rate is available. */
    costEUR?: number | null;
    usdPerEur?: number | null;
    exchangeRateSource?: FxSource;
    exchangeRateDate?: string | null;
    exchangeRateFetchedAt?: number | null;
    /** $/1M token rates applied at request time (absent for local providers
     *  such as ollama, cost 0). Recorded here because monitor/costs.ts is a
     *  mutable table — a future price change must not alter the historical cost. */
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
    cachedInputPricePerMillion?: number;
}

export interface SessionMetrics {
    sessionId: string;
    startTime: number;
    endTime?: number;
    totalFiles: number;
    totalAudioDurationSec: number;
    transcriptionTimeMs: number;
    summarizationTimeMs: number;
    totalTokensUsed: number;
    dbStartSizeBytes?: number;
    dbEndSizeBytes?: number;
    diskUsage?: {
        totalGB: number;
        freeGB: number;
        usedPercent: number;
    };
    errors: string[];
    resourceUsage: {
        cpuSamples: number[];
        ramSamplesMB: number[];
    };
    /**
     * Same samples split by runtime role. `resourceUsage` stays for backwards
     * compatibility and aggregate reports; this field tells us whether voice
     * acquisition or background processing consumed the headroom.
     */
    resourceUsageByRole?: Record<string, {
        cpuSamples: number[];
        ramSamplesMB: number[];
    }>;
    recordingMetrics?: {
        startedAt: number;
        endedAt?: number;
        humanParticipants: number;
        maxFfmpegEncoders: number;
        maxConcurrentRecordingGuilds: number;
    };
    /** 15-second host/process samples used for capacity planning. No user IDs. */
    capacitySamples?: CapacitySample[];
    runtimePhaseTransitions?: Array<{
        timestamp: number;
        role: string;
        phase: RuntimePhase;
    }>;
    runtimeContexts?: Record<string, {
        logicalCpuCount: number;
        totalRamMB: number;
        platform: NodeJS.Platform;
        architecture: string;
        nodeVersion: string;
        configuredRecordingGuildLimit: number;
        configuredMixConcurrency: number;
        configuredUploadConcurrency: number;
    }>;
    systemHealth?: {
        minFreeRamMB: number; // Minima RAM libera osservata
        maxCpuLoad: number;   // Massimo Load Average (1min)
        /** Worst delay observed by the monitor's 5s timer. */
        maxEventLoopLagMs?: number;
    };
    whisperMetrics?: {
        avgProcessingRatio: number;  // Processing time / audio duration
        minProcessingTime: number;
        maxProcessingTime: number;
        filesPerHour: number;
    };
    queueMetrics?: {
        totalJobsProcessed: number;
        totalJobsFailed: number;
        avgWaitTimeMs: number;
        maxWaitTimeMs: number;
        retriedJobs: number;
    };
    aiMetrics?: {
        provider: MonitorProvider;
        totalRequests: number;
        avgLatencyMs: number;
        minLatencyMs: number;
        maxLatencyMs: number;
        tokensPerSecond: number;
        failedRequests: number;
    };
    costMetrics?: {
        totalCostUSD: number;
        /** NULL means the USD total could not be converted reliably. */
        totalCostEUR?: number | null;
        usdPerEur?: number | null;
        exchangeRateSource?: FxSource;
        exchangeRateDate?: string | null;
        exchangeRateFetchedAt?: number | null;
        breakdown: CostBreakdown[];
        byProvider: {
            openai: number;
            gemini: number;
            ollama: number;
            'ollama-cloud': number;
            anthropic: number;
        };
    };
    storageMetrics?: {
        localFilesCreated: number;
        localFilesDeleted: number;
        totalUploadedMB: number;
        uploadSuccessRate: number;
        avgCompressionRatio: number;
    };
    performanceTrend?: {
        firstHourAvgCpu: number;
        lastHourAvgCpu: number;
        cpuDegradation: number;
        thermalThrottlingDetected: boolean;
    };
}
