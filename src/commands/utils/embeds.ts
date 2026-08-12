/**
 * Standard embeds and replies for every Discord command.
 *
 * One place for the colour palette, the layout of entity cards and the error
 * messages with usage hints: each command used to build its own EmbedBuilder
 * by hand (27 files) and replied to errors in its own way.
 */

import { EmbedBuilder, ColorResolvable } from 'discord.js';
import { Command, CommandContext } from '../types';
import { t, Locale } from '../../i18n';

/** The bot's official palette (the gold D4AF37 is the Bardo's historical colour). */
export const COLORS = {
    primary: '#D4AF37' as ColorResolvable,
    success: '#3BA55D' as ColorResolvable,
    error: '#ED4245' as ColorResolvable,
    warn: '#FAA61A' as ColorResolvable,
} as const;

/** Base embed in the Bardo's colour. */
export function baseEmbed(title: string, opts: { color?: ColorResolvable; footer?: string } = {}): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(opts.color || COLORS.primary)
        .setTitle(title);
    if (opts.footer) embed.setFooter({ text: opts.footer });
    return embed;
}

export interface EntityEmbedOptions {
    /** The entity's emoji, e.g. 👤 for NPCs, 🎒 for loot. */
    icon: string;
    title: string;
    /** Short-id (without #): shown in the title as a stable reference. */
    shortId?: string;
    description?: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    /** Operational hint at the foot of the card, e.g. "Usa $npc #ID per i dettagli". */
    footerHint?: string;
}

/** Uniform entity card (title with icon+short-id, fields, hint). */
export function entityEmbed(opts: EntityEmbedOptions): EmbedBuilder {
    const idSuffix = opts.shortId ? `  \`#${opts.shortId}\`` : '';
    const embed = baseEmbed(`${opts.icon} ${opts.title}${idSuffix}`, { footer: opts.footerHint });
    if (opts.description) embed.setDescription(opts.description);
    if (opts.fields?.length) embed.addFields(opts.fields.slice(0, 25)); // limite Discord
    return embed;
}

/** "`$usage` — description" lines from the command's metadata, in `locale`. */
export function formatUsage(cmd: Command, locale: Locale): string {
    return (cmd.usage || [])
        .map(u => `\`${u.usage}\` — ${t(locale, u.descriptionKey)}`)
        .join('\n');
}

/**
 * Standard error reply: a red embed with the message and, when the command has
 * `usage` metadata, the usage examples; otherwise it points to $help.
 */
export async function errorReply(ctx: CommandContext, msg: string, cmd?: Command): Promise<void> {
    const embed = baseEmbed(t(ctx.locale, 'common.errorTitle'), { color: COLORS.error })
        .setDescription(msg);

    const usageText = cmd ? formatUsage(cmd, ctx.locale) : '';
    if (usageText) {
        embed.addFields({ name: t(ctx.locale, 'common.usageTitle'), value: usageText.substring(0, 1024) });
    } else {
        embed.setFooter({ text: t(ctx.locale, 'common.helpFooter', { cmd: cmd?.name || '' }).trim() });
    }

    await ctx.message.reply({ embeds: [embed] });
}

/** Shows a command's syntax (for missing/malformed arguments). */
export async function usageReply(ctx: CommandContext, cmd: Command): Promise<void> {
    const usageText = formatUsage(cmd, ctx.locale);
    const localizedDesc = cmd.descriptionKey ? t(ctx.locale, cmd.descriptionKey) : '';
    const embed = baseEmbed(t(ctx.locale, 'common.usageOf', { cmd: `$${cmd.name}` }), { color: COLORS.warn })
        .setDescription(usageText || localizedDesc || t(ctx.locale, 'common.helpFooter', { cmd: cmd.name }));
    await ctx.message.reply({ embeds: [embed] });
}
