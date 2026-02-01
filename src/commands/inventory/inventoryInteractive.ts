import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ComponentType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} from 'discord.js';
import { CommandContext } from '../types';
import {
    inventoryRepository,
    addInventoryEvent,
    db
} from '../../db';
import { InventoryItem } from '../../db/types';
import { guildSessions } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';

// Helper for Bio Regen - usato SOLO per note narrative
async function regenerateItemBio(campaignId: number, itemName: string) {
    const history = inventoryRepository.getInventoryHistory(campaignId, itemName);
    const item = inventoryRepository.getInventoryItemByName(campaignId, itemName);
    const currentDesc = item?.description || "";
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('ITEM', { campaignId, name: itemName, currentDesc }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markInventoryDirtyForSync(campaignId: number, itemName: string) {
    inventoryRepository.markInventoryDirty(campaignId, itemName);
}

export async function startInteractiveInventoryUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let item = inventoryRepository.getInventoryItemByShortId(ctx.activeCampaign!.id, query);
        if (!item) item = inventoryRepository.getInventoryItemByName(ctx.activeCampaign!.id, query);

        if (item) {
            await showInventoryFieldSelection(ctx.message as any, item, ctx, true);
            return;
        }
    }
    await showInventorySelection(ctx, null, 0, null, 'UPDATE');
}

export async function startInteractiveInventoryDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let item = inventoryRepository.getInventoryItemByShortId(ctx.activeCampaign!.id, query);
        if (!item) item = inventoryRepository.getInventoryItemByName(ctx.activeCampaign!.id, query);

        if (item) {
            await showInventoryDeleteConfirmation(ctx.message as any, item, ctx, true);
            return;
        }
    }
    await showInventorySelection(ctx, null, 0, null, 'DELETE');
}

export async function startInteractiveInventoryAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_inventory_add')
                .setLabel('Aggiungi Nuovo Oggetto')
                .setStyle(ButtonStyle.Success)
                .setEmoji('💰')
        );

    const reply = await ctx.message.reply({
        content: "**🛠️ Gestione Inventario**\nClicca sul bottone qui sotto per registrare un nuovo oggetto.",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_inventory_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const modal = new ModalBuilder()
            .setCustomId('modal_inventory_add_new')
            .setTitle("Nuovo Oggetto");

        const nameInput = new TextInputBuilder()
            .setCustomId('item_name')
            .setLabel("Nome dell'Oggetto")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const qtyInput = new TextInputBuilder()
            .setCustomId('item_quantity')
            .setLabel("Quantità")
            .setStyle(TextInputStyle.Short)
            .setValue("1")
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('item_description')
            .setLabel("Descrizione (Opzionale)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(qtyInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
        );

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === 'modal_inventory_add_new' && i.user.id === interaction.user.id
            });

            const name = submission.fields.getTextInputValue('item_name');
            const qtyStr = submission.fields.getTextInputValue('item_quantity');
            const qty = parseInt(qtyStr) || 1;
            const description = submission.fields.getTextInputValue('item_description') || "";
            const currentSession = guildSessions.get(ctx.guildId);

            inventoryRepository.addLoot(ctx.activeCampaign!.id, name, qty, currentSession, description, true);

            if (currentSession) {
                // L'evento "Oggetto acquisito" è narrativo valido, lo manteniamo
                addInventoryEvent(ctx.activeCampaign!.id, name, currentSession, `Oggetto acquisito (x${qty}).`, "LOOT", true);
                // Marca dirty per sync in background invece di rigenerazione sincrona
                markInventoryDirtyForSync(ctx.activeCampaign!.id, name);
            }

            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_item')
                        .setLabel('Modifica Dettagli')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ **Oggetto Aggiunto!**\n💰 **${name}** (x${qty})\n📜 ${description || "Nessuna descrizione"}\n\n*Puoi aggiungere note o cambiare dettagli ora:*`,
                components: [successRow]
            });

            try { await reply.delete(); } catch { }

            const message = await submission.fetchReply();
            const editCollector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (i) => i.customId === 'edit_created_item' && i.user.id === ctx.message.author.id
            });

            editCollector.on('collect', async (i) => {
                const item = inventoryRepository.getInventoryItemByName(ctx.activeCampaign!.id, name);
                if (item) await showInventoryFieldSelection(i, item, ctx);
            });

        } catch (err) { }
    });

    collector.on('end', () => {
        if (reply.editable) {
            reply.edit({ components: [] }).catch(() => { });
        }
    });
}

async function showInventorySelection(
    ctx: CommandContext,
    searchQuery: string | null,
    page: number,
    interactionToUpdate: any | null,
    mode: 'UPDATE' | 'DELETE'
) {
    const ITEMS_PER_PAGE = 20;
    const offset = page * ITEMS_PER_PAGE;
    let items: InventoryItem[] = [];
    let total = 0;

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const all = inventoryRepository.listAllInventory(ctx.activeCampaign!.id);
        const filtered = all.filter(i => i.item_name.toLowerCase().includes(q) || (i.description && i.description.toLowerCase().includes(q)));
        total = filtered.length;
        items = filtered.slice(offset, offset + ITEMS_PER_PAGE);
    } else {
        total = inventoryRepository.countInventory(ctx.activeCampaign!.id);
        items = inventoryRepository.getInventory(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);
    }

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    const options = items.map(i => {
        return new StringSelectMenuOptionBuilder()
            .setLabel(i.item_name.substring(0, 100))
            .setDescription(`ID: #${i.short_id} | Qt: ${i.quantity}`)
            .setValue(i.item_name)
            .setEmoji('📦');
    });

    if (page === 0 && options.length < 25) {
        options.unshift(
            new StringSelectMenuOptionBuilder()
                .setLabel("🔍 Cerca...")
                .setValue("SEARCH_ACTION")
                .setEmoji('🔍')
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('inventory_select_entity')
        .setPlaceholder(`Seleziona un oggetto...`)
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('page_prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('page_next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const content = `**🛠️ ${mode === 'DELETE' ? 'Eliminazione' : 'Aggiornamento'} Inventario**\nPagina: ${page + 1}/${totalPages || 1}`;

    let response;
    if (interactionToUpdate) {
        await interactionToUpdate.update({ content, components: rows });
        response = interactionToUpdate.message;
    } else {
        response = await ctx.message.reply({ content, components: rows });
    }

    const collector = response.createMessageComponentCollector({
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction: any) => {
        if (interaction.isStringSelectMenu()) {
            const val = interaction.values[0];
            if (val === 'SEARCH_ACTION') {
                collector.stop();
                const modal = new ModalBuilder().setCustomId('modal_inv_search').setTitle("🔍 Cerca nell'Inventario");
                const input = new TextInputBuilder().setCustomId('search_query').setLabel("Nome o descrizione").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
                await interaction.showModal(modal);

                try {
                    const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_inv_search' && i.user.id === interaction.user.id });
                    await showInventorySelection(ctx, submission.fields.getTextInputValue('search_query'), 0, submission, mode);
                } catch (e) { }
            } else {
                collector.stop();
                const item = inventoryRepository.getInventoryItemByName(ctx.activeCampaign!.id, val);
                if (!item) return;
                if (mode === 'DELETE') await showInventoryDeleteConfirmation(interaction, item, ctx);
                else await showInventoryFieldSelection(interaction, item, ctx);
            }
        } else if (interaction.isButton()) {
            collector.stop();
            if (interaction.customId === 'page_prev') {
                await showInventorySelection(ctx, searchQuery, page - 1, interaction, mode);
            } else if (interaction.customId === 'page_next') {
                await showInventorySelection(ctx, searchQuery, page + 1, interaction, mode);
            }
        }
    });
}

async function showInventoryDeleteConfirmation(interaction: any, item: InventoryItem, ctx: CommandContext, isNewMessage: boolean = false) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('btn_confirm_delete').setLabel('Conferma Eliminazione').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('btn_cancel_delete').setLabel('Annulla').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const content = `⚠️ **Sei sicuro di voler eliminare definitivamente: ${item.item_name}?**\nQuesto rimuoverà anche tutta la sua storia.`;
    const options = { content, components: [row] };

    const message = isNewMessage ? await interaction.reply(options) : await interaction.update(options);
    const target = isNewMessage ? message : interaction.message;

    const collector = target.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        if (i.customId === 'btn_confirm_delete') {
            inventoryRepository.deleteInventoryHistory(ctx.activeCampaign!.id, item.item_name);
            inventoryRepository.removeLoot(ctx.activeCampaign!.id, item.item_name, 999999);
            await i.update({ content: `✅ Oggetto **${item.item_name}** eliminato definitivamente.`, components: [] });
        } else {
            await i.update({ content: "❌ Eliminazione annullata.", components: [] });
        }
    });
}

async function showInventoryFieldSelection(interaction: any, item: InventoryItem, ctx: CommandContext, isNewMessage: boolean = false) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('inventory_select_field')
        .setPlaceholder(`Modifica: ${item.item_name}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Nome').setValue('item_name').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Quantità').setValue('quantity').setEmoji('🔢'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Note').setValue('notes').setEmoji('📝'),
            new StringSelectMenuOptionBuilder().setLabel('Nota Narrativa').setValue('note').setEmoji('📓')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = `**🛠️ Modifica Oggetto: ${item.item_name}**\nCosa vuoi aggiornare?`;
    const options = { content, components: [row] };

    const message = isNewMessage ? await interaction.reply(options) : await interaction.update(options);
    const target = isNewMessage ? message : interaction.message;

    const collector = target.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const field = i.values[0];
        if (field === 'quantity') await showInventoryQuantityUpdate(i, item, ctx);
        else await showInventoryTextModal(i, item, field, ctx);
    });
}

async function showInventoryQuantityUpdate(interaction: any, item: InventoryItem, ctx: CommandContext) {
    const modal = new ModalBuilder().setCustomId(`modal_inv_qty_${Date.now()}`).setTitle("Aggiorna Quantità");
    const input = new TextInputBuilder()
        .setCustomId('quantity')
        .setLabel("Nuova Quantità (numero)")
        .setStyle(TextInputStyle.Short)
        .setValue(item.quantity.toString())
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId.startsWith('modal_inv_qty_') && i.user.id === interaction.user.id });
        const newQty = parseInt(submission.fields.getTextInputValue('quantity'));

        if (isNaN(newQty)) {
            await submission.reply({ content: "❌ Inserisci un numero valido.", ephemeral: true });
            return;
        }

        inventoryRepository.updateInventoryFields(ctx.activeCampaign!.id, item.item_name, { quantity: newQty }, true);
        await submission.reply(`✅ Quantità di **${item.item_name}** aggiornata a **${newQty}**.`);
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showInventoryTextModal(interaction: any, item: InventoryItem, field: string, ctx: CommandContext) {
    const modalId = `modal_itext_${Date.now()}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Modifica ${field}`);
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'note' ? "Nota Narrativa" : `Nuovo ${field}`)
        .setStyle(field === 'description' || field === 'notes' || field === 'note' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(field === 'note' ? "" : (item as any)[field] || "")
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id });
        const newValue = submission.fields.getTextInputValue('value');

        if (field === 'note') {
            await submission.deferReply();
            const session = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addInventoryEvent(ctx.activeCampaign!.id, item.item_name, session, newValue, "MANUAL_UPDATE", true);
            await regenerateItemBio(ctx.activeCampaign!.id, item.item_name);
            await submission.editReply(`📝 Nota aggiunta a **${item.item_name}**.`);
        } else {
            inventoryRepository.updateInventoryFields(ctx.activeCampaign!.id, item.item_name, { [field]: newValue }, true);
            if (field === 'item_name') {
                // Update history records as well (since they reference name)
                db.prepare('UPDATE inventory_history SET item_name = ? WHERE campaign_id = ? AND item_name = ?')
                    .run(newValue, ctx.activeCampaign!.id, item.item_name);
            }
            await submission.reply(`✅ **${item.item_name}** aggiornato (${field}).`);
        }
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}
