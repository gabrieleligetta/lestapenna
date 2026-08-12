/**
 * $segnala — reporting a problem or a violation, from Discord.
 *
 * Discord's Developer Policy makes this an obligation, not a courtesy:
 * developers must «provide users of their Application with a way to report
 * issues or violations relating to the Application or its use», and must review
 * those reports and act on them.
 *
 * The web app already has one — the red button in `AppShell` — but it sits
 * behind a login that most people at a table will never go through. The bot is
 * where they are, so the way to report has to be here as well.
 *
 * It feeds the **same** pipeline as the web button (`ReportsService` → the
 * `reports/` prefix on the bucket → the notification email), so a report filed
 * from Discord is triaged exactly like any other. See `docs/REPORTS-FLOW.md`.
 */

import { Command, CommandContext } from '../types';
import { ReportsService } from '../../api/reports/reports.service';
import { baseEmbed, COLORS } from '../utils/embeds';
import { config } from '../../config';
import { t } from '../../i18n';

const MIN_LENGTH = 10;

export const reportCommand: Command = {
    name: 'report',
    category: 'meta',
    descriptionKey: 'help.cmd.report',
    aliases: ['segnala', 'reportar', 'signaler', 'melden', 'reportarpt'],
    requiresCampaign: false,
    usage: [
        { usage: '$segnala <descrizione>', descriptionKey: 'help.cmd.report' },
    ],

    async execute(ctx: CommandContext): Promise<void> {
        const description = (ctx.rawArgs ?? ctx.args.join(' ')).trim();

        if (description.length < MIN_LENGTH) {
            await ctx.message.reply({
                embeds: [
                    baseEmbed(t(ctx.locale, 'report.title'), { color: COLORS.warn })
                        .setDescription(t(ctx.locale, 'report.usage', {
                            contact: config.links.contactEmail || '',
                        })),
                ],
            });
            return;
        }

        try {
            const service = new ReportsService();
            const created = await service.create({
                type: 'OTHER',
                severity: 'medium',
                description,
                locale: ctx.locale,
                guildId: ctx.guildId,
                campaignId: ctx.activeCampaign?.id,
                reporter: {
                    discordUserId: ctx.message.author.id,
                    username: ctx.message.author.username,
                    globalName: ctx.message.author.globalName ?? null,
                },
            });

            await ctx.message.reply({
                embeds: [
                    baseEmbed(t(ctx.locale, 'report.title'), { color: COLORS.success })
                        .setDescription(t(ctx.locale, 'report.sent', { id: created.id })),
                ],
            });
        } catch (error) {
            // Storage may be unconfigured on a self-hosted instance. Losing the
            // report silently would defeat the obligation this command exists
            // for, so we fall back to telling them where to write instead.
            console.error('[Report] Could not store the report:', error);
            await ctx.message.reply({
                embeds: [
                    baseEmbed(t(ctx.locale, 'report.title'), { color: COLORS.error })
                        .setDescription(t(ctx.locale, 'report.failed', {
                            contact: config.links.contactEmail || '',
                        })),
                ],
            });
        }
    },
};
