import pidusage from 'pidusage';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

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
    // 🆕 AGGIUNGI QUESTI
    whisperMetrics?: {
        avgProcessingRatio: number;  // Tempo elaborazione / durata audio (ideale: < 0.5)
        minProcessingTime: number;   // File più veloce
        maxProcessingTime: number;   // File più lento
        filesPerHour: number;        // Throughput
    };
    queueMetrics?: {
        totalJobsProcessed: number;
        totalJobsFailed: number;
        avgWaitTimeMs: number;      // Tempo medio in coda
        maxWaitTimeMs: number;      // Longest wait
        retriedJobs: number;        // Job che hanno richiesto retry
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
    storageMetrics?: {
        localFilesCreated: number;
        localFilesDeleted: number;
        totalUploadedMB: number;
        uploadSuccessRate: number; // Percentuale upload riusciti
        avgCompressionRatio: number; // PCM -> MP3 size reduction
    };
    performanceTrend?: {
        firstHourAvgCpu: number;
        lastHourAvgCpu: number;
        cpuDegradation: number;  // Percentuale di rallentamento
        thermalThrottlingDetected: boolean;
    };
}

const dbPath = path.join(__dirname, '..', 'data', 'dnd_bot.db');

class SystemMonitor {
    private currentSession: SessionMetrics | null = null;
    private interval: NodeJS.Timeout | null = null;

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

        // Campiona risorse ogni 5 secondi
        this.interval = setInterval(() => this.sampleResources(), 5000);

        // Eseguiamo subito un check del disco
        this.checkDiskSpace();

        console.log(`[Monitor] 📊 Iniziato tracciamento sessione ${sessionId} (DB Size: ${(dbSize / 1024 / 1024).toFixed(2)} MB)`);
    }

    private async sampleResources() {
        if (!this.currentSession) return;
        try {
            const stats = await pidusage(process.pid);
            this.currentSession.resourceUsage.cpuSamples.push(Math.round(stats.cpu));
            this.currentSession.resourceUsage.ramSamplesMB.push(Math.round(stats.memory / 1024 / 1024));

            // Aggiorniamo lo spazio disco ogni tanto (es. ogni 10 campionamenti = 50 sec) o semplicemente ad ogni ciclo se non è pesante
            // Per semplicità lo facciamo ogni volta ma in modo asincrono senza await bloccante
            if (this.currentSession.resourceUsage.cpuSamples.length % 12 === 0) { // Ogni minuto circa
                this.checkDiskSpace();
            }
        } catch (e) {
            console.error("Errore campionamento risorse:", e);
        }
    }

    private checkDiskSpace() {
        if (!this.currentSession) return;

        // Comando df -k . per ottenere info sulla partizione corrente in KB
        exec('df -k .', (error, stdout, stderr) => {
            if (error || !this.currentSession) {
                return;
            }
            try {
                // Output tipico:
                // Filesystem     1K-blocks      Used Available Use% Mounted on
                // /dev/disk1s1s1 494384792 38472812 455911980   8% /

                const lines = stdout.trim().split('\n');
                if (lines.length < 2) return;

                const parts = lines[1].split(/\s+/);
                if (parts.length >= 5) {
                    const totalKB = parseInt(parts[1]);
                    const availableKB = parseInt(parts[3]);
                    // Use% potrebbe essere parts[4] (es "8%")

                    const totalGB = totalKB / (1024 * 1024);
                    const freeGB = availableKB / (1024 * 1024);
                    const usedPercent = ((totalGB - freeGB) / totalGB) * 100;

                    this.currentSession.diskUsage = {
                        totalGB: parseFloat(totalGB.toFixed(2)),
                        freeGB: parseFloat(freeGB.toFixed(2)),
                        usedPercent: parseFloat(usedPercent.toFixed(1))
                    };
                }
            } catch (e) {
                console.error("[Monitor] Errore parsing df:", e);
            }
        });
    }

    logFileProcessed(durationSec: number, processingTimeMs: number) {
        if (this.currentSession) {
            this.currentSession.totalFiles++;
            this.currentSession.totalAudioDurationSec += durationSec;
            this.currentSession.transcriptionTimeMs += processingTimeMs;

            // 🆕 Calcolo Whisper Metrics
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
                // Update min/max
                this.currentSession.whisperMetrics.minProcessingTime = Math.min(
                    this.currentSession.whisperMetrics.minProcessingTime,
                    processingTimeSec
                );
                this.currentSession.whisperMetrics.maxProcessingTime = Math.max(
                    this.currentSession.whisperMetrics.maxProcessingTime,
                    processingTimeSec
                );

                // Update average ratio
                const totalRatio = this.currentSession.totalAudioDurationSec > 0
                    ? (this.currentSession.transcriptionTimeMs / 1000) / this.currentSession.totalAudioDurationSec
                    : 0;
                this.currentSession.whisperMetrics.avgProcessingRatio = totalRatio;
            }

            // Calcola throughput
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

    // 🆕 AGGIUNGI QUESTO METODO
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

        // Update wait times
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

    // 🆕 AGGIUNGI QUESTO METODO
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

    // 🆕 AGGIUNGI QUESTO METODO
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

        // Update latency stats
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

        // Tokens per second
        if (latencyMs > 0) {
            const tokensPerSec = tokensGenerated / (latencyMs / 1000);
            const prevTotal = (this.currentSession.aiMetrics.tokensPerSecond * (total - 1)) / total;
            this.currentSession.aiMetrics.tokensPerSecond = prevTotal + (tokensPerSec / total);
        }
    }

    // 🆕 AGGIUNGI QUESTO METODO
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

            // Compression ratio (solo se è un file audio compresso)
            if (originalSizeMB > uploadedSizeMB && uploadedSizeMB > 0) {
                const ratio = originalSizeMB / uploadedSizeMB;
                const total = this.currentSession.storageMetrics.localFilesCreated;
                const prevAvg = this.currentSession.storageMetrics.avgCompressionRatio;
                this.currentSession.storageMetrics.avgCompressionRatio =
                    (prevAvg * (total - 1) + ratio) / total;
            }
        } else {
            // Recalculate success rate
            const total = this.currentSession.storageMetrics.localFilesCreated;
            const successCount = Math.round(this.currentSession.storageMetrics.uploadSuccessRate * (total - 1) / 100);
            this.currentSession.storageMetrics.uploadSuccessRate = (successCount / total) * 100;
        }
    }

    // 🆕 AGGIUNGI QUESTO METODO
    logFileDeleted() {
        if (this.currentSession && this.currentSession.storageMetrics) {
            this.currentSession.storageMetrics.localFilesDeleted++;
        }
    }

    endSession(): SessionMetrics | null {
        if (this.interval) clearInterval(this.interval);

        // Ultimo check disco sincrono o quasi (ma exec è async, quindi ci affidiamo all'ultimo valore salvato)
        // Se non abbiamo mai fatto check, proviamo a lanciarlo ma endSession deve ritornare subito.
        // Confidiamo che startSession o il loop abbiano popolato diskUsage.

        if (this.currentSession) {
            this.currentSession.endTime = Date.now();
            try {
                if (fs.existsSync(dbPath)) {
                    this.currentSession.dbEndSizeBytes = fs.statSync(dbPath).size;
                }
            } catch (e) {
                console.error("[Monitor] Errore lettura dimensione finale DB:", e);
            }

            // 🆕 CALCOLO THERMAL DEGRADATION
            const samples = this.currentSession.resourceUsage.cpuSamples;
            if (samples.length > 120) { // Almeno 10 minuti di dati (120 samples @ 5s)
                const firstHour = samples.slice(0, Math.min(720, samples.length / 2));
                const lastHour = samples.slice(-Math.min(720, samples.length / 2));

                const firstAvg = firstHour.reduce((a, b) => a + b, 0) / firstHour.length;
                const lastAvg = lastHour.reduce((a, b) => a + b, 0) / lastHour.length;

                const degradation = firstAvg > 0 ? ((firstAvg - lastAvg) / firstAvg) * 100 : 0;

                // 🔧 FIX: Throttling detection più intelligente
                const sessionIsActive = this.currentSession.totalFiles > 0;
                const significantDrop = degradation > 20; // CPU cala del 20%+
                const avgCpuWasHigh = firstAvg > 30; // Lavoro intenso all'inizio

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

export const monitor = new SystemMonitor();
