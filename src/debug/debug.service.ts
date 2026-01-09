import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { QueueService } from '../queue/queue.service';
import { LoggerService } from '../logger/logger.service';
import { CampaignService } from '../campaign/campaign.service';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class DebugService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly queueService: QueueService,
    private readonly logger: LoggerService,
    private readonly campaignService: CampaignService
  ) {}

  async ensureTestEnvironment(guildId: string, userId: string): Promise<string> {
    // Cerca campagna di test
    let campaign = this.dbService.getDb().prepare('SELECT * FROM campaigns WHERE guild_id = ? AND name = ?').get(guildId, 'TEST-CAMPAIGN') as any;

    if (!campaign) {
      this.logger.log(`[Debug] Creazione campagna di test per Guild ${guildId}`);
      campaign = this.campaignService.create(guildId, 'TEST-CAMPAIGN');
    }

    // Assicura che sia attiva
    this.campaignService.setActive(guildId, campaign.id);

    // Assicura che l'utente abbia un PG
    const char = this.dbService.getDb().prepare('SELECT * FROM characters WHERE user_id = ? AND campaign_id = ?').get(userId, campaign.id);
    if (!char) {
      this.dbService.getDb().prepare(
        'INSERT INTO characters (user_id, campaign_id, character_name, class, race) VALUES (?, ?, ?, ?, ?)'
      ).run(userId, campaign.id, 'TestSubject', 'Commoner', 'Human');
    }

    return campaign.id;
  }

  async startTestStream(guildId: string, userId: string, url: string, channelId: string) {
    const campaignId = await this.ensureTestEnvironment(guildId, userId);
    const sessionId = `test-direct-${uuidv4().substring(0, 8)}`;

    // Crea sessione
    this.dbService.getDb().prepare(
      'INSERT INTO sessions (session_id, guild_id, campaign_id, start_time) VALUES (?, ?, ?, ?)'
    ).run(sessionId, guildId, campaignId, Date.now());

    const recordingsDir = path.join(process.cwd(), 'recordings');
    if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

    const tempFileName = `${userId}-${Date.now()}.mp3`;
    const tempFilePath = path.join(recordingsDir, tempFileName);

    this.logger.log(`[Debug] Avvio download test da: ${url}`);

    try {
      const isYouTube = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/.+$/.test(url);

      if (isYouTube) {
        const cookiesPath = path.resolve(process.cwd(), 'cookies.json');
        let cookieArg = '';
        if (fs.existsSync(cookiesPath)) {
            cookieArg = ` --cookies "${cookiesPath}"`;
        }

        const cmd = `yt-dlp -x --audio-format mp3 --output "${tempFilePath}"${cookieArg} "${url}"`;
        await execAsync(cmd);
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Errore HTTP: ${response.statusText}`);
        if (!response.body) throw new Error("Nessun contenuto ricevuto");
        // @ts-ignore
        await pipeline(response.body, fs.createWriteStream(tempFilePath));
      }

      // Aggiungi record recording
      this.dbService.getDb().prepare(
        'INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sessionId, tempFileName, tempFilePath, userId, Date.now(), 'PENDING');

      // Accoda job trascrizione
      await this.queueService.addAudioJob({
        sessionId,
        fileName: tempFileName,
        filePath: tempFilePath,
        userId
      }, { jobId: tempFileName, removeOnComplete: true });

      // Accoda job riassunto (con delay per dare tempo alla trascrizione)
      await this.queueService.addSummaryJob(
        { sessionId, channelId, guildId },
        { jobId: `summary-${sessionId}`, delay: 5000 }
      );

      return sessionId;

    } catch (error: any) {
      this.logger.error(`[Debug] Errore test stream:`, error);
      if (fs.existsSync(tempFilePath)) try { fs.unlinkSync(tempFilePath); } catch {}
      throw error;
    }
  }

  async cleanTestSessions(guildId: string): Promise<number> {
    const testSessions = this.dbService.getDb().prepare("SELECT session_id FROM sessions WHERE session_id LIKE 'test-%' AND guild_id = ?").all(guildId) as { session_id: string }[];

    let count = 0;
    for (const s of testSessions) {
      await this.queueService.removeSessionJobs(s.session_id);
      this.dbService.getDb().prepare("DELETE FROM recordings WHERE session_id = ?").run(s.session_id);
      this.dbService.getDb().prepare("DELETE FROM knowledge_fragments WHERE session_id = ?").run(s.session_id);
      this.dbService.getDb().prepare("DELETE FROM sessions WHERE session_id = ?").run(s.session_id);
      count++;
    }
    return count;
  }
}
