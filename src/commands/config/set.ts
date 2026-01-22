import { Command, CommandContext } from '../types';
import { setGuildConfig } from '../../db';

export const setCommand: Command = {
    name: 'set',
    aliases: ['setcmd', 'setsummary'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        if (commandName === 'setcmd') {
            if (!message.member?.permissions.has('ManageChannels')) {
                await message.reply("⛔ Non hai il permesso di configurare il bot.");
                return;
            }
            setGuildConfig(message.guild!.id, 'cmd_channel_id', message.channelId);
            await message.reply(`✅ Canale Comandi impostato su <#${message.channelId}>.`);
            return;
        }

        if (commandName === 'setsummary') {
            if (!message.member?.permissions.has('ManageChannels')) {
                await message.reply("⛔ Non hai il permesso di configurare il bot.");
                return;
            }
            setGuildConfig(message.guild!.id, 'summary_channel_id', message.channelId);
            await message.reply(`✅ Canale Riassunti impostato su <#${message.channelId}>.`);
            return;
        }
    }
};
