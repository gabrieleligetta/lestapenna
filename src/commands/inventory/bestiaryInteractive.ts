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
    bestiaryRepository,
    db
} from '../../db';
import { BestiaryEntry } from '../../db/types';
import { getActiveSession } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';
import { t } from '../../i18n';
import { deleteEntityFromCommand } from '../utils/entityDelete';

// Helper for bio regeneration - used ONLY for narrative notes
async function regenerateMonsterBio(campaignId: number, monsterName: string) {
    const history = bestiaryRepository.getBestiaryHistory(campaignId, monsterName);
    const monster = bestiaryRepository.getMonsterByName(campaignId, monsterName);
    const currentDesc = monster?.description || "";
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('MONSTER', { campaignId, name: monsterName, currentDesc }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markBestiaryDirtyForSync(campaignId: number, name: string) {
    bestiaryRepository.markBestiaryDirty(campaignId, name);
}

export async function startInteractiveBestiaryUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let monster = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, query);
        if (!monster) monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, query);

        if (monster) {
            await showBestiaryFieldSelection(ctx.message as any, monster, ctx, true);
            return;
        }
    }
    await showBestiarySelection(ctx, null, 0, null, 'UPDATE');
}

export async function startInteractiveBestiaryDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let monster = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, query);
        if (!monster) monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, query);

        if (monster) {
            await showBestiaryDeleteConfirmation(ctx.message as any, monster, ctx, true);
            return;
        }
    }
    await showBestiarySelection(ctx, null, 0, null, 'DELETE');
}

async function showBestiarySelection(
    ctx: CommandContext,
    searchQuery: string | null,
    page: number,
    interactionToUpdate: any | null,
    mode: 'UPDATE' | 'DELETE'
) {
    const ITEMS_PER_PAGE = 20;
    const offset = page * ITEMS_PER_PAGE;
    let monsters: BestiaryEntry[] = [];

    // For listing, we use listMonsters which groups by name
    const all = bestiaryRepository.listAllMonsters(ctx.activeCampaign!.id);
    let filtered = all;

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = all.filter(m => m.name.toLowerCase().includes(q) || (m.description && m.description.toLowerCase().includes(q)));
    }

    const total = filtered.length;
    monsters = filtered.slice(offset, offset + ITEMS_PER_PAGE);
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    const options = monsters.map(m => {
        const statusIcon = m.status === 'ALIVE' ? '⚔️' : m.status === 'DEFEATED' ? '💀' : '🏃';
        return new StringSelectMenuOptionBuilder()
            .setLabel(m.name.substring(0, 100))
            .setDescription(t(ctx.locale, 'bestiary.optionDescription', {
                id: m.short_id || '?????',
                status: bestiaryStatusLabel(ctx, m.status)
            }))
            .setValue(m.name)
            .setEmoji(statusIcon);
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
        .setCustomId('bestiary_select_entity')
        .setPlaceholder(t(ctx.locale, 'bestiary.selectPlaceholder'))
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('page_prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('page_next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const content = t(ctx.locale, 'bestiary.managePage', {
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
                const modal = new ModalBuilder().setCustomId('modal_best_search').setTitle(t(ctx.locale, 'bestiary.searchTitle'));
                const input = new TextInputBuilder().setCustomId('search_query').setLabel(t(ctx.locale, 'inventory.searchQueryLabel')).setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
                await interaction.showModal(modal);

                try {
                    const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_best_search' && i.user.id === interaction.user.id });
                    await showBestiarySelection(ctx, submission.fields.getTextInputValue('search_query'), 0, submission, mode);
                } catch (e) { }
            } else {
                collector.stop();
                const monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, val);
                if (!monster) return;
                if (mode === 'DELETE') await showBestiaryDeleteConfirmation(interaction, monster, ctx);
                else await showBestiaryFieldSelection(interaction, monster, ctx);
            }
        } else if (interaction.isButton()) {
            collector.stop();
            if (interaction.customId === 'page_prev') {
                await showBestiarySelection(ctx, searchQuery, page - 1, interaction, mode);
            } else if (interaction.customId === 'page_next') {
                await showBestiarySelection(ctx, searchQuery, page + 1, interaction, mode);
            }
        }
    });
}

async function showBestiaryDeleteConfirmation(interaction: any, monster: BestiaryEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('btn_confirm_delete').setLabel(t(ctx.locale, 'inventory.confirmDeleteButton')).setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('btn_cancel_delete').setLabel(t(ctx.locale, 'common.cancel')).setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const content = t(ctx.locale, 'bestiary.confirmDelete', { monster: monster.name });
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
            await deleteEntityFromCommand(ctx, 'bestiary', monster);
            await i.update({ content: t(ctx.locale, 'bestiary.deletedPermanently', { monster: monster.name }), components: [] });
        } else {
            await i.update({ content: t(ctx.locale, 'inventory.deleteCancelled'), components: [] });
        }
    });
}

async function showBestiaryFieldSelection(interaction: any, monster: BestiaryEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('bestiary_select_field')
        .setPlaceholder(t(ctx.locale, 'inventory.editPlaceholder', { item: monster.name }))
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldName')).setValue('name').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.status')).setValue('status').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldDescription')).setValue('description').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'bestiary.abilities')).setValue('abilities').setEmoji('⚔️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'bestiary.weaknesses')).setValue('weaknesses').setEmoji('🎯'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'bestiary.resistances')).setValue('resistances').setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldNotes')).setValue('notes').setEmoji('📝'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldNarrativeNote')).setValue('note').setEmoji('📓')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = t(ctx.locale, 'bestiary.editPrompt', { monster: monster.name });
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
        if (field === 'status') await showBestiaryStatusUpdate(i, monster, ctx);
        else if (['abilities', 'weaknesses', 'resistances'].includes(field)) await showBestiaryArrayModal(i, monster, field, ctx);
        else await showBestiaryTextModal(i, monster, field, ctx);
    });
}

async function showBestiaryStatusUpdate(interaction: any, monster: BestiaryEntry, ctx: CommandContext) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('bestiary_update_status')
        .setPlaceholder(t(ctx.locale, 'bestiary.newStatusPlaceholder'))
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'bestiary.statusAlive')).setValue('ALIVE').setEmoji('⚔️').setDefault(monster.status === 'ALIVE'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'bestiary.statusDefeated')).setValue('DEFEATED').setEmoji('💀').setDefault(monster.status === 'DEFEATED'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'bestiary.statusFled')).setValue('FLED').setEmoji('🏃').setDefault(monster.status === 'FLED')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ content: t(ctx.locale, 'bestiary.updateStatusPrompt', { monster: monster.name }), components: [row] });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newStatus = i.values[0];

        // Update the status and mark dirty for the background sync
        const success = bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { status: newStatus }, true);
        if (!success) {
            await i.update({ content: t(ctx.locale, 'bestiary.statusUpdateError', { monster: monster.name }), components: [] });
            return;
        }
        markBestiaryDirtyForSync(ctx.activeCampaign!.id, monster.name);

        // We do NOT add automatic events for a status change - they are narrative noise

        await i.update({ content: t(ctx.locale, 'bestiary.statusUpdatedInteractive', { monster: monster.name, status: bestiaryStatusLabel(ctx, newStatus) }), components: [] });
    });
}

async function showBestiaryArrayModal(interaction: any, monster: BestiaryEntry, field: string, ctx: CommandContext) {
    const modalId = `modal_barray_${Date.now()}`;
    const fieldLabel = bestiaryFieldLabel(ctx, field);
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(t(ctx.locale, 'inventory.editFieldTitle', { field: fieldLabel }));

    let currentVal = "";
    try {
        const arr = (monster as any)[field] ? JSON.parse((monster as any)[field]) : [];
        currentVal = arr.join(', ');
    } catch (e) { }

    const input = new TextInputBuilder()
        .setCustomId('values')
        .setLabel(t(ctx.locale, 'bestiary.commaSeparatedLabel'))
        .setStyle(TextInputStyle.Paragraph)
        .setValue(currentVal)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id });
        const newValue = submission.fields.getTextInputValue('values');
        const items = newValue.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);

        const success = bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { [field]: items }, true);
        if (!success) {
            await submission.reply({ content: t(ctx.locale, 'bestiary.updateError', { monster: monster.name, field: fieldLabel }), ephemeral: true });
            return;
        }
        await submission.reply(t(ctx.locale, 'bestiary.updated', { monster: monster.name, field: fieldLabel }));
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showBestiaryTextModal(interaction: any, monster: BestiaryEntry, field: string, ctx: CommandContext) {
    const modalId = `modal_btext_${Date.now()}`;
    const fieldLabel = bestiaryFieldLabel(ctx, field);
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(t(ctx.locale, 'inventory.editFieldTitle', { field: fieldLabel }));
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'note' ? t(ctx.locale, 'inventory.fieldNarrativeNote') : t(ctx.locale, 'inventory.newFieldLabel', { field: fieldLabel }))
        .setStyle(field === 'description' || field === 'notes' || field === 'note' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(field === 'note' ? "" : (monster as any)[field] || "")
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id });
        const newValue = submission.fields.getTextInputValue('value');

        if (field === 'note') {
            await submission.deferReply();
            const session = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
            bestiaryRepository.addBestiaryEvent(ctx.activeCampaign!.id, monster.name, session, newValue, "MANUAL_UPDATE", true);
            await regenerateMonsterBio(ctx.activeCampaign!.id, monster.name);
            await submission.editReply(t(ctx.locale, 'bestiary.noteAdded', { monster: monster.name }));
        } else {
            const success = bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { [field]: newValue }, true);
            if (!success) {
                await submission.reply({ content: t(ctx.locale, 'bestiary.updateError', { monster: monster.name, field: fieldLabel }), ephemeral: true });
                return;
            }
            if (field === 'name') {
                // Update history records as well
                db.prepare('UPDATE bestiary_history SET monster_name = ? WHERE campaign_id = ? AND monster_name = ?')
                    .run(newValue, ctx.activeCampaign!.id, monster.name);
            }
            await submission.reply(t(ctx.locale, 'bestiary.updated', { monster: monster.name, field: fieldLabel }));
        }
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

function bestiaryStatusLabel(ctx: CommandContext, status: string): string {
    if (status === 'ALIVE') return t(ctx.locale, 'bestiary.statusAlive');
    if (status === 'DEFEATED') return t(ctx.locale, 'bestiary.statusDefeated');
    if (status === 'FLED') return t(ctx.locale, 'bestiary.statusFled');
    return status;
}

function bestiaryFieldLabel(ctx: CommandContext, field: string): string {
    switch (field) {
        case 'name': return t(ctx.locale, 'inventory.fieldName');
        case 'status': return t(ctx.locale, 'artifact.status');
        case 'description': return t(ctx.locale, 'inventory.fieldDescription');
        case 'abilities': return t(ctx.locale, 'bestiary.abilities');
        case 'weaknesses': return t(ctx.locale, 'bestiary.weaknesses');
        case 'resistances': return t(ctx.locale, 'bestiary.resistances');
        case 'notes': return t(ctx.locale, 'inventory.fieldNotes');
        case 'note': return t(ctx.locale, 'inventory.fieldNarrativeNote');
        default: return field;
    }
}
