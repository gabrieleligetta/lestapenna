import {
    Client, Guild, TextChannel, ChannelType, EmbedBuilder,
    ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config';
import { tenantRepository } from '../db/repositories/TenantRepository';
import {
    Locale, DEFAULT_LOCALE, SUPPORTED_LOCALES, LANGUAGE_NAMES,
    getGuildLocale, setGuildLocale, normalizeLocale, t,
} from '../i18n';

// Track guilds that have already received welcome message (prevents duplicates)
const welcomedGuilds = new Set<string>();

// Clear welcomed status after 5 minutes (allows re-sending if needed after restart)
const WELCOME_DEBOUNCE_MS = 5 * 60 * 1000;

export function markGuildAsWelcomed(guildId: string): void {
    welcomedGuilds.add(guildId);
    setTimeout(() => welcomedGuilds.delete(guildId), WELCOME_DEBOUNCE_MS);
}

export function hasBeenWelcomed(guildId: string): boolean {
    return welcomedGuilds.has(guildId);
}

export function buildWelcomeEmbed(locale: Locale = DEFAULT_LOCALE): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(t(locale, 'welcome.title'))
        .setColor("#9B59B6")
        .setDescription(t(locale, 'welcome.desc'))
        .addFields(
            { name: t(locale, 'welcome.step1Name'), value: t(locale, 'welcome.step1Value'), inline: false },
            { name: t(locale, 'welcome.step2Name'), value: t(locale, 'welcome.step2Value'), inline: false },
            { name: t(locale, 'welcome.step3Name'), value: t(locale, 'welcome.step3Value'), inline: false },
            { name: t(locale, 'welcome.step4Name'), value: t(locale, 'welcome.step4Value'), inline: false },
            { name: t(locale, 'welcome.step5Name'), value: t(locale, 'welcome.step5Value'), inline: false },
            { name: t(locale, 'welcome.sessionName'), value: t(locale, 'welcome.sessionValue'), inline: false }
        )
        .setFooter({ text: t(locale, 'welcome.footer') });
}

// Pre-language-selection prompt: deliberately multilingual and NOT routed
// through t(), because at this point the guild has not picked a language yet.
const LANGUAGE_SELECT_PROMPT =
    '🌍 **Choose your language · Scegli la lingua · Elige tu idioma · Choisis ta langue · Wähle deine Sprache · Escolha seu idioma**';

const LANGUAGE_FLAGS: Record<Locale, string> = {
    en: '🇬🇧', it: '🇮🇹', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', 'pt-BR': '🇧🇷',
};

// Only server managers may choose: within 15 minutes, after which we fall back
// to the guessed language (Discord preferredLocale) and show the welcome anyway.
const LANGUAGE_SELECT_TIMEOUT_MS = 15 * 60_000;

/**
 * Onboarding flow: FIRST ask for the language with a select, THEN show the
 * welcome message in the chosen language. On timeout, use the guessed language.
 */
export async function sendLanguageSelectThenWelcome(channel: TextChannel, guild: Guild): Promise<void> {
    const select = new StringSelectMenuBuilder()
        .setCustomId('setup_language')
        .setPlaceholder('Language / Lingua / Idioma / Langue / Sprache')
        .addOptions(SUPPORTED_LOCALES.map(l =>
            new StringSelectMenuOptionBuilder()
                .setLabel(LANGUAGE_NAMES[l])
                .setValue(l)
                .setEmoji(LANGUAGE_FLAGS[l])
        ));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const prompt = await channel.send({ content: LANGUAGE_SELECT_PROMPT, components: [row] });

    let locale: Locale = getGuildLocale(guild.id, guild.preferredLocale);
    try {
        const choice = await prompt.awaitMessageComponent({
            time: LANGUAGE_SELECT_TIMEOUT_MS,
            filter: (i) =>
                i.customId === 'setup_language' &&
                (i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false),
        });
        await choice.deferUpdate();
        if (choice.isStringSelectMenu()) {
            const chosen = normalizeLocale(choice.values[0]);
            if (chosen) {
                locale = chosen;
                setGuildLocale(guild.id, chosen);
            }
        }
    } catch {
        // Timed out with no choice: carry on with the guessed language.
    }

    try { await prompt.edit({ components: [] }); } catch { }
    await channel.send({ embeds: [buildWelcomeEmbed(locale)] });
}

export function registerGuildJoinHandler(client: Client) {
    client.on('guildCreate', async (guild) => {
        console.log(`[GuildJoin] Bot aggiunto al server: ${guild.name} (${guild.id})`);

        // DEV_GUILD_ID: If set, only handle that specific guild
        if (config.discord.devGuildId && guild.id !== config.discord.devGuildId) {
            console.log(`[GuildJoin] DEV_GUILD_ID attivo, ignoro server ${guild.name}`);
            return;
        }

        // IGNORE_GUILD_IDS: Skip these guilds
        if (config.discord.ignoreGuildIds.includes(guild.id)) {
            console.log(`[GuildJoin] Server ${guild.name} in ignore list, skip`);
            return;
        }

        // Guild record: written on join, idempotent on re-join.
        // There are no plans or quotas — this only tracks who administers it.
        try {
            const existing = tenantRepository.getTenant(guild.id);
            if (!existing) {
                tenantRepository.createTenant(guild.id, guild.ownerId);
                console.log(`[GuildJoin] Gilda registrata: ${guild.name} (${guild.id})`);
            }
        } catch (e) {
            console.error(`[GuildJoin] Registrazione gilda fallita per ${guild.id}:`, e);
        }

        // Check debounce to prevent duplicate messages
        if (hasBeenWelcomed(guild.id)) {
            console.log(`[GuildJoin] Server ${guild.name} già notificato di recente, skip.`);
            return;
        }

        // Try to find a suitable channel to send the welcome message
        // Priority: system channel > first text channel where we can send
        let targetChannel: TextChannel | null = null;

        if (guild.systemChannel) {
            targetChannel = guild.systemChannel;
        } else {
            // Find first text channel we have permission to send to
            const textChannels = guild.channels.cache
                .filter(ch => ch.type === ChannelType.GuildText)
                .filter(ch => {
                    const perms = ch.permissionsFor(client.user!);
                    return perms?.has('SendMessages') && perms?.has('ViewChannel');
                });

            if (textChannels.size > 0) {
                targetChannel = textChannels.first() as TextChannel;
            }
        }

        if (targetChannel) {
            try {
                markGuildAsWelcomed(guild.id);
                console.log(`[GuildJoin] Avvio onboarding (select lingua) in #${targetChannel.name}`);
                // Fire-and-forget: the select waits up to 15 min, it must not block the handler.
                sendLanguageSelectThenWelcome(targetChannel, guild)
                    .catch(e => console.error(`[GuildJoin] Onboarding fallito per ${guild.name}:`, e));
            } catch (e) {
                console.error(`[GuildJoin] Impossibile avviare l'onboarding:`, e);
            }
        } else {
            console.warn(`[GuildJoin] Nessun canale disponibile per il messaggio di benvenuto in ${guild.name}`);
        }
    });
}
