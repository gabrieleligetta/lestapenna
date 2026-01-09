import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AiService } from '../ai/ai.service';
import { DatabaseService } from '../database/database.service';
import { LoggerService } from '../logger/logger.service';
import { QueueService } from '../queue/queue.service';
import { MonitorService } from '../monitor/monitor.service';
import { ReporterService } from '../reporter/reporter.service';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { Inject } from '@nestjs/common';

@Processor('summary-processing')
export class SummaryProcessor extends WorkerHost {
  constructor(
    private readonly aiService: AiService,
    private readonly dbService: DatabaseService,
    private readonly logger: LoggerService,
    private readonly queueService: QueueService,
    private readonly monitorService: MonitorService,
    private readonly reporterService: ReporterService,
    @Inject('DISCORD_CLIENT') private readonly discordClient: Client
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { sessionId, channelId, guildId } = job.data;
    this.logger.log(`[SummaryWorker] 🕵️ Controllo completamento sessione ${sessionId}...`);

    const audioQueue = this.queueService.getAudioQueue();
    const jobs = await audioQueue.getJobs(['waiting', 'active', 'delayed']);
    const pending = jobs.filter(j => j.data && j.data.sessionId === sessionId);

    if (pending.length > 0) {
      this.logger.log(`[SummaryWorker] Sessione ${sessionId} ha ancora ${pending.length} file in coda. Riprovo tra 10s.`);
      throw new Error("Pending audio jobs");
    }

    this.logger.log(`[SummaryWorker] ✅ Tutti i file processati. Inizio generazione riassunto per ${sessionId}.`);
    const start = Date.now();
    
    const channel = await this.discordClient.channels.fetch(channelId) as TextChannel;
    if (channel) await channel.send("✍️ Tutti i bardi hanno consegnato le trascrizioni. Inizio la stesura del racconto...");

    try {
      await this.aiService.ingestSessionRaw(sessionId);
      
      const result = await this.aiService.generateSummary(sessionId, 'DM');

      this.dbService.getDb().prepare('UPDATE sessions SET title = ?, summary = ? WHERE session_id = ?').run(result.title, result.summary, sessionId);

      if (channel) {
        await this.publishSummary(channel, sessionId, result);
      }

      // Invia Email Recap al DM
      const campaignId = this.dbService.getDb().prepare('SELECT campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as { campaign_id: string };
      if (campaignId) {
          await this.reporterService.sendSessionRecap(
              sessionId, 
              campaignId.campaign_id, 
              result.summary, 
              result.loot, 
              result.loot_removed, 
              result.narrative
          );
      }

      this.monitorService.logSummarizationTime(Date.now() - start);
      if (result.tokens) this.monitorService.logTokenUsage(result.tokens);

      return { success: true, title: result.title };

    } catch (e: any) {
      this.logger.error(`[SummaryWorker] ❌ Errore generazione riassunto:`, e);
      if (channel) await channel.send(`⚠️ Errore durante la generazione del riassunto: ${e.message}`);
      throw e;
    }
  }

  private async publishSummary(channel: TextChannel, sessionId: string, result: any) {
    const sessionDate = new Date().toLocaleDateString('it-IT');
    
    await channel.send(`\`\`\`diff\n-SESSIONE COMPLETATA - ${sessionDate}\n[ID: ${sessionId}]\n\`\`\``);
    await channel.send(`## 📜 ${result.title}`);

    if (result.narrative) {
        const chunks = result.narrative.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) await channel.send(`*${chunk}*`);
        await channel.send(`---\n`);
    }

    const chunks = result.summary.match(/[\s\S]{1,1900}/g) || [];
    for (const chunk of chunks) await channel.send(chunk);

    if ((result.loot && result.loot.length > 0) || (result.quests && result.quests.length > 0)) {
        const embed = new EmbedBuilder()
            .setColor("#F1C40F")
            .setTitle("🎒 Riepilogo Tecnico");

        if (result.loot && result.loot.length > 0) {
            embed.addFields({ name: "💰 Bottino", value: result.loot.map((i: string) => `• ${i}`).join('\n') });
        }
        if (result.quests && result.quests.length > 0) {
            embed.addFields({ name: "🗺️ Missioni", value: result.quests.map((q: string) => `• ${q}`).join('\n') });
        }
        await channel.send({ embeds: [embed] });
    }
  }
}
