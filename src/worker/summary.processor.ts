import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LoggerService } from '../logger/logger.service';
import { AiService } from '../ai/ai.service';
import { SessionRepository } from '../session/session.repository';
import { LoreService } from '../lore/lore.service';
import { MonitorService } from '../monitor/monitor.service';
import { ReporterService } from '../reporter/reporter.service';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { Inject } from '@nestjs/common';
import { CampaignRepository } from '../campaign/campaign.repository';

@Processor('summary-processing')
export class SummaryProcessor extends WorkerHost {
  constructor(
    private readonly logger: LoggerService,
    private readonly aiService: AiService,
    private readonly sessionRepo: SessionRepository,
    private readonly loreService: LoreService,
    private readonly monitorService: MonitorService,
    private readonly reporterService: ReporterService,
    private readonly campaignRepo: CampaignRepository,
    @Inject('DISCORD_CLIENT') private readonly client: Client
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { sessionId, channelId, guildId } = job.data;
    this.logger.log(`[Worker] 📝 Generazione riassunto per sessione ${sessionId}...`);

    const startTime = Date.now();

    try {
      // 1. Genera Riassunto con AI
      const result = await this.aiService.generateSummary(sessionId, 'DM');
      
      this.monitorService.logSummarizationTime(Date.now() - startTime);

      // 2. Salva nel DB
      this.sessionRepo.updateTitleAndSummary(sessionId, result.title, result.summary);

      // 3. Aggiorna Lore (NPC, Eventi, ecc.)
      const session = this.sessionRepo.findById(sessionId);
      if (session) {
          const campaign = this.campaignRepo.findById(session.campaign_id);
          const currentYear = campaign?.current_year || 0;

          if (result.npc_events) {
              for (const npc of result.npc_events) {
                  this.loreService.updateNpcEntry(session.campaign_id, npc.name, npc.event, undefined, npc.type === 'DEATH' ? 'DEAD' : undefined);
              }
          }
          if (result.world_events) {
              for (const evt of result.world_events) {
                  this.loreService.addWorldEvent(session.campaign_id, sessionId, evt.event, evt.type, currentYear);
              }
          }
      }

      // 4. Invia su Discord
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      if (channel) {
          const embed = new EmbedBuilder()
              .setTitle(`📜 ${result.title}`)
              .setDescription(result.summary)
              .setColor('#FFD700')
              .addFields(
                  { name: '📖 Narrativa', value: result.narrative.substring(0, 1024) },
                  { name: '💰 Loot', value: result.loot?.join(', ') || 'Nessuno', inline: true },
                  { name: '⚔️ Quest', value: result.quests?.join('\n') || 'Nessuna', inline: true }
              )
              .setFooter({ text: `Sessione ID: ${sessionId}` });

          await channel.send({ embeds: [embed] });
      }

      // 5. Invia Email Recap
      if (session) {
          this.reporterService.sendSessionRecap(
              sessionId,
              session.campaign_id,
              result.summary,
              result.loot || [],
              result.loot_removed || [],
              result.narrative
          ).catch(e => this.logger.error(`[Worker] ❌ Errore invio email recap:`, e));
      }

      // 6. Ingestione RAG
      await this.aiService.ingestSessionRaw(sessionId);

      this.logger.log(`[Worker] ✅ Riassunto completato per ${sessionId}`);
      return result;

    } catch (error: any) {
      this.logger.error(`[Worker] ❌ Errore riassunto ${sessionId}:`, error);
      this.monitorService.logError('Summary', `Session: ${sessionId} - ${error.message}`);
      throw error;
    }
  }
}
