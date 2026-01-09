import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as pidusage from 'pidusage';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { LoggerService } from '../logger/logger.service';
import { ReporterService } from '../reporter/reporter.service';

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
}

@Injectable()
export class MonitorService implements OnModuleDestroy {
    private currentSession: SessionMetrics | null = null;
    private interval: NodeJS.Timeout | null = null;
    private readonly dbPath = path.resolve(process.cwd(), 'data', 'database.sqlite');

    constructor(
        private readonly logger: LoggerService,
        private readonly reporterService: ReporterService
    ) {}

    onModuleDestroy() {
        if (this.interval) clearInterval(this.interval);
    }

    startSession(sessionId: string) {
        let dbSize = 0;
        try {
            if (fs.existsSync(this.dbPath)) {
                dbSize = fs.statSync(this.dbPath).size;
            }
        } catch (e) {
            this.logger.error("[Monitor] Errore lettura dimensione DB:", e);
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
        this.checkDiskSpace();

        this.logger.log(`[Monitor] 📊 Iniziato tracciamento sessione ${sessionId}`);
    }

    private async sampleResources() {
        if (!this.currentSession) return;
        try {
            const stats = await pidusage(process.pid);
            this.currentSession.resourceUsage.cpuSamples.push(Math.round(stats.cpu));
            this.currentSession.resourceUsage.ramSamplesMB.push(Math.round(stats.memory / 1024 / 1024));
            
            if (this.currentSession.resourceUsage.cpuSamples.length % 12 === 0) {
                 this.checkDiskSpace();
            }
        } catch (e) {
            this.logger.error("Errore campionamento risorse:", e);
        }
    }

    private checkDiskSpace() {
        if (!this.currentSession) return;
        exec('df -k .', (error, stdout, stderr) => {
            if (error || !this.currentSession) return;
            try {
                const lines = stdout.trim().split('\n');
                if (lines.length < 2) return;
                const parts = lines[1].split(/\s+/);
                if (parts.length >= 5) {
                    const totalKB = parseInt(parts[1]);
                    const availableKB = parseInt(parts[3]);
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
                this.logger.error("[Monitor] Errore parsing df:", e);
            }
        });
    }

    logFileProcessed(durationSec: number, processingTimeMs: number) {
        if (this.currentSession) {
            this.currentSession.totalFiles++;
            this.currentSession.totalAudioDurationSec += durationSec;
            this.currentSession.transcriptionTimeMs += processingTimeMs;
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

    async endSession() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        
        if (this.currentSession) {
            this.currentSession.endTime = Date.now();
            try {
                if (fs.existsSync(this.dbPath)) {
                    this.currentSession.dbEndSizeBytes = fs.statSync(this.dbPath).size;
                }
            } catch (e) {
                this.logger.error("[Monitor] Errore lettura dimensione finale DB:", e);
            }
            
            // Invia Report Tecnico
            await this.reporterService.sendTechnicalReport(this.currentSession);
        }
        this.currentSession = null;
    }

    isSessionActive(): boolean {
        return this.currentSession !== null;
    }
}
