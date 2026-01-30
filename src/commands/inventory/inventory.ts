/**
 * $inventario / $inventory / $loot command - Inventory management
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    addLoot,
    removeLoot,
    getInventory,
    getSessionInventory,
    mergeInventoryItems,
    addInventoryEvent,
    getInventoryItemByName,
    getInventoryHistory,
    deleteInventoryHistory,
    deleteInventoryRagSummary,
    getInventoryItemByShortId
} from '../../db';
import { inventoryRepository } from '../../db/repositories/InventoryRepository';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { generateBio } from '../../bard/bio';
import { showEntityEvents } from '../utils/eventsViewer';

// Helper for Regen
async function regenerateItemBio(campaignId: number, itemName: string) {
    const history = getInventoryHistory(campaignId, itemName);
    const item = getInventoryItemByName(campaignId, itemName);
    const currentDesc = item?.description || "";

    // Map history to simple objects
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('ITEM', { campaignId, name: itemName, currentDesc }, simpleHistory);
}

export const inventoryCommand: Command = {
    name: 'inventory',
    aliases: ['inventario', 'loot', 'bag'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

        const generateItemDetailEmbed = (item: any) => {
            const embed = new EmbedBuilder()
                .setTitle(`📦 ${item.item_name}`)
                .setColor("#F1C40F")
                .setDescription(item.description || "*Nessuna descrizione.*")
                .addFields(
                    { name: "Quantità", value: item.quantity.toString(), inline: true },
                    { name: "ID", value: `\`#${item.short_id}\``, inline: true }
                );

            if (item.notes) {
                embed.addFields({ name: "📝 Note", value: item.notes });
            }

            embed.setFooter({ text: `Usa $loot update ${item.short_id} | <Nota> per aggiornare.` });
            return embed;
        };

        // --- SESSION SPECIFIC: $inventario <session_id> ---
        if (arg && isSessionId(arg)) {
            const sessionId = extractSessionId(arg);
            const sessionItems = getSessionInventory(sessionId);

            if (sessionItems.length === 0) {
                await ctx.message.reply(
                    `💰 Nessun oggetto acquisito nella sessione \`${sessionId}\`.\n` +
                    `*Nota: Solo gli oggetti aggiunti dopo l'aggiornamento vengono tracciati per sessione.*`
                );
                return;
            }

            const list = sessionItems.map((i: any) => {
                const desc = i.description ? `\n> *${i.description.substring(0, 100)}${i.description.length > 100 ? '...' : ''}*` : '';
                return `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
            }).join('\n');
            await ctx.message.reply(`**💰 Loot della Sessione \`${sessionId}\`:**\n\n${list}`);
            return;
        }

        // SUBCOMMAND: $loot add <Item>
        if (arg.toLowerCase().startsWith('add ')) {
            const item = arg.substring(4).trim();
            const currentSession = guildSessions.get(ctx.guildId);
            addLoot(ctx.activeCampaign!.id, item, 1, currentSession, undefined, true);

            // Add Event
            if (currentSession) {
                addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, "Oggetto acquisito.", "LOOT", true);
                regenerateItemBio(ctx.activeCampaign!.id, item);
            }

            await ctx.message.reply(`💰 Aggiunto: **${item}**`);
            return;
        }

        // SUBCOMMAND: $loot update <Item> | <Note>
        if (arg.toLowerCase().startsWith('update ')) {
            const content = arg.substring(7);
            const parts = content.split('|');
            if (parts.length < 2) {
                await ctx.message.reply("⚠️ Uso: `$loot update <Oggetto/ID> | <Nota/Storia>`");
                return;
            }
            let item = parts[0].trim();
            const note = parts.slice(1).join('|').trim();

            // ID Resolution
            const sidMatch = item.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const itemEntry = getInventoryItemByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (itemEntry) item = itemEntry.item_name;
            }

            const existing = getInventoryItemByName(ctx.activeCampaign!.id, item);
            if (!existing) {
                await ctx.message.reply(`❌ Oggetto non trovato: "${item}"`);
                return;
            }

            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, note, "MANUAL_UPDATE", true);
            await ctx.message.reply(`📝 Nota aggiunta a **${item}**. Aggiornamento leggenda...`);

            await regenerateItemBio(ctx.activeCampaign!.id, item);
            return;
        }

        // SUBCOMMAND: $loot use <Item>
        const usePrefixes = ['use ', 'usa ', 'remove '];
        const prefix = usePrefixes.find(p => arg.toLowerCase().startsWith(p));

        if (prefix) {
            let item = arg.substring(prefix.length).trim();

            // ID Resolution
            const sidMatch = item.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const itemEntry = getInventoryItemByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (itemEntry) item = itemEntry.item_name;
            }

            const removed = removeLoot(ctx.activeCampaign!.id, item, 1);
            if (removed) {
                const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
                addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, "Oggetto utilizzato/rimosso.", "USE", true);
                regenerateItemBio(ctx.activeCampaign!.id, item);
                await ctx.message.reply(`📉 Rimosso/Usato: **${item}**`);
            }
            else await ctx.message.reply(`⚠️ Oggetto "${item}" non trovato nell'inventario.`);
            return;
        }

        // SUBCOMMAND: $loot delete <Item> (Full Wipe)
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let item = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const sidMatch = item.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const itemEntry = getInventoryItemByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (itemEntry) item = itemEntry.item_name;
            }

            const existing = getInventoryItemByName(ctx.activeCampaign!.id, item);
            if (!existing) {
                await ctx.message.reply(`❌ Oggetto non trovato: "${item}"`);
                return;
            }

            // Full Wipe
            await ctx.message.reply(`🗑️ Eliminazione completa per **${item}** in corso...`);
            deleteInventoryRagSummary(ctx.activeCampaign!.id, item);
            deleteInventoryHistory(ctx.activeCampaign!.id, item);
            removeLoot(ctx.activeCampaign!.id, item, 999999);

            await ctx.message.reply(`✅ Oggetto **${item}** eliminato definitivamente (RAG, Storia, Inventario).`);
            return;
        }

        // SUBCOMMAND: events - $loot <name/#id> events [page]
        const eventsMatch = arg.match(/^(.+?)\s+events(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            let itemIdentifier = eventsMatch[1].trim();
            const page = eventsMatch[2] ? parseInt(eventsMatch[2]) : 1;

            // Resolve short ID
            const sidMatch = itemIdentifier.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const itemEntry = getInventoryItemByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (itemEntry) itemIdentifier = itemEntry.item_name;
                else {
                    await ctx.message.reply(`❌ Oggetto con ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            }

            // Verify item exists
            const item = getInventoryItemByName(ctx.activeCampaign!.id, itemIdentifier);
            if (!item) {
                await ctx.message.reply(`❌ Oggetto **${itemIdentifier}** non trovato.`);
                return;
            }

            await showEntityEvents(ctx, {
                tableName: 'inventory_history',
                entityKeyColumn: 'item_name',
                entityKeyValue: item.item_name,
                campaignId: ctx.activeCampaign!.id,
                entityDisplayName: item.item_name,
                entityEmoji: '📦'
            }, page);
            return;
        }

        // VIEW SPECIFIC ITEM: $loot <ID> or $loot #abcde or $loot <Name>
        // Check if it's a list command or empty
        if (!arg || arg.toLowerCase().startsWith('list') || arg.toLowerCase().startsWith('lista')) {
            // Proceed to list below
        } else {
            let itemDetail: any = null;
            const sidMatchDetail = arg.match(/^#([a-z0-9]{5})$/i);

            if (sidMatchDetail) {
                itemDetail = getInventoryItemByShortId(ctx.activeCampaign!.id, sidMatchDetail[1]);
            } else {
                itemDetail = getInventoryItemByName(ctx.activeCampaign!.id, arg);
            }

            if (itemDetail) {
                await ctx.message.reply({ embeds: [generateItemDetailEmbed(itemDetail)] });
                return;
            } else {
                // Only error if it looked like an ID search
                if (sidMatchDetail) {
                    await ctx.message.reply(`❌ ID \`#${sidMatchDetail[1]}\` non trovato.`);
                    return;
                }
                // If name search failed, fallthrough to list? Or error?
                // Usually specific search should error if not found.
                await ctx.message.reply(`❌ Oggetto "${arg}" non trovato.`);
                return;
            }
        }

        // VIEW: List (Paginated)
        let initialPage = 1;
        if (arg) {
            const parts = arg.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                initialPage = parseInt(parts[1]);
            }
        }

        const ITEMS_PER_PAGE = 10;
        let currentPage = Math.max(0, initialPage - 1);

        const generateEmbed = (page: number) => {
            const offset = page * ITEMS_PER_PAGE;
            const items = getInventory(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);
            const total = inventoryRepository.countInventory(ctx.activeCampaign!.id);
            const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

            if (items.length === 0 && total > 0 && page > 0) {
                return { embed: new EmbedBuilder().setDescription("❌ Pagina inesistente."), totalPages: Math.ceil(total / ITEMS_PER_PAGE) };
            }

            if (total === 0) {
                return { embed: new EmbedBuilder().setDescription("Lo zaino è vuoto."), totalPages: 0 };
            }

            const list = items.map((i: any) => {
                const desc = i.description ? `\n> *${i.description.substring(0, 80)}${i.description.length > 80 ? '...' : ''}*` : '';
                return `\`#${i.short_id}\` 📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
            }).join('\n\n');

            const embed = new EmbedBuilder()
                .setTitle(`💰 Inventario di Gruppo (${ctx.activeCampaign?.name})`)
                .setColor("#F1C40F")
                .setDescription(list)
                .setFooter({ text: `Pagina ${page + 1} di ${totalPages} • Totale: ${total}` });

            return { embed, totalPages };
        };

        const generateButtons = (page: number, totalPages: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>();
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel('⬅️ Precedente')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel('Successivo ➡️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
            return row;
        };

        const generateSelectMenu = (items: any[]) => {
            if (items.length === 0) return null;

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_item')
                .setPlaceholder('🔍 Seleziona un oggetto per i dettagli...')
                .addOptions(
                    items.map((i: any) =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(i.item_name.substring(0, 100))
                            .setDescription(`ID: #${i.short_id} | Quantità: ${i.quantity}`)
                            .setValue(i.item_name)
                            .setEmoji('📦')
                    )
                );

            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        };

        const initialData = generateEmbed(currentPage);
        const offset = currentPage * ITEMS_PER_PAGE;
        const currentItems = getInventory(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);

        if (initialData.totalPages === 0 || !initialData.embed.data.title) {
            await ctx.message.reply({ embeds: [initialData.embed] });
            return;
        }

        const components: any[] = [];
        if (initialData.totalPages > 1) components.push(generateButtons(currentPage, initialData.totalPages));
        const selectRow = generateSelectMenu(currentItems);
        if (selectRow) components.push(selectRow);

        const reply = await ctx.message.reply({
            embeds: [initialData.embed],
            components
        });

        if (initialData.totalPages > 1 || currentItems.length > 0) {
            const collector = reply.createMessageComponentCollector({
                time: 60000 * 5 // 5 minutes
            });

            collector.on('collect', async (interaction: MessageComponentInteraction) => {
                if (interaction.user.id !== ctx.message.author.id) {
                    await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
                    return;
                }

                if (interaction.isButton()) {
                    if (interaction.customId === 'prev_page') {
                        currentPage = Math.max(0, currentPage - 1);
                    } else if (interaction.customId === 'next_page') {
                        currentPage++;
                    }

                    const newData = generateEmbed(currentPage);
                    const newOffset = currentPage * ITEMS_PER_PAGE;
                    const newItems = getInventory(ctx.activeCampaign!.id, ITEMS_PER_PAGE, newOffset);

                    const newComponents: any[] = [];
                    if (newData.totalPages > 1) newComponents.push(generateButtons(currentPage, newData.totalPages));
                    const newSelectRow = generateSelectMenu(newItems);
                    if (newSelectRow) newComponents.push(newSelectRow);

                    await interaction.update({
                        embeds: [newData.embed],
                        components: newComponents
                    });
                } else if (interaction.isStringSelectMenu()) {
                    if (interaction.customId === 'select_item') {
                        const selectedName = interaction.values[0];
                        const item = getInventoryItemByName(ctx.activeCampaign!.id, selectedName);
                        if (item) {
                            const detailEmbed = generateItemDetailEmbed(item);
                            await interaction.reply({ embeds: [detailEmbed] });
                        } else {
                            await interaction.reply({ content: "Oggetto non trovato.", ephemeral: true });
                        }
                    }
                }
            });

            collector.on('end', () => {
                reply.edit({ components: [] }).catch(() => { });
            });
        }
    }
};

export const mergeItemCommand: Command = {
    name: 'mergeitem',
    aliases: ['unisciitem', 'mergeitems'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const parts = arg.split('|').map(s => s.trim());

        if (parts.length !== 2) {
            await ctx.message.reply("Uso: `$unisciitem <nome vecchio/ID> | <nome nuovo/ID>`");
            return;
        }

        let [oldName, newName] = parts;

        // Resolve Old Name
        const oldSidMatch = oldName.match(/^#([a-z0-9]{5})$/i);
        if (oldSidMatch) {
            const itemEntry = getInventoryItemByShortId(ctx.activeCampaign!.id, oldSidMatch[1]);
            if (itemEntry) oldName = itemEntry.item_name;
        }

        // Resolve New Name
        const newSidMatch = newName.match(/^#([a-z0-9]{5})$/i);
        if (newSidMatch) {
            const itemEntry = getInventoryItemByShortId(ctx.activeCampaign!.id, newSidMatch[1]);
            if (itemEntry) newName = itemEntry.item_name;
        }

        const success = mergeInventoryItems(ctx.activeCampaign!.id, oldName, newName);
        if (success) {
            await ctx.message.reply(`✅ **Oggetti uniti!**\n💰 **${oldName}** è stato integrato in **${newName}**\nLe quantità sono state sommate.`);
        } else {
            await ctx.message.reply(`❌ Impossibile unire. Verifica che "${oldName}" esista nell'inventario.`);
        }
    }
};
