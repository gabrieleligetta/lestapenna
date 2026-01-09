import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { SessionService } from './session.service';
import { CampaignService } from '../campaign/campaign.service';
import { SessionRepository } from './session.repository';
import { RecordingRepository } from '../audio/recording.repository';
import { QueueService } from '../queue/queue.service';
import { StringOption, NumberOption, BooleanOption } from 'necord';
import { GuildMember, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { PodcastMixerService } from '../audio/podcast-mixer.service';
import { BackupService } from '../backup/backup.service';
import { CharacterRepository } from '../character/character.repository';
import { LoreRepository } from '../lore/lore.repository';
import { AiService } from '../ai/ai.service';
import { LoggerService } from '../logger/logger.service';

class StartSessionDto {
  @StringOption({ name: 'location', description: 'Luogo della sessione (Macro | Micro)', required: false })
  location?: string;

  @BooleanOption({ name: 'test', description: 'Modalità test (crea ambiente automatico)', required: false })
  test?: boolean;
}

class NoteDto {
  @StringOption({ name: 'text', description: 'Testo della nota', required: true })
  text: string;
}

class LocationDto {
  @StringOption({ name: 'place', description: 'Nuovo luogo', required: true })
  place: string;
}

class SessionIdDto {
  @StringOption({ name: 'session_id', description: 'ID della sessione', required: true })
  sessionId: string;
}

class SetSessionNumberDto {
  @StringOption({ name: 'session_id', description: 'ID della sessione', required: true })
  sessionId: string;
  @NumberOption({ name: 'number', description: 'Nuovo numero sessione', required: true })
  number: number;
}

class AtlasDto {
    @StringOption({ name: 'description', description: 'Nuova descrizione per il luogo corrente', required: false })
    description?: string;
}

class SummarizeDto {
    @StringOption({ name: 'session_id', description: 'ID della sessione', required: false })
    sessionId?: string;
    @StringOption({ name: 'tone', description: 'Tono del riassunto (DM, EPICO, MISTERO)', required: false })
    tone?: string;
}

class EditTitleDto {
    @StringOption({ name: 'session_id', description: 'ID della sessione', required: true })
    sessionId: string;
    @StringOption({ name: 'title', description: 'Nuovo titolo', required: true })
    title: string;
}

@Injectable()
export class SessionCommands {
  constructor(
    private readonly sessionService: SessionService,
    private readonly campaignService: CampaignService,
    private readonly sessionRepo: SessionRepository,
    private readonly recordingRepo: RecordingRepository,
    private readonly characterRepo: CharacterRepository,
    private readonly queueService: QueueService,
    private readonly podcastMixer: PodcastMixerService,
    private readonly backupService: BackupService,
    private readonly loreRepo: LoreRepository,
    private readonly aiService: AiService,
    private readonly logger: LoggerService
  ) {}

  // --- LISTEN / ASCOLTA ---
  @SlashCommand({ name: 'listen', description: 'Inizia una nuova sessione di gioco' })
  public async onListen(@Context() [interaction]: SlashCommandContext, @Options() options: StartSessionDto) {
    const { location, test } = options;
    const member = interaction.member as GuildMember;
    if (!member.voice.channel) return interaction.reply({ content: "❌ Devi essere in un canale vocale per evocare il Bardo!", ephemeral: true });

    let activeCampaign = this.campaignService.getActive(interaction.guildId!);

    if (test) {
        const setupCamp = await this.sessionService.ensureTestEnvironment(interaction.guildId!, interaction.user.id);
        if (setupCamp) {
            activeCampaign = setupCamp;
            if (interaction.channel) {
                await (interaction.channel as any).send(`🧪 **Modalità Test Attiva**: Campagna e Personaggio configurati.`);
            }
        } else {
            return interaction.reply({ content: "❌ Errore critico nel setup dell'ambiente di test.", ephemeral: true });
        }
    }

    if (!activeCampaign) return interaction.reply({ content: "⚠️ **Nessuna campagna attiva!** Chiedi a un admin di attivarne una.", ephemeral: true });

    if (activeCampaign.current_year === undefined || activeCampaign.current_year === null) {
        return interaction.reply({ 
            content: `🛑 **Configurazione Temporale Mancante!**\n` +
                     `Prima di iniziare, imposta l'anno corrente con \`/data <Anno>\`.`, 
            ephemeral: true 
        });
    }

    // Gestione Luogo
    let locObj = undefined;
    if (location) {
      const parts = location.split('|').map(s => s.trim());
      locObj = { macro: parts[0], micro: parts[1] || parts[0] };
      if (interaction.channel) {
          await (interaction.channel as any).send(`📍 Posizione tracciata: **${locObj.macro}** | **${locObj.micro}**.`);
      }
    } else {
      const currentLoc = this.sessionService.getLocation(interaction.guildId!);
      if (currentLoc && (currentLoc.macro || currentLoc.micro)) {
          if (interaction.channel) {
              await (interaction.channel as any).send(`📍 Luogo attuale: **${currentLoc.macro || '-'}** | **${currentLoc.micro || '-'}** (Se è cambiato, usa \`/ascolta location: Macro | Micro\`)`);
          }
      } else {
          if (interaction.channel) {
              await (interaction.channel as any).send(`⚠️ **Luogo Sconosciuto.**\nConsiglio: usa \`/ascolta location: <Città> | <Luogo>\` per aiutare il Bardo.`);
          }
      }
    }

    // Validazione Partecipanti
    const voiceChannel = member.voice.channel;
    const members = Array.from(voiceChannel.members.values());
    const validation = await this.sessionService.validateParticipants(activeCampaign.id, members);

    if (validation.missing.length > 0) {
        return interaction.reply({
            content: `🛑 **ALT!** Non posso iniziare la cronaca per **${activeCampaign.name}**.\n` +
                     `I seguenti avventurieri non hanno dichiarato il loro nome in questa campagna:\n` +
                     validation.missing.map(n => `- **${n}** (Usa: \`/iam <NomePersonaggio>\`)`).join('\n'),
            ephemeral: false
        });
    }

    if (validation.bots.length > 0) {
        if (interaction.channel) {
            await (interaction.channel as any).send(`🤖 Noto la presenza di costrutti magici (${validation.bots.join(', ')}). Le loro voci saranno ignorate.`);
        }
    }

    try {
      const sessionId = await this.sessionService.startSession(interaction.guildId!, member.voice.channel, interaction.channelId, activeCampaign.id, locObj);
      return interaction.reply(`🔊 **Cronaca Iniziata** per la campagna **${activeCampaign.name}**.\nID Sessione: \`${sessionId}\`.\nI bardi stanno ascoltando ${members.length - validation.bots.length} eroi.`);
    } catch (e: any) {
      return interaction.reply({ content: `❌ Errore: ${e.message}`, ephemeral: true });
    }
  }

  @SlashCommand({ name: 'ascolta', description: 'Inizia una nuova sessione di gioco (Alias)' })
  public async onAscolta(@Context() [interaction]: SlashCommandContext, @Options() options: StartSessionDto) {
      return this.onListen([interaction], options);
  }

  @SlashCommand({ name: 'testascolta', description: 'Inizia una sessione di test (Alias)' })
  public async onTestAscolta(@Context() [interaction]: SlashCommandContext, @Options() options: StartSessionDto) {
      options.test = true;
      return this.onListen([interaction], options);
  }

  // --- STOPLISTENING / TERMINA ---
  @SlashCommand({ name: 'stoplistening', description: 'Termina la sessione corrente' })
  public async onStopListening(@Context() [interaction]: SlashCommandContext) {
    const sessionId = await this.sessionService.stopSession(interaction.guildId!);
    if (!sessionId) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    return interaction.reply(`🛑 Sessione **${sessionId}** terminata.\nLo Scriba sta iniziando a trascrivere e riassumere...`);
  }

  @SlashCommand({ name: 'termina', description: 'Termina la sessione corrente (Alias)' })
  public async onTermina(@Context() [interaction]: SlashCommandContext) {
      return this.onStopListening([interaction]);
  }

  // --- PAUSE / PAUSA ---
  @SlashCommand({ name: 'pause', description: 'Mette in pausa la registrazione' })
  public async onPause(@Context() [interaction]: SlashCommandContext) {
    if (!this.sessionService.pauseSession(interaction.guildId!)) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    return interaction.reply("⏸️ **Registrazione in Pausa**.");
  }

  @SlashCommand({ name: 'pausa', description: 'Mette in pausa la registrazione (Alias)' })
  public async onPausa(@Context() [interaction]: SlashCommandContext) {
      return this.onPause([interaction]);
  }

  // --- RESUME / RIPRENDI ---
  @SlashCommand({ name: 'resume', description: 'Riprende la registrazione' })
  public async onResume(@Context() [interaction]: SlashCommandContext) {
    if (!this.sessionService.resumeSession(interaction.guildId!)) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    return interaction.reply("▶️ **Registrazione Ripresa**.");
  }

  @SlashCommand({ name: 'riprendi', description: 'Riprende la registrazione (Alias)' })
  public async onRiprendi(@Context() [interaction]: SlashCommandContext) {
      return this.onResume([interaction]);
  }

  // --- NOTE / NOTA ---
  @SlashCommand({ name: 'note', description: 'Aggiunge una nota alla sessione corrente' })
  public async onNote(@Context() [interaction]: SlashCommandContext, @Options() options: NoteDto) {
    const { text } = options;
    const sessionId = this.sessionService.getActiveSession(interaction.guildId!);
    if (!sessionId) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    this.sessionService.addNote(sessionId, interaction.user.id, text);
    return interaction.reply({ content: "📝 Nota registrata.", ephemeral: true });
  }

  @SlashCommand({ name: 'nota', description: 'Aggiunge una nota alla sessione corrente (Alias)' })
  public async onNota(@Context() [interaction]: SlashCommandContext, @Options() options: NoteDto) {
      return this.onNote([interaction], options);
  }

  // --- LOCATION / LUOGO ---
  @SlashCommand({ name: 'location', description: 'Aggiorna il luogo corrente' })
  public async onLocation(@Context() [interaction]: SlashCommandContext, @Options() options: LocationDto) {
    const { place } = options;
    const active = this.campaignService.getActive(interaction.guildId!);
    if (!active) return interaction.reply("⚠️ Nessuna campagna attiva.");

    const sessionId = this.sessionService.getActiveSession(interaction.guildId!);
    const parts = place.split('|').map(s => s.trim());
    const macro = parts[0];
    const micro = parts[1] || null;
    
    this.sessionService.updateLocation(active.id, sessionId || null, macro, micro);
    return interaction.reply(`📍 Posizione aggiornata: **${macro}** | **${micro || '-'}**`);
  }

  @SlashCommand({ name: 'luogo', description: 'Aggiorna il luogo corrente (Alias)' })
  public async onLuogo(@Context() [interaction]: SlashCommandContext, @Options() options: LocationDto) {
      return this.onLocation([interaction], options);
  }

  // --- DOWNLOAD / SCARICA ---
  @SlashCommand({ name: 'download', description: 'Scarica l\'audio completo della sessione' })
  public async onDownload(@Context() [interaction]: SlashCommandContext, @Options() options: SessionIdDto) {
    const { sessionId } = options;
    await interaction.deferReply();
    
    const activeSession = this.sessionService.getActiveSession(interaction.guildId!);
    if (activeSession === sessionId) {
        return interaction.editReply("⚠️ La sessione è ancora attiva. Terminala prima di scaricare.");
    }

    try {
        const masterFileName = `PODCAST-${sessionId}.mp3`;
        const presignedUrl = await this.backupService.getPresignedUrl(masterFileName, sessionId, 3600 * 24);

        if (presignedUrl) {
             return interaction.editReply(`✅ **Audio Sessione Trovato!**\nPuoi scaricarlo qui (link valido 24h):\n${presignedUrl}`);
        }

        const filePath = await this.podcastMixer.mixSession(sessionId);
        if (!filePath) return interaction.editReply("❌ Impossibile generare l'audio (file sorgenti mancanti).");

        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB < 25) {
            await interaction.editReply({
                content: `✅ **Audio Sessione Pronto!** (${sizeMB.toFixed(2)} MB)`,
                files: [filePath]
            });
        } else {
            const fileName = path.basename(filePath);
            const customKey = `recordings/${sessionId}/master/${fileName}`;
            await this.backupService.uploadToOracle(filePath, fileName, sessionId, customKey);
            const newUrl = await this.backupService.getPresignedUrl(fileName, sessionId, 3600 * 24);
            await interaction.editReply(`✅ **Audio Generato** (${sizeMB.toFixed(2)} MB).\nScarica qui:\n${newUrl}`);
        }
        try { fs.unlinkSync(filePath); } catch {}
    } catch (e: any) {
        return interaction.editReply(`❌ Errore: ${e.message}`);
    }
  }

  @SlashCommand({ name: 'scarica', description: 'Scarica l\'audio completo della sessione (Alias)' })
  public async onScarica(@Context() [interaction]: SlashCommandContext, @Options() options: SessionIdDto) {
      return this.onDownload([interaction], options);
  }

  // --- DOWNLOADTXT / SCARICATRASCRIZIONI ---
  @SlashCommand({ name: 'downloadtxt', description: 'Scarica la trascrizione testuale' })
  public async onDownloadTxt(@Context() [interaction]: SlashCommandContext, @Options() options: SessionIdDto) {
    const { sessionId } = options;
    const transcripts = this.recordingRepo.getTranscripts(sessionId);

    if (transcripts.length === 0) return interaction.reply("⚠️ Nessuna trascrizione trovata.");

    const session = this.sessionRepo.findById(sessionId);
    const sessionStart = session ? session.start_time : 0;

    const formattedText = transcripts.map(t => {
        let text = "";
        try {
            const segments = JSON.parse(t.transcription_text || '[]');
            text = segments.map((s: any) => s.text).join(' ');
        } catch { text = t.transcription_text || ''; }
        
        let charName = t.user_id;
        if (session) {
            const char = this.characterRepo.findByUser(t.user_id, session.campaign_id);
            if (char) charName = char.character_name;
        }

        const offsetMs = t.timestamp! - sessionStart!;
        const totalSeconds = Math.floor(Math.max(0, offsetMs) / 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        const timeLabel = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

        return `[${timeLabel}] ${charName}: ${text}`;
    }).join('\n');

    const filePath = path.join(process.cwd(), 'recordings', `transcript-${sessionId}.txt`);
    fs.writeFileSync(filePath, formattedText);

    await interaction.reply({
        content: `📜 **Trascrizione Completa** per sessione \`${sessionId}\``,
        files: [filePath]
    });
    try { fs.unlinkSync(filePath); } catch {}
  }

  @SlashCommand({ name: 'scaricatrascrizioni', description: 'Scarica la trascrizione testuale (Alias)' })
  public async onScaricaTrascrizioni(@Context() [interaction]: SlashCommandContext, @Options() options: SessionIdDto) {
      return this.onDownloadTxt([interaction], options);
  }

  // --- SETSESSION / IMPOSTASESSIONE ---
  @SlashCommand({ name: 'setsession', description: 'Imposta il numero della sessione' })
  public async onSetSession(@Context() [interaction]: SlashCommandContext, @Options() { sessionId, number }: SetSessionNumberDto) {
    this.sessionRepo.updateSessionNumber(sessionId, number);
    return interaction.reply(`✅ Numero sessione per \`${sessionId}\` impostato a **${number}**.`);
  }

  @SlashCommand({ name: 'impostasessione', description: 'Imposta il numero della sessione (Alias)' })
  public async onImpostaSessione(@Context() [interaction]: SlashCommandContext, @Options() options: SetSessionNumberDto) {
      return this.onSetSession([interaction], options);
  }

  // --- RESET ---
  @SlashCommand({ name: 'reset', description: 'Forza il reset della sessione' })
  public async onReset(@Context() [interaction]: SlashCommandContext, @Options() { sessionId }: SessionIdDto) {
    await interaction.reply(`🔄 **Reset Sessione ${sessionId}** avviato...`);
    
    await this.queueService.removeSessionJobs(sessionId);
    
    const files = this.recordingRepo.findBySession(sessionId);
    
    for (const file of files) {
        await this.queueService.addAudioJob({
            sessionId: file.session_id,
            fileName: file.filename,
            filePath: file.filepath,
            userId: file.user_id
        }, { jobId: `${file.filename}-reset-${Date.now()}`, removeOnComplete: true });
    }
    
    return interaction.followUp(`✅ **Reset Completato**. ${files.length} file riaccodati.`);
  }
  
  // --- LISTSESSIONS / LISTASESSIONI ---
  @SlashCommand({ name: 'listsessions', description: 'Lista le sessioni della campagna' })
  public async onListSessions(@Context() [interaction]: SlashCommandContext) {
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply("Nessuna campagna attiva.");
      
      const sessions = this.sessionRepo.findByCampaign(active.id);
      
      if (sessions.length === 0) return interaction.reply("Nessuna sessione trovata.");
      
      const ITEMS_PER_PAGE = 5;
      const totalPages = Math.ceil(sessions.length / ITEMS_PER_PAGE);
      let currentPage = 0;

      const generateEmbed = (page: number) => {
          const start = page * ITEMS_PER_PAGE;
          const end = start + ITEMS_PER_PAGE;
          const currentSessions = sessions.slice(start, end);

          const list = currentSessions.map(s => {
              const title = s.title ? `📜 **${s.title}**` : "";
              return `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time!).toLocaleString()}\n${title}`;
          }).join('\n\n');

          return new EmbedBuilder()
              .setTitle(`📜 Cronache: ${active.name}`)
              .setColor("#7289DA")
              .setDescription(list)
              .setFooter({ text: `Pagina ${page + 1} di ${totalPages}` });
      };

      const generateButtons = (page: number) => {
          const row = new ActionRowBuilder<ButtonBuilder>();
          row.addComponents(
              new ButtonBuilder().setCustomId('prev_page').setLabel('⬅️ Precedente').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
              new ButtonBuilder().setCustomId('next_page').setLabel('Successivo ➡️').setStyle(ButtonStyle.Primary).setDisabled(page === totalPages - 1)
          );
          return row;
      };

      const reply = await interaction.reply({
          embeds: [generateEmbed(currentPage)],
          components: totalPages > 1 ? [generateButtons(currentPage)] : [],
          fetchReply: true
      });

      if (totalPages > 1) {
          const collector = reply.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
          collector.on('collect', async (i) => {
              if (i.user.id !== interaction.user.id) {
                  await i.reply({ content: "Solo chi ha invocato il comando può sfogliare.", ephemeral: true });
                  return;
              }
              if (i.customId === 'prev_page') currentPage--;
              else if (i.customId === 'next_page') currentPage++;
              await i.update({ embeds: [generateEmbed(currentPage)], components: [generateButtons(currentPage)] });
          });
      }
  }

  @SlashCommand({ name: 'listasessioni', description: 'Lista le sessioni della campagna (Alias)' })
  public async onListaSessioni(@Context() [interaction]: SlashCommandContext) {
      return this.onListSessions([interaction]);
  }

  // --- TRAVELS / VIAGGI ---
  @SlashCommand({ name: 'travels', description: 'Mostra il diario di viaggio' })
  public async onTravels(@Context() [interaction]: SlashCommandContext) {
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply("Nessuna campagna attiva.");

      const sessionId = this.sessionService.getActiveSession(interaction.guildId!);
      if (!sessionId) return interaction.reply("Nessuna sessione attiva per mostrare i viaggi correnti.");

      const history = this.sessionRepo.getLocationHistory(sessionId);
      if (history.length === 0) return interaction.reply("Il diario di viaggio è vuoto.");

      let msg = "**📜 Diario di Viaggio (Ultimi spostamenti):**\n";
      history.forEach((h: any) => {
          const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
          msg += `\`${h.session_date} ${time}\` 🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}\n`;
      });

      return interaction.reply(msg);
  }

  @SlashCommand({ name: 'viaggi', description: 'Mostra il diario di viaggio (Alias)' })
  public async onViaggi(@Context() [interaction]: SlashCommandContext) {
      return this.onTravels([interaction]);
  }

  // --- ATLAS / ATLANTE / MEMORIA ---
  @SlashCommand({ name: 'atlas', description: 'Consulta o aggiorna l\'Atlante' })
  public async onAtlas(@Context() [interaction]: SlashCommandContext, @Options() options: AtlasDto) {
      const { description } = options;
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply("Nessuna campagna attiva.");

      const loc = this.sessionService.getLocation(interaction.guildId!);
      if (!loc || !loc.macro || !loc.micro) {
          return interaction.reply("⚠️ Non so dove siete. Imposta prima il luogo con `/location`.");
      }

      if (description) {
          this.loreRepo.upsertAtlasEntry(active.id, loc.macro, loc.micro, description);
          this.logger.log(`Aggiornato Atlante: ${loc.macro} - ${loc.micro}`);
          await this.aiService.ingestLocationDescription(active.id.toString(), loc.macro, loc.micro, description);
          return interaction.reply(`📖 **Atlante Aggiornato** per *${loc.micro}*:\n"${description}"`);
      } else {
          const entry = this.loreRepo.getAtlasEntry(active.id, loc.macro, loc.micro);
          if (entry) {
              return interaction.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n_${entry.description}_`);
          } else {
              return interaction.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n*Nessuna memoria registrata per questo luogo.*`);
          }
      }
  }

  @SlashCommand({ name: 'atlante', description: 'Consulta o aggiorna l\'Atlante (Alias)' })
  public async onAtlante(@Context() [interaction]: SlashCommandContext, @Options() options: AtlasDto) {
      return this.onAtlas([interaction], options);
  }

  @SlashCommand({ name: 'memoria', description: 'Consulta o aggiorna l\'Atlante (Alias)' })
  public async onMemoria(@Context() [interaction]: SlashCommandContext, @Options() options: AtlasDto) {
      return this.onAtlas([interaction], options);
  }

  // --- SUMMARIZE / RACCONTA / NARRATE ---
  @SlashCommand({ name: 'summarize', description: 'Genera manualmente un riassunto' })
  public async onSummarize(@Context() [interaction]: SlashCommandContext, @Options() options: SummarizeDto) {
      const { sessionId, tone } = options;
      const targetSessionId = sessionId || this.sessionService.getActiveSession(interaction.guildId!);
      if (!targetSessionId) return interaction.reply("Specifica un ID sessione o avvia una sessione.");

      await interaction.reply(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

      try {
          await this.aiService.ingestSessionRaw(targetSessionId);
          const result = await this.aiService.generateSummary(targetSessionId, tone || 'DM');
          
          this.sessionRepo.updateTitleAndSummary(targetSessionId, result.title, result.summary);
          
          const embed = new EmbedBuilder()
              .setTitle(`📜 ${result.title}`)
              .setDescription(result.summary)
              .setColor('#FFD700')
              .addFields(
                  { name: '📖 Narrativa', value: result.narrative?.substring(0, 1024) || '-' },
                  { name: '💰 Loot', value: result.loot?.join(', ') || 'Nessuno', inline: true },
                  { name: '⚔️ Quest', value: result.quests?.join('\n') || 'Nessuna', inline: true }
              );

          return interaction.followUp({ embeds: [embed] });
      } catch (e: any) {
          return interaction.followUp(`⚠️ Errore generazione riassunto: ${e.message}`);
      }
  }

  @SlashCommand({ name: 'racconta', description: 'Genera manualmente un riassunto (Alias)' })
  public async onRacconta(@Context() [interaction]: SlashCommandContext, @Options() options: SummarizeDto) {
      return this.onSummarize([interaction], options);
  }

  @SlashCommand({ name: 'narrate', description: 'Genera manualmente un riassunto (Alias)' })
  public async onNarrate(@Context() [interaction]: SlashCommandContext, @Options() options: SummarizeDto) {
      return this.onSummarize([interaction], options);
  }

  // --- EDITTITLE / MODIFICATITOLO ---
  @SlashCommand({ name: 'edittitle', description: 'Modifica il titolo di una sessione' })
  public async onEditTitle(@Context() [interaction]: SlashCommandContext, @Options() { sessionId, title }: EditTitleDto) {
      this.sessionRepo.updateSessionTitle(sessionId, title);
      return interaction.reply(`✅ Titolo aggiornato per la sessione \`${sessionId}\`: **${title}**`);
  }

  @SlashCommand({ name: 'modificatitolo', description: 'Modifica il titolo di una sessione (Alias)' })
  public async onModificaTitolo(@Context() [interaction]: SlashCommandContext, @Options() options: EditTitleDto) {
      return this.onEditTitle([interaction], options);
  }

  // --- INGEST / MEMORIZZA ---
  @SlashCommand({ name: 'ingest', description: 'Forza l\'ingestione della memoria' })
  public async onIngest(@Context() [interaction]: SlashCommandContext, @Options() { sessionId }: SessionIdDto) {
      await interaction.reply(`🧠 **Ingestione Memoria** avviata per sessione \`${sessionId}\`...`);
      try {
          await this.aiService.ingestSessionRaw(sessionId);
          return interaction.followUp(`✅ Memoria aggiornata per sessione \`${sessionId}\`.`);
      } catch (e: any) {
          return interaction.followUp(`❌ Errore ingestione: ${e.message}`);
      }
  }

  @SlashCommand({ name: 'memorizza', description: 'Forza l\'ingestione della memoria (Alias)' })
  public async onMemorizza(@Context() [interaction]: SlashCommandContext, @Options() options: SessionIdDto) {
      return this.onIngest([interaction], options);
  }
}
