/**
 * $eliminacampagna / $deletecampaign command - Delete a campaign
 */

import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getCampaigns } from '../../db';
import { eraseCampaignData } from '../../services/dataErasure';
import { t } from '../../i18n';

export const deleteCampaignCommand: Command = {
    name: 'deletecampaign',
    category: 'campagna',
    descriptionKey: 'help.cmd.deletecampaign',
    aliases: ['eliminacampagna'],
    requiresCampaign: false,
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const nameOrId = ctx.args.join(' ');
        if (!nameOrId) {
            await ctx.message.reply(t(ctx.locale, 'campaign.deleteUsage'));
            return;
        }

        const campaigns = getCampaigns(ctx.guildId);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) {
            await ctx.message.reply(t(ctx.locale, 'campaign.notFound'));
            return;
        }

        // Ask for confirmation
        await ctx.message.reply(t(ctx.locale, 'campaign.deleteConfirm', { name: target.name }));

        try {
            const collected = await (ctx.message.channel as TextChannel).awaitMessages({
                filter: (m: Message) => m.author.id === ctx.message.author.id && ['CONFIRM', 'CONFERMO'].includes(m.content.trim().toUpperCase()),
                max: 1,
                time: 15000,
                errors: ['time']
            });

            if (collected.size > 0) {
                // Erases the audio and the transcripts too, not only the campaign
                // row: deleting a campaign used to leave both behind.
                await eraseCampaignData(target.id);
                await ctx.message.reply(t(ctx.locale, 'campaign.deleted', { name: target.name }));
            }
        } catch {
            await ctx.message.reply(t(ctx.locale, 'campaign.deleteTimeout'));
        }
    }
};
