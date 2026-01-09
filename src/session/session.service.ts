import { Injectable } from '@nestjs/common';
import { SessionRepository } from './session.repository';
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
    private readonly sessionRepo: SessionRepository,
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

    this.sessionRepo.create(sessionId, guildId, campaignId, now);

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

    this.sessionRepo.updateEndTime(sessionId, Date.now());

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
    this.sessionRepo.addNote(sessionId, userId, note);
    this.logger.log(`Nota aggiunta alla sessione ${sessionId} da ${userId}`);
  }

  updateLocation(guildId: string, sessionId: string | null, macro: string | null, micro: string | null): void {
    this.sessionRepo.addLocationHistory(guildId, sessionId, macro, micro);
    this.logger.log(`Posizione aggiornata: ${macro} | ${micro}`);
  }

  getLocation(guildId: string): { macro: string, micro: string } | undefined {
    return this.sessionRepo.getLastLocation(guildId);
  }
}
