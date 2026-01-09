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

  // --- CREATECAMPAIGN / CREACAMPAGNA ---
  @SlashCommand({ name: 'createcampaign', description: 'Crea una nuova campagna', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onCreateCampaign(@Context() [interaction]: SlashCommandContext, @Options() options: CreateCampaignDto) {
    const { name } = options;
    const campaign = this.campaignService.create(interaction.guildId!, name);
    return interaction.reply({ content: `✅ Campagna **${campaign.name}** creata e attivata! Usa \`/selezionacampagna ${name}\` per attivarla.`, ephemeral: false });
  }

  @SlashCommand({ name: 'creacampagna', description: 'Crea una nuova campagna (Alias)', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onCreaCampagna(@Context() [interaction]: SlashCommandContext, @Options() options: CreateCampaignDto) {
      return this.onCreateCampaign([interaction], options);
  }

  // --- LISTCAMPAIGNS / LISTACAMPAGNE ---
  @SlashCommand({ name: 'listcampaigns', description: 'Lista tutte le campagne del server' })
  public async onListCampaigns(@Context() [interaction]: SlashCommandContext) {
    const campaigns = this.campaignService.findAll(interaction.guildId!);
    const active = this.campaignService.getActive(interaction.guildId!);

    if (campaigns.length === 0) return interaction.reply({ content: "Nessuna campagna trovata. Creane una con `/creacampagna`.", ephemeral: true });

    const list = campaigns.map(c => `${c.id === active?.id ? '👉 ' : ''}**${c.name}** (ID: \`${c.id}\`)`).join('\n');
    return interaction.reply({ content: `**🗺️ Campagne di questo Server**\n${list}`, ephemeral: true });
  }

  @SlashCommand({ name: 'listacampagne', description: 'Lista tutte le campagne del server (Alias)' })
  public async onListaCampagne(@Context() [interaction]: SlashCommandContext) {
      return this.onListCampaigns([interaction]);
  }

  // --- SELECTCAMPAIGN / SELEZIONACAMPAGNA / SETCAMPAGNA ---
  @SlashCommand({ name: 'selectcampaign', description: 'Seleziona la campagna attiva', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onSelectCampaign(@Context() [interaction]: SlashCommandContext, @Options() options: SelectCampaignDto) {
    const { nameOrId } = options;
    const campaigns = this.campaignService.findAll(interaction.guildId!);
    const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

    if (!target) return interaction.reply({ content: "⚠️ Campagna non trovata.", ephemeral: true });

    this.campaignService.setActive(interaction.guildId!, target.id);
    return interaction.reply({ content: `✅ Campagna attiva impostata su: **${target.name}**.` });
  }

  @SlashCommand({ name: 'selezionacampagna', description: 'Seleziona la campagna attiva (Alias)', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onSelezionaCampagna(@Context() [interaction]: SlashCommandContext, @Options() options: SelectCampaignDto) {
      return this.onSelectCampaign([interaction], options);
  }

  @SlashCommand({ name: 'setcampagna', description: 'Seleziona la campagna attiva (Alias)', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onSetCampagna(@Context() [interaction]: SlashCommandContext, @Options() options: SelectCampaignDto) {
      return this.onSelectCampaign([interaction], options);
  }

  // --- DELETECAMPAIGN / ELIMINACAMPAGNA ---
  @SlashCommand({ name: 'deletecampaign', description: 'Elimina definitivamente una campagna', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onDeleteCampaign(@Context() [interaction]: SlashCommandContext, @Options() options: DeleteCampaignDto) {
      const { nameOrId } = options;
      const campaigns = this.campaignService.findAll(interaction.guildId!);
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

  @SlashCommand({ name: 'eliminacampagna', description: 'Elimina definitivamente una campagna (Alias)', defaultMemberPermissions: PermissionFlagsBits.Administrator })
  public async onEliminaCampagna(@Context() [interaction]: SlashCommandContext, @Options() options: DeleteCampaignDto) {
      return this.onDeleteCampaign([interaction], options);
  }

  // --- ASK / CHIEDIALBARDO ---
  @SlashCommand({ name: 'ask', description: 'Fai una domanda al Bardo sulla storia della campagna' })
  public async onAsk(@Context() [interaction]: SlashCommandContext, @Options() options: AskBardDto) {
      const { question } = options;
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply({ content: "⚠️ Nessuna campagna attiva.", ephemeral: true });

      await interaction.deferReply();
      try {
          const answer = await this.aiService.askBard(active.id.toString(), question);
          return interaction.editReply(`**❓ ${question}**\n\n📜 ${answer}`);
      } catch (e) {
          return interaction.editReply("❌ Il Bardo ha avuto un vuoto di memoria.");
      }
  }

  @SlashCommand({ name: 'chiedialbardo', description: 'Fai una domanda al Bardo sulla storia della campagna (Alias)' })
  public async onChiediAlBardo(@Context() [interaction]: SlashCommandContext, @Options() options: AskBardDto) {
      return this.onAsk([interaction], options);
  }

  // --- AGGIUNGILORE (Solo ITA in legacy?) ---
  @SlashCommand({ name: 'aggiungilore', description: 'Aggiungi manualmente una conoscenza alla memoria del Bardo' })
  public async onAggiungiLore(@Context() [interaction]: SlashCommandContext, @Options() options: IngestLoreDto) {
      const { text, type } = options;
      const active = this.campaignService.getActive(interaction.guildId!);
      if (!active) return interaction.reply({ content: "⚠️ Nessuna campagna attiva.", ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      try {
          if (type?.toLowerCase() === 'mondo') {
              await this.aiService.ingestWorldEvent(active.id.toString(), "MANUAL", text, "LORE");
          } else {
              await this.aiService.ingestWorldEvent(active.id.toString(), "MANUAL", text, type || "GENERIC");
          }
          return interaction.editReply("✅ Conoscenza acquisita con successo.");
      } catch (e) {
          return interaction.editReply("❌ Errore durante l'apprendimento.");
      }
  }
}
