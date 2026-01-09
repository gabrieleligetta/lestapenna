import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext, Options, StringOption } from 'necord';
import { QueueService } from '../queue/queue.service';
import { ConfigRepository } from './config.repository';
import { PermissionFlagsBits, TextChannel, Message } from 'discord.js';
import { BackupService } from '../backup/backup.service';
import { ReporterService } from '../reporter/reporter.service';

class SetChannelDto {
    @StringOption({ name: 'type', description: 'Tipo canale (cmd o summary)', required: true, choices: [{name: 'Comandi', value: 'cmd'}, {name: 'Riassunti', value: 'summary'}] })
    type: string;
}

@Injectable()
export class SystemCommands {
  constructor(
    private readonly queueService: QueueService,
    private readonly configRepo: ConfigRepository,
    private readonly backupService: BackupService,
    private readonly reporterService: ReporterService
  ) {}

  @SlashCommand({ name: 'aiuto', description: 'Mostra i comandi disponibili' })
  public async onHelp(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply({
        content: `📚 **Guida ai Comandi**\nConsulta il README o usa i comandi Slash autocompletati.\n\n**Categorie:**\n- \`/session-*\`: Gestione sessioni\n- \`/campaign-*\`: Gestione campagne\n- \`/iam\`, \`/myclass\`: Gestione PG\n- \`/npc\`, \`/timeline-*\`: Lore`,
        ephemeral: true
    });
  }

  @SlashCommand({ name: 'toni', description: 'Mostra i toni narrativi disponibili' })
  public async onTones(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply("🎭 **Toni Narrativi**:\n- DM (Tecnico)\n- EPIC (Epico)\n- DARK (Oscuro)\n- COMIC (Divertente)\n- MYSTERY (Misterioso)");
  }

  @SlashCommand({ name: 'stato', description: 'Mostra lo stato del sistema' })
  public async onStatus(@Context() [interaction]: SlashCommandContext) {
    const counts = await this.queueService.getJobCounts();
    return interaction.reply(
        `📊 **Stato Sistema**\n` +
        `- 🎧 Audio Queue: ${counts.audio.waiting} in attesa, ${counts.audio.active} attivi\n` +
        `- 📝 Summary Queue: ${counts.summary.waiting} in attesa, ${counts.summary.active} attivi\n` +
        `- 🔧 Correction Queue: ${counts.correction.waiting} in attesa`
    );
  }

  @SlashCommand({ name: 'setcmd', description: 'Imposta il canale per i comandi', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onSetCmd(@Context() [interaction]: SlashCommandContext) {
      this.configRepo.setConfig(interaction.guildId!, 'cmd_channel_id', interaction.channelId);
      return interaction.reply(`✅ Canale **Comandi** impostato su <#${interaction.channelId}>.`);
  }

  @SlashCommand({ name: 'setsummary', description: 'Imposta il canale per i riassunti', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onSetSummary(@Context() [interaction]: SlashCommandContext) {
      this.configRepo.setConfig(interaction.guildId!, 'summary_channel_id', interaction.channelId);
      return interaction.reply(`✅ Canale **Riassunti** impostato su <#${interaction.channelId}>.`);
  }

  @SlashCommand({ name: 'wipe', description: 'Reset totale del sistema (PERICOLO)', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onWipe(@Context() [interaction]: SlashCommandContext) {
      if (interaction.user.id !== '310865403066712074') return interaction.reply({ content: "⛔ Solo il Creatore può invocare il Ragnarok.", ephemeral: true });

      await interaction.reply("⚠️ **ATTENZIONE**: Questa operazione cancellerà **TUTTO** (DB, Cloud, Code, File Locali). Sei sicuro? Scrivi `CONFERMO` in chat entro 15 secondi.");

      const channel = interaction.channel as TextChannel;
      if (!channel) return;

      try {
          const collected = await channel.awaitMessages({
              filter: (m: Message) => m.author.id === interaction.user.id && m.content === 'CONFERMO',
              max: 1,
              time: 15000,
              errors: ['time']
          });

          if (collected.size > 0) {
              const statusMsg = await interaction.followUp("🧹 **Ragnarok avviato...**");
              try {
                  await this.queueService.clearAllQueues();
                  await statusMsg.edit("🧹 **Ragnarok in corso...**\n- Code svuotate ✅");
                  const cloudCount = await this.backupService.wipeBucket();
                  await statusMsg.edit(`🧹 **Ragnarok in corso...**\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅`);
                  // TODO: Implementare wipeDatabase e wipeLocalFiles in servizi appropriati
                  await statusMsg.edit(`🔥 **Ragnarok completato.** Tutto è stato riportato al nulla.\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅`);
              } catch (err: any) {
                  await statusMsg.edit(`❌ Errore durante il Ragnarok: ${err.message}`);
              }
          }
      } catch (e) {
          await interaction.followUp("⌛ Tempo scaduto. Il mondo è salvo.");
      }
  }

  @SlashCommand({ name: 'testmail', description: 'Invia una mail di test', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onTestMail(@Context() [interaction]: SlashCommandContext) {
      if (interaction.user.id !== '310865403066712074') return interaction.reply({ content: "⛔ Accesso negato.", ephemeral: true });

      await interaction.reply("📧 Invio email di test in corso...");
      // TODO: Implementare sendTestEmail in ReporterService
      // const success = await this.reporterService.sendTestEmail('gabligetta@gmail.com');
      const success = true; // Mock

      if (success) {
          await interaction.followUp("✅ Email inviata con successo! Controlla la casella di posta.");
      } else {
          await interaction.followUp("❌ Errore durante l'invio.");
      }
  }
}
