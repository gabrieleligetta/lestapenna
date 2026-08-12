import { Command, CommandContext } from '../types';
import { setGuildConfig, getGuildConfig } from '../../db';
import { getGuildAdminId, isGuildOperator } from '../../utils/permissions';
import { t } from '../../i18n';

export const setCommand: Command = {
    name: 'set',
    category: 'admin',
    descriptionKey: 'help.cmd.set',
    aliases: ['setcmd', 'setsummary', 'setemail', 'setadmin'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        if (commandName === 'setcmd') {
            if (!message.member?.permissions.has('ManageChannels')) {
                await message.reply(t(ctx.locale, 'config.noPermission'));
                return;
            }
            setGuildConfig(message.guild!.id, 'cmd_channel_id', message.channelId);
            await message.reply(t(ctx.locale, 'config.commandChannelSet', { channel: message.channelId }));
            return;
        }

        if (commandName === 'setsummary') {
            if (!message.member?.permissions.has('ManageChannels')) {
                await message.reply(t(ctx.locale, 'config.noPermission'));
                return;
            }
            setGuildConfig(message.guild!.id, 'summary_channel_id', message.channelId);
            await message.reply(t(ctx.locale, 'config.summaryChannelSet', { channel: message.channelId }));
            return;
        }

        if (commandName === 'setemail') {
            if (!message.member?.permissions.has('ManageGuild')) {
                await message.reply(t(ctx.locale, 'config.noPermission'));
                return;
            }

            const emails = ctx.args.join(' ').trim();

            if (!emails) {
                // Mostra configurazione attuale
                const current = getGuildConfig(message.guild!.id, 'report_recipients');
                if (current) {
                    await message.reply(t(ctx.locale, 'config.currentEmails', { emails: current }));
                } else {
                    await message.reply(t(ctx.locale, 'config.noEmails'));
                }
                return;
            }

            // Valida formato email (base)
            const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const invalid = emailList.filter(e => !emailRegex.test(e));

            if (invalid.length > 0) {
                await message.reply(t(ctx.locale, 'config.invalidEmails', { emails: invalid.join(', ') }));
                return;
            }

            setGuildConfig(message.guild!.id, 'report_recipients', emailList.join(','));
            await message.reply(t(ctx.locale, 'config.emailsSet', { emails: emailList.join(', ') }));
            return;
        }

        if (commandName === 'setadmin') {
            // Who may appoint: the current administrator, the instance
            // developer, or whoever manages the server on Discord.
            //
            // That last one is not a widening: without it, on a freshly
            // installed instance — no `admin_user_id` in the configuration and
            // no DISCORD_DEVELOPER_ID — the comparison would be between the
            // identity of the person typing and two empty values, so nobody
            // could appoint the first administrator. As long as an ID lived in
            // the source the block was invisible, because someone always got
            // through: one single person, the same one on every installation
            // in the world.
            if (!isGuildOperator(message.author.id, message.guild!.id, message.member)) {
                await message.reply(t(ctx.locale, 'config.currentAdminOnly'));
                return;
            }

            const mention = message.mentions.users.first();
            const userId = mention?.id || ctx.args[0];

            if (!userId) {
                // Mostra admin attuale
                const admin = getGuildAdminId(message.guild!.id);
                if (getGuildConfig(message.guild!.id, 'admin_user_id')) {
                    await message.reply(t(ctx.locale, 'config.serverAdmin', { admin }));
                } else if (admin) {
                    await message.reply(t(ctx.locale, 'config.serverAdminDefault', { admin }));
                } else {
                    await message.reply(t(ctx.locale, 'config.serverAdminNone'));
                }
                return;
            }

            // Validate that it is a valid ID
            if (!/^\d{17,19}$/.test(userId)) {
                await message.reply(t(ctx.locale, 'config.invalidUserId'));
                return;
            }

            setGuildConfig(message.guild!.id, 'admin_user_id', userId);
            await message.reply(t(ctx.locale, 'config.newAdminSet', { admin: userId }));
            return;
        }
    }
};
