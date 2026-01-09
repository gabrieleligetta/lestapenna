import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext, Options, StringOption } from 'necord';
import { QueueService } from '../queue/queue.service';
import { ConfigRepository } from './config.repository';
import { PermissionFlagsBits } from 'discord.js';

class SetChannelDto {
    @StringOption({ name: 'type', description: 'Tipo canale (cmd o summary)', required: true, choices: [{name: 'Comandi', value: 'cmd'}, {name: 'Riassunti', value: 'summary'}] })
    type: string;
}

@Injectable()
export class SystemCommands {
  constructor(
    private readonly queueService: QueueService,
    private readonly configRepo: ConfigRepository
  ) {}

  @SlashCommand({ name: 'help', description: 'Mostra i comandi disponibili' })
  public async onHelp(@Context() [interaction]: SlashCommandContext) {
    // Link al README o messaggio breve
    return interaction.reply({
        content: `📚 **Guida ai Comandi**\nConsulta il README o usa i comandi Slash autocompletati.\n\n**Categorie:**\n- \`/session-*\`: Gestione sessioni\n- \`/campaign-*\`: Gestione campagne\n- \`/iam\`, \`/myclass\`: Gestione PG\n- \`/npc\`, \`/timeline-*\`: Lore`,
        ephemeral: true
    });
  }

  @SlashCommand({ name: 'tones', description: 'Mostra i toni narrativi disponibili' })
  public async onTones(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply("🎭 **Toni Narrativi**:\n- DM (Tecnico)\n- EPIC (Epico)\n- DARK (Oscuro)\n- COMIC (Divertente)\n- MYSTERY (Misterioso)");
  }

  @SlashCommand({ name: 'status', description: 'Mostra lo stato del sistema' })
  public async onStatus(@Context() [interaction]: SlashCommandContext) {
    const counts = await this.queueService.getJobCounts();
    return interaction.reply(
        `📊 **Stato Sistema**\n` +
        `- 🎧 Audio Queue: ${counts.audio.waiting} in attesa, ${counts.audio.active} attivi\n` +
        `- 📝 Summary Queue: ${counts.summary.waiting} in attesa, ${counts.summary.active} attivi\n` +
        `- 🔧 Correction Queue: ${counts.correction.waiting} in attesa`
    );
  }

  @SlashCommand({ name: 'config-set-channel', description: 'Imposta i canali di output', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onSetChannel(@Context() [interaction]: SlashCommandContext, @Options() { type }: SetChannelDto) {
      const field = type === 'cmd' ? 'cmd_channel_id' : 'summary_channel_id';
      
      this.configRepo.setConfig(interaction.guildId!, field, interaction.channelId);
      
      return interaction.reply(`✅ Canale **${type}** impostato su <#${interaction.channelId}>.`);
  }
}
