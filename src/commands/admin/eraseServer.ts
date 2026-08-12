/**
 * $cancellaserver — the administrator erases the whole server's data on request.
 *
 * The `guildDelete` handler already erases everything when the bot is removed,
 * so this exists for the case where the table wants its archive gone but wants
 * to keep using the bot — a campaign that ended, a server changing hands, a
 * data subject request arriving at the administrator, who under this
 * architecture is the controller (see `public/legal/terms.html` §3a).
 *
 * Double confirmation, and the second one has to be the server's own name: this
 * destroys everybody's history, not just the history of whoever typed it.
 */

import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { eraseGuildData } from '../../services/dataErasure';
import { baseEmbed, COLORS } from '../utils/embeds';
import { t } from '../../i18n';

export const eraseServerCommand: Command = {
    name: 'eraseserver',
    category: 'admin',
    descriptionKey: 'help.cmd.eraseserver',
    aliases: ['cancellaserver', 'borrarservidor', 'effacerserveur', 'serverloeschen', 'apagarservidor'],
    requiresCampaign: false,
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const guildName = message.guild?.name ?? '';

        await message.reply({
            embeds: [
                baseEmbed(t(ctx.locale, 'privacy.eraseServerTitle'), { color: COLORS.error })
                    .setDescription(t(ctx.locale, 'privacy.eraseServerConfirm', { name: guildName })),
            ],
        });

        try {
            const collected = await (message.channel as TextChannel).awaitMessages({
                filter: (m: Message) =>
                    m.author.id === message.author.id &&
                    m.content.trim().toLowerCase() === guildName.trim().toLowerCase(),
                max: 1,
                time: 60_000,
                errors: ['time'],
            });
            if (collected.size === 0) return;
        } catch {
            await message.reply(t(ctx.locale, 'privacy.eraseServerTimeout'));
            return;
        }

        try {
            const result = await eraseGuildData(ctx.guildId);
            const total = Object.values(result.rows).reduce((sum, n) => sum + n, 0);

            if (result.failedPrefixes.length > 0) {
                await message.reply({
                    embeds: [
                        baseEmbed(t(ctx.locale, 'privacy.eraseServerTitle'), { color: COLORS.error })
                            .setDescription(t(ctx.locale, 'privacy.eraseServerPartial')),
                    ],
                });
                return;
            }

            await message.reply({
                embeds: [
                    baseEmbed(t(ctx.locale, 'privacy.eraseServerTitle'), { color: COLORS.success })
                        .setDescription(t(ctx.locale, 'privacy.eraseServerDone', {
                            rows: String(total),
                            files: String(result.objects + result.localFiles),
                        })),
                ],
            });
        } catch (error) {
            console.error('[EraseServer] Erasure failed:', error);
            await message.reply(t(ctx.locale, 'privacy.eraseServerError'));
        }
    },
};
