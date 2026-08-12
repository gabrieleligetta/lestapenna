/**
 * Shared CRUD blocks for the entity commands ($loot, $bestiario, $artifact, $quest).
 *
 * Each of the 4 commands used to duplicate (~70%): short-id/name resolution,
 * the events subcommand trio (dispatch + interactive selection + view by
 * identifier), the parsing of `update <target> [| note | field value]`
 * and the scaffolding of the paginated list (buttons + select menu + collector).
 * It lives here once, driven by a declarative per-entity spec;
 * the commands keep only their business logic and specific rendering.
 */

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageComponentInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} from 'discord.js';
import { CommandContext } from '../types';
import { parseShortId } from '../../utils/shortId';
import { showEntityEvents } from './eventsViewer';
import { handleEventsAction } from './eventsSubcommand';
import { Locale, MessageKey, t } from '../../i18n';

export interface EntityCrudSpec<T> {
    /** i18n key of the entity label, e.g. 'entity.item'. */
    labelKey: MessageKey;
    /** Grammatical gender for the participles in the messages ("trovato"/"trovata"). */
    gender: 'm' | 'f';
    emoji: string;
    /** History table and key column, e.g. 'inventory_history'/'item_name'. */
    historyTable: string;
    historyKeyColumn: string;
    getByShortId(campaignId: number, shortId: string): T | null | undefined;
    getByName(campaignId: number, name: string): T | null | undefined;
    /** The entity's canonical name (item_name / name / title). */
    name(entity: T): string;
    /** Entities offered in the event selection menu (truncated to 25). */
    listForEvents(campaignId: number): T[];
    /** Descriptive line in the selection menu, e.g. "#a3f9c - Qty: 2". */
    selectionDescription(entity: T, locale: Locale): string;
    selectionEmoji(entity: T): string;
    /** i18n key of the message shown when there is nothing to select. */
    emptyEventsKey: MessageKey;
}

export function notFoundMessage<T>(spec: EntityCrudSpec<T>, identifier: string, locale: Locale): string {
    return t(locale, spec.gender === 'f' ? 'crud.notFoundF' : 'crud.notFoundM', {
        label: t(locale, spec.labelKey),
        id: identifier,
    });
}

export interface ResolvedWithRest<T> {
    entity: T | null;
    /** Trailing tokens not consumed by the resolution (quantity, page...). */
    rest: string;
}

/**
 * Resolution tolerant of trailing tokens. In order:
 * 1. first token as a short-id → rest = everything else;
 * 2. the whole string as an exact name (always wins: a literal "Pozione 2" stays resolvable);
 * 3. the name minus the last token when numeric → rest = that number (page/quantity).
 */
export function resolveEntityWithRest<T>(spec: EntityCrudSpec<T>, campaignId: number, input: string): ResolvedWithRest<T> {
    const tokens = input.trim().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return { entity: null, rest: '' };

    const sid = parseShortId(tokens[0]);
    if (sid) {
        const byId = spec.getByShortId(campaignId, sid);
        if (byId) return { entity: byId, rest: tokens.slice(1).join(' ') };
    }

    const byFullName = spec.getByName(campaignId, input.trim());
    if (byFullName) return { entity: byFullName, rest: '' };

    const lastToken = tokens[tokens.length - 1];
    if (tokens.length > 1 && /^\d+$/.test(lastToken)) {
        const byTrimmedName = spec.getByName(campaignId, tokens.slice(0, -1).join(' '));
        if (byTrimmedName) return { entity: byTrimmedName, rest: lastToken };
    }

    return { entity: null, rest: '' };
}

/** Resolves a short-id (#abcde or abcde) or a name; null when not found. */
export function resolveEntity<T>(spec: EntityCrudSpec<T>, campaignId: number, identifier: string): T | null {
    return resolveEntityWithRest(spec, campaignId, identifier).entity;
}

/** Like resolveEntity, but returns the canonical name (or the input as it was). */
export function resolveEntityName<T>(spec: EntityCrudSpec<T>, campaignId: number, identifier: string): string {
    const entity = resolveEntity(spec, campaignId, identifier);
    return entity ? spec.name(entity) : identifier;
}

/** Events view by identifier; false when the entity does not exist. */
export async function showEventsByIdentifier<T>(
    ctx: CommandContext,
    spec: EntityCrudSpec<T>,
    identifier: string,
    page: number = 1
): Promise<boolean> {
    const campaignId = ctx.activeCampaign!.id;
    const entity = resolveEntity(spec, campaignId, identifier);
    if (!entity) return false;

    await showEntityEvents(ctx, {
        tableName: spec.historyTable,
        entityKeyColumn: spec.historyKeyColumn,
        entityKeyValue: spec.name(entity),
        campaignId,
        entityDisplayName: spec.name(entity),
        entityEmoji: spec.emoji,
        entityId: (entity as any).id ?? null
    }, page);

    return true;
}

/** Entity selection menu → event history. */
export async function startEventsInteractiveSelection<T>(ctx: CommandContext, spec: EntityCrudSpec<T>) {
    const campaignId = ctx.activeCampaign!.id;
    const entities = spec.listForEvents(campaignId).slice(0, 25);

    if (entities.length === 0) {
        await ctx.message.reply(t(ctx.locale, spec.emptyEventsKey));
        return;
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_entity_events')
        .setPlaceholder(t(ctx.locale, spec.gender === 'f' ? 'crud.selectPlaceholderF' : 'crud.selectPlaceholderM', { label: t(ctx.locale, spec.labelKey).toLowerCase() }))
        .addOptions(
            entities.map(e =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(spec.name(e).substring(0, 100))
                    .setDescription(spec.selectionDescription(e, ctx.locale))
                    .setValue(spec.name(e))
                    .setEmoji(spec.selectionEmoji(e))
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const reply = await ctx.message.reply({
        content: t(ctx.locale, spec.gender === 'f' ? 'crud.selectPromptF' : 'crud.selectPromptM', { label: t(ctx.locale, spec.labelKey).toLowerCase() }),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_entity_events' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const entity = spec.getByName(ctx.activeCampaign!.id, interaction.values[0]);
        if (entity) {
            await interaction.update({ content: t(ctx.locale, 'crud.loadingEvents', { name: spec.name(entity) }), components: [] });
            await showEntityEvents(ctx, {
                tableName: spec.historyTable,
                entityKeyColumn: spec.historyKeyColumn,
                entityKeyValue: spec.name(entity),
                campaignId: ctx.activeCampaign!.id,
                entityDisplayName: spec.name(entity),
                entityEmoji: spec.emoji,
                entityId: (entity as any).id ?? null
            }, 1);
        } else {
            await interaction.reply({ content: notFoundMessage(spec, interaction.values[0], ctx.locale), ephemeral: true });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            await reply.edit({ content: t(ctx.locale, 'crud.selectionTimeout'), components: [] }).catch(() => { });
        }
    });
}

/**
 * Handles `$cmd events [add|update|delete] [target] [page]` in full.
 * Call it when the first argument is events/eventi; the caller returns
 * immediately afterwards.
 */
export async function handleEntityEventsSubcommand<T>(ctx: CommandContext, spec: EntityCrudSpec<T>): Promise<void> {
    const remainder = ctx.args.slice(1);

    const handled = await handleEventsAction(ctx, remainder, {
        tableName: spec.historyTable,
        entityKeyColumn: spec.historyKeyColumn,
        emoji: spec.emoji,
        labelKey: spec.labelKey,
        gender: spec.gender,
        resolve: (campaignId, identifier) => {
            const entity = resolveEntity(spec, campaignId, identifier);
            return entity
                ? { keyValue: spec.name(entity), displayName: spec.name(entity), entityId: (entity as any).id ?? null }
                : null;
        }
    });
    if (handled) return;

    const target = remainder.join(' ').trim().toLowerCase();
    if (remainder.length === 0 || target === 'list' || target === 'lista') {
        await startEventsInteractiveSelection(ctx, spec);
        return;
    }

    // An optional trailing page number: `$cmd events <Name|#id> 2`
    const identifier = remainder.join(' ');
    const { entity, rest } = resolveEntityWithRest(spec, ctx.activeCampaign!.id, identifier);
    if (!entity) {
        await ctx.message.reply(notFoundMessage(spec, identifier, ctx.locale));
        return;
    }
    const page = /^\d+$/.test(rest) ? parseInt(rest) : 1;

    await showEntityEvents(ctx, {
        tableName: spec.historyTable,
        entityKeyColumn: spec.historyKeyColumn,
        entityKeyValue: spec.name(entity),
        campaignId: ctx.activeCampaign!.id,
        entityDisplayName: spec.name(entity),
        entityEmoji: spec.emoji,
        entityId: (entity as any).id ?? null
    }, page);
}

/** Match of `<name/#id> events [page]` at the end of the argument. */
export function matchTrailingEvents(arg: string): { identifier: string; page: number } | null {
    const m = arg.match(/^(.+?)\s+(events|eventi)(?:\s+(\d+))?$/i);
    if (!m) return null;
    return { identifier: m[1].trim(), page: m[3] ? parseInt(m[3]) : 1 };
}

/**
 * Parsing of the target of `update <Name or #ID> [| note | field value]`.
 * `keywords` are the metadata fields accepted after the name (e.g. 'status').
 */
export function parseUpdateTarget(fullContent: string, keywords: string[]): { targetIdentifier: string; remainingArgs: string } {
    if (fullContent.startsWith('#')) {
        const parts = fullContent.split(' ');
        return { targetIdentifier: parts[0], remainingArgs: parts.slice(1).join(' ') };
    }

    if (fullContent.includes('|')) {
        return {
            targetIdentifier: fullContent.split('|')[0].trim(),
            remainingArgs: "|" + fullContent.split('|').slice(1).join('|')
        };
    }

    // A free name followed by a metadata keyword: cut at the last occurrence.
    const lower = fullContent.toLowerCase();
    for (const kw of keywords) {
        const idx = lower.lastIndexOf(` ${kw} `);
        if (idx !== -1) {
            return {
                targetIdentifier: fullContent.substring(0, idx).trim(),
                remainingArgs: fullContent.substring(idx + 1).trim()
            };
        }
    }
    return { targetIdentifier: fullContent, remainingArgs: "" };
}

/**
 * Help embed for `update`: current values + editable fields.
 * `fieldsHelp` is the already formatted text of the fields (varies per entity).
 */
export async function showUpdateHelpEmbed(
    ctx: CommandContext,
    opts: { title: string; currentValues: string; fieldsHelp: string; errorMsg?: string }
): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle(opts.title)
        .setColor("#3498DB")
        .setDescription(opts.errorMsg ? `⚠️ **${opts.errorMsg}**\n\n` : "")
        .addFields(
            { name: t(ctx.locale, 'crud.updateCurrentValues'), value: opts.currentValues, inline: false },
            { name: t(ctx.locale, 'crud.updateFields'), value: opts.fieldsHelp }
        );
    await ctx.message.reply({ embeds: [embed] });
}

export interface PaginatedListSpec<T> {
    /** Items of the requested page + the overall total. */
    fetchPage(page: number, perPage: number): { items: T[]; total: number };
    perPage: number;
    /** Embed for the page (the list is already rendered by the caller). */
    buildEmbed(items: T[], page: number, totalPages: number, total: number): EmbedBuilder;
    /** Embed per lista vuota. */
    emptyEmbed(): EmbedBuilder | string;
    /** Detail card shown on selection. */
    buildDetailEmbed(entity: T): EmbedBuilder;
    /** Entry of the select menu. */
    selectOption(entity: T): { label: string; description: string; emoji: string };
    /** Re-fetches the selected entity (for fresh data). */
    resolveSelected(value: string): T | null | undefined;
    /** Detail reply visible only to the user (default false). */
    detailEphemeral?: boolean;
}

/**
 * Standard paginated list: embed + page buttons + detail select menu,
 * with a collector restricted to the command's author (5 minutes).
 */
export async function runPaginatedEntityList<T>(
    ctx: CommandContext,
    spec: PaginatedListSpec<T>,
    initialPage: number = 1
): Promise<void> {
    const first = spec.fetchPage(0, spec.perPage);
    if (first.total === 0) {
        const empty = spec.emptyEmbed();
        await ctx.message.reply(typeof empty === 'string' ? empty : { embeds: [empty] });
        return;
    }

    const totalPages = Math.ceil(first.total / spec.perPage);
    let currentPage = Math.min(Math.max(0, initialPage - 1), totalPages - 1);

    const generateButtons = (page: number, pages: number) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('prev_page')
                .setLabel(t(ctx.locale, 'common.prevButton'))
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId('next_page')
                .setLabel(t(ctx.locale, 'common.nextButton'))
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === pages - 1)
        );

    const generateSelectMenu = (items: T[]) => {
        if (items.length === 0) return null;
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_entity')
            .setPlaceholder(t(ctx.locale, 'crud.selectDetails'))
            .addOptions(
                items.map(e => {
                    const opt = spec.selectOption(e);
                    return new StringSelectMenuOptionBuilder()
                        .setLabel(opt.label.substring(0, 100))
                        .setDescription(opt.description.substring(0, 100))
                        .setValue(opt.label.substring(0, 100))
                        .setEmoji(opt.emoji);
                })
            );
        return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    };

    const render = (page: number) => {
        const { items, total } = spec.fetchPage(page, spec.perPage);
        const pages = Math.max(1, Math.ceil(total / spec.perPage));
        const components: any[] = [];
        if (pages > 1) components.push(generateButtons(page, pages));
        const selectRow = generateSelectMenu(items);
        if (selectRow) components.push(selectRow);
        return { embed: spec.buildEmbed(items, page, pages, total), components, pages };
    };

    const initial = render(currentPage);
    const reply = await ctx.message.reply({ embeds: [initial.embed], components: initial.components });

    const collector = reply.createMessageComponentCollector({ time: 60000 * 5 });

    collector.on('collect', async (interaction: MessageComponentInteraction) => {
        if (interaction.user.id !== ctx.message.author.id) {
            await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'prev_page') currentPage = Math.max(0, currentPage - 1);
            else if (interaction.customId === 'next_page') currentPage++;

            const next = render(currentPage);
            await interaction.update({ embeds: [next.embed], components: next.components });
        } else if (interaction.isStringSelectMenu() && interaction.customId === 'select_entity') {
            const entity = spec.resolveSelected(interaction.values[0]);
            if (entity) {
                await interaction.reply({ embeds: [spec.buildDetailEmbed(entity)], ephemeral: spec.detailEphemeral || false });
            } else {
                await interaction.reply({ content: t(ctx.locale, 'crud.itemNotFound'), ephemeral: true });
            }
        }
    });

    collector.on('end', () => {
        reply.edit({ components: [] }).catch(() => { });
    });
}
