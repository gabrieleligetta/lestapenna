import {
    ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    Message, ComponentType,
} from 'discord.js';
import { campaignRepository } from '../../db/repositories/CampaignRepository';
import {
    Locale, SUPPORTED_LOCALES, LANGUAGE_NAMES, normalizeLocale, t,
} from '../../i18n';

const LANGUAGE_FLAGS: Record<Locale, string> = {
    en: '🇬🇧', it: '🇮🇹', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', 'pt-BR': '🇧🇷',
};

/**
 * After a campaign is created, asks with a select which language it is played
 * in (transcription + summaries). On timeout it sets nothing: the campaign
 * inherits the guild's language (campaigns.language = NULL).
 */
export async function promptCampaignLanguage(
    replyTo: Message,
    uiLocale: Locale,
    campaignId: number,
    campaignName: string,
    userId: string,
): Promise<void> {
    const select = new StringSelectMenuBuilder()
        .setCustomId(`campaign_language_${campaignId}`)
        .setPlaceholder('Language / Lingua / Idioma / Langue / Sprache / Português')
        .addOptions(SUPPORTED_LOCALES.map(l =>
            new StringSelectMenuOptionBuilder()
                .setLabel(LANGUAGE_NAMES[l])
                .setValue(l)
                .setEmoji(LANGUAGE_FLAGS[l])
        ));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const prompt = await replyTo.reply({
        content: t(uiLocale, 'campaign.chooseLanguage', { name: campaignName }),
        components: [row],
    });

    try {
        const choice = await prompt.awaitMessageComponent({
            componentType: ComponentType.StringSelect,
            time: 120_000,
            filter: (i) => i.customId === `campaign_language_${campaignId}` && i.user.id === userId,
        });
        const locale = normalizeLocale(choice.values[0]);
        if (locale) {
            campaignRepository.setCampaignLanguage(campaignId, locale);
            await choice.update({
                content: t(uiLocale, 'language.campaignSet', {
                    campaign: campaignName,
                    name: LANGUAGE_NAMES[locale],
                }),
                components: [],
            });
            return;
        }
        await choice.update({ components: [] });
    } catch {
        // Timeout: the campaign inherits the guild's language.
        try { await prompt.edit({ components: [] }); } catch { }
    }
}
