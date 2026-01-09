import { Injectable } from '@nestjs/common';
import { LoggerService } from '../logger/logger.service';
import { BackupService } from '../backup/backup.service';
import { SessionRepository } from '../session/session.repository';
import { RecordingRepository } from './recording.repository';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

@Injectable()
export class PodcastMixerService {
  private readonly RECORDINGS_DIR = path.join(process.cwd(), 'recordings');
  private readonly OUTPUT_DIR = path.join(process.cwd(), 'mixed_sessions');
  private readonly TEMP_DIR = path.join(process.cwd(), 'temp_mix');
  private readonly BATCH_SIZE = 10;
  private readonly MASTER_BITRATE = '192k';

  constructor(
    private readonly logger: LoggerService,
    private readonly backupService: BackupService,
    private readonly sessionRepo: SessionRepository,
    private readonly recordingRepo: RecordingRepository
  ) {
    this.ensureDirectories();
  }

  private ensureDirectories() {
    if (!fs.existsSync(this.OUTPUT_DIR)) fs.mkdirSync(this.OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(this.TEMP_DIR)) fs.mkdirSync(this.TEMP_DIR, { recursive: true });
  }

  async mixSession(sessionId: string): Promise<string | null> {
    this.logger.log(`[Mixer] 🧱 Inizio mixaggio sessione ${sessionId} (Modalità Float 32-bit)...`);

    // 1. Recupera dati sessione e registrazioni dal DB
    const session = this.sessionRepo.findById(sessionId);
    if (!session || !session.start_time) {
      this.logger.error(`[Mixer] Sessione ${sessionId} non trovata o senza start_time.`);
      return null;
    }
    const sessionStart = session.start_time;

    const recordings = this.recordingRepo.findBySession(sessionId);

    if (!recordings.length) {
      this.logger.warn(`[Mixer] Nessuna registrazione trovata per la sessione ${sessionId}.`);
      return null;
    }

    // 2. Download e Preparazione
    this.logger.log(`[Mixer] 📥 Verifica di ${recordings.length} tracce audio...`);
    const validFiles: { path: string, delay: number }[] = [];

    for (const rec of recordings) {
      const filePath = path.join(this.RECORDINGS_DIR, rec.filename);

      // Verifica esistenza, altrimenti scarica dal cloud
      if (!fs.existsSync(filePath)) {
        this.logger.log(`[Mixer] ☁️ Scaricamento ${rec.filename} da Oracle...`);
        const success = await this.backupService.downloadFromOracle(rec.filename, filePath, sessionId);
        if (!success) {
          this.logger.warn(`[Mixer] ⚠️ File mancante impossibile da recuperare: ${rec.filename}`);
          continue;
        }
      }

      validFiles.push({
        path: filePath,
        delay: Math.max(0, rec.timestamp - sessionStart)
      });
    }

    if (validFiles.length === 0) {
      this.logger.error("[Mixer] Nessun file valido disponibile per il mix.");
      return null;
    }

    // File "Accumulatore" temporaneo (WAV 32-bit Float)
    let accumulatorPath = path.join(this.TEMP_DIR, `acc_${sessionId}.wav`);
    const stepOutputPath = path.join(this.TEMP_DIR, `step_${sessionId}.wav`);

    // Pulizia preventiva
    if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);

    // 3. Loop a Blocchi (The Accumulator Loop)
    let processedCount = 0;
    validFiles.sort((a, b) => a.delay - b.delay);

    while (processedCount < validFiles.length) {
      const batch = validFiles.slice(processedCount, processedCount + this.BATCH_SIZE);
      const isFirstBatch = processedCount === 0;

      this.logger.log(`[Mixer] 🔄 Mixing blocco ${Math.ceil((processedCount + 1) / this.BATCH_SIZE)}: ${batch.length} file...`);

      try {
        await this.processBatch(batch, accumulatorPath, stepOutputPath, isFirstBatch);
      } catch (e) {
        this.logger.error(`[Mixer] Errore durante il batch processing:`, e);
        throw e;
      }

      // Scambio file: l'output diventa il nuovo input (accumulatore)
      if (!isFirstBatch) {
        fs.renameSync(stepOutputPath, accumulatorPath);
      }

      processedCount += batch.length;
      if (global.gc) global.gc();
    }

    // 4. Mastering Finale (Normalizzazione + Encoding MP3)
    this.logger.log(`[Mixer] 🎛️  Mastering finale (Loudness EBU R128)...`);
    const finalMp3Path = path.join(this.OUTPUT_DIR, `MASTER-${sessionId}.mp3`);

    try {
      await this.convertToMp3(accumulatorPath, finalMp3Path);
    } catch (e) {
      this.logger.error(`[Mixer] Errore durante il mastering finale:`, e);
      throw e;
    }

    // 5. Cleanup
    try {
      if (fs.existsSync(accumulatorPath)) fs.unlinkSync(accumulatorPath);
      if (fs.existsSync(stepOutputPath)) fs.unlinkSync(stepOutputPath);
    } catch (e) {
      this.logger.warn("[Mixer] Warning cleanup:", e);
    }

    this.logger.log(`[Mixer] ✅ Master creato con successo: ${finalMp3Path}`);
    return finalMp3Path;
  }

  private processBatch(
    files: { path: string, delay: number }[],
    accumulatorPath: string,
    outputPath: string,
    isFirstBatch: boolean
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = [];
      let filterComplex = "";

      // Input 0: Accumulatore (se esiste)
      if (!isFirstBatch) {
        args.push('-i', accumulatorPath);
      }

      // Input successivi: File del batch
      files.forEach((f) => {
        args.push('-i', f.path);
      });

      // Costruzione Filter Complex
      const outputTags: string[] = [];
      let inputIndex = 0;

      // Gestione Accumulatore nel filtro
      if (!isFirstBatch) {
        outputTags.push('[0]');
        inputIndex++;
      }

      // Gestione Nuovi File
      files.forEach((f, idx) => {
        const currentIdx = inputIndex + idx;
        const tag = `s${idx}`;
        const safeDelay = Math.max(0, Math.floor(f.delay));
        filterComplex += `[${currentIdx}]adelay=${safeDelay}|${safeDelay}[${tag}];`;
        outputTags.push(`[${tag}]`);
      });

      const totalInputs = outputTags.length;

      if (totalInputs === 1) {
        filterComplex += `${outputTags[0]}aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[out]`;
      } else {
        filterComplex += `${outputTags.join('')}amix=inputs=${totalInputs}:dropout_transition=0:normalize=0,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo[out]`;
      }

      const destination = isFirstBatch ? accumulatorPath : outputPath;

      const ffmpegArgs = [
        ...args,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-c:a', 'pcm_f32le',
        '-ar', '48000',
        destination,
        '-y'
      ];

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);

      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg batch mix failed with code ${code}`));
      });

      ffmpeg.on('error', (err) => reject(err));
    });
  }

  private convertToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,
        '-filter:a', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-c:a', 'libmp3lame',
        '-b:a', this.MASTER_BITRATE,
        '-ar', '48000',
        outputPath,
        '-y'
      ]);

      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Final MP3 conversion failed with code ${code}`));
      });

      ffmpeg.on('error', reject);
    });
  }
}
