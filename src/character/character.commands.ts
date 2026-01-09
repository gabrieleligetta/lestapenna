import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, Options, SlashCommandContext } from 'necord';
import { CharacterService } from './character.service';
import { CampaignService } from '../campaign/campaign.service';
import { StringOption } from 'necord';
import { EmbedBuilder } from 'discord.js';

class SetNameDto {
  @StringOption({
    name: 'name',
    description: 'Il nome del tuo personaggio',
    required: true,
  })
  name: string;
}

class SetClassDto {
  @StringOption({
    name: 'class_name',
    description: 'La classe del tuo personaggio (es. Barbaro, Mago)',
    required: true,
  })
  className: string;
}

class SetRaceDto {
  @StringOption({
    name: 'race_name',
    description: 'La razza del tuo personaggio (es. Elfo, Nano)',
    required: true,
  })
  raceName: string;
}

class SetDescDto {
  @StringOption({
    name: 'description',
    description: 'Breve descrizione del personaggio',
    required: true,
  })
  description: string;
}

@Injectable()
export class CharacterCommands {
  constructor(
    private readonly characterService: CharacterService,
    private readonly campaignService: CampaignService
  ) {}

  private async getActiveCampaignOrReply(interaction: any) {
    const active = this.campaignService.getActive(interaction.guildId!);
    if (!active) {
      await interaction.reply({ content: "⚠️ Nessuna campagna attiva. Chiedi a un admin di attivarne una.", ephemeral: true });
      return null;
    }
    return active;
  }

  @SlashCommand({ name: 'iam', description: 'Imposta il nome del tuo personaggio' })
  public async onIam(@Context() [interaction]: SlashCommandContext, @Options() { name }: SetNameDto) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    if (name.toUpperCase() === 'DM' || name.toUpperCase() === 'DUNGEON MASTER') {
      this.characterService.updateUserCharacter(interaction.user.id, active.id, 'character_name', 'DM');
      this.characterService.updateUserCharacter(interaction.user.id, active.id, 'class', 'Dungeon Master');
      this.characterService.updateUserCharacter(interaction.user.id, active.id, 'race', 'Narratore');
      return interaction.reply(`🎲 **Saluti, Dungeon Master.** Il Bardo è ai tuoi ordini per la campagna **${active.name}**.`);
    }

    this.characterService.updateUserCharacter(interaction.user.id, active.id, 'character_name', name);
    return interaction.reply(`⚔️ Nome aggiornato: **${name}** (Campagna: ${active.name})`);
  }

  @SlashCommand({ name: 'myclass', description: 'Imposta la classe del tuo personaggio' })
  public async onMyClass(@Context() [interaction]: SlashCommandContext, @Options() { className }: SetClassDto) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.characterService.updateUserCharacter(interaction.user.id, active.id, 'class', className);
    return interaction.reply(`🛡️ Classe aggiornata: **${className}**`);
  }

  @SlashCommand({ name: 'myrace', description: 'Imposta la razza del tuo personaggio' })
  public async onMyRace(@Context() [interaction]: SlashCommandContext, @Options() { raceName }: SetRaceDto) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.characterService.updateUserCharacter(interaction.user.id, active.id, 'race', raceName);
    return interaction.reply(`🧬 Razza aggiornata: **${raceName}**`);
  }

  @SlashCommand({ name: 'mydesc', description: 'Imposta la descrizione del tuo personaggio' })
  public async onMyDesc(@Context() [interaction]: SlashCommandContext, @Options() { description }: SetDescDto) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.characterService.updateUserCharacter(interaction.user.id, active.id, 'description', description);
    return interaction.reply(`📜 Descrizione aggiornata! Il Bardo prenderà nota.`);
  }

  @SlashCommand({ name: 'whoami', description: 'Mostra il tuo profilo personaggio corrente' })
  public async onWhoAmI(@Context() [interaction]: SlashCommandContext) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    const p = this.characterService.getUserProfile(interaction.user.id, active.id);
    if (p.character_name) {
      const embed = new EmbedBuilder()
        .setTitle(`👤 Profilo di ${p.character_name}`)
        .setDescription(`Campagna: **${active.name}**`)
        .setColor("#3498DB")
        .addFields(
          { name: "⚔️ Nome", value: p.character_name || "Non impostato", inline: true },
          { name: "🛡️ Classe", value: p.class || "Sconosciuta", inline: true },
          { name: "🧬 Razza", value: p.race || "Sconosciuta", inline: true },
          { name: "📜 Biografia", value: p.description || "Nessuna descrizione." }
        )
        .setThumbnail(interaction.user.displayAvatarURL());

      return interaction.reply({ embeds: [embed] });
    } else {
      return interaction.reply("Non ti conosco in questa campagna. Usa `/iam` per iniziare la tua leggenda!");
    }
  }

  @SlashCommand({ name: 'party', description: 'Mostra tutti i personaggi della campagna' })
  public async onParty(@Context() [interaction]: SlashCommandContext) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    const characters = this.characterService.getCampaignCharacters(active.id);

    if (characters.length === 0) {
      return interaction.reply("Nessun avventuriero registrato in questa campagna.");
    }

    const list = characters.map(c => {
      const name = c.character_name || "Sconosciuto";
      const details = [c.race, c.class].filter(Boolean).join(' - ');
      return `**${name}**${details ? ` (${details})` : ''}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Party: ${active.name}`)
      .setColor("#9B59B6")
      .setDescription(list);

    return interaction.reply({ embeds: [embed] });
  }

  @SlashCommand({ name: 'resetpg', description: 'Cancella il tuo personaggio corrente' })
  public async onResetPg(@Context() [interaction]: SlashCommandContext) {
    const active = await this.getActiveCampaignOrReply(interaction);
    if (!active) return;

    this.characterService.deleteUserCharacter(interaction.user.id, active.id);
    return interaction.reply("🗑️ Scheda personaggio resettata. Ora sei un'anima errante.");
  }
}
