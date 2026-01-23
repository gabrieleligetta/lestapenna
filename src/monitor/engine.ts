/**
 * Monitor - Main Engine
 */

import pidusage from 'pidusage';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { SessionMetrics } from './types';
import { calculateCost } from './costs';
import { checkDiskSpace } from './utils';

const dbPath = path.join(__dirname, '..', '..', 'data', 'dnd_bot.db'); // Adjusted path

export class SystemMonitor {
    private currentSession: SessionMetrics | null = null;
    private interval: NodeJS.Timeout | null = null;
    private lastLogTime = 0;
    private readonly LOG_INTERVAL = 15000; // 15 secondi
    private sampleCounter = 0;

    startSession(sessionId: string) {
        let dbSize = 0;
        try {
            if (fs.existsSync(dbPath)) {
                dbSize = fs.statSync(dbPath).size;
            }
        } catch (e) {
            console.error("[Monitor] Errore lettura dimensione DB:", e);
        }

        this.currentSession = {
            sessionId,
            startTime: Date.now(),
            totalFiles: 0,
            totalAudioDurationSec: 0,
            transcriptionTimeMs: 0,
            summarizationTimeMs: 0,
            totalTokensUsed: 0,
            dbStartSizeBytes: dbSize,
            errors: [],
            resourceUsage: { cpuSamples: [], ramSamplesMB: [] }
        };

        this.interval = setInterval(() => this.sampleResources(), 5000);
        this.updateDiskSpace();

        console.log(`[Monitor] 📊 Iniziato tracciamento sessione ${sessionId} (DB Size: ${(dbSize / 1024 / 1024).toFixed(2)} MB)`);
    }

    startIdleMonitoring() {
        console.log("[Monitor] 💤 Avvio monitoraggio Idle (Heartbeat 60s)...");
        setInterval(() => {
            if (!this.currentSession) {
                this.logSystemHealth(true);
            }
        }, 60000);
    }

    private async sampleResources() {
        if (!this.currentSession) return;
        this.sampleCounter++;

        try {
            const stats = await pidusage(process.pid);
            this.currentSession.resourceUsage.cpuSamples.push(Math.round(stats.cpu));
            this.currentSession.resourceUsage.ramSamplesMB.push(Math.round(stats.memory / 1024 / 1024));

            const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
            const cpuLoad = os.loadavg()[0];

            if (!this.currentSession.systemHealth) {
                this.currentSession.systemHealth = {
                    minFreeRamMB: freeMemMB,
                    maxCpuLoad: cpuLoad
                };
            } else {
                this.currentSession.systemHealth.minFreeRamMB = Math.min(this.currentSession.systemHealth.minFreeRamMB, freeMemMB);
                this.currentSession.systemHealth.maxCpuLoad = Math.max(this.currentSession.systemHealth.maxCpuLoad, cpuLoad);
            }

            if (this.sampleCounter % 12 === 0) {
                this.updateDiskSpace();
            }

            if (this.sampleCounter % 6 === 0) {
                this.logSystemHealth();
            }

            const now = Date.now();
            if (now - this.lastLogTime > this.LOG_INTERVAL) {
                this.lastLogTime = now;
            }

        } catch (e) {
            console.error("Errore campionamento risorse:", e);
        }
    }

    private logSystemHealth(isIdle: boolean = false) {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const usedMemGB = (usedMem / (1024 * 1024 * 1024)).toFixed(2);
        const totalMemGB = (totalMem / (1024 * 1024 * 1024)).toFixed(2);
        const memPercent = Math.round((usedMem / totalMem) * 100);

        const loadAvg = os.loadavg()[0].toFixed(2);

        let diskUsedPct = '?';
        if (this.currentSession?.diskUsage) {
            diskUsedPct = this.currentSession.diskUsage.usedPercent.toFixed(1);
        } else {
            const diskStats = checkDiskSpace();
            if (diskStats) {
                diskUsedPct = diskStats.usedPercent.toFixed(1);
            }
        }

        const timestamp = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const prefix = isIdle ? '[Idle]' : '[Health]';
        console.log(`[${timestamp}] ${prefix} 🖥️ SYS: CPU Load ${loadAvg} | 🧠 RAM: ${usedMemGB}/${totalMemGB} GB (${memPercent}%) | 💿 Disk: ${diskUsedPct}%`);

        if (freeMem < 2 * 1024 * 1024 * 1024) {
            console.warn(`[⚠️ ALARM] RAM IN ESURIMENTO! Liberi solo ${(freeMem / 1024 / 1024).toFixed(0)} MB`);
        }
    }

    private updateDiskSpace() {
        const diskData = checkDiskSpace();
        if (diskData && this.currentSession) {
            this.currentSession.diskUsage = diskData;
        }
        return diskData;
    }

    logFileProcessed(durationSec: number, processingTimeMs: number) {
        if (this.currentSession) {
            this.currentSession.totalFiles++;
            this.currentSession.totalAudioDurationSec += durationSec;
            this.currentSession.transcriptionTimeMs += processingTimeMs;

            const processingTimeSec = processingTimeMs / 1000;
            const ratio = durationSec > 0 ? processingTimeSec / durationSec : 0;

            if (!this.currentSession.whisperMetrics) {
                this.currentSession.whisperMetrics = {
                    avgProcessingRatio: ratio,
                    minProcessingTime: processingTimeSec,
                    maxProcessingTime: processingTimeSec,
                    filesPerHour: 0
                };
            } else {
                this.currentSession.whisperMetrics.minProcessingTime = Math.min(
                    this.currentSession.whisperMetrics.minProcessingTime,
                    processingTimeSec
                );
                this.currentSession.whisperMetrics.maxProcessingTime = Math.max(
                    this.currentSession.whisperMetrics.maxProcessingTime,
                    processingTimeSec
                );

                const totalRatio = this.currentSession.totalAudioDurationSec > 0
                    ? (this.currentSession.transcriptionTimeMs / 1000) / this.currentSession.totalAudioDurationSec
                    : 0;
                this.currentSession.whisperMetrics.avgProcessingRatio = totalRatio;
            }

            const elapsedHours = (Date.now() - this.currentSession.startTime) / (1000 * 60 * 60);
            if (elapsedHours > 0) {
                this.currentSession.whisperMetrics.filesPerHour = this.currentSession.totalFiles / elapsedHours;
            }
        }
    }

    logSummarizationTime(ms: number) {
        if (this.currentSession) this.currentSession.summarizationTimeMs = ms;
    }

    logTokenUsage(tokens: number) {
        if (this.currentSession) {
            this.currentSession.totalTokensUsed += tokens;
        }
    }

    logError(context: string, error: string) {
        if (this.currentSession) {
            this.currentSession.errors.push(`[${context}] ${error}`);
        }
    }

    logJobProcessed(waitTimeMs: number, retryCount: number = 0) {
        if (!this.currentSession) return;

        if (!this.currentSession.queueMetrics) {
            this.currentSession.queueMetrics = {
                totalJobsProcessed: 0,
                totalJobsFailed: 0,
                avgWaitTimeMs: waitTimeMs,
                maxWaitTimeMs: waitTimeMs,
                retriedJobs: 0
            };
        }

        this.currentSession.queueMetrics.totalJobsProcessed++;

        const total = this.currentSession.queueMetrics.totalJobsProcessed;
        this.currentSession.queueMetrics.avgWaitTimeMs =
            (this.currentSession.queueMetrics.avgWaitTimeMs * (total - 1) + waitTimeMs) / total;

        this.currentSession.queueMetrics.maxWaitTimeMs = Math.max(
            this.currentSession.queueMetrics.maxWaitTimeMs,
            waitTimeMs
        );

        if (retryCount > 0) {
            this.currentSession.queueMetrics.retriedJobs++;
        }
    }

    logJobFailed() {
        if (this.currentSession) {
            if (!this.currentSession.queueMetrics) {
                this.currentSession.queueMetrics = {
                    totalJobsProcessed: 0,
                    totalJobsFailed: 0,
                    avgWaitTimeMs: 0,
                    maxWaitTimeMs: 0,
                    retriedJobs: 0
                };
            }
            this.currentSession.queueMetrics.totalJobsFailed++;
        }
    }

    logAIRequest(provider: 'ollama' | 'openai', latencyMs: number, tokensGenerated: number, failed: boolean = false) {
        if (!this.currentSession) return;

        if (!this.currentSession.aiMetrics) {
            this.currentSession.aiMetrics = {
                provider,
                totalRequests: 0,
                avgLatencyMs: 0,
                minLatencyMs: latencyMs,
                maxLatencyMs: latencyMs,
                tokensPerSecond: 0,
                failedRequests: 0
            };
        }

        if (failed) {
            this.currentSession.aiMetrics.failedRequests++;
            return;
        }

        this.currentSession.aiMetrics.totalRequests++;

        const total = this.currentSession.aiMetrics.totalRequests;
        this.currentSession.aiMetrics.avgLatencyMs =
            (this.currentSession.aiMetrics.avgLatencyMs * (total - 1) + latencyMs) / total;

        this.currentSession.aiMetrics.minLatencyMs = Math.min(
            this.currentSession.aiMetrics.minLatencyMs,
            latencyMs
        );

        this.currentSession.aiMetrics.maxLatencyMs = Math.max(
            this.currentSession.aiMetrics.maxLatencyMs,
            latencyMs
        );

        if (latencyMs > 0) {
            const tokensPerSec = tokensGenerated / (latencyMs / 1000);
            const prevTotal = (this.currentSession.aiMetrics.tokensPerSecond * (total - 1)) / total;
            this.currentSession.aiMetrics.tokensPerSecond = prevTotal + (tokensPerSec / total);
        }
    }

    logAIRequestWithCost(
        phase: string,
        provider: 'ollama' | 'openai',
        model: string,
        inputTokens: number,
        outputTokens: number,
        cachedInputTokens: number = 0,
        latencyMs: number,
        failed: boolean = false
    ) {
        if (!this.currentSession) return;

        this.logAIRequest(provider, latencyMs, outputTokens, failed);

        if (failed) return;

        if (!this.currentSession.costMetrics) {
            this.currentSession.costMetrics = {
                totalCostUSD: 0,
                breakdown: [],
                byProvider: { openai: 0, ollama: 0 }
            };
        }

        const cost = provider === 'openai'
            ? calculateCost(model, inputTokens, outputTokens, cachedInputTokens)
            : 0;

        this.currentSession.costMetrics.breakdown.push({
            phase,
            provider,
            model,
            inputTokens,
            outputTokens,
            cachedInputTokens,
            costUSD: cost
        });

        this.currentSession.costMetrics.totalCostUSD += cost;
        this.currentSession.costMetrics.byProvider[provider] += cost;

        const timestamp = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        console.log(`[${timestamp}] [Monitor] 💰 ${phase} (${model}): $${cost.toFixed(4)} USD`);
    }

    getCostSummaryByPhase(): Record<string, number> {
        if (!this.currentSession?.costMetrics) return {};

        const summary: Record<string, number> = {};
        for (const item of this.currentSession.costMetrics.breakdown) {
            if (!summary[item.phase]) summary[item.phase] = 0;
            summary[item.phase] += item.costUSD;
        }
        return summary;
    }

    logFileUpload(originalSizeMB: number, uploadedSizeMB: number, success: boolean) {
        if (!this.currentSession) return;

        if (!this.currentSession.storageMetrics) {
            this.currentSession.storageMetrics = {
                localFilesCreated: 0,
                localFilesDeleted: 0,
                totalUploadedMB: 0,
                uploadSuccessRate: 100,
                avgCompressionRatio: 1
            };
        }

        this.currentSession.storageMetrics.localFilesCreated++;

        if (success) {
            this.currentSession.storageMetrics.totalUploadedMB += uploadedSizeMB;

            if (originalSizeMB > uploadedSizeMB && uploadedSizeMB > 0) {
                const ratio = originalSizeMB / uploadedSizeMB;
                const total = this.currentSession.storageMetrics.localFilesCreated;
                const prevAvg = this.currentSession.storageMetrics.avgCompressionRatio;
                this.currentSession.storageMetrics.avgCompressionRatio =
                    (prevAvg * (total - 1) + ratio) / total;
            }
        } else {
            const total = this.currentSession.storageMetrics.localFilesCreated;
            const successCount = Math.round(this.currentSession.storageMetrics.uploadSuccessRate * (total - 1) / 100);
            this.currentSession.storageMetrics.uploadSuccessRate = (successCount / total) * 100;
        }
    }

    logFileDeleted() {
        if (this.currentSession && this.currentSession.storageMetrics) {
            this.currentSession.storageMetrics.localFilesDeleted++;
        }
    }

    async endSession(): Promise<SessionMetrics | null> {
        if (this.interval) clearInterval(this.interval);

        if (this.currentSession) {
            this.currentSession.endTime = Date.now();
            try {
                if (fs.existsSync(dbPath)) {
                    this.currentSession.dbEndSizeBytes = fs.statSync(dbPath).size;
                }
            } catch (e) {
                console.error("[Monitor] Errore lettura dimensione finale DB:", e);
            }

            const samples = this.currentSession.resourceUsage.cpuSamples;
            if (samples.length > 120) {
                const firstHour = samples.slice(0, Math.min(720, samples.length / 2));
                const lastHour = samples.slice(-Math.min(720, samples.length / 2));

                const firstAvg = firstHour.reduce((a, b) => a + b, 0) / firstHour.length;
                const lastAvg = lastHour.reduce((a, b) => a + b, 0) / lastHour.length;

                const degradation = firstAvg > 0 ? ((firstAvg - lastAvg) / firstAvg) * 100 : 0;

                const sessionIsActive = this.currentSession.totalFiles > 0;
                const significantDrop = degradation > 20;
                const avgCpuWasHigh = firstAvg > 30;

                this.currentSession.performanceTrend = {
                    firstHourAvgCpu: Math.round(firstAvg),
                    lastHourAvgCpu: Math.round(lastAvg),
                    cpuDegradation: Math.round(degradation),
                    thermalThrottlingDetected: sessionIsActive && significantDrop && avgCpuWasHigh
                };
            }
        }
        const metrics = this.currentSession;
        this.currentSession = null;
        return metrics;
    }

    isSessionActive(): boolean {
        return this.currentSession !== null;
    }
}
