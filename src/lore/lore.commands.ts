import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { LoreService } from './lore.service';
import { CampaignService } from '../campaign/campaign.service';
import { StringOption, NumberOption } from 'necord';
import { EmbedBuilder } from 'discord.js';

class NpcDto {
  @StringOption({
    name: 'name',
    description: 'Nome dell\'NPC da cercare',
    required: false,
  })
  name?: string;
}

class TimelineAddDto {
  @NumberOption({
    name: 'year',
    description: 'Anno dell\'evento',
    required: true,
  })
  year: number;

  @StringOption({
    name: 'description',
    description: 'Descrizione dell\'evento',
    required: true,
  })
  description: string;

  @StringOption({
    name: 'type',
    description: 'Tipo evento (WAR, POLITICS, ecc.)',
    required: false,
  })
  type?: string;
}

class SetDateDto {
  @NumberOption({
    name: 'year',
    description: 'Anno corrente della campagna',
    required: true,
  })
  year: number;
}

@Injectable()
export class LoreCommands {
  constructor(
    private readonly loreService: LoreService,
    private readonly campaignService: CampaignService
  ) {}

  private async getActiveCampaignOrReply(interaction: any) {
    const active = this.campaignService.getActive(interaction.guildId!);
    if (!active) {
      await interaction.reply({ content: "⚠️ Nessuna campagna attiva.", ephemeral: true });
      return null;
    }
    return active;
  }

  @SlashCommand({ name: 'npc', description: 'Cerca o lista NPC' })
  public async onNpc(@Context() [interaction]: SlashCommandContext, @Options() { name }: NpcDto) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    if (!name) {
      const npcs = this.loreService.listNpcs(active.id);
      if (npcs.length === 0) return interaction.reply("L'archivio NPC è vuoto.");

      const list = npcs.map(n => `👤 **${n.name}** (${n.role || '?'}) [${n.status}]`).join('\n');
      return interaction.reply(`**📂 Dossier NPC Recenti**\n${list}`);
    }

    const npc = this.loreService.getNpcEntry(active.id, name);
    if (!npc) return interaction.reply("NPC non trovato.");

    const embed = new EmbedBuilder()
      .setTitle(`👤 Dossier: ${npc.name}`)
      .setColor(npc.status === 'DEAD' ? "#FF0000" : "#00FF00")
      .addFields(
        { name: "Ruolo", value: npc.role || "Sconosciuto", inline: true },
        { name: "Stato", value: npc.status || "Vivo", inline: true },
        { name: "Note", value: npc.description || "Nessuna nota." }
      )
      .setFooter({ text: `Ultimo avvistamento: ${new Date(npc.last_updated).toLocaleDateString()}` });

    return interaction.reply({ embeds: [embed] });
  }

  @SlashCommand({ name: 'timeline-add', description: 'Aggiunge un evento alla cronologia' })
  public async onTimelineAdd(@Context() [interaction]: SlashCommandContext, @Options() { year, description, type }: TimelineAddDto) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.loreService.addWorldEvent(active.id, null, description, type || 'GENERIC', year);
    return interaction.reply(`📜 Evento storico aggiunto nell'anno **${year}**.`);
  }

  @SlashCommand({ name: 'timeline-view', description: 'Mostra la cronologia del mondo' })
  public async onTimelineView(@Context() [interaction]: SlashCommandContext) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    const events = this.loreService.getWorldTimeline(active.id);

    if (events.length === 0) {
      return interaction.reply("📜 La cronologia mondiale è ancora bianca.");
    }

    let msg = `🌍 **Cronologia del Mondo: ${active.name}**\n\n`;
    const icons: Record<string, string> = {
      'WAR': '⚔️', 'POLITICS': '👑', 'DISCOVERY': '💎',
      'CALAMITY': '🌋', 'SUPERNATURAL': '🔮', 'GENERIC': '🔹'
    };

    events.forEach(e => {
      const icon = icons[e.event_type] || '🔹';
      const yearLabel = e.year === 0 ? "**[Anno 0]**" : (e.year > 0 ? `**[${e.year} D.E.]**` : `**[${Math.abs(e.year)} P.E.]**`);
      msg += `${yearLabel} ${icon} ${e.description}\n`;
    });

    // Gestione chunking semplice per ora (Discord ha limite 2000 char)
    if (msg.length > 2000) {
      msg = msg.substring(0, 1990) + "... (continua)";
    }

    return interaction.reply(msg);
  }

  @SlashCommand({ name: 'set-date', description: 'Imposta la data corrente della campagna' })
  public async onSetDate(@Context() [interaction]: SlashCommandContext, @Options() { year }: SetDateDto) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.loreService.setCampaignYear(active.id, year);
    const label = year === 0 ? "Anno 0" : (year > 0 ? `${year} D.E.` : `${Math.abs(year)} P.E.`);
    
    return interaction.reply(`📅 Data campagna aggiornata a: **${label}**`);
  }
}
