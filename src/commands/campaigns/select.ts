/**
 * $selezionacampagna / $selectcampaign command - Select active campaign
 */

import { Command, CommandContext } from '../types';
import { getCampaigns, setActiveCampaign } from '../../db';
import { startInteractiveCampaignSelect } from './interactiveUpdate';
import { t } from '../../i18n';

export const selectCampaignCommand: Command = {
    name: 'selectcampaign',
    category: 'campagna',
    descriptionKey: 'help.cmd.selectcampaign',
    aliases: ['selezionacampagna', 'setcampagna', 'setcampaign'],
    requiresCampaign: false,
    // Switching the active campaign redirects every other command on the
    // server, including where the next session gets recorded.
    adminOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const nameOrId = ctx.args.join(' ');
        if (!nameOrId) {
            await startInteractiveCampaignSelect(ctx);
            return;
        }

        const campaigns = getCampaigns(ctx.guildId);
        const target = campaigns.find(c => c.name.toLowerCase() === nameOrId.toLowerCase() || c.id.toString() === nameOrId);

        if (!target) {
            await ctx.message.reply(t(ctx.locale, 'campaign.notFound'));
            return;
        }

        setActiveCampaign(ctx.guildId, target.id);
        await ctx.message.reply(t(ctx.locale, 'campaign.activeSet', { name: target.name }));
    }
};
