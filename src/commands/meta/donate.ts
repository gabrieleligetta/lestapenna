/**
 * $dona — where the web app is, and how to support the project.
 *
 * Lestapenna sells nothing and bills nothing: under BYOK each table pays its own
 * provider directly, so there is no revenue anywhere in the system. A donation
 * is therefore about the work, not about the service, and the copy says so
 * plainly rather than implying that giving money improves anything.
 *
 * Every link comes from the config and each one is optional. An instance that
 * sets `DONATION_URL=` shows no donation link at all — a fork should not be
 * quietly collecting money for upstream, and someone self-hosting for four
 * friends may not want to ask them for anything.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Command, CommandContext } from '../types';
import { baseEmbed } from '../utils/embeds';
import { config } from '../../config';
import { t } from '../../i18n';

export const donateCommand: Command = {
    name: 'donate',
    category: 'meta',
    descriptionKey: 'help.cmd.donate',
    aliases: ['dona', 'sostieni', 'support'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { donationUrl, repoUrl, webAppUrl } = config.links;

        if (!donationUrl && !repoUrl && !webAppUrl) {
            await ctx.message.reply(t(ctx.locale, 'donate.nothingConfigured'));
            return;
        }

        const embed = baseEmbed(t(ctx.locale, 'donate.title'))
            .setDescription(t(ctx.locale, 'donate.body'));

        if (webAppUrl) {
            embed.addFields({
                name: t(ctx.locale, 'donate.webField'),
                value: t(ctx.locale, 'donate.webValue', { url: `<${webAppUrl}>` }),
            });
        }

        // Link buttons carry no customId and need no collector: they are just
        // links that happen to look like buttons, so nothing here expires.
        const row = new ActionRowBuilder<ButtonBuilder>();
        if (donationUrl) {
            row.addComponents(new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel(t(ctx.locale, 'donate.buttonSponsor'))
                .setEmoji('💛')
                .setURL(donationUrl));
        }
        if (webAppUrl) {
            row.addComponents(new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel(t(ctx.locale, 'donate.buttonWeb'))
                .setEmoji('🌐')
                .setURL(webAppUrl));
        }
        if (repoUrl) {
            row.addComponents(new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel(t(ctx.locale, 'donate.buttonRepo'))
                .setEmoji('⭐')
                .setURL(repoUrl));
        }

        await ctx.message.reply({
            embeds: [embed],
            components: row.components.length ? [row] : [],
        });
    },
};
