import pidusage from 'pidusage';
import * as os from 'os';

export interface SessionMetrics {
    sessionId: string;
    startTime: number;
    endTime?: number;
    totalFiles: number;
    totalAudioDurationSec: number;
    transcriptionTimeMs: number;
    summarizationTimeMs: number;
    totalTokensUsed: number; // NUOVO CAMPO
    errors: string[];
    resourceUsage: {
        cpuSamples: number[];
        ramSamplesMB: number[];
    };
}

class SystemMonitor {
    private currentSession: SessionMetrics | null = null;
    private interval: NodeJS.Timeout | null = null;

    startSession(sessionId: string) {
        this.currentSession = {
            sessionId,
            startTime: Date.now(),
            totalFiles: 0,
            totalAudioDurationSec: 0,
            transcriptionTimeMs: 0,
            summarizationTimeMs: 0,
            totalTokensUsed: 0, // Inizializzazione
            errors: [],
            resourceUsage: { cpuSamples: [], ramSamplesMB: [] }
        };

        // Campiona risorse ogni 5 secondi
        this.interval = setInterval(() => this.sampleResources(), 5000);
        console.log(`[Monitor] 📊 Iniziato tracciamento sessione ${sessionId}`);
    }

    private async sampleResources() {
        if (!this.currentSession) return;
        try {
            const stats = await pidusage(process.pid);
            this.currentSession.resourceUsage.cpuSamples.push(Math.round(stats.cpu));
            this.currentSession.resourceUsage.ramSamplesMB.push(Math.round(stats.memory / 1024 / 1024));
        } catch (e) {
            console.error("Errore campionamento risorse:", e);
        }
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

    // NUOVO METODO
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

    endSession(): SessionMetrics | null {
        if (this.interval) clearInterval(this.interval);
        if (this.currentSession) {
            this.currentSession.endTime = Date.now();
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
