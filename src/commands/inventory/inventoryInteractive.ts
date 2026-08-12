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
import { getActiveSession } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';
import { getCampaignLocale, t } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';

// Helper for bio regeneration - used ONLY for narrative notes
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
                .setLabel(t(ctx.locale, 'inventory.addButton'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('💰')
        );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'inventory.managePrompt'),
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
            .setTitle(t(ctx.locale, 'inventory.newTitle'));

        const nameInput = new TextInputBuilder()
            .setCustomId('item_name')
            .setLabel(t(ctx.locale, 'inventory.nameLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const qtyInput = new TextInputBuilder()
            .setCustomId('item_quantity')
            .setLabel(t(ctx.locale, 'inventory.quantity'))
            .setStyle(TextInputStyle.Short)
            .setValue("1")
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('item_description')
            .setLabel(t(ctx.locale, 'inventory.descriptionOptional'))
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
            const currentSession = (await getActiveSession(ctx.guildId));

            inventoryRepository.addLoot(ctx.activeCampaign!.id, name, qty, currentSession, description, true);

            if (currentSession) {
                // The "Item acquired" event is legitimate narrative, we keep it
                addInventoryEvent(ctx.activeCampaign!.id, name, currentSession, t(
                    getCampaignLocale(ctx.activeCampaign!.id),
                    'inventory.eventAcquiredQuantity',
                    { quantity: qty }
                ), "LOOT", true);
                // Mark dirty for the background sync instead of regenerating synchronously
                markInventoryDirtyForSync(ctx.activeCampaign!.id, name);
            }

            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_item')
                        .setLabel(t(ctx.locale, 'inventory.editDetails'))
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: t(ctx.locale, 'inventory.addedDetails', {
                    name,
                    quantity: qty,
                    description: description || t(ctx.locale, 'inventory.noDescriptionPlain')
                }),
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
    let items: any[] = [];
    let total = 0;

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        // Use the variant that carries the artifact info
        const all = inventoryRepository.listAllInventoryWithArtifacts(ctx.activeCampaign!.id);
        const filtered = all.filter(i => i.item_name.toLowerCase().includes(q) || (i.description && i.description.toLowerCase().includes(q)));
        total = filtered.length;
        items = filtered.slice(offset, offset + ITEMS_PER_PAGE);
    } else {
        total = inventoryRepository.countInventory(ctx.activeCampaign!.id);
        items = inventoryRepository.getInventoryWithArtifactInfo(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);
    }

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    const options = items.map(i => {
        // Icona diversa per artefatti
        const emoji = i.is_artifact ? (i.is_cursed ? '☠️' : '🔮') : '📦';
        const artifactTag = i.is_artifact ? t(ctx.locale, 'inventory.artifactOptionTag') : '';
        return new StringSelectMenuOptionBuilder()
            .setLabel(i.item_name.substring(0, 100))
            .setDescription(t(ctx.locale, 'inventory.optionDescriptionShort', {
                id: i.short_id,
                quantity: i.quantity,
                artifact: artifactTag
            }))
            .setValue(i.item_name)
            .setEmoji(emoji);
    });

    if (page === 0 && options.length < 25) {
        options.unshift(
            new StringSelectMenuOptionBuilder()
                .setLabel(t(ctx.locale, 'wizard.searchOption'))
                .setValue("SEARCH_ACTION")
                .setEmoji('🔍')
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('inventory_select_entity')
        .setPlaceholder(t(ctx.locale, 'inventory.selectPlaceholder'))
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('page_prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('page_next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const content = t(ctx.locale, 'inventory.managePage', {
        action: t(ctx.locale, mode === 'DELETE' ? 'inventory.deleteMode' : 'inventory.updateMode'),
        page: page + 1,
        total: totalPages || 1
    });

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
                const modal = new ModalBuilder().setCustomId('modal_inv_search').setTitle(t(ctx.locale, 'inventory.searchTitle'));
                const input = new TextInputBuilder().setCustomId('search_query').setLabel(t(ctx.locale, 'inventory.searchQueryLabel')).setStyle(TextInputStyle.Short).setRequired(true);
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
        new ButtonBuilder().setCustomId('btn_confirm_delete').setLabel(t(ctx.locale, 'inventory.confirmDeleteButton')).setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('btn_cancel_delete').setLabel(t(ctx.locale, 'common.cancel')).setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const content = t(ctx.locale, 'inventory.confirmDelete', { item: item.item_name });
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
            await deleteEntityFromCommand(ctx, 'inventory', item);
            await i.update({ content: t(ctx.locale, 'inventory.deleted', { item: item.item_name }), components: [] });
        } else {
            await i.update({ content: t(ctx.locale, 'inventory.deleteCancelled'), components: [] });
        }
    });
}

async function showInventoryFieldSelection(interaction: any, item: InventoryItem, ctx: CommandContext, isNewMessage: boolean = false) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('inventory_select_field')
        .setPlaceholder(t(ctx.locale, 'inventory.editPlaceholder', { item: item.item_name }))
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldName')).setValue('item_name').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.quantity')).setValue('quantity').setEmoji('🔢'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldDescription')).setValue('description').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldNotes')).setValue('notes').setEmoji('📝'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldNarrativeNote')).setValue('note').setEmoji('📓')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = t(ctx.locale, 'inventory.editPrompt', { item: item.item_name });
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
    const modal = new ModalBuilder().setCustomId(`modal_inv_qty_${Date.now()}`).setTitle(t(ctx.locale, 'inventory.quantityModalTitle'));
    const input = new TextInputBuilder()
        .setCustomId('quantity')
        .setLabel(t(ctx.locale, 'inventory.quantityNewLabel'))
        .setStyle(TextInputStyle.Short)
        .setValue(item.quantity.toString())
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId.startsWith('modal_inv_qty_') && i.user.id === interaction.user.id });
        const newQty = parseInt(submission.fields.getTextInputValue('quantity'));

        if (isNaN(newQty)) {
            await submission.reply({ content: t(ctx.locale, 'inventory.invalidQuantity'), ephemeral: true });
            return;
        }

        const success = inventoryRepository.updateInventoryFields(ctx.activeCampaign!.id, item.item_name, { quantity: newQty }, true);
        if (!success) {
            await submission.reply({ content: t(ctx.locale, 'inventory.quantityUpdateError', { item: item.item_name }), ephemeral: true });
            return;
        }
        await submission.reply(t(ctx.locale, 'inventory.quantityUpdated', { item: item.item_name, quantity: newQty }));
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showInventoryTextModal(interaction: any, item: InventoryItem, field: string, ctx: CommandContext) {
    const modalId = `modal_itext_${Date.now()}`;
    const fieldLabel = inventoryFieldLabel(ctx, field);
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(t(ctx.locale, 'inventory.editFieldTitle', { field: fieldLabel }));
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'note' ? t(ctx.locale, 'inventory.fieldNarrativeNote') : t(ctx.locale, 'inventory.newFieldLabel', { field: fieldLabel }))
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
            const session = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
            addInventoryEvent(ctx.activeCampaign!.id, item.item_name, session, newValue, "MANUAL_UPDATE", true);
            await regenerateItemBio(ctx.activeCampaign!.id, item.item_name);
            await submission.editReply(t(ctx.locale, 'inventory.noteAdded', { item: item.item_name }));
        } else {
            const success = inventoryRepository.updateInventoryFields(ctx.activeCampaign!.id, item.item_name, { [field]: newValue }, true);
            if (!success) {
                await submission.reply({ content: t(ctx.locale, 'inventory.updateError', { item: item.item_name, field: fieldLabel }), ephemeral: true });
                return;
            }
            if (field === 'item_name') {
                // Update history records as well (since they reference name)
                db.prepare('UPDATE inventory_history SET item_name = ? WHERE campaign_id = ? AND item_name = ?')
                    .run(newValue, ctx.activeCampaign!.id, item.item_name);
            }
            await submission.reply(t(ctx.locale, 'inventory.updated', { item: item.item_name, field: fieldLabel }));
        }
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

function inventoryFieldLabel(ctx: CommandContext, field: string): string {
    switch (field) {
        case 'item_name': return t(ctx.locale, 'inventory.fieldName');
        case 'quantity': return t(ctx.locale, 'inventory.quantity');
        case 'description': return t(ctx.locale, 'inventory.fieldDescription');
        case 'notes': return t(ctx.locale, 'inventory.fieldNotes');
        case 'note': return t(ctx.locale, 'inventory.fieldNarrativeNote');
        default: return field;
    }
}
