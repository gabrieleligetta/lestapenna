/**
 * $eliminacampagna / $deletecampaign command - Delete a campaign
 */

import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getCampaigns, deleteCampaign } from '../../db';

export const deleteCampaignCommand: Command = {
    name: 'deletecampaign',
    aliases: ['eliminacampagna'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const nameOrId = ctx.args.join(' ');
        if (!nameOrId) {
            await ctx.message.reply("Uso: `$eliminacampagna <Nome o ID>`");
            return;
        }

        const campaigns = getCampaigns(ctx.guildId);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) {
            await ctx.message.reply("⚠️ Campagna non trovata.");
            return;
        }

        // Ask for confirmation
        await ctx.message.reply(`⚠️ **ATTENZIONE**: Stai per eliminare la campagna **${target.name}** e TUTTE le sue sessioni, registrazioni e memorie. Questa azione è irreversibile.\nScrivi \`CONFERMO\` per procedere.`);

        try {
            const collected = await (ctx.message.channel as TextChannel).awaitMessages({
                filter: (m: Message) => m.author.id === ctx.message.author.id && m.content === 'CONFERMO',
                max: 1,
                time: 15000,
                errors: ['time']
            });

            if (collected.size > 0) {
                deleteCampaign(target.id);
                await ctx.message.reply(`🗑️ Campagna **${target.name}** eliminata definitivamente.`);
            }
        } catch (e) {
            await ctx.message.reply("⌛ Tempo scaduto. Eliminazione annullata.");
        }
    }
};
