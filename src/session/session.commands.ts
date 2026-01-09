import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { SessionService } from './session.service';
import { CampaignService } from '../campaign/campaign.service';
import { DatabaseService } from '../database/database.service';
import { QueueService } from '../queue/queue.service';
import { StringOption, NumberOption } from 'necord';
import { GuildMember, EmbedBuilder } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { PodcastMixerService } from '../audio/podcast-mixer.service';
import { BackupService } from '../backup/backup.service';

class StartSessionDto {
  @StringOption({ name: 'location', description: 'Luogo della sessione', required: false })
  location?: string;
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

@Injectable()
export class SessionCommands {
  constructor(
    private readonly sessionService: SessionService,
    private readonly campaignService: CampaignService,
    private readonly dbService: DatabaseService,
    private readonly queueService: QueueService,
    private readonly podcastMixer: PodcastMixerService,
    private readonly backupService: BackupService
  ) {}

  @SlashCommand({ name: 'session-start', description: 'Inizia una nuova sessione di gioco' })
  public async onStart(@Context() [interaction]: SlashCommandContext, @Options() { location }: StartSessionDto) {
    const member = interaction.member as GuildMember;
    if (!member.voice.channel) return interaction.reply({ content: "❌ Devi essere in un canale vocale!", ephemeral: true });

    const activeCampaign = this.campaignService.getActive(interaction.guildId!);
    if (!activeCampaign) return interaction.reply({ content: "⚠️ Nessuna campagna attiva.", ephemeral: true });

    if (activeCampaign.current_year === undefined || activeCampaign.current_year === null) {
        return interaction.reply({ content: "🛑 Configura l'anno corrente con `/set-date` prima di iniziare.", ephemeral: true });
    }

    let locObj = undefined;
    if (location) {
      const parts = location.split('|').map(s => s.trim());
      locObj = { macro: parts[0], micro: parts[1] || parts[0] };
    }

    try {
      const sessionId = await this.sessionService.startSession(interaction.guildId!, member.voice.channel, interaction.channelId, activeCampaign.id, locObj);
      return interaction.reply(`🔊 **Sessione Iniziata**\nCampagna: **${activeCampaign.name}**\nID: \`${sessionId}\`\nIl Bardo sta ascoltando...`);
    } catch (e: any) {
      return interaction.reply({ content: `❌ Errore: ${e.message}`, ephemeral: true });
    }
  }

  @SlashCommand({ name: 'session-stop', description: 'Termina la sessione corrente' })
  public async onStop(@Context() [interaction]: SlashCommandContext) {
    const sessionId = await this.sessionService.stopSession(interaction.guildId!);
    if (!sessionId) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    return interaction.reply(`🛑 Sessione **${sessionId}** terminata.\nLo Scriba sta iniziando a trascrivere e riassumere...`);
  }

  @SlashCommand({ name: 'session-pause', description: 'Mette in pausa la registrazione' })
  public async onPause(@Context() [interaction]: SlashCommandContext) {
    if (!this.sessionService.pauseSession(interaction.guildId!)) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    return interaction.reply("⏸️ **Registrazione in Pausa**.");
  }

  @SlashCommand({ name: 'session-resume', description: 'Riprende la registrazione' })
  public async onResume(@Context() [interaction]: SlashCommandContext) {
    if (!this.sessionService.resumeSession(interaction.guildId!)) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    return interaction.reply("▶️ **Registrazione Ripresa**.");
  }

  @SlashCommand({ name: 'note', description: 'Aggiunge una nota alla sessione corrente' })
  public async onNote(@Context() [interaction]: SlashCommandContext, @Options() { text }: NoteDto) {
    const sessionId = this.sessionService.getActiveSession(interaction.guildId!);
    if (!sessionId) return interaction.reply({ content: "⚠️ Nessuna sessione attiva.", ephemeral: true });
    this.sessionService.addNote(sessionId, interaction.user.id, text);
    return interaction.reply({ content: "📝 Nota registrata.", ephemeral: true });
  }

  @SlashCommand({ name: 'location', description: 'Aggiorna il luogo corrente' })
  public async onLocation(@Context() [interaction]: SlashCommandContext, @Options() { place }: LocationDto) {
    const sessionId = this.sessionService.getActiveSession(interaction.guildId!);
    const parts = place.split('|').map(s => s.trim());
    const macro = parts[0];
    const micro = parts[1] || null;
    this.sessionService.updateLocation(interaction.guildId!, sessionId || null, macro, micro);
    return interaction.reply(`📍 Posizione aggiornata: **${macro}** | **${micro || '-'}**`);
  }

  @SlashCommand({ name: 'session-download', description: 'Scarica l\'audio completo della sessione' })
  public async onDownload(@Context() [interaction]: SlashCommandContext, @Options() { sessionId }: SessionIdDto) {
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

  @SlashCommand({ name: 'session-transcript', description: 'Scarica la trascrizione testuale' })
  public async onTranscript(@Context() [interaction]: SlashCommandContext, @Options() { sessionId }: SessionIdDto) {
    const transcripts = this.dbService.getDb().prepare(
        'SELECT transcription_text, user_id, timestamp FROM recordings WHERE session_id = ? AND transcription_text IS NOT NULL ORDER BY timestamp ASC'
    ).all(sessionId) as any[];

    if (transcripts.length === 0) return interaction.reply("⚠️ Nessuna trascrizione trovata.");

    // Recupera start_time della sessione per calcolare offset relativo
    const session = this.dbService.getDb().prepare('SELECT start_time, campaign_id FROM sessions WHERE session_id = ?').get(sessionId) as any;
    const sessionStart = session ? session.start_time : 0;

    const formattedText = transcripts.map(t => {
        let text = "";
        try {
            const segments = JSON.parse(t.transcription_text);
            text = segments.map((s: any) => s.text).join(' ');
        } catch { text = t.transcription_text; }
        
        let charName = t.user_id;
        if (session) {
            const char = this.dbService.getDb().prepare('SELECT character_name FROM characters WHERE user_id = ? AND campaign_id = ?').get(t.user_id, session.campaign_id) as any;
            if (char) charName = char.character_name;
        }

        // Calcolo Timestamp Relativo (HH:MM:SS)
        const offsetMs = t.timestamp - sessionStart;
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

  @SlashCommand({ name: 'session-set-number', description: 'Imposta il numero della sessione' })
  public async onSetNumber(@Context() [interaction]: SlashCommandContext, @Options() { sessionId, number }: SetSessionNumberDto) {
    this.dbService.getDb().prepare('UPDATE sessions SET session_number = ? WHERE session_id = ?').run(number, sessionId);
    return interaction.reply(`✅ Numero sessione per \`${sessionId}\` impostato a **${number}**.`);
  }

  @SlashCommand({ name: 'session-reset', description: 'Forza il reset della sessione' })
  public async onReset(@Context() [interaction]: SlashCommandContext, @Options() { sessionId }: SessionIdDto) {
    await interaction.reply(`🔄 **Reset Sessione ${sessionId}** avviato...`);
    
    await this.queueService.removeSessionJobs(sessionId);
    
    const files = this.dbService.getDb().prepare('SELECT * FROM recordings WHERE session_id = ?').all(sessionId) as any[];
    
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
  
  @SlashCommand({ name: 'session-list', description: 'Lista le sessioni della campagna' })
  public async onList(@Context() [interaction]: SlashCommandContext) {
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply("Nessuna campagna attiva.");
      
      const sessions = this.dbService.getDb().prepare(
          'SELECT * FROM sessions WHERE campaign_id = ? ORDER BY start_time DESC LIMIT 10'
      ).all(active.id) as any[];
      
      if (sessions.length === 0) return interaction.reply("Nessuna sessione trovata.");
      
      const list = sessions.map(s => `🆔 \`${s.session_id}\` - 📅 ${new Date(s.start_time).toLocaleDateString()} - 📜 ${s.title || 'Senza titolo'}`).join('\n');
      return interaction.reply(`**Ultime Sessioni (${active.name})**\n${list}`);
  }
}
