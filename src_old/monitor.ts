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
