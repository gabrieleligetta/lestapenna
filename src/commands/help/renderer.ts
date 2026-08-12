/**
 * Single renderer for $help (guild locale) and $aiuto (IT).
 *
 * This used to be ~680 lines of hand-curated prose, six copies of it — one per
 * locale — listing command names as literal strings. Predictably it drifted: it
 * advertised `$resetpg` and `$clearchara`, which are not registered anywhere,
 * while never mentioning `$members`, `$artifact`, `$travels`, `$download` or
 * `$session`. Roughly half the command table was missing, and adding a command
 * meant remembering to edit six blocks.
 *
 * Now the pages are built from the registry itself (`ctx.dispatcher`), so a
 * command appears in the help because it exists, and its description is an i18n
 * key like every other user-facing string. The guard in
 * `tests/unit/commands/helpCoverage.test.ts` is what keeps it that way.
 */

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageComponentInteraction,
} from 'discord.js';
import { Command, CommandContext, CommandCategory, CATEGORY_ORDER } from '../types';
import { baseEmbed, COLORS, formatUsage } from '../utils/embeds';
import { Locale, t } from '../../i18n';
import { config } from '../../config';

/** How long the buttons stay live. */
const COLLECTOR_MS = 5 * 60 * 1000;

/**
 * The commands shown on the normal pages.
 *
 * Everything destructive lives behind `$help dev`: it stays fully usable, but a
 * player browsing the guide should not meet `$rebuild` between `$party` and
 * `$timeline`.
 */
function visibleCommands(all: Command[]): Command[] {
    return all.filter(c => c.category && c.category !== 'dev' && !c.operatorOnly);
}

function commandsIn(all: Command[], category: CommandCategory): Command[] {
    return all
        .filter(c => c.category === category)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** The categories that actually have something to show, in CATEGORY_ORDER. */
function populatedCategories(all: Command[]): CommandCategory[] {
    return CATEGORY_ORDER.filter(cat => cat !== 'dev' && commandsIn(all, cat).length > 0);
}

/** «`$name` — description», plus an `admin` badge where the gate applies. */
function commandLines(cmds: Command[], locale: Locale): string {
    return cmds.map(c => {
        const badge = c.adminOnly ? ` *(${t(locale, 'help.adminBadge')})*` : '';
        const desc = c.descriptionKey ? t(locale, c.descriptionKey) : '';
        return `\`$${c.name}\`${badge} — ${desc}`;
    }).join('\n');
}

/** The CTA line that closes every page. Empty when the instance configured none. */
function ctaLine(): string {
    const parts: string[] = [];
    if (config.links.webAppUrl) parts.push(`🌐 <${config.links.webAppUrl}>`);
    if (config.links.donationUrl) parts.push('💛 `$dona`');
    return parts.join('  ·  ');
}

function categoryEmbed(
    ctx: CommandContext,
    locale: Locale,
    all: Command[],
    categories: CommandCategory[],
    page: number,
): EmbedBuilder {
    const category = categories[page];
    const cmds = commandsIn(all, category);

    const embed = baseEmbed(`${t(locale, 'help.title')} · ${t(locale, `help.cat.${category}` as never)}`)
        .setDescription(commandLines(cmds, locale))
        .setFooter({
            text: t(locale, 'help.pageFooter', {
                page: page + 1,
                total: categories.length,
                n: cmds.length,
            }),
        });

    const cta = ctaLine();
    if (cta) embed.addFields({ name: '​', value: cta });
    return embed;
}

function devEmbed(locale: Locale, all: Command[]): EmbedBuilder {
    const cmds = commandsIn(all, 'dev');
    return baseEmbed(t(locale, 'help.cat.dev'), { color: COLORS.warn })
        .setDescription(t(locale, 'help.dangerNote') + '\n\n' + commandLines(cmds, locale));
}

/** The detail card for a single command, built from its own metadata. */
function commandEmbed(locale: Locale, cmd: Command): EmbedBuilder {
    const embed = baseEmbed(`\`$${cmd.name}\``)
        .setDescription(cmd.descriptionKey ? t(locale, cmd.descriptionKey) : '');

    const usage = formatUsage(cmd, locale);
    if (usage) embed.addFields({ name: t(locale, 'common.usageTitle'), value: usage.substring(0, 1024) });

    if (cmd.aliases.length) {
        embed.addFields({
            name: t(locale, 'help.aliasesLabel'),
            value: cmd.aliases.map(a => `\`$${a}\``).join(', '),
        });
    }

    const permission = cmd.operatorOnly
        ? t(locale, 'help.permOperator')
        : cmd.adminOnly ? t(locale, 'help.permAdmin') : t(locale, 'help.permEveryone');
    embed.addFields({ name: t(locale, 'help.permLabel'), value: permission });

    return embed;
}

function buildComponents(
    locale: Locale,
    categories: CommandCategory[],
    page: number,
): ActionRowBuilder<any>[] {
    const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('help_prev')
            .setLabel(t(locale, 'common.prevButton'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId('help_next')
            .setLabel(t(locale, 'common.nextButton'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === categories.length - 1),
    );

    const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_category')
            .setPlaceholder(t(locale, 'help.selectCategory'))
            .addOptions(categories.map((cat, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(t(locale, `help.cat.${cat}` as never))
                    .setValue(String(i))
                    .setDefault(i === page),
            )),
    );

    return [nav, select];
}

/**
 * Renders the help for the given locale: a single command, the danger zone, or
 * the browsable category pages.
 */
export async function renderHelp(ctx: CommandContext, locale: Locale): Promise<void> {
    const all = ctx.dispatcher?.getCommands() ?? [];
    const arg = ctx.args[0]?.toLowerCase();

    // --- DANGER ZONE ---
    if (arg === 'dev') {
        await ctx.message.reply({ embeds: [devEmbed(locale, all)] });
        return;
    }

    const visible = visibleCommands(all);
    const categories = populatedCategories(visible);

    // --- A SINGLE COMMAND, OR A CATEGORY BY NAME ---
    if (arg) {
        const byCategory = categories.indexOf(arg as CommandCategory);
        if (byCategory === -1) {
            const cmd = all.find(c => c.name === arg || c.aliases.includes(arg));
            if (!cmd) {
                await ctx.message.reply(t(locale, 'help.notFound', { arg }));
                return;
            }
            await ctx.message.reply({ embeds: [commandEmbed(locale, cmd)] });
            return;
        }
        await sendBrowser(ctx, locale, visible, categories, byCategory);
        return;
    }

    await sendBrowser(ctx, locale, visible, categories, 0);
}

/** The paginated view, with its collector. */
async function sendBrowser(
    ctx: CommandContext,
    locale: Locale,
    visible: Command[],
    categories: CommandCategory[],
    initialPage: number,
): Promise<void> {
    const pageCategories = categories;
    let page = initialPage;

    const intro = baseEmbed(t(locale, 'help.title'))
        .setDescription(`${t(locale, 'help.intro')}\n\n${t(locale, 'help.devHint')}`);

    const reply = await ctx.message.reply({
        embeds: [intro, categoryEmbed(ctx, locale, visible, pageCategories, page)],
        components: buildComponents(locale, pageCategories, page),
    });

    const collector = reply.createMessageComponentCollector({ time: COLLECTOR_MS });

    collector.on('collect', async (interaction: MessageComponentInteraction) => {
        // The buttons belong to whoever asked for the help: otherwise anyone
        // passing by could flip the page from under them.
        if (interaction.user.id !== ctx.message.author.id) {
            await interaction.reply({ content: t(locale, 'common.onlyInvoker'), ephemeral: true });
            return;
        }

        if (interaction.isButton()) {
            page = interaction.customId === 'help_prev'
                ? Math.max(0, page - 1)
                : Math.min(pageCategories.length - 1, page + 1);
        } else if (interaction.isStringSelectMenu()) {
            page = parseInt(interaction.values[0], 10);
        }

        await interaction.update({
            embeds: [intro, categoryEmbed(ctx, locale, visible, pageCategories, page)],
            components: buildComponents(locale, pageCategories, page),
        });
    });

    collector.on('end', async () => {
        // Buttons that no longer answer are worse than no buttons.
        try {
            await reply.edit({ components: [] });
        } catch { /* message deleted, nothing to do */ }
    });
}
