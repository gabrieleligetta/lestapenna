/**
 * $dimenticami — a person asks for their own data to be erased.
 *
 * Discord's Developer Terms §5(b) require deleting API Data when «the applicable
 * user requests you delete it», and — separately — require giving users «an
 * easily accessible way» to ask. An address in a privacy policy that nobody at
 * the table will ever open is not an accessible way. The people whose voices end
 * up in this database are in a voice channel on Discord, so the way out has to
 * be on Discord too, next to the notice that told them they were being recorded.
 *
 * The confirmation step is not ceremony. This is irreversible and it is
 * self-service: someone must not be able to destroy their own session history by
 * mistyping a command name.
 */

import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { eraseUserData } from '../../services/dataErasure';
import { baseEmbed, COLORS } from '../utils/embeds';
import { t } from '../../i18n';

export const forgetMeCommand: Command = {
    name: 'forgetme',
    category: 'meta',
    descriptionKey: 'help.cmd.forgetme',
    aliases: ['dimenticami', 'olvidame', 'oubliemoi', 'vergissmich', 'esquecame'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;

        await message.reply({
            embeds: [
                baseEmbed(t(ctx.locale, 'privacy.forgetMeTitle'), { color: COLORS.warn })
                    .setDescription(t(ctx.locale, 'privacy.forgetMeConfirm')),
            ],
        });

        try {
            const collected = await (message.channel as TextChannel).awaitMessages({
                filter: (m: Message) =>
                    m.author.id === message.author.id &&
                    ['CONFIRM', 'CONFERMO'].includes(m.content.trim().toUpperCase()),
                max: 1,
                time: 30_000,
                errors: ['time'],
            });
            if (collected.size === 0) return;
        } catch {
            await message.reply(t(ctx.locale, 'privacy.forgetMeTimeout'));
            return;
        }

        try {
            const result = await eraseUserData(ctx.guildId, message.author.id);
            const total = Object.values(result.rows).reduce((sum, n) => sum + n, 0);

            if (result.failedPrefixes.length > 0) {
                // Saying «done» when part of it survives would be the one failure
                // mode this whole command exists to prevent.
                await message.reply({
                    embeds: [
                        baseEmbed(t(ctx.locale, 'privacy.forgetMeTitle'), { color: COLORS.error })
                            .setDescription(t(ctx.locale, 'privacy.forgetMePartial')),
                    ],
                });
                return;
            }

            await message.reply({
                embeds: [
                    baseEmbed(t(ctx.locale, 'privacy.forgetMeTitle'), { color: COLORS.success })
                        .setDescription(t(ctx.locale, 'privacy.forgetMeDone', {
                            rows: String(total),
                            files: String(result.objects + result.localFiles),
                        })),
                ],
            });
        } catch (error) {
            console.error('[ForgetMe] Erasure failed:', error);
            await message.reply(t(ctx.locale, 'privacy.forgetMeError'));
        }
    },
};
