import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AudioService } from '../audio/audio.service';
import { LoggerService } from '../logger/logger.service';
import { QueueService } from '../queue/queue.service';
import { MonitorService } from '../monitor/monitor.service';
import { v4 as uuidv4 } from 'uuid';
import { VoiceBasedChannel } from 'discord.js';

@Injectable()
export class SessionService {
  private activeSessions = new Map<string, string>(); // GuildID -> SessionID
  private sessionChannels = new Map<string, string>(); // SessionID -> ChannelID (Text)

  constructor(
    private readonly dbService: DatabaseService,
    private readonly audioService: AudioService,
    private readonly logger: LoggerService,
    private readonly queueService: QueueService,
    private readonly monitorService: MonitorService
  ) {}

  getActiveSession(guildId: string): string | undefined {
    return this.activeSessions.get(guildId);
  }

  async startSession(guildId: string, voiceChannel: VoiceBasedChannel, textChannelId: string, campaignId: string, location?: { macro?: string, micro?: string }): Promise<string> {
    if (this.activeSessions.has(guildId)) {
      throw new Error('Una sessione è già attiva in questo server.');
    }

    const sessionId = uuidv4();
    const now = Date.now();

    this.dbService.getDb().prepare(
      'INSERT INTO sessions (session_id, guild_id, campaign_id, start_time) VALUES (?, ?, ?, ?)'
    ).run(sessionId, guildId, campaignId, now);

    if (location) {
      this.updateLocation(guildId, sessionId, location.macro || null, location.micro || null);
    }

    await this.audioService.connectToChannel(voiceChannel, sessionId);

    this.activeSessions.set(guildId, sessionId);
    this.sessionChannels.set(sessionId, textChannelId);
    
    // Avvia monitoraggio
    this.monitorService.startSession(sessionId);
    
    this.logger.log(`Sessione avviata: ${sessionId} (Guild: ${guildId})`);

    return sessionId;
  }

  async stopSession(guildId: string): Promise<string | null> {
    const sessionId = this.activeSessions.get(guildId);
    if (!sessionId) return null;

    this.logger.log(`Arresto sessione ${sessionId}...`);

    await this.audioService.disconnect(guildId);

    this.dbService.getDb().prepare(
      'UPDATE sessions SET end_time = ? WHERE session_id = ?'
    ).run(Date.now(), sessionId);

    const channelId = this.sessionChannels.get(sessionId);

    if (channelId) {
        await this.queueService.addSummaryJob(
            { sessionId, channelId, guildId },
            { 
                jobId: `summary-${sessionId}`,
                attempts: 10, 
                backoff: { type: 'fixed', delay: 10000 }
            }
        );
        this.logger.log(`Job di riassunto accodato per ${sessionId}`);
    }

    this.activeSessions.delete(guildId);
    this.sessionChannels.delete(sessionId);
    
    // Termina monitoraggio
    this.monitorService.endSession();

    return sessionId;
  }

  pauseSession(guildId: string): boolean {
    if (!this.activeSessions.has(guildId)) return false;
    this.audioService.pauseRecording(guildId);
    return true;
  }

  resumeSession(guildId: string): boolean {
    if (!this.activeSessions.has(guildId)) return false;
    this.audioService.resumeRecording(guildId);
    return true;
  }

  addNote(sessionId: string, userId: string, note: string): void {
    this.dbService.getDb().prepare(
      'INSERT INTO session_notes (session_id, user_id, note, timestamp) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, note, Date.now());
    this.logger.log(`Nota aggiunta alla sessione ${sessionId} da ${userId}`);
  }

  updateLocation(guildId: string, sessionId: string | null, macro: string | null, micro: string | null): void {
    const now = Date.now();
    const dateStr = new Date().toLocaleDateString('it-IT');

    this.dbService.getDb().prepare(
      'INSERT INTO location_history (guild_id, session_id, macro_location, micro_location, timestamp, session_date) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(guildId, sessionId, macro, micro, now, dateStr);

    this.logger.log(`Posizione aggiornata: ${macro} | ${micro}`);
  }

  getLocation(guildId: string): { macro: string, micro: string } | undefined {
    return this.dbService.getDb().prepare(
      'SELECT macro_location as macro, micro_location as micro FROM location_history WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(guildId) as { macro: string, micro: string } | undefined;
  }
}
