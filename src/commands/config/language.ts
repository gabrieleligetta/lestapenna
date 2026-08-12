import { Command, CommandContext } from '../types';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import {
    SUPPORTED_LOCALES, LANGUAGE_NAMES,
    normalizeLocale, setGuildLocale, getCampaignLocale, t,
} from '../../i18n';

/**
 * $language — two distinct languages:
 * - `$language <code>`: the bot's INTERFACE language (per guild, menus/replies);
 * - `$language campagna <code>`: the SPOKEN language of the active campaign
 *   (Whisper transcription + AI summaries/output). Default: inherits the guild.
 * With no arguments it shows both.
 */
export const languageCommand: Command = {
    name: 'language',
    category: 'admin',
    descriptionKey: 'help.cmd.language',
    aliases: ['lingua', 'idioma', 'langue', 'sprache'],
    requiresCampaign: false,
    adminOnly: true,
    usage: [
        { usage: '$language', descriptionKey: 'help.usage.language.show' },
        { usage: '$language en', descriptionKey: 'help.usage.language.ui' },
        { usage: '$language campagna it', descriptionKey: 'help.usage.language.campaign' },
    ],

    async execute(ctx: CommandContext) {
        const list = SUPPORTED_LOCALES.map(l => `\`${l}\` (${LANGUAGE_NAMES[l]})`).join(', ');
        const first = ctx.args[0]?.toLowerCase();

        // --- No argument: show the interface language + the campaign language ---
        if (!first) {
            let campaignLine = '';
            if (ctx.activeCampaign) {
                const campaignLocale = getCampaignLocale(ctx.activeCampaign.id);
                campaignLine = t(ctx.locale, 'language.campaignLine', {
                    campaign: ctx.activeCampaign.name,
                    name: LANGUAGE_NAMES[campaignLocale],
                });
            }
            await ctx.message.reply(t(ctx.locale, 'language.current', {
                name: LANGUAGE_NAMES[ctx.locale],
                campaignLine,
                list,
            }));
            return;
        }

        // --- $language campagna <code>: spoken language of the active campaign ---
        const isCampaignSub = ['campagna', 'campaign', 'campaña', 'campagne', 'kampagne', 'campanha'].includes(first);
        if (isCampaignSub) {
            if (!ctx.activeCampaign) {
                await ctx.message.reply(t(ctx.locale, 'language.noCampaign'));
                return;
            }
            const code = ctx.args[1];
            const locale = normalizeLocale(code);
            if (!locale) {
                await ctx.message.reply(t(ctx.locale, 'language.invalid', { code: code || '?', list }));
                return;
            }
            campaignRepository.setCampaignLanguage(ctx.activeCampaign.id, locale);
            await ctx.message.reply(t(ctx.locale, 'language.campaignSet', {
                campaign: ctx.activeCampaign.name,
                name: LANGUAGE_NAMES[locale],
            }));
            return;
        }

        // --- $language <code>: the interface language (per guild) ---
        const locale = normalizeLocale(first);
        if (!locale) {
            await ctx.message.reply(t(ctx.locale, 'language.invalid', { code: first, list }));
            return;
        }

        setGuildLocale(ctx.guildId, locale);
        // Confirmation in the NEW language: immediate feedback that the change is live.
        await ctx.message.reply(t(locale, 'language.set', { name: LANGUAGE_NAMES[locale] }));
    },
};
