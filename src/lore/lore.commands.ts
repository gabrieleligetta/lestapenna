import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { LoreService } from './lore.service';
import { CampaignService } from '../campaign/campaign.service';
import { SessionService } from '../session/session.service';
import { AiService } from '../ai/ai.service';
import { StringOption, NumberOption } from 'necord';
import { EmbedBuilder, TextChannel } from 'discord.js';

class NpcDto {
  @StringOption({ name: 'name', description: 'Nome dell\'NPC da cercare', required: false })
  name?: string;
}

class TimelineAddDto {
  @NumberOption({ name: 'year', description: 'Anno dell\'evento', required: true })
  year: number;
  @StringOption({ name: 'description', description: 'Descrizione dell\'evento', required: true })
  description: string;
  @StringOption({ name: 'type', description: 'Tipo evento (WAR, POLITICS, ecc.)', required: false })
  type?: string;
}

class SetDateDto {
  @NumberOption({ name: 'year', description: 'Anno corrente della campagna', required: true })
  year: number;
}

class YearZeroDto {
    @StringOption({ name: 'description', description: 'Descrizione Evento Cardine', required: true })
    description: string;
}

class AskDto {
    @StringOption({ name: 'question', description: 'Domanda per il Bardo', required: true })
    question: string;
}

class WikiDto {
    @StringOption({ name: 'term', description: 'Termine da cercare', required: true })
    term: string;
}

class QuestAddDto {
    @StringOption({ name: 'title', description: 'Titolo della quest', required: true })
    title: string;
}

class QuestDoneDto {
    @StringOption({ name: 'title', description: 'Titolo della quest da completare', required: true })
    title: string;
}

class LootAddDto {
    @StringOption({ name: 'item', description: 'Nome dell\'oggetto', required: true })
    item: string;
}

class LootUseDto {
    @StringOption({ name: 'item', description: 'Nome dell\'oggetto da usare/rimuovere', required: true })
    item: string;
}

@Injectable()
export class LoreCommands {
  constructor(
    private readonly loreService: LoreService,
    private readonly campaignService: CampaignService,
    private readonly sessionService: SessionService,
    private readonly aiService: AiService
  ) {}

  private async getActiveCampaignOrReply(interaction: any) {
    const active = this.campaignService.getActive(interaction.guildId!);
    if (!active) {
      await interaction.reply({ content: "⚠️ Nessuna campagna attiva.", ephemeral: true });
      return null;
    }
    return active;
  }

  // --- NPC / DOSSIER ---
  @SlashCommand({ name: 'npc', description: 'Cerca o lista NPC' })
  public async onNpc(@Context() [interaction]: SlashCommandContext, @Options() options: NpcDto) {
    const { name } = options;
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
      .setFooter({ text: `Ultimo avvistamento: ${npc.last_updated ? new Date(npc.last_updated).toLocaleDateString() : 'Sconosciuto'}` });

    return interaction.reply({ embeds: [embed] });
  }

  @SlashCommand({ name: 'dossier', description: 'Cerca o lista NPC (Alias)' })
  public async onDossier(@Context() [interaction]: SlashCommandContext, @Options() options: NpcDto) {
      return this.onNpc([interaction], options);
  }

  // --- PRESENZE ---
  @SlashCommand({ name: 'presenze', description: 'Mostra gli NPC incontrati nella sessione corrente' })
  public async onPresenze(@Context() [interaction]: SlashCommandContext) {
      const sessionId = this.sessionService.getActiveSession(interaction.guildId!);
      if (!sessionId) return interaction.reply("⚠️ Nessuna sessione attiva.");

      const npcs = this.loreService.getEncounteredNpcs(sessionId);
      if (npcs.length === 0) return interaction.reply(`👥 **NPC Incontrati:** Nessuno rilevato finora.`);

      const list = npcs.map(n => n.name).join(', ');
      return interaction.reply(`👥 **NPC Incontrati in questa sessione:**\n${list}`);
  }

  // --- TIMELINE / CRONOLOGIA ---
  @SlashCommand({ name: 'timeline', description: 'Mostra la cronologia del mondo' })
  public async onTimeline(@Context() [interaction]: SlashCommandContext) {
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
      const icon = icons[e.event_type!] || '🔹';
      const yearLabel = e.year === 0 ? "**[Anno 0]**" : (e.year! > 0 ? `**[${e.year} D.E.]**` : `**[${Math.abs(e.year!)} P.E.]**`);
      msg += `${yearLabel} ${icon} ${e.description}\n`;
    });

    if (msg.length > 2000) {
      msg = msg.substring(0, 1990) + "... (continua)";
    }

    return interaction.reply(msg);
  }

  @SlashCommand({ name: 'cronologia', description: 'Mostra la cronologia del mondo (Alias)' })
  public async onCronologia(@Context() [interaction]: SlashCommandContext) {
      return this.onTimeline([interaction]);
  }

  @SlashCommand({ name: 'timeline-add', description: 'Aggiunge un evento alla cronologia' })
  public async onTimelineAdd(@Context() [interaction]: SlashCommandContext, @Options() options: TimelineAddDto) {
    const { year, description, type } = options;
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.loreService.addWorldEvent(active.id, null, description, type || 'GENERIC', year);
    return interaction.reply(`📜 Evento storico aggiunto nell'anno **${year}**.`);
  }

  // --- DATE / DATA / ANNO / YEAR ---
  @SlashCommand({ name: 'date', description: 'Imposta la data corrente della campagna' })
  public async onDate(@Context() [interaction]: SlashCommandContext, @Options() options: SetDateDto) {
    const { year } = options;
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.loreService.setCampaignYear(active.id, year);
    const label = year === 0 ? "Anno 0" : (year > 0 ? `${year} D.E.` : `${Math.abs(year)} P.E.`);
    
    return interaction.reply(`📅 Data campagna aggiornata a: **${label}**`);
  }

  @SlashCommand({ name: 'data', description: 'Imposta la data corrente della campagna (Alias)' })
  public async onData(@Context() [interaction]: SlashCommandContext, @Options() options: SetDateDto) {
      return this.onDate([interaction], options);
  }

  @SlashCommand({ name: 'anno', description: 'Imposta la data corrente della campagna (Alias)' })
  public async onAnno(@Context() [interaction]: SlashCommandContext, @Options() options: SetDateDto) {
      return this.onDate([interaction], options);
  }

  @SlashCommand({ name: 'year', description: 'Imposta la data corrente della campagna (Alias)' })
  public async onYear(@Context() [interaction]: SlashCommandContext, @Options() options: SetDateDto) {
      return this.onDate([interaction], options);
  }

  // --- YEAR0 / ANNO0 ---
  @SlashCommand({ name: 'year0', description: 'Imposta l\'evento fondante (Anno 0)' })
  public async onYearZero(@Context() [interaction]: SlashCommandContext, @Options() options: YearZeroDto) {
      const { description } = options;
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      this.loreService.setCampaignYear(active.id, 0);
      this.loreService.addWorldEvent(active.id, null, description, 'GENERIC', 0);

      return interaction.reply(`📅 **Anno 0 Stabilito!**\nEvento: *${description}*\nOra puoi usare \`/data <Anno>\` per impostare la data corrente.`);
  }

  @SlashCommand({ name: 'anno0', description: 'Imposta l\'evento fondante (Anno 0) (Alias)' })
  public async onAnnoZero(@Context() [interaction]: SlashCommandContext, @Options() options: YearZeroDto) {
      return this.onYearZero([interaction], options);
  }

  // --- ASK / CHIEDIALBARDO ---
  @SlashCommand({ name: 'ask', description: 'Chiedi al Bardo qualcosa sulla storia' })
  public async onAsk(@Context() [interaction]: SlashCommandContext, @Options() options: AskDto) {
      const { question } = options;
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      await interaction.deferReply();
      try {
          const answer = await this.aiService.askBard(active.id.toString(), question);
          return interaction.followUp(`**❓ ${question}**\n\n📜 ${answer}`);
      } catch (e) {
          return interaction.followUp("❌ Il Bardo ha avuto un vuoto di memoria.");
      }
  }

  @SlashCommand({ name: 'chiedialbardo', description: 'Chiedi al Bardo qualcosa sulla storia (Alias)' })
  public async onChiediAlBardo(@Context() [interaction]: SlashCommandContext, @Options() options: AskDto) {
      return this.onAsk([interaction], options);
  }

  // --- WIKI / LORE ---
  @SlashCommand({ name: 'wiki', description: 'Cerca frammenti di lore esatti' })
  public async onWiki(@Context() [interaction]: SlashCommandContext, @Options() options: WikiDto) {
      const { term } = options;
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      await interaction.deferReply();
      
      try {
          const fragments = await this.aiService.searchKnowledge(active.id.toString(), term, 3);

          if (fragments.length === 0) {
              return interaction.followUp("Non ho trovato nulla negli archivi su questo argomento.");
          }

          await interaction.followUp(`📚 **Archivi: ${term}**\nHo trovato ${fragments.length} frammenti pertinenti.`);

          for (let i = 0; i < fragments.length; i++) {
              const fragment = fragments[i];
              const safeFragment = fragment.length > 4000 ? fragment.substring(0, 4000) + "..." : fragment;

              const embed = new EmbedBuilder()
                  .setTitle(`Frammento ${i + 1}`)
                  .setColor("#F1C40F")
                  .setDescription(safeFragment);

              if (interaction.channel && 'send' in interaction.channel) {
                  await (interaction.channel as TextChannel).send({ embeds: [embed] });
              }
          }
      } catch (err) {
          console.error("Errore wiki:", err);
          await interaction.followUp("Errore durante la consultazione degli archivi.");
      }
  }

  @SlashCommand({ name: 'lore', description: 'Cerca frammenti di lore esatti (Alias)' })
  public async onLore(@Context() [interaction]: SlashCommandContext, @Options() options: WikiDto) {
      return this.onWiki([interaction], options);
  }

  // --- QUEST / OBIETTIVI ---
  @SlashCommand({ name: 'quest', description: 'Visualizza le quest attive' })
  public async onQuest(@Context() [interaction]: SlashCommandContext) {
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      const quests = this.loreService.getOpenQuests(active.id);

      if (quests.length === 0) return interaction.reply("Nessuna quest attiva al momento.");

      const list = quests.map((q: any) => `🔹 **${q.title}**`).join('\n');
      return interaction.reply(`**🗺️ Quest Attive (${active.name})**\n\n${list}`);
  }

  @SlashCommand({ name: 'obiettivi', description: 'Visualizza le quest attive (Alias)' })
  public async onObiettivi(@Context() [interaction]: SlashCommandContext) {
      return this.onQuest([interaction]);
  }

  @SlashCommand({ name: 'quest-add', description: 'Aggiunge una nuova quest' })
  public async onQuestAdd(@Context() [interaction]: SlashCommandContext, @Options() options: QuestAddDto) {
      const { title } = options;
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      this.loreService.addQuest(active.id, title);
      return interaction.reply(`🗺️ Quest aggiunta: **${title}**`);
  }

  @SlashCommand({ name: 'quest-done', description: 'Completa una quest' })
  public async onQuestDone(@Context() [interaction]: SlashCommandContext, @Options() options: QuestDoneDto) {
      const { title } = options;
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      const success = this.loreService.completeQuest(active.id, title);
      if (success) return interaction.reply(`✅ Quest aggiornata come completata: **${title}**`);
      else return interaction.reply(`⚠️ Quest "${title}" non trovata.`);
  }

  // --- INVENTORY / INVENTARIO / BAG / LOOT ---
  @SlashCommand({ name: 'inventory', description: 'Visualizza l\'inventario di gruppo' })
  public async onInventory(@Context() [interaction]: SlashCommandContext) {
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      const items = this.loreService.getInventory(active.id);

      if (items.length === 0) return interaction.reply("Lo zaino è vuoto.");

      const list = items.map((i: any) => `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}`).join('\n');
      return interaction.reply(`**💰 Inventario di Gruppo (${active.name})**\n\n${list}`);
  }

  @SlashCommand({ name: 'inventario', description: 'Visualizza l\'inventario di gruppo (Alias)' })
  public async onInventario(@Context() [interaction]: SlashCommandContext) {
      return this.onInventory([interaction]);
  }

  @SlashCommand({ name: 'bag', description: 'Visualizza l\'inventario di gruppo (Alias)' })
  public async onBag(@Context() [interaction]: SlashCommandContext) {
      return this.onInventory([interaction]);
  }

  @SlashCommand({ name: 'loot-add', description: 'Aggiunge un oggetto all\'inventario' })
  public async onLootAdd(@Context() [interaction]: SlashCommandContext, @Options() options: LootAddDto) {
      const { item } = options;
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      this.loreService.addLoot(active.id, item);
      return interaction.reply(`💰 Aggiunto: **${item}**`);
  }

  @SlashCommand({ name: 'loot-use', description: 'Rimuove o usa un oggetto' })
  public async onLootUse(@Context() [interaction]: SlashCommandContext, @Options() options: LootUseDto) {
      const { item } = options;
      const active = await this.getActiveCampaignOrReply(interaction);
      if (!active) return;

      const removed = this.loreService.removeLoot(active.id, item);
      
      if (removed) return interaction.reply(`📉 Rimosso/Usato: **${item}**`);
      else return interaction.reply(`⚠️ Oggetto "${item}" non trovato nell'inventario.`);
  }
}
