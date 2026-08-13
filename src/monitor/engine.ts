/**
 * Monitor - Main Engine
 */

import pidusage from 'pidusage';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { CapacitySample, SessionMetrics, MonitorProvider, RuntimePhase } from './types';
import { calculateCost, resolvePricing } from './costs';
import { checkDiskSpace } from './utils';
import { tenantRepository } from '../db/repositories/TenantRepository';
import { aiUsageRepository } from '../db/repositories/AiUsageRepository';
import { getSessionGuildId, getSessionCampaignId } from '../db';
import { logger } from '../utils/logger';
import {
    getUsdEurRate,
    type UsdEurRate,
} from '../services/aiCostTransparency';
import { attachEuroCosts } from './currency';
import { currentAiScope } from '../bard/ai/ambientScope';
import { getProcessRole } from '../services/processRole';

const log = logger('Monitor');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dnd_bot.db');
const capacityMetricsDir = process.env.CAPACITY_METRICS_DIR
    || path.join(path.dirname(dbPath), 'capacity-metrics');

type CapacityCheckpointEvent =
    | { type: 'sample'; data: CapacitySample }
    | { type: 'transition'; data: NonNullable<SessionMetrics['runtimePhaseTransitions']>[number] }
    | { type: 'context'; role: string; data: NonNullable<SessionMetrics['runtimeContexts']>[string] }
    | { type: 'recording'; data: NonNullable<SessionMetrics['recordingMetrics']> };

export class SystemMonitor {
    private readonly sessions = new Map<string, SessionMetrics>();
    private readonly intervals = new Map<string, NodeJS.Timeout>();
    private readonly lastSampleAt = new Map<string, number>();
    private readonly sampleCounts = new Map<string, number>();
    private readonly systemCpuTicks = new Map<string, { idle: number; total: number }>();
    private readonly runtimePhases = new Map<string, RuntimePhase>();
    private readonly activeFfmpegEncoders = new Map<string, number>();
    private readonly checkpointWrites = new Map<string, Promise<void>>();
    private currentRecordingGuilds = 0;
    private defaultSessionId: string | null = null;
    private lastLogTime = 0;
    private readonly LOG_INTERVAL = 15000; // 15 secondi
    private sampleCounter = 0;

    private get currentSession(): SessionMetrics | null {
        const sessionId = currentAiScope()?.sessionId ?? this.defaultSessionId;
        return sessionId ? this.sessions.get(sessionId) ?? null : null;
    }

    private session(explicitSessionId?: string): SessionMetrics | null {
        if (explicitSessionId) return this.sessions.get(explicitSessionId) ?? null;
        return this.currentSession;
    }

    startSession(sessionId: string, seed?: SessionMetrics) {
        this.defaultSessionId = sessionId;
        const existing = this.sessions.get(sessionId);
        if (existing) {
            if (seed) this.mergeMetrics(existing, seed);
            return;
        }

        let dbSize = 0;
        try {
            if (fs.existsSync(dbPath)) {
                dbSize = fs.statSync(dbPath).size;
            }
        } catch (e) {
            console.error("[Monitor] Errore lettura dimensione DB:", e);
        }

        const metrics: SessionMetrics = seed ? JSON.parse(JSON.stringify(seed)) : {
            sessionId,
            startTime: Date.now(),
            totalFiles: 0,
            totalAudioDurationSec: 0,
            transcriptionTimeMs: 0,
            summarizationTimeMs: 0,
            totalTokensUsed: 0,
            dbStartSizeBytes: dbSize,
            errors: [],
            resourceUsage: { cpuSamples: [], ramSamplesMB: [] },
            resourceUsageByRole: {}
        };
        metrics.resourceUsageByRole ??= {};
        metrics.capacitySamples ??= [];
        metrics.runtimePhaseTransitions ??= [];
        metrics.runtimeContexts ??= {};
        const role = getProcessRole();
        metrics.runtimeContexts[role] ??= {
            logicalCpuCount: os.cpus().length,
            totalRamMB: Math.round(os.totalmem() / 1024 / 1024),
            platform: process.platform,
            architecture: process.arch,
            nodeVersion: process.version,
            configuredRecordingGuildLimit: Number.parseInt(process.env.MAX_CONCURRENT_RECORDING_GUILDS || '2', 10) || 2,
            configuredMixConcurrency: Number.parseInt(process.env.MIX_CONCURRENCY_LIMIT || '1', 10) || 1,
            configuredUploadConcurrency: Number.parseInt(process.env.MAX_CONCURRENT_UPLOADS || '2', 10) || 2,
        };
        this.hydrateCapacityCheckpoints(sessionId, metrics);
        this.appendCapacityCheckpoint(sessionId, {
            type: 'context',
            role,
            data: metrics.runtimeContexts[role],
        });
        this.sessions.set(sessionId, metrics);
        this.lastSampleAt.set(sessionId, Date.now());
        this.sampleCounts.set(sessionId, 0);
        this.systemCpuTicks.set(sessionId, this.readSystemCpuTicks());
        this.setRuntimePhase(sessionId, 'other');

        const interval = setInterval(() => void this.sampleResources(sessionId), 5000);
        interval.unref?.();
        this.intervals.set(sessionId, interval);
        this.updateDiskSpace(sessionId);

        log.info(`Iniziato tracciamento sessione ${sessionId} (DB Size: ${(dbSize / 1024 / 1024).toFixed(2)} MB)`);
    }

    startIdleMonitoring() {
        console.log("[Monitor] 💤 Avvio monitoraggio Idle (Heartbeat 1h)...");
        setInterval(() => {
            if (this.sessions.size === 0) {
                this.logSystemHealth(true);
            }
        }, 3600000); // 1 hour
    }

    private async sampleResources(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        this.sampleCounter++;

        try {
            const now = Date.now();
            const previousSampleAt = this.lastSampleAt.get(sessionId) ?? now;
            const eventLoopLagMs = Math.max(0, now - previousSampleAt - 5000);
            this.lastSampleAt.set(sessionId, now);
            const stats = await pidusage(process.pid);
            const processCpuPercent = Math.round(stats.cpu);
            const processRamMB = Math.round(stats.memory / 1024 / 1024);
            session.resourceUsage.cpuSamples.push(processCpuPercent);
            session.resourceUsage.ramSamplesMB.push(processRamMB);
            const role = getProcessRole();
            const roleUsage = session.resourceUsageByRole ??= {};
            const roleSamples = roleUsage[role] ??= { cpuSamples: [], ramSamplesMB: [] };
            roleSamples.cpuSamples.push(processCpuPercent);
            roleSamples.ramSamplesMB.push(processRamMB);

            const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
            const cpuLoad = os.loadavg()[0];
            const systemCpuPercent = this.readSystemCpuPercent(sessionId);

            if (!session.systemHealth) {
                session.systemHealth = {
                    minFreeRamMB: freeMemMB,
                    maxCpuLoad: cpuLoad,
                    maxEventLoopLagMs: eventLoopLagMs,
                };
            } else {
                session.systemHealth.minFreeRamMB = Math.min(session.systemHealth.minFreeRamMB, freeMemMB);
                session.systemHealth.maxCpuLoad = Math.max(session.systemHealth.maxCpuLoad, cpuLoad);
                session.systemHealth.maxEventLoopLagMs = Math.max(
                    session.systemHealth.maxEventLoopLagMs ?? 0,
                    eventLoopLagMs,
                );
            }

            if (this.sampleCounter % 12 === 0) {
                this.updateDiskSpace(sessionId);
            }

            if (this.sampleCounter % 6 === 0) {
                this.logSystemHealth();
            }

            const sessionSampleCount = (this.sampleCounts.get(sessionId) ?? 0) + 1;
            this.sampleCounts.set(sessionId, sessionSampleCount);
            if (sessionSampleCount % 3 === 0) {
                const activeRecordingGuilds = role !== 'worker'
                    ? this.currentRecordingGuilds
                    : undefined;
                const capacitySample: CapacitySample = {
                    timestamp: now,
                    role,
                    phase: this.runtimePhases.get(sessionId) ?? 'other',
                    processCpuPercent,
                    processRamMB,
                    systemCpuPercent,
                    freeRamMB: freeMemMB,
                    loadAverage1m: Number(cpuLoad.toFixed(2)),
                    eventLoopLagMs,
                    ...(role !== 'worker' ? {
                        activeFfmpegEncoders: this.activeFfmpegEncoders.get(sessionId) ?? 0,
                        ...(activeRecordingGuilds === undefined ? {} : { activeRecordingGuilds }),
                    } : {}),
                };
                (session.capacitySamples ??= []).push(capacitySample);
                this.appendCapacityCheckpoint(sessionId, { type: 'sample', data: capacitySample });
            }

            if (now - this.lastLogTime > this.LOG_INTERVAL) {
                this.lastLogTime = now;
            }

        } catch (e) {
            console.error("Errore campionamento risorse:", e);
        }
    }

    private readSystemCpuTicks(): { idle: number; total: number } {
        let idle = 0;
        let total = 0;
        for (const cpu of os.cpus()) {
            idle += cpu.times.idle;
            total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
        }
        return { idle, total };
    }

    private checkpointPrefix(sessionId: string): string {
        return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    private checkpointPath(sessionId: string, role: string = getProcessRole()): string {
        return path.join(capacityMetricsDir, `${this.checkpointPrefix(sessionId)}--${role}.jsonl`);
    }

    private appendCapacityCheckpoint(sessionId: string, event: CapacityCheckpointEvent): void {
        const filePath = this.checkpointPath(sessionId);
        const previous = this.checkpointWrites.get(filePath) ?? Promise.resolve();
        const pending = previous
            .then(async () => {
                await fs.promises.mkdir(capacityMetricsDir, { recursive: true });
                await fs.promises.appendFile(filePath, `${JSON.stringify(event)}\n`);
            })
            .catch(error => {
                log.warn(`Capacity checkpoint fallito per ${sessionId}: ${(error as Error).message}`);
            });
        this.checkpointWrites.set(filePath, pending);
    }

    private async flushCapacityCheckpoints(sessionId: string): Promise<void> {
        const prefix = `${this.checkpointPrefix(sessionId)}--`;
        await Promise.all([...this.checkpointWrites.entries()]
            .filter(([filePath]) => path.basename(filePath).startsWith(prefix))
            .map(([, pending]) => pending));
    }

    private hydrateCapacityCheckpoints(sessionId: string, metrics: SessionMetrics): void {
        if (!fs.existsSync(capacityMetricsDir)) return;
        const prefix = `${this.checkpointPrefix(sessionId)}--`;
        const sampleKeys = new Set((metrics.capacitySamples ?? []).map(sample => `${sample.role}:${sample.timestamp}`));
        const transitionKeys = new Set((metrics.runtimePhaseTransitions ?? [])
            .map(transition => `${transition.role}:${transition.timestamp}:${transition.phase}`));

        for (const fileName of fs.readdirSync(capacityMetricsDir)) {
            if (!fileName.startsWith(prefix) || !fileName.endsWith('.jsonl')) continue;
            try {
                const lines = fs.readFileSync(path.join(capacityMetricsDir, fileName), 'utf8').split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const event = JSON.parse(line) as CapacityCheckpointEvent;
                    if (event.type === 'sample') {
                        const key = `${event.data.role}:${event.data.timestamp}`;
                        if (!sampleKeys.has(key)) {
                            (metrics.capacitySamples ??= []).push(event.data);
                            sampleKeys.add(key);
                        }
                    } else if (event.type === 'transition') {
                        const key = `${event.data.role}:${event.data.timestamp}:${event.data.phase}`;
                        if (!transitionKeys.has(key)) {
                            (metrics.runtimePhaseTransitions ??= []).push(event.data);
                            transitionKeys.add(key);
                        }
                    } else if (event.type === 'context') {
                        (metrics.runtimeContexts ??= {})[event.role] = event.data;
                    } else if (event.type === 'recording') {
                        if (!metrics.recordingMetrics) metrics.recordingMetrics = { ...event.data };
                        else {
                            metrics.recordingMetrics.startedAt = Math.min(metrics.recordingMetrics.startedAt, event.data.startedAt);
                            metrics.recordingMetrics.endedAt = Math.max(metrics.recordingMetrics.endedAt ?? 0, event.data.endedAt ?? 0) || undefined;
                            metrics.recordingMetrics.humanParticipants = Math.max(metrics.recordingMetrics.humanParticipants, event.data.humanParticipants);
                            metrics.recordingMetrics.maxFfmpegEncoders = Math.max(metrics.recordingMetrics.maxFfmpegEncoders, event.data.maxFfmpegEncoders);
                            metrics.recordingMetrics.maxConcurrentRecordingGuilds = Math.max(
                                metrics.recordingMetrics.maxConcurrentRecordingGuilds,
                                event.data.maxConcurrentRecordingGuilds,
                            );
                        }
                    }
                }
            } catch (error) {
                log.warn(`Capacity checkpoint illeggibile ${fileName}: ${(error as Error).message}`);
            }
        }
        metrics.capacitySamples?.sort((left, right) => left.timestamp - right.timestamp);
        metrics.runtimePhaseTransitions?.sort((left, right) => left.timestamp - right.timestamp);
    }

    async clearCapacityCheckpoints(sessionId: string): Promise<void> {
        await this.flushCapacityCheckpoints(sessionId);
        if (!fs.existsSync(capacityMetricsDir)) return;
        const prefix = `${this.checkpointPrefix(sessionId)}--`;
        for (const fileName of fs.readdirSync(capacityMetricsDir)) {
            if (!fileName.startsWith(prefix) || !fileName.endsWith('.jsonl')) continue;
            try {
                const filePath = path.join(capacityMetricsDir, fileName);
                await fs.promises.unlink(filePath);
                this.checkpointWrites.delete(filePath);
            } catch (error) {
                log.warn(`Impossibile eliminare il checkpoint ${fileName}: ${(error as Error).message}`);
            }
        }
    }

    private readSystemCpuPercent(sessionId: string): number {
        const current = this.readSystemCpuTicks();
        const previous = this.systemCpuTicks.get(sessionId) ?? current;
        this.systemCpuTicks.set(sessionId, current);
        const totalDelta = current.total - previous.total;
        const idleDelta = current.idle - previous.idle;
        return totalDelta > 0
            ? Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2))
            : 0;
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

    private updateDiskSpace(sessionId?: string) {
        const diskData = checkDiskSpace();
        const session = this.session(sessionId);
        if (diskData && session) {
            session.diskUsage = diskData;
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

    logRecordingStarted(
        sessionId: string,
        humanParticipants: number,
        concurrentRecordingGuilds: number,
    ): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.recordingMetrics = {
            startedAt: Date.now(),
            humanParticipants,
            maxFfmpegEncoders: 0,
            maxConcurrentRecordingGuilds: concurrentRecordingGuilds,
        };
        this.appendCapacityCheckpoint(sessionId, { type: 'recording', data: session.recordingMetrics });
        this.setRuntimePhase(sessionId, 'recording');
        this.logConcurrentRecordingGuilds(concurrentRecordingGuilds);
    }

    logConcurrentRecordingGuilds(count: number): void {
        this.currentRecordingGuilds = Math.max(0, count);
        for (const session of this.sessions.values()) {
            const recording = session.recordingMetrics;
            if (!recording || recording.endedAt) continue;
            const previousMax = recording.maxConcurrentRecordingGuilds;
            recording.maxConcurrentRecordingGuilds = Math.max(recording.maxConcurrentRecordingGuilds, count);
            if (recording.maxConcurrentRecordingGuilds !== previousMax) {
                this.appendCapacityCheckpoint(session.sessionId, { type: 'recording', data: recording });
            }
        }
    }

    logActiveFfmpegEncoders(sessionId: string, count: number): void {
        this.activeFfmpegEncoders.set(sessionId, count);
        const recording = this.sessions.get(sessionId)?.recordingMetrics;
        if (recording) {
            const previousMax = recording.maxFfmpegEncoders;
            recording.maxFfmpegEncoders = Math.max(recording.maxFfmpegEncoders, count);
            if (recording.maxFfmpegEncoders !== previousMax) {
                this.appendCapacityCheckpoint(sessionId, { type: 'recording', data: recording });
            }
        }
    }

    logRecordingEnded(sessionId: string): void {
        const recording = this.sessions.get(sessionId)?.recordingMetrics;
        if (recording && !recording.endedAt) recording.endedAt = Date.now();
        if (recording) this.appendCapacityCheckpoint(sessionId, { type: 'recording', data: recording });
        this.activeFfmpegEncoders.set(sessionId, 0);
        this.currentRecordingGuilds = Math.max(0, this.currentRecordingGuilds - 1);
        this.setRuntimePhase(sessionId, 'queued');
    }

    setRuntimePhase(sessionId: string, phase: RuntimePhase): void {
        if (!this.sessions.has(sessionId) || this.runtimePhases.get(sessionId) === phase) return;
        this.runtimePhases.set(sessionId, phase);
        const transitions = this.sessions.get(sessionId)!.runtimePhaseTransitions ??= [];
        const transition = { timestamp: Date.now(), role: getProcessRole(), phase };
        transitions.push(transition);
        this.appendCapacityCheckpoint(sessionId, { type: 'transition', data: transition });
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

    logAIRequest(provider: MonitorProvider, latencyMs: number, tokensGenerated: number, failed: boolean = false) {
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
        provider: MonitorProvider,
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
                byProvider: { openai: 0, gemini: 0, ollama: 0, 'ollama-cloud': 0, anthropic: 0 }
            };
        }

        const isBilledProvider = provider === 'openai' || provider === 'gemini' || provider === 'anthropic';
        const pricing = isBilledProvider ? resolvePricing(model) : null;
        const cost = isBilledProvider ? calculateCost(model, inputTokens, outputTokens, cachedInputTokens) : 0;

        this.currentSession.costMetrics.breakdown.push({
            phase,
            provider,
            model,
            inputTokens,
            outputTokens,
            cachedInputTokens,
            costUSD: cost,
            inputPricePerMillion: pricing?.input,
            outputPricePerMillion: pricing?.output,
            cachedInputPricePerMillion: pricing?.cachedInput,
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

    logFileUpload(originalSizeMB: number, uploadedSizeMB: number, success: boolean, sessionId?: string) {
        const session = this.session(sessionId);
        if (!session) return;

        if (!session.storageMetrics) {
            session.storageMetrics = {
                localFilesCreated: 0,
                localFilesDeleted: 0,
                totalUploadedMB: 0,
                uploadSuccessRate: 100,
                avgCompressionRatio: 1
            };
        }

        session.storageMetrics.localFilesCreated++;

        if (success) {
            session.storageMetrics.totalUploadedMB += uploadedSizeMB;

            if (originalSizeMB > uploadedSizeMB && uploadedSizeMB > 0) {
                const ratio = originalSizeMB / uploadedSizeMB;
                const total = session.storageMetrics.localFilesCreated;
                const prevAvg = session.storageMetrics.avgCompressionRatio;
                session.storageMetrics.avgCompressionRatio =
                    (prevAvg * (total - 1) + ratio) / total;
            }
        } else {
            const total = session.storageMetrics.localFilesCreated;
            const successCount = Math.round(session.storageMetrics.uploadSuccessRate * (total - 1) / 100);
            session.storageMetrics.uploadSuccessRate = (successCount / total) * 100;
        }
    }

    logFileDeleted() {
        if (this.currentSession && this.currentSession.storageMetrics) {
            this.currentSession.storageMetrics.localFilesDeleted++;
        }
    }

    snapshotSession(sessionId: string): SessionMetrics | null {
        const metrics = this.sessions.get(sessionId);
        return metrics ? JSON.parse(JSON.stringify(metrics)) : null;
    }

    discardSession(sessionId: string): void {
        const interval = this.intervals.get(sessionId);
        if (interval) clearInterval(interval);
        this.intervals.delete(sessionId);
        this.lastSampleAt.delete(sessionId);
        this.sampleCounts.delete(sessionId);
        this.systemCpuTicks.delete(sessionId);
        this.runtimePhases.delete(sessionId);
        this.activeFfmpegEncoders.delete(sessionId);
        this.sessions.delete(sessionId);
        if (this.defaultSessionId === sessionId) {
            const remaining = [...this.sessions.keys()];
            this.defaultSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        }
    }

    private mergeMetrics(target: SessionMetrics, source: SessionMetrics): void {
        target.startTime = Math.min(target.startTime, source.startTime);
        target.totalFiles += source.totalFiles;
        target.totalAudioDurationSec += source.totalAudioDurationSec;
        target.transcriptionTimeMs += source.transcriptionTimeMs;
        target.summarizationTimeMs += source.summarizationTimeMs;
        target.totalTokensUsed += source.totalTokensUsed;
        target.errors.push(...source.errors);
        target.resourceUsage.cpuSamples.push(...source.resourceUsage.cpuSamples);
        target.resourceUsage.ramSamplesMB.push(...source.resourceUsage.ramSamplesMB);
        if (source.resourceUsageByRole) {
            target.resourceUsageByRole ??= {};
            for (const [role, samples] of Object.entries(source.resourceUsageByRole)) {
                const targetSamples = target.resourceUsageByRole[role] ??= { cpuSamples: [], ramSamplesMB: [] };
                targetSamples.cpuSamples.push(...samples.cpuSamples);
                targetSamples.ramSamplesMB.push(...samples.ramSamplesMB);
            }
        }
        if (source.capacitySamples) {
            target.capacitySamples ??= [];
            const existingSamples = new Set(target.capacitySamples.map(sample => `${sample.role}:${sample.timestamp}`));
            for (const sample of source.capacitySamples) {
                const key = `${sample.role}:${sample.timestamp}`;
                if (!existingSamples.has(key)) {
                    target.capacitySamples.push(sample);
                    existingSamples.add(key);
                }
            }
            target.capacitySamples.sort((left, right) => left.timestamp - right.timestamp);
        }
        if (source.runtimePhaseTransitions) {
            target.runtimePhaseTransitions ??= [];
            const existingTransitions = new Set(target.runtimePhaseTransitions
                .map(transition => `${transition.role}:${transition.timestamp}:${transition.phase}`));
            for (const transition of source.runtimePhaseTransitions) {
                const key = `${transition.role}:${transition.timestamp}:${transition.phase}`;
                if (!existingTransitions.has(key)) {
                    target.runtimePhaseTransitions.push(transition);
                    existingTransitions.add(key);
                }
            }
            target.runtimePhaseTransitions.sort((left, right) => left.timestamp - right.timestamp);
        }
        if (source.runtimeContexts) {
            target.runtimeContexts = { ...(target.runtimeContexts ?? {}), ...source.runtimeContexts };
        }
        if (source.recordingMetrics) {
            if (!target.recordingMetrics) target.recordingMetrics = { ...source.recordingMetrics };
            else {
                target.recordingMetrics.startedAt = Math.min(target.recordingMetrics.startedAt, source.recordingMetrics.startedAt);
                target.recordingMetrics.endedAt = Math.max(target.recordingMetrics.endedAt ?? 0, source.recordingMetrics.endedAt ?? 0) || undefined;
                target.recordingMetrics.humanParticipants = Math.max(target.recordingMetrics.humanParticipants, source.recordingMetrics.humanParticipants);
                target.recordingMetrics.maxFfmpegEncoders = Math.max(target.recordingMetrics.maxFfmpegEncoders, source.recordingMetrics.maxFfmpegEncoders);
                target.recordingMetrics.maxConcurrentRecordingGuilds = Math.max(
                    target.recordingMetrics.maxConcurrentRecordingGuilds,
                    source.recordingMetrics.maxConcurrentRecordingGuilds,
                );
            }
        }

        if (source.systemHealth) {
            target.systemHealth = target.systemHealth ? {
                minFreeRamMB: Math.min(target.systemHealth.minFreeRamMB, source.systemHealth.minFreeRamMB),
                maxCpuLoad: Math.max(target.systemHealth.maxCpuLoad, source.systemHealth.maxCpuLoad),
                maxEventLoopLagMs: Math.max(
                    target.systemHealth.maxEventLoopLagMs ?? 0,
                    source.systemHealth.maxEventLoopLagMs ?? 0,
                ),
            } : { ...source.systemHealth };
        }
        if (source.whisperMetrics) target.whisperMetrics = { ...source.whisperMetrics };
        if (source.queueMetrics) {
            if (!target.queueMetrics) target.queueMetrics = { ...source.queueMetrics };
            else {
                const oldCount = target.queueMetrics.totalJobsProcessed;
                const newCount = source.queueMetrics.totalJobsProcessed;
                const total = oldCount + newCount;
                target.queueMetrics.avgWaitTimeMs = total > 0
                    ? (target.queueMetrics.avgWaitTimeMs * oldCount + source.queueMetrics.avgWaitTimeMs * newCount) / total
                    : 0;
                target.queueMetrics.totalJobsProcessed = total;
                target.queueMetrics.totalJobsFailed += source.queueMetrics.totalJobsFailed;
                target.queueMetrics.maxWaitTimeMs = Math.max(target.queueMetrics.maxWaitTimeMs, source.queueMetrics.maxWaitTimeMs);
                target.queueMetrics.retriedJobs += source.queueMetrics.retriedJobs;
            }
        }
        if (source.costMetrics) {
            if (!target.costMetrics) target.costMetrics = JSON.parse(JSON.stringify(source.costMetrics));
            else {
                target.costMetrics.totalCostUSD += source.costMetrics.totalCostUSD;
                target.costMetrics.breakdown.push(...source.costMetrics.breakdown);
                for (const provider of Object.keys(target.costMetrics.byProvider) as MonitorProvider[]) {
                    target.costMetrics.byProvider[provider] += source.costMetrics.byProvider[provider];
                }
            }
        }
        if (source.storageMetrics) {
            if (!target.storageMetrics) target.storageMetrics = { ...source.storageMetrics };
            else {
                target.storageMetrics.localFilesCreated += source.storageMetrics.localFilesCreated;
                target.storageMetrics.localFilesDeleted += source.storageMetrics.localFilesDeleted;
                target.storageMetrics.totalUploadedMB += source.storageMetrics.totalUploadedMB;
                target.storageMetrics.uploadSuccessRate = Math.min(target.storageMetrics.uploadSuccessRate, source.storageMetrics.uploadSuccessRate);
            }
        }
    }

    async endSession(sessionId?: string): Promise<SessionMetrics | null> {
        const resolvedSessionId = sessionId ?? currentAiScope()?.sessionId ?? this.defaultSessionId;
        if (!resolvedSessionId) return null;
        this.defaultSessionId = resolvedSessionId;
        await this.flushCapacityCheckpoints(resolvedSessionId);
        const resolvedMetrics = this.sessions.get(resolvedSessionId);
        if (resolvedMetrics) this.hydrateCapacityCheckpoints(resolvedSessionId, resolvedMetrics);
        const interval = this.intervals.get(resolvedSessionId);
        if (interval) clearInterval(interval);

        if (resolvedMetrics) {
            resolvedMetrics.endTime = Date.now();
            try {
                if (fs.existsSync(dbPath)) {
                    resolvedMetrics.dbEndSizeBytes = fs.statSync(dbPath).size;
                }
            } catch (e) {
                console.error("[Monitor] Errore lettura dimensione finale DB:", e);
            }

            const samples = resolvedMetrics.resourceUsage.cpuSamples;
            if (samples.length > 120) {
                const firstHour = samples.slice(0, Math.min(720, samples.length / 2));
                const lastHour = samples.slice(-Math.min(720, samples.length / 2));

                const firstAvg = firstHour.reduce((a, b) => a + b, 0) / firstHour.length;
                const lastAvg = lastHour.reduce((a, b) => a + b, 0) / lastHour.length;

                const degradation = firstAvg > 0 ? ((firstAvg - lastAvg) / firstAvg) * 100 : 0;

                const sessionIsActive = resolvedMetrics.totalFiles > 0;
                const significantDrop = degradation > 20;
                const avgCpuWasHigh = firstAvg > 30;

                resolvedMetrics.performanceTrend = {
                    firstHourAvgCpu: Math.round(firstAvg),
                    lastHourAvgCpu: Math.round(lastAvg),
                    cpuDegradation: Math.round(degradation),
                    thermalThrottlingDetected: sessionIsActive && significantDrop && avgCpuWasHigh
                };
            }
        }
        const metrics = resolvedMetrics ?? null;

        // Flush AI cost and audio minutes to usage_tracking
        if (metrics) {
            try {
                // A single rate for the whole session: email, monthly aggregate and
                // granular rows must agree exactly. If the ECB rate/cache is
                // unavailable, EUR stays NULL and USD keeps being stored.
                if (metrics.costMetrics) {
                    const unavailableRate: UsdEurRate = {
                        source: 'UNAVAILABLE',
                        usdPerEur: null,
                        rateDate: null,
                        fetchedAt: null,
                    };
                    const exchangeRate = metrics.costMetrics.totalCostUSD > 0
                        ? await getUsdEurRate()
                        : unavailableRate;
                    attachEuroCosts(metrics.costMetrics, exchangeRate);
                }

                const guildId = getSessionGuildId(metrics.sessionId);
                if (guildId) {
                    // AI cost
                    const totalCost = metrics.costMetrics?.totalCostUSD ?? 0;
                    if (totalCost > 0) {
                        const totalCostEur = metrics.costMetrics?.totalCostEUR ?? null;
                        tenantRepository.addAiCost(guildId, totalCost, totalCostEur);
                        log.info(
                            `Usage tracking: +$${totalCost.toFixed(4)} / ` +
                            `${totalCostEur === null ? 'EUR unavailable' : `€${totalCostEur.toFixed(4)}`}`,
                            { guildId },
                        );
                    }

                    // Audio minutes
                    const audioMinutes = metrics.totalAudioDurationSec / 60;
                    if (audioMinutes > 0) {
                        tenantRepository.addAudioMinutes(guildId, audioMinutes);
                        log.info(`Usage tracking: +${audioMinutes.toFixed(1)} min audio`, { guildId });
                    }

                    // Storage bytes (uploaded)
                    const uploadedBytes = (metrics.storageMetrics?.totalUploadedMB ?? 0) * 1024 * 1024;
                    if (uploadedBytes > 0) {
                        tenantRepository.addStorageBytes(guildId, Math.round(uploadedBytes));
                    }
                }

                // Granular per-phase/model log (ai_usage_log): survives even when
                // guildId cannot be resolved (guild_id stays NULL on the row).
                const breakdown = metrics.costMetrics?.breakdown;
                if (breakdown && breakdown.length > 0) {
                    const campaignId = getSessionCampaignId(metrics.sessionId) ?? null;
                    aiUsageRepository.logSessionUsage(
                        metrics.sessionId,
                        guildId ?? null,
                        campaignId,
                        breakdown.map(b => ({
                            phase: b.phase,
                            provider: b.provider,
                            model: b.model,
                            inputTokens: b.inputTokens,
                            outputTokens: b.outputTokens,
                            cachedInputTokens: b.cachedInputTokens,
                            inputPricePerMillion: b.inputPricePerMillion,
                            outputPricePerMillion: b.outputPricePerMillion,
                            cachedInputPricePerMillion: b.cachedInputPricePerMillion,
                            costUSD: b.costUSD,
                            costEUR: b.costEUR,
                            usdPerEur: b.usdPerEur,
                            exchangeRateSource: b.exchangeRateSource,
                            exchangeRateDate: b.exchangeRateDate,
                            exchangeRateFetchedAt: b.exchangeRateFetchedAt,
                        }))
                    );
                }
            } catch (e) {
                log.error('Errore aggiornamento usage tracking', e as Error);
            }
        }

        this.discardSession(resolvedSessionId);
        return metrics;
    }

    isSessionActive(sessionId?: string): boolean {
        return sessionId ? this.sessions.has(sessionId) : this.sessions.size > 0;
    }
}
