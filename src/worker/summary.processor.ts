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
import { RecordingRepository } from '../audio/recording.repository';
import { CharacterRepository } from '../character/character.repository';
import { CharacterService } from '../character/character.service';

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
        private readonly recordingRepo: RecordingRepository,
        private readonly characterRepo: CharacterRepository,
        private readonly characterService: CharacterService,
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
            this.logger.debug(`[Worker] Chiamata a aiService.generateSummary per ${sessionId}`);
            const result = await this.aiService.generateSummary(sessionId, 'DM');
            this.logger.debug(`[Worker] Riassunto generato con successo. Titolo: ${result.title}`);

            this.monitorService.logSummarizationTime(Date.now() - startTime);

            // 2. Salva nel DB
            this.logger.debug(`[Worker] Salvataggio riassunto nel DB per ${sessionId}`);
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
                if (result.character_growth) {
                    for (const growth of result.character_growth) {
                        this.characterService.addCharacterEvent(session.campaign_id, growth.name, sessionId, growth.type, growth.event);
                    }
                }
            }

            // 4. Invia su Discord (Nuova Logica)
            this.logger.debug(`[Worker] Invio riassunto su Discord (Channel: ${channelId})`);
            const channel = await this.client.channels.fetch(channelId) as TextChannel;

            if (channel) {
                await this.publishSummary(sessionId, result.summary, channel, false, result.title, result.loot, result.quests, result.narrative);
            } else {
                this.logger.warn(`[Worker] Canale Discord ${channelId} non trovato.`);
            }

            // 5. Invia Email Recap
            if (session) {
                this.reporterService.sendSessionRecap(
                    sessionId,
                    session.campaign_id,
                    result.summary,
                    result.loot || [],
                    result.loot_removed || [],
                    result.narrative || ''
                ).catch(e => this.logger.error(`[Worker] ❌ Errore invio email recap:`, e));
            }

            // 6. Ingestione RAG
            this.logger.debug(`[Worker] Avvio ingestione RAG per ${sessionId}`);
            await this.aiService.ingestSessionRaw(sessionId);

            this.logger.log(`[Worker] ✅ Riassunto completato per ${sessionId}`);
            return result;

        } catch (error: any) {
            this.logger.error(`[Worker] ❌ Errore riassunto ${sessionId}: ${error.message}`, error.stack);
            if (error.response) {
                this.logger.error(`[Worker] Dettagli risposta errore: ${JSON.stringify(error.response.data)}`);
            }
            this.monitorService.logError('Summary', `Session: ${sessionId} - ${error.message}`);
            throw error;
        }
    }

    private async publishSummary(sessionId: string, summary: string, defaultChannel: TextChannel, isReplay: boolean = false, title?: string, loot?: string[], quests?: string[], narrative?: string) {
        // Nota: Qui potremmo gestire un canale riassunti separato se configurato, ma per ora usiamo defaultChannel

        let targetChannel: TextChannel = defaultChannel;

        // Recupera session number
        const session = this.sessionRepo.findById(sessionId);
        let sessionNum = session?.session_number || null;

        if (sessionNum === null) {
            const info = await this.fetchSessionInfoFromHistory(targetChannel, sessionId);
            if (isReplay) {
                if (info.sessionNumber) {
                    sessionNum = info.sessionNumber;
                    this.sessionRepo.updateSessionNumber(sessionId, sessionNum);
                }
            } else {
                if (info.lastRealNumber > 0) {
                    sessionNum = info.lastRealNumber + 1;
                    this.sessionRepo.updateSessionNumber(sessionId, sessionNum);
                }
            }
        }

        if (sessionNum === null) {
            sessionNum = 1;
            this.sessionRepo.updateSessionNumber(sessionId, sessionNum);
        }

        // Recupera Autore
        const recordings = this.recordingRepo.findBySession(sessionId);
        const authorId = recordings.length > 0 ? recordings[0].user_id : null;
        const campaignId = session?.campaign_id;

        let authorName = "Viandante";
        if (authorId && campaignId) {
            const char = this.characterRepo.findByUser(authorId, campaignId);
            if (char && char.character_name) authorName = char.character_name;
        }

        const sessionStartTime = session?.start_time || Date.now();
        const sessionDate = new Date(sessionStartTime);

        const dateStr = sessionDate.toLocaleDateString('it-IT');
        const dateShort = sessionDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const timeStr = sessionDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

        const replayTag = isReplay ? " (REPLAY)" : "";

        // Header
        let header = `-SESSIONE ${sessionNum} - ${dateStr}${replayTag}\n[ID: ${sessionId}]`;
        if (campaignId) {
            const campaign = this.campaignRepo.findById(campaignId);
            if (campaign) {
                header = `--- ${campaign.name.toUpperCase()} ---\n` + header;
            }
        }

        await targetChannel.send(`\`\`\`diff\n${header}\n\`\`\``);

        if (title) {
            await targetChannel.send(`## 📜 ${title}`);
        }

        await targetChannel.send(`**${authorName}** — ${dateShort}, ${timeStr}`);

        // --- RACCONTO NARRATIVO ---
        if (narrative && narrative.length > 10) {
            await targetChannel.send(`### 📖 Racconto`);
            const narrativeChunks = narrative.match(/[\s\S]{1,1900}/g) || [];
            for (const chunk of narrativeChunks) {
                await targetChannel.send(chunk);
            }
            await targetChannel.send(`---\n`); // Separatore
        }

        // --- RIASSUNTO (LOG) ---
        const chunks = summary.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) {
            await targetChannel.send(chunk);
        }

        // --- VISUALIZZAZIONE LOOT & QUEST ---
        if ((loot && loot.length > 0) || (quests && quests.length > 0)) {
            const embed = new EmbedBuilder()
                .setColor("#F1C40F")
                .setTitle("🎒 Riepilogo Tecnico");

            if (loot && loot.length > 0) {
                embed.addFields({ name: "💰 Bottino (Loot)", value: loot.map(i => `• ${i}`).join('\n') });
            }

            if (quests && quests.length > 0) {
                embed.addFields({ name: "🗺️ Missioni (Quests)", value: quests.map(q => `• ${q}`).join('\n') });
            }

            await targetChannel.send({ embeds: [embed] });
        }

        this.logger.log(`[Worker] 📨 Riassunto inviato per sessione ${sessionId} nel canale ${targetChannel.name}!`);
    }

    private async fetchSessionInfoFromHistory(channel: TextChannel, targetSessionId?: string): Promise<{ lastRealNumber: number, sessionNumber?: number }> {
        let lastRealNumber = 0;
        let foundSessionNumber: number | undefined;

        try {
            const messages = await channel.messages.fetch({ limit: 100 });
            const sortedMessages = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

            for (const msg of sortedMessages) {
                const sessionMatch = msg.content.match(/-SESSIONE\s+(\d+)/i);
                const idMatch = msg.content.match(/\[ID: ([a-f0-9-]+)\]/i);
                const isReplay = msg.content.includes("(REPLAY)");

                if (sessionMatch) {
                    const num = parseInt(sessionMatch[1]);
                    if (!isNaN(num)) {
                        if (!isReplay && lastRealNumber === 0) {
                            lastRealNumber = num;
                        }
                        if (targetSessionId && idMatch && idMatch[1] === targetSessionId) {
                            foundSessionNumber = num;
                        }
                        if (!targetSessionId && lastRealNumber !== 0) break;
                        if (targetSessionId && lastRealNumber !== 0 && foundSessionNumber !== undefined) break;
                    }
                }
            }
        } catch (e) {
            this.logger.error("❌ Errore durante il recupero della cronologia del canale:", e);
        }

        return { lastRealNumber, sessionNumber: foundSessionNumber };
    }
}
