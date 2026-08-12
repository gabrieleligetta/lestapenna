/**
 * $inventario / $inventory / $loot command - Inventory management
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    removeLoot,
    getInventory,
    getSessionInventory,
    addInventoryEvent,
    getInventoryItemByName,
    getInventoryHistory,
    getInventoryItemByShortId
} from '../../db';
import { inventoryRepository } from '../../db/repositories/InventoryRepository';
import { getActiveSession } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { assertSessionInActiveCampaign } from '../utils/sessionScope';
import { generateBio } from '../../bard/bio';
import {
    EntityCrudSpec,
    handleEntityEventsSubcommand,
    matchTrailingEvents,
    showEventsByIdentifier,
    resolveEntity,
    resolveEntityName,
    resolveEntityWithRest,
    notFoundMessage,
    runPaginatedEntityList
} from '../utils/entityCrud';
import {
    startInteractiveInventoryAdd,
    startInteractiveInventoryUpdate,
    startInteractiveInventoryDelete
} from './inventoryInteractive';
import { getCampaignLocale, t } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';
import { assertCampaignWrite } from '../utils/campaignWrite';

const inventorySpec: EntityCrudSpec<any> = {
    labelKey: 'entity.item',
    gender: 'm',
    emoji: '📦',
    historyTable: 'inventory_history',
    historyKeyColumn: 'item_name',
    getByShortId: (cid, sid) => inventoryRepository.getInventoryItemByShortId(cid, sid),
    getByName: (cid, name) => inventoryRepository.getInventoryItemByName(cid, name),
    name: (i) => i.item_name,
    listForEvents: (cid) => getInventory(cid, 25, 0),
    selectionDescription: (i, locale) => `#${i.short_id} - ${t(locale, 'inventory.qtyShort')}: ${i.quantity}`,
    selectionEmoji: () => '📦',
    emptyEventsKey: 'entity.emptyInventory'
};

// Helper for regeneration - used ONLY for narrative notes
async function regenerateItemBio(campaignId: number, itemName: string) {
    const history = getInventoryHistory(campaignId, itemName);
    const item = getInventoryItemByName(campaignId, itemName);
    const currentDesc = item?.description || "";

    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('ITEM', { campaignId, name: itemName, currentDesc }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markInventoryDirtyForSync(campaignId: number, itemName: string) {
    inventoryRepository.markInventoryDirty(campaignId, itemName);
}

export const inventoryCommand: Command = {
    name: 'inventory',
    category: 'entita',
    descriptionKey: 'help.cmd.inventory',
    aliases: ['inventario', 'loot', 'bag'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const firstArg = ctx.args[0]?.toLowerCase();

        // Events Subcommand: $loot events [action] [Target]
        if (firstArg === 'events' || firstArg === 'eventi') {
            await handleEntityEventsSubcommand(ctx, inventorySpec);
            return;
        }

        const generateItemDetailEmbed = (item: any) => {
            // Controlla se è un artefatto
            const itemWithArtifact = inventoryRepository.getInventoryItemWithArtifactInfo(ctx.activeCampaign!.id, item.item_name);
            const isArtifact = itemWithArtifact?.is_artifact || false;
            const isCursed = itemWithArtifact?.is_cursed || false;

            const icon = isArtifact ? (isCursed ? '☠️' : '🔮') : '📦';
            const color = isArtifact ? (isCursed ? "#8B0000" : "#9B59B6") : "#F1C40F";

            const embed = new EmbedBuilder()
                .setTitle(`${icon} ${item.item_name}`)
                .setColor(color)
                .setDescription(item.description || t(ctx.locale, 'inventory.noDescription'))
                .addFields(
                    { name: t(ctx.locale, 'inventory.quantity'), value: item.quantity.toString(), inline: true },
                    { name: t(ctx.locale, 'inventory.id'), value: `\`#${item.short_id}\``, inline: true }
                );

            if (isArtifact) {
                embed.addFields({
                    name: t(ctx.locale, 'inventory.artifact'),
                    value: t(ctx.locale, 'inventory.artifactStatus', {
                        status: itemWithArtifact?.artifact_status || t(ctx.locale, 'inventory.unknown'),
                        cursed: isCursed ? t(ctx.locale, 'inventory.cursedTag') : ''
                    }),
                    inline: false
                });
            }

            if (item.notes) {
                embed.addFields({ name: t(ctx.locale, 'inventory.notes'), value: item.notes });
            }

            embed.setFooter({ text: t(ctx.locale, 'inventory.updateFooter', { id: item.short_id }) });
            return embed;
        };

        // --- SESSION SPECIFIC: $inventario <session_id> ---
        if (arg && isSessionId(arg)) {
            const sessionId = extractSessionId(arg);
            if (!await assertSessionInActiveCampaign(ctx, sessionId)) return;
            const sessionItems = getSessionInventory(sessionId);

            if (sessionItems.length === 0) {
                await ctx.message.reply(t(ctx.locale, 'inventory.sessionEmpty', { id: sessionId }));
                return;
            }

            const list = sessionItems.map((i: any) => {
                const desc = i.description ? `\n> *${i.description.substring(0, 100)}${i.description.length > 100 ? '...' : ''}*` : '';
                return `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
            }).join('\n');
            await ctx.message.reply(t(ctx.locale, 'inventory.sessionTitle', { id: sessionId, list }));
            return;
        }

        // SUBCOMMAND: $loot add <Item>
        if (arg.toLowerCase() === 'add' || arg.toLowerCase().startsWith('add ')) {
            const item = arg.substring(4).trim();
            if (!item) {
                await startInteractiveInventoryAdd(ctx);
                return;
            }
            const currentSession = (await getActiveSession(ctx.guildId));
            inventoryRepository.addLoot(ctx.activeCampaign!.id, item, 1, currentSession, undefined, true);

            // The "Item acquired" event is legitimate narrative
            if (currentSession) {
                addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, t(getCampaignLocale(ctx.activeCampaign!.id), 'inventory.eventAcquired'), "LOOT", true);
                markInventoryDirtyForSync(ctx.activeCampaign!.id, item);
            }

            await ctx.message.reply(t(ctx.locale, 'inventory.added', { item }));
            return;
        }

        // SUBCOMMAND: $loot update <Item> | <Note>
        if (arg.toLowerCase() === 'update' || arg.toLowerCase().startsWith('update ')) {
            const content = arg.substring(7).trim();
            if (!content) {
                await startInteractiveInventoryUpdate(ctx);
                return;
            }
            const parts = content.split('|');
            if (parts.length < 2) {
                // Name/ID only: when the item exists, start the interactive update on it
                const item = resolveEntityName(inventorySpec, ctx.activeCampaign!.id, parts[0].trim());
                const existing = inventoryRepository.getInventoryItemByName(ctx.activeCampaign!.id, item);
                if (existing) {
                    await startInteractiveInventoryUpdate({ ...ctx, args: [item] });
                    return;
                }

                await ctx.message.reply(t(ctx.locale, 'inventory.updateUsage'));
                return;
            }
            const item = resolveEntityName(inventorySpec, ctx.activeCampaign!.id, parts[0].trim());
            const note = parts.slice(1).join('|').trim();

            const existing = inventoryRepository.getInventoryItemByName(ctx.activeCampaign!.id, item);
            if (!existing) {
                await ctx.message.reply(t(ctx.locale, 'inventory.notFound', { item }));
                return;
            }

            const currentSession = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
            addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, note, "MANUAL_UPDATE", true);
            await ctx.message.reply(t(ctx.locale, 'inventory.noteAddedRegenerating', { item }));

            await regenerateItemBio(ctx.activeCampaign!.id, item);
            return;
        }

        // SUBCOMMAND: $loot use <Item|#id> [quantità]
        const usePrefixes = ['use ', 'usa ', 'remove '];
        const prefix = usePrefixes.find(p => arg.toLowerCase().startsWith(p));

        if (prefix) {
            const target = arg.substring(prefix.length).trim();
            const { entity, rest } = resolveEntityWithRest(inventorySpec, ctx.activeCampaign!.id, target);
            const item = entity ? inventorySpec.name(entity) : target;
            const qty = /^\d+$/.test(rest) ? Math.max(1, parseInt(rest)) : 1;

            const removed = removeLoot(ctx.activeCampaign!.id, item, qty);
            if (removed) {
                const currentSession = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
                // The "Item used" event is legitimate narrative
                addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, t(getCampaignLocale(ctx.activeCampaign!.id), 'inventory.eventUsed'), "USE", true);
                markInventoryDirtyForSync(ctx.activeCampaign!.id, item);
                await ctx.message.reply(t(ctx.locale, 'inventory.used', { item, quantity: qty > 1 ? ` ×${qty}` : '' }));
            }
            else await ctx.message.reply(t(ctx.locale, 'inventory.notInInventory', { item }));
            return;
        }

        // SUBCOMMAND: $loot delete <Item> (Full Wipe)
        if (arg.toLowerCase() === 'delete' || arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            const rawTarget = arg.split(' ').slice(1).join(' ').trim();

            if (!rawTarget) {
                await startInteractiveInventoryDelete(ctx);
                return;
            }

            const item = resolveEntityName(inventorySpec, ctx.activeCampaign!.id, rawTarget);
            const existing = inventoryRepository.getInventoryItemByName(ctx.activeCampaign!.id, item);
            if (!existing) {
                await ctx.message.reply(t(ctx.locale, 'inventory.notFound', { item }));
                return;
            }

            if (!await assertCampaignWrite(ctx)) return;
            await ctx.message.reply(t(ctx.locale, 'inventory.deleteProgress', { item }));

            const outcome = await deleteEntityFromCommand(ctx, 'inventory', existing);
            if (outcome.denied) return;
            await ctx.message.reply(
                t(ctx.locale, 'inventory.deletedFull', { item })
                + deleteSummaryLine(ctx.locale, outcome.report),
            );
            return;
        }

        // SUBCOMMAND: events - $loot <name/#id> events [page]
        const trailingEvents = matchTrailingEvents(arg);
        if (trailingEvents) {
            const found = await showEventsByIdentifier(ctx, inventorySpec, trailingEvents.identifier, trailingEvents.page);
            if (!found) {
                await ctx.message.reply(notFoundMessage(inventorySpec, trailingEvents.identifier, ctx.locale));
            }
            return;
        }

        // VIEW SPECIFIC ITEM: $loot <ID> or $loot #abcde or $loot <Name>
        if (arg && !arg.toLowerCase().startsWith('list') && !arg.toLowerCase().startsWith('lista')) {
            const itemDetail = resolveEntity(inventorySpec, ctx.activeCampaign!.id, arg);
            if (itemDetail) {
                await ctx.message.reply({ embeds: [generateItemDetailEmbed(itemDetail)] });
            } else {
                await ctx.message.reply(t(ctx.locale, 'inventory.notFound', { item: arg }));
            }
            return;
        }

        // VIEW: List (Paginated)
        let initialPage = 1;
        if (arg) {
            const parts = arg.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                initialPage = parseInt(parts[1]);
            }
        }

        await runPaginatedEntityList(ctx, {
            perPage: 10,
            fetchPage: (page, perPage) => ({
                // Use the function that includes artifact info
                items: inventoryRepository.getInventoryWithArtifactInfo(ctx.activeCampaign!.id, perPage, page * perPage),
                total: inventoryRepository.countInventory(ctx.activeCampaign!.id)
            }),
            buildEmbed: (items, page, totalPages, total) => {
                const list = items.map((i: any) => {
                    // Icona diversa per artefatti
                    const icon = i.is_artifact ? (i.is_cursed ? '☠️' : '🔮') : '📦';
                    const artifactBadge = i.is_artifact ? t(ctx.locale, 'inventory.artifactBadge') : '';
                    const desc = i.description ? `\n> *${i.description.substring(0, 80)}${i.description.length > 80 ? '...' : ''}*` : '';
                    return `\`#${i.short_id}\` ${icon} **${i.item_name}**${artifactBadge} ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
                }).join('\n\n');

                return new EmbedBuilder()
                    .setTitle(t(ctx.locale, 'inventory.groupTitle', { campaign: ctx.activeCampaign?.name || '' }))
                    .setColor("#F1C40F")
                    .setDescription(list)
                    .setFooter({ text: t(ctx.locale, 'inventory.pageTotal', { page: page + 1, totalPages, total }) });
            },
            emptyEmbed: () => new EmbedBuilder().setDescription(t(ctx.locale, 'inventory.empty')),
            buildDetailEmbed: generateItemDetailEmbed,
            selectOption: (i: any) => ({
                label: i.item_name,
                description: t(ctx.locale, 'inventory.optionDescription', {
                    id: i.short_id,
                    quantity: i.quantity,
                    artifact: i.is_artifact ? t(ctx.locale, 'inventory.artifactOptionTag') : ''
                }),
                emoji: i.is_artifact ? (i.is_cursed ? '☠️' : '🔮') : '📦'
            }),
            resolveSelected: (name) => getInventoryItemByName(ctx.activeCampaign!.id, name)
        }, initialPage);
    }
};
