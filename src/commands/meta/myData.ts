/**
 * $imieidati — a person asks for a copy of what we hold about them.
 *
 * Unlike {@link ./forgetMe}, this one is not asked for by Discord: the Developer
 * Terms only require an accessible way to have data «modified and deleted», and
 * the words *download*, *export* and *portability* appear nowhere in either
 * document. It comes from the first line of §5(a) instead — «you will comply
 * with all applicable privacy laws… including the GDPR» — and from GDPR art. 15
 * and 20, which do require a copy in a machine-readable format.
 *
 * The reply goes to **DM**, not to the channel. The export contains that
 * person's transcribed speech, and posting it into a shared text channel would
 * be a disclosure dressed up as a subject access request. When DMs are closed we
 * say so and stop, rather than falling back to the channel.
 */

import { AttachmentBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { exportUserData } from '../../services/dataExport';
import { baseEmbed, COLORS } from '../utils/embeds';
import { t } from '../../i18n';

export const myDataCommand: Command = {
    name: 'mydata',
    category: 'meta',
    descriptionKey: 'help.cmd.mydata',
    aliases: ['imieidati', 'misdatos', 'mesdonnees', 'meinedaten', 'meusdados'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;

        try {
            const data = exportUserData(ctx.guildId, message.author.id);
            const payload = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
            const file = new AttachmentBuilder(payload, {
                name: `lestapenna-${ctx.guildId}-${message.author.id}.json`,
            });

            await message.author.send({
                embeds: [
                    baseEmbed(t(ctx.locale, 'privacy.myDataTitle'), { color: COLORS.primary })
                        .setDescription(t(ctx.locale, 'privacy.myDataBody')),
                ],
                files: [file],
            });

            await message.reply(t(ctx.locale, 'privacy.myDataSent'));
        } catch (error) {
            // Discord rejects a DM to someone with them closed. That is a real
            // answer to give, not an internal error to swallow.
            console.error('[MyData] Export failed:', error);
            await message.reply(t(ctx.locale, 'privacy.myDataError'));
        }
    },
};
