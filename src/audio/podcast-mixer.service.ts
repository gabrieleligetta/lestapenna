import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LoggerService } from '../logger/logger.service';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class PodcastMixerService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly logger: LoggerService
  ) {}

  async mixSession(sessionId: string): Promise<string | null> {
    this.logger.log(`[Mixer] 🎹 Inizio mixaggio podcast per sessione ${sessionId}...`);

    // 1. Recupera info sessione
    const session = this.dbService.getDb().prepare('SELECT start_time FROM sessions WHERE session_id = ?').get(sessionId) as { start_time: number };
    if (!session) throw new Error("Sessione non trovata");

    const sessionStart = session.start_time;

    // 2. Recupera tutti i file FULL della sessione
    // Nota: Assumiamo che i file FULL siano stati creati e salvati in 'recordings' table con timestamp corretto
    const recordings = this.dbService.getDb().prepare(
      'SELECT filepath, timestamp, user_id FROM recordings WHERE session_id = ? AND filename LIKE "FULL-%"'
    ).all(sessionId) as { filepath: string, timestamp: number, user_id: string }[];

    if (recordings.length === 0) {
      this.logger.warn(`[Mixer] Nessun file audio trovato per la sessione ${sessionId}.`);
      return null;
    }

    // 3. Costruisci comando FFmpeg
    // Inputs
    const inputs = recordings.map(r => `-i "${r.filepath}"`).join(' ');
    
    // Filter Complex
    // [0]adelay=offset|offset[a]; [1]adelay=offset|offset[b]; ... [a][b]amix=inputs=N
    let filterComplex = "";
    let mixInputs = "";

    recordings.forEach((rec, index) => {
      // Calcola ritardo in millisecondi
      let delay = rec.timestamp - sessionStart;
      if (delay < 0) delay = 0; // Safety check

      // Etichetta output del filtro (a, b, c...)
      const label = String.fromCharCode(97 + index); // a, b, c...
      
      // Aggiungi filtro adelay (ritardo su entrambi i canali stereo)
      filterComplex += `[${index}]adelay=${delay}|${delay}[${label}];`;
      mixInputs += `[${label}]`;
    });

    // Aggiungi filtro amix finale
    filterComplex += `${mixInputs}amix=inputs=${recordings.length}:dropout_transition=2,loudnorm[out]`;

    const outputFilename = `PODCAST-${sessionId}.mp3`;
    const outputPath = path.join(process.cwd(), 'recordings', outputFilename);

    const command = `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[out]" -ac 2 -b:a 192k "${outputPath}"`;

    try {
      this.logger.log(`[Mixer] Esecuzione FFmpeg...`);
      // this.logger.debug(`CMD: ${command}`); // Decommentare per debug
      await execAsync(command);
      
      this.logger.log(`[Mixer] ✅ Podcast generato: ${outputPath}`);
      return outputPath;
    } catch (e: any) {
      this.logger.error(`[Mixer] ❌ Errore generazione podcast:`, e);
      throw e;
    }
  }
}
