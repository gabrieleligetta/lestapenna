import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { CampaignService } from './campaign.service';
import { StringOption } from 'necord';
import { PermissionFlagsBits, TextChannel, Message } from 'discord.js';
import { AiService } from '../ai/ai.service';

class CreateCampaignDto {
  @StringOption({ name: 'name', description: 'Nome della nuova campagna', required: true })
  name: string;
}

class SelectCampaignDto {
  @StringOption({ name: 'name_or_id', description: 'Nome o ID della campagna da attivare', required: true })
  nameOrId: string;
}

class DeleteCampaignDto {
  @StringOption({ name: 'name_or_id', description: 'Nome o ID della campagna da eliminare', required: true })
  nameOrId: string;
}

class AskBardDto {
  @StringOption({ name: 'domanda', description: 'Cosa vuoi chiedere al Bardo?', required: true })
  question: string;
}

class IngestLoreDto {
  @StringOption({ name: 'testo', description: 'Il testo da aggiungere alla memoria', required: true })
  text: string;
  @StringOption({ name: 'tipo', description: 'Tipo di lore (Mondo, Biografia, Luogo)', required: false })
  type: string;
}

@Injectable()
export class CampaignCommands {
  constructor(
      private readonly campaignService: CampaignService,
      private readonly aiService: AiService
  ) {}

  @SlashCommand({ name: 'creacampagna', description: 'Crea una nuova campagna', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onCreate(@Context() [interaction]: SlashCommandContext, @Options() { name }: CreateCampaignDto) {
    const campaign = this.campaignService.create(interaction.guildId!, name);
    return interaction.reply({ content: `✅ Campagna **${campaign.name}** creata e attivata! Usa \`/selezionacampagna ${name}\` per attivarla.`, ephemeral: false });
  }

  @SlashCommand({ name: 'listacampagne', description: 'Lista tutte le campagne del server' })
  public async onList(@Context() [interaction]: SlashCommandContext) {
    const campaigns = this.campaignService.findAll(interaction.guildId!);
    const active = this.campaignService.getActive(interaction.guildId!);

    if (campaigns.length === 0) return interaction.reply({ content: "Nessuna campagna trovata. Creane una con `/creacampagna`.", ephemeral: true });

    const list = campaigns.map(c => `${c.id === active?.id ? '👉 ' : ''}**${c.name}** (ID: \`${c.id}\`)`).join('\n');
    return interaction.reply({ content: `**🗺️ Campagne di questo Server**\n${list}`, ephemeral: true });
  }

  @SlashCommand({ name: 'selezionacampagna', description: 'Seleziona la campagna attiva', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onSelect(@Context() [interaction]: SlashCommandContext, @Options() { nameOrId }: SelectCampaignDto) {
    const campaigns = this.campaignService.findAll(interaction.guildId!);
    // FIX: c.id is number, nameOrId is string
    const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

    if (!target) return interaction.reply({ content: "⚠️ Campagna non trovata.", ephemeral: true });

    this.campaignService.setActive(interaction.guildId!, target.id);
    return interaction.reply({ content: `✅ Campagna attiva impostata su: **${target.name}**.` });
  }

  @SlashCommand({ name: 'eliminacampagna', description: 'Elimina definitivamente una campagna', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onDelete(@Context() [interaction]: SlashCommandContext, @Options() { nameOrId }: DeleteCampaignDto) {
      const campaigns = this.campaignService.findAll(interaction.guildId!);
      // FIX: c.id is number, nameOrId is string
      const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

      if (!target) return interaction.reply({ content: "⚠️ Campagna non trovata.", ephemeral: true });

      await interaction.reply(`⚠️ **ATTENZIONE**: Stai per eliminare la campagna **${target.name}** e TUTTE le sue sessioni, registrazioni e memorie. Questa azione è irreversibile.\nScrivi \`CONFERMO\` in chat per procedere.`);

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
              this.campaignService.delete(target.id);
              await interaction.followUp(`🗑️ Campagna **${target.name}** eliminata definitivamente.`);
          }
      } catch (e) {
          await interaction.followUp("⌛ Tempo scaduto. Eliminazione annullata.");
      }
  }

  @SlashCommand({ name: 'chiedibardo', description: 'Fai una domanda al Bardo sulla storia della campagna' })
  public async onAskBard(@Context() [interaction]: SlashCommandContext, @Options() { question }: AskBardDto) {
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply({ content: "⚠️ Nessuna campagna attiva.", ephemeral: true });

      await interaction.deferReply();
      try {
          // FIX: active.id is number, askBard expects string
          const answer = await this.aiService.askBard(active.id.toString(), question);
          return interaction.editReply(`**❓ ${question}**\n\n📜 ${answer}`);
      } catch (e) {
          return interaction.editReply("❌ Il Bardo ha avuto un vuoto di memoria.");
      }
  }

  @SlashCommand({ name: 'aggiungilore', description: 'Aggiungi manualmente una conoscenza alla memoria del Bardo' })
  public async onIngestLore(@Context() [interaction]: SlashCommandContext, @Options() { text, type }: IngestLoreDto) {
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply({ content: "⚠️ Nessuna campagna attiva.", ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      try {
          if (type?.toLowerCase() === 'mondo') {
              // FIX: active.id is number, ingestWorldEvent expects string
              await this.aiService.ingestWorldEvent(active.id.toString(), "MANUAL", text, "LORE");
          } else {
              // Default generico
              await this.aiService.ingestWorldEvent(active.id.toString(), "MANUAL", text, type || "GENERIC");
          }
          return interaction.editReply("✅ Conoscenza acquisita con successo.");
      } catch (e) {
          return interaction.editReply("❌ Errore durante l'apprendimento.");
      }
  }
}
