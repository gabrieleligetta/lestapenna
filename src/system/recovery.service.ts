import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggerService } from '../logger/logger.service';
import { QueueService } from '../queue/queue.service';
import { BackupService } from '../backup/backup.service';
import { RecordingRepository } from '../audio/recording.repository';
import { SessionRepository } from '../session/session.repository';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class RecoveryService implements OnModuleInit {
    private readonly RECORDINGS_DIR = path.join(process.cwd(), 'recordings');

    constructor(
        private readonly logger: LoggerService,
        private readonly queueService: QueueService,
        private readonly backupService: BackupService,
        private readonly recordingRepo: RecordingRepository,
        private readonly sessionRepo: SessionRepository
    ) {}

    async onModuleInit() {
        // Eseguiamo il controllo all'avvio, ma con un leggero ritardo per non bloccare il boot
        setTimeout(() => {
            this.recoverOrphanedFiles();
            this.checkUnprocessedJobs();
        }, 5000);
    }

    async recoverOrphanedFiles() {
        if (!fs.existsSync(this.RECORDINGS_DIR)) return;

        const files = fs.readdirSync(this.RECORDINGS_DIR);
        const mp3Files = files.filter(f => f.endsWith('.mp3') && !f.startsWith('MASTER-') && !f.startsWith('FULL-') && !f.startsWith('PODCAST-'));

        if (mp3Files.length === 0) return;

        this.logger.log(`[Recovery] 🔍 Scansione file orfani in corso (${mp3Files.length} file trovati)...`);
        let recoveredCount = 0;

        for (const file of mp3Files) {
            const filePath = path.join(this.RECORDINGS_DIR, file);
            
            // Regex per estrarre userId e timestamp: userId-timestamp.mp3
            const match = file.match(/^(.+)-(\d+)\.mp3$/);
            if (!match) continue;

            const userId = match[1];
            const timestamp = parseInt(match[2]);

            // Se esiste già nel DB, saltiamo
            const existing = this.recordingRepo.findByFilename(file);
            if (existing) continue;

            // Ignoriamo file troppo recenti (potrebbero essere in corso di scrittura)
            if (Date.now() - timestamp < 300000) continue;

            this.logger.warn(`[Recovery] 🩹 Trovato file orfano: ${file}. Tento recupero...`);

            // Cerchiamo una sessione compatibile temporalmente
            let sessionId = `recovered-${uuidv4().substring(0, 8)}`;
            
            const foundSession = this.sessionRepo.findByTimestamp(timestamp);
            if (foundSession) {
                sessionId = foundSession.session_id;
                this.logger.log(`[Recovery] 🔗 File orfano associato alla sessione esistente: ${sessionId}`);
            } else {
                this.logger.warn(`[Recovery] ⚠️ Nessuna sessione trovata per il timestamp ${timestamp}. Il file verrà caricato su Oracle ma non associato al DB.`);
            }

            // Tentativo di upload su Oracle per sicurezza
            try {
                await this.backupService.uploadToOracle(filePath, file, sessionId);
                
                // Se abbiamo trovato una sessione valida, proviamo a reinserire il record nel DB
                if (foundSession) {
                     // Recuperiamo location e anno dalla sessione se possibile, o usiamo default
                     // Nota: recordingRepo.create richiede parametri che potremmo non avere precisi
                     // Per ora ci limitiamo al backup cloud per non corrompere il DB con dati parziali
                     this.logger.log(`[Recovery] ✅ File ${file} salvato su Cloud nella cartella ${sessionId}`);
                }
            } catch (e) {
                this.logger.error(`[Recovery] Errore gestione orfano ${file}:`, e);
            }

            recoveredCount++;
        }

        if (recoveredCount > 0) {
            this.logger.log(`[Recovery] ✅ Scansione terminata. Gestiti ${recoveredCount} file.`);
        }
    }

    async checkUnprocessedJobs() {
        this.logger.log("[Recovery] 🔍 Controllo lavori interrotti nel database...");
        const orphanJobs = this.recordingRepo.getUnprocessed();

        if (orphanJobs.length > 0) {
            const sessionIds = [...new Set(orphanJobs.map(job => job.session_id))];
            this.logger.log(`[Recovery] 📦 Trovati ${orphanJobs.length} file non processati in ${sessionIds.length} sessioni.`);

            for (const sessionId of sessionIds) {
                this.logger.log(`[Recovery] 🔄 Ripristino automatico sessione ${sessionId}...`);
                
                // Rimuoviamo vecchi job dalla coda per evitare duplicati
                await this.queueService.removeSessionJobs(sessionId);
                
                // Resettiamo lo stato nel DB e otteniamo la lista da riprocessare
                const filesToProcess = this.recordingRepo.resetUnfinished(sessionId);

                for (const job of filesToProcess) {
                    await this.queueService.addAudioJob({
                        sessionId: job.session_id,
                        fileName: job.filename,
                        filePath: job.filepath,
                        userId: job.user_id
                    }, {
                        jobId: `${job.filename}-recovery-${Date.now()}`,
                        attempts: 5,
                        backoff: { type: 'exponential', delay: 2000 },
                        removeOnComplete: true
                    });
                }
                this.logger.log(`[Recovery] ✅ Sessione ${sessionId}: ${filesToProcess.length} file riaccodati.`);
            }
        } else {
            this.logger.log("[Recovery] ✨ Nessun lavoro in sospeso trovato.");
        }
    }
}
