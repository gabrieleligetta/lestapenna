import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { DebugService } from './debug.service';
import { StringOption } from 'necord';
import { PermissionFlagsBits } from 'discord.js';

class TestStreamDto {
  @StringOption({
    name: 'url',
    description: 'URL YouTube o file audio diretto',
    required: true,
  })
  url: string;
}

@Injectable()
export class DebugCommands {
  constructor(private readonly debugService: DebugService) {}

  @SlashCommand({
    name: 'test-stream',
    description: 'Simula una sessione scaricando un audio da URL',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
  })
  public async onTestStream(@Context() [interaction]: SlashCommandContext, @Options() { url }: TestStreamDto) {
    await interaction.deferReply();
    try {
      const sessionId = await this.debugService.startTestStream(interaction.guildId!, interaction.user.id, url, interaction.channelId);
      return interaction.editReply(`🧪 **Test Stream Avviato**\nID Sessione: \`${sessionId}\`\nAudio scaricato e accodato. Attendi il riassunto...`);
    } catch (e: any) {
      return interaction.editReply(`❌ Errore: ${e.message}`);
    }
  }

  @SlashCommand({
    name: 'clean-test',
    description: 'Elimina tutte le sessioni di test (ID che iniziano con test-)',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
  })
  public async onCleanTest(@Context() [interaction]: SlashCommandContext) {
    const count = await this.debugService.cleanTestSessions(interaction.guildId!);
    return interaction.reply(`🧹 Eliminate **${count}** sessioni di test.`);
  }
}
