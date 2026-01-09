import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { CampaignService } from './campaign.service';
import { StringOption } from 'necord';
import { PermissionFlagsBits } from 'discord.js';

class CreateCampaignDto {
  @StringOption({
    name: 'name',
    description: 'Nome della nuova campagna',
    required: true,
  })
  name: string;
}

class SelectCampaignDto {
  @StringOption({
    name: 'name_or_id',
    description: 'Nome o ID della campagna da attivare',
    required: true,
  })
  nameOrId: string;
}

@Injectable()
export class CampaignCommands {
  constructor(private readonly campaignService: CampaignService) {}

  @SlashCommand({
    name: 'campaign-create',
    description: 'Crea una nuova campagna',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
  })
  public async onCreate(@Context() [interaction]: SlashCommandContext, @Options() { name }: CreateCampaignDto) {
    const campaign = this.campaignService.create(interaction.guildId!, name);
    return interaction.reply({ content: `✅ Campagna **${campaign.name}** creata e attivata!`, ephemeral: false });
  }

  @SlashCommand({
    name: 'campaign-list',
    description: 'Lista tutte le campagne del server',
  })
  public async onList(@Context() [interaction]: SlashCommandContext) {
    const campaigns = this.campaignService.findAll(interaction.guildId!);
    const active = this.campaignService.getActive(interaction.guildId!);

    if (campaigns.length === 0) {
      return interaction.reply({ content: "Nessuna campagna trovata.", ephemeral: true });
    }

    const list = campaigns.map(c => 
      `${c.id === active?.id ? '👉 ' : ''}**${c.name}** (ID: \`${c.id}\`)`
    ).join('\n');

    return interaction.reply({ content: `**Campagne del Server**\n${list}`, ephemeral: true });
  }

  @SlashCommand({
    name: 'campaign-select',
    description: 'Seleziona la campagna attiva',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
  })
  public async onSelect(@Context() [interaction]: SlashCommandContext, @Options() { nameOrId }: SelectCampaignDto) {
    const campaigns = this.campaignService.findAll(interaction.guildId!);
    const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id === nameOrId);

    if (!target) {
      return interaction.reply({ content: "⚠️ Campagna non trovata.", ephemeral: true });
    }

    this.campaignService.setActive(interaction.guildId!, target.id);
    return interaction.reply({ content: `✅ Campagna attiva impostata su: **${target.name}**.` });
  }
}
