/**
 * $party / $compagni command - Show all party members
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getCampaignCharacters } from '../../db';

export const partyCommand: Command = {
    name: 'party',
    aliases: ['compagni'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const characters = getCampaignCharacters(ctx.activeCampaign!.id);

        if (characters.length === 0) {
            await ctx.message.reply("Nessun avventuriero registrato in questa campagna.");
            return;
        }

        const list = characters.map(c => {
            const name = c.character_name || "Sconosciuto";
            const details = [c.race, c.class].filter(Boolean).join(' - ');
            return `**${name}**${details ? ` (${details})` : ''}`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`🛡️ Party: ${ctx.activeCampaign!.name}`)
            .setColor("#9B59B6")
            .setDescription(list);

        await ctx.message.reply({ embeds: [embed] });
    }
};
