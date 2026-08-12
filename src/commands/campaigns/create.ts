/**
 * $creacampagna / $createcampaign command - Create a new campaign
 */

import { Command, CommandContext } from '../types';
import { startInteractiveCampaignCreate } from './interactiveUpdate';
import { promptCampaignLanguage } from '../utils/campaignLanguage';
import { createCampaignWithParty } from '../../services/campaignSetup';
import { t } from '../../i18n';

export const createCampaignCommand: Command = {
    name: 'createcampaign',
    category: 'campagna',
    descriptionKey: 'help.cmd.createcampaign',
    aliases: ['creacampagna'],
    requiresCampaign: false,
    // Creating a campaign shapes the server's whole workspace.
    adminOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const name = ctx.args.join(' ');
        if (!name) {
            await startInteractiveCampaignCreate(ctx);
            return;
        }

        // Creates the campaign + party faction and enrols the creator as MASTER.
        const campaign = createCampaignWithParty({
            guildId: ctx.guildId,
            name,
            creatorUserId: ctx.message.author.id,
        });

        await ctx.message.reply(t(ctx.locale, 'campaign.created', { name }));

        // 🆕 The campaign's spoken language (transcription + summaries); on timeout
        // it inherits the guild's language.
        await promptCampaignLanguage(ctx.message, ctx.locale, campaign.id, name, ctx.message.author.id);
    }
};
