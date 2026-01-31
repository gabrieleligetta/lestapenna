import { Command, CommandContext } from '../types';
import { setGuildConfig, getGuildConfig } from '../../db';
import { config } from '../../config';

// Il Developer ID di default (fallback globale)
const DEFAULT_DEVELOPER_ID = config.discord.developerId;

export const setCommand: Command = {
    name: 'set',
    aliases: ['setcmd', 'setsummary', 'setemail', 'setadmin'],
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

        if (commandName === 'setemail') {
            if (!message.member?.permissions.has('ManageGuild')) {
                await message.reply("⛔ Non hai il permesso di configurare il bot.");
                return;
            }

            const emails = ctx.args.join(' ').trim();

            if (!emails) {
                // Mostra configurazione attuale
                const current = getGuildConfig(message.guild!.id, 'report_recipients');
                if (current) {
                    await message.reply(`📧 **Email Report attuali:** ${current}`);
                } else {
                    await message.reply(`📧 Nessuna email configurata per questo server.\nUso: \`$setemail email1@example.com, email2@example.com\``);
                }
                return;
            }

            // Valida formato email (base)
            const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const invalid = emailList.filter(e => !emailRegex.test(e));

            if (invalid.length > 0) {
                await message.reply(`❌ Email non valide: ${invalid.join(', ')}`);
                return;
            }

            setGuildConfig(message.guild!.id, 'report_recipients', emailList.join(','));
            await message.reply(`✅ **Email Report impostate:** ${emailList.join(', ')}`);
            return;
        }

        if (commandName === 'setadmin') {
            // Solo il developer globale o l'admin attuale può cambiare admin
            const currentAdmin = getGuildConfig(message.guild!.id, 'admin_user_id') || DEFAULT_DEVELOPER_ID;
            if (message.author.id !== currentAdmin && message.author.id !== DEFAULT_DEVELOPER_ID) {
                await message.reply("⛔ Solo l'admin attuale può designare un nuovo admin.");
                return;
            }

            const mention = message.mentions.users.first();
            const userId = mention?.id || ctx.args[0];

            if (!userId) {
                // Mostra admin attuale
                const admin = getGuildConfig(message.guild!.id, 'admin_user_id');
                if (admin) {
                    await message.reply(`👑 **Admin del server:** <@${admin}>`);
                } else {
                    await message.reply(`👑 **Admin del server:** <@${DEFAULT_DEVELOPER_ID}> (default)`);
                }
                return;
            }

            // Valida che sia un ID valido
            if (!/^\d{17,19}$/.test(userId)) {
                await message.reply("❌ ID utente non valido. Usa menzione o ID numerico.");
                return;
            }

            setGuildConfig(message.guild!.id, 'admin_user_id', userId);
            await message.reply(`✅ **Nuovo admin del server:** <@${userId}>\nQuesto utente può ora usare i comandi admin ($wipe, $rebuild, ecc.)`);
            return;
        }
    }
};
