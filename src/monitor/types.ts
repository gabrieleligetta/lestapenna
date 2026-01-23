/**
 * Monitor - Types
 */

export interface CostBreakdown {
    phase: string;           // 'analyst', 'map', 'summary', 'chat', 'embeddings', 'metadata'
    provider: 'ollama' | 'openai';
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;  // Per prompt caching
    costUSD: number;
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
    systemHealth?: {
        minFreeRamMB: number; // Minima RAM libera osservata
        maxCpuLoad: number;   // Massimo Load Average (1min)
    };
    whisperMetrics?: {
        avgProcessingRatio: number;  // Tempo elaborazione / durata audio
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
        provider: 'ollama' | 'openai';
        totalRequests: number;
        avgLatencyMs: number;
        minLatencyMs: number;
        maxLatencyMs: number;
        tokensPerSecond: number;
        failedRequests: number;
    };
    costMetrics?: {
        totalCostUSD: number;
        breakdown: CostBreakdown[];
        byProvider: {
            openai: number;
            ollama: number;
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
