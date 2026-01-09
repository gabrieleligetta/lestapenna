import { Injectable } from '@nestjs/common';
import { SessionRepository } from './session.repository';
import { AudioService } from '../audio/audio.service';
import { LoggerService } from '../logger/logger.service';
import { QueueService } from '../queue/queue.service';
import { MonitorService } from '../monitor/monitor.service';
import { CampaignRepository } from '../campaign/campaign.repository';
import { CharacterRepository } from '../character/character.repository';
import { v4 as uuidv4 } from 'uuid';
import { VoiceBasedChannel, GuildMember } from 'discord.js';

@Injectable()
export class SessionService {
  private activeSessions = new Map<string, string>(); // GuildID -> SessionID
  private sessionChannels = new Map<string, string>(); // SessionID -> ChannelID (Text)

  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly audioService: AudioService,
    private readonly logger: LoggerService,
    private readonly queueService: QueueService,
    private readonly monitorService: MonitorService,
    private readonly campaignRepo: CampaignRepository,
    private readonly characterRepo: CharacterRepository
  ) {}

  getActiveSession(guildId: string): string | undefined {
    return this.activeSessions.get(guildId);
  }

  async ensureTestEnvironment(guildId: string, userId: string): Promise<any> {
    let campaign = this.campaignRepo.findActive(guildId);

    if (!campaign) {
        const campaigns = this.campaignRepo.findAll(guildId);
        const testCampaignName = "Campagna di Test";
        let testCampaign = campaigns.find(c => c.name === testCampaignName);

        if (!testCampaign) {
            // FIX: create returns number ID, no uuid needed
            const newId = this.campaignRepo.create(guildId, testCampaignName);
            testCampaign = this.campaignRepo.findById(newId);
        }

        if (testCampaign) {
            this.campaignRepo.setActive(guildId, testCampaign.id);
            campaign = this.campaignRepo.findActive(guildId);
        }
    }

    if (!campaign) return null;

    // Check Year
    if (campaign.current_year === undefined || campaign.current_year === null) {
        this.campaignRepo.setYear(campaign.id, 1000);
        campaign.current_year = 1000;
    }

    // Check Location
    const loc = this.sessionRepo.getLastLocation(guildId);
    if (!loc || (!loc.macro && !loc.micro)) {
        // FIX: addLocationHistory requires campaignId
        this.sessionRepo.addLocationHistory(campaign.id, null, "Laboratorio", "Stanza dei Test");
    }

    // Check Character
    const char = this.characterRepo.findByUser(userId, campaign.id);
    if (!char || !char.character_name) {
        this.characterRepo.upsert(userId, campaign.id, 'character_name', 'Test Subject');
        this.characterRepo.upsert(userId, campaign.id, 'class', 'Tester');
        this.characterRepo.upsert(userId, campaign.id, 'race', 'Construct');
    }

    return campaign;
  }

  async validateParticipants(campaignId: number, members: GuildMember[]): Promise<{ missing: string[], bots: string[] }> {
    const missing: string[] = [];
    const bots: string[] = [];

    for (const m of members) {
        if (m.user.bot) {
            bots.push(m.displayName);
            continue;
        }
        const char = this.characterRepo.findByUser(m.id, campaignId);
        if (!char || !char.character_name) {
            missing.push(m.displayName);
        }
    }
    return { missing, bots };
  }

  async startSession(guildId: string, voiceChannel: VoiceBasedChannel, textChannelId: string, campaignId: number, location?: { macro?: string, micro?: string }): Promise<string> {
    if (this.activeSessions.has(guildId)) {
      throw new Error('Una sessione è già attiva in questo server.');
    }

    // PAUSA CODA
    await this.queueService.getAudioQueue().pause();
    this.logger.log(`[Flow] Coda in PAUSA. Inizio accumulo file.`);

    const sessionId = uuidv4();
    const now = Date.now();

    this.sessionRepo.create(sessionId, guildId, campaignId, now);

    if (location) {
      this.updateLocation(campaignId, sessionId, location.macro || null, location.micro || null);
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

    // RIPRESA CODA
    await this.queueService.getAudioQueue().resume();
    this.logger.log(`[Flow] Coda RIPRESA.`);

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

  updateLocation(campaignId: number, sessionId: string | null, macro: string | null, micro: string | null): void {
    this.sessionRepo.addLocationHistory(campaignId, sessionId, macro, micro);
    this.logger.log(`Posizione aggiornata: ${macro} | ${micro}`);
  }

  getLocation(guildId: string): { macro: string, micro: string } | undefined {
    return this.sessionRepo.getLastLocation(guildId);
  }
}
