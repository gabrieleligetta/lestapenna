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
    EmbedBuilder,
    MessageComponentInteraction
} from 'discord.js';
import { CommandContext } from '../types';
import {
    questRepository,
    addQuest,
    addQuestEvent,
    deleteQuestHistory,
    deleteQuestRagSummary,
    db
} from '../../db';
import { Quest, QuestStatus } from '../../db/types';
import { getActiveSession } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';

// Helper for Bio Regen - usato SOLO per note narrative, non per cambio stato
async function regenerateQuestBio(campaignId: number, title: string, status: string) {
    const history = questRepository.getQuestHistory(campaignId, title);
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('QUEST', { campaignId, name: title, role: status, currentDesc: "" }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markQuestDirtyForSync(campaignId: number, title: string) {
    questRepository.markQuestDirty(campaignId, title);
}

export async function startInteractiveQuestUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let quest = questRepository.getQuestByShortId(ctx.activeCampaign!.id, query);
        if (!quest) quest = questRepository.getQuestByTitle(ctx.activeCampaign!.id, query);

        if (quest) {
            await showQuestFieldSelection(ctx.message as any, quest, ctx, true);
            return;
        }
    }
    await showQuestSelection(ctx, null, 'ALL', 0, null, 'UPDATE');
}

export async function startInteractiveQuestDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let quest = questRepository.getQuestByShortId(ctx.activeCampaign!.id, query);
        if (!quest) quest = questRepository.getQuestByTitle(ctx.activeCampaign!.id, query);

        if (quest) {
            await showQuestDeleteConfirmation(ctx.message as any, quest, ctx, true);
            return;
        }
    }
    await showQuestSelection(ctx, null, 'ALL', 0, null, 'DELETE');
}

export async function startInteractiveQuestStatusChange(ctx: CommandContext, newStatus: string) {
    // For "done" we show only open/in progress
    // For "undone" we show only completed/failed
    const filter = newStatus === 'COMPLETED' ? 'ACTIVE' : 'CLOSED';
    await showQuestSelection(ctx, null, filter, 0, null, 'STATUS_CHANGE', newStatus);
}

export async function startInteractiveQuestAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_quest_add')
                .setLabel('Crea Nuova Quest')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🗺️')
        );

    const reply = await ctx.message.reply({
        content: "**🛠️ Creazione Quest**\nClicca sul bottone qui sotto per aprire il modulo di creazione.",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_quest_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const modal = new ModalBuilder()
            .setCustomId('modal_quest_add_new')
            .setTitle("Nuova Quest");

        const titleInput = new TextInputBuilder()
            .setCustomId('quest_title')
            .setLabel("Titolo della Quest")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('quest_description')
            .setLabel("Descrizione (Opzionale)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
        );

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === 'modal_quest_add_new' && i.user.id === interaction.user.id
            });

            const title = submission.fields.getTextInputValue('quest_title');
            const description = submission.fields.getTextInputValue('quest_description') || "";
            const currentSession = (await getActiveSession(ctx.guildId));

            addQuest(ctx.activeCampaign!.id, title, currentSession, description, QuestStatus.OPEN, 'MAJOR', true);
            if (currentSession) {
                // L'evento "Quest iniziata" è narrativo valido
                addQuestEvent(ctx.activeCampaign!.id, title, currentSession, "Quest iniziata.", "CREATION", true);
                // Marca dirty per sync in background
                markQuestDirtyForSync(ctx.activeCampaign!.id, title);
            }

            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_quest')
                        .setLabel('Modifica Dettagli')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ **Nuova Quest Creata!**\n🗺️ **${title}**\n📜 ${description || "Nessuna descrizione"}\n\n*Puoi aggiungere altri dettagli ora o cambiare il tipo:*`,
                components: [successRow]
            });

            try { await reply.delete(); } catch { }

            const message = await submission.fetchReply();
            const editCollector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (i) => i.customId === 'edit_created_quest' && i.user.id === ctx.message.author.id
            });

            editCollector.on('collect', async (i) => {
                const quest = questRepository.getQuestByTitle(ctx.activeCampaign!.id, title);
                if (quest) await showQuestFieldSelection(i, quest, ctx);
            });

        } catch (err) { }
    });

    collector.on('end', () => {
        if (reply.editable) {
            reply.edit({ components: [] }).catch(() => { });
        }
    });
}

async function showQuestSelection(
    ctx: CommandContext,
    searchQuery: string | null,
    statusFilter: string,
    page: number,
    interactionToUpdate: any | null,
    mode: 'UPDATE' | 'DELETE' | 'STATUS_CHANGE',
    targetStatus?: string
) {
    const ITEMS_PER_PAGE = 20;
    const offset = page * ITEMS_PER_PAGE;
    let quests: Quest[] = [];
    let total = 0;

    // Fetching logic
    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const all = questRepository.listAllQuests(ctx.activeCampaign!.id);
        quests = all.filter(q => q.title.toLowerCase().includes(query) || (q.description && q.description.toLowerCase().includes(query)));
        total = quests.length;
        quests = quests.slice(offset, offset + ITEMS_PER_PAGE);
    } else {
        quests = questRepository.getQuestsByStatus(ctx.activeCampaign!.id, statusFilter, ITEMS_PER_PAGE, offset);
        total = questRepository.countQuestsByStatus(ctx.activeCampaign!.id, statusFilter);
    }

    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    const options = quests.map(q => {
        const typeIcon = q.type === 'MAJOR' ? '👑' : '📜';
        const s = q.status as string;
        const statusIcon = (s === QuestStatus.IN_PROGRESS || s === 'IN CORSO') ? '⏳' :
            (s === QuestStatus.COMPLETED || s === 'DONE') ? '✅' :
                (s === QuestStatus.FAILED) ? '❌' : '🔹';

        return new StringSelectMenuOptionBuilder()
            .setLabel(q.title.substring(0, 100))
            .setDescription(`ID: #${q.short_id} | ${q.status}`)
            .setValue(q.title)
            .setEmoji(statusIcon);
    });

    if (page === 0) {
        options.unshift(
            new StringSelectMenuOptionBuilder()
                .setLabel("🔍 Cerca...")
                .setDescription("Filtra per titolo o descrizione")
                .setValue("SEARCH_ACTION")
                .setEmoji('🔍')
        );
    }

    const actionText = mode === 'DELETE' ? "Eliminazione" : mode === 'STATUS_CHANGE' ? "Cambio Stato" : "Aggiornamento";
    const select = new StringSelectMenuBuilder()
        .setCustomId('quest_select_entity')
        .setPlaceholder(searchQuery ? `Risultati per: ${searchQuery}` : `Seleziona una quest...`)
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    // Filter Buttons
    const filterRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('filter_ACTIVE').setLabel('Attive').setStyle(statusFilter === 'ACTIVE' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('⏳'),
            new ButtonBuilder().setCustomId('filter_COMPLETED').setLabel('Completate').setStyle(statusFilter === 'COMPLETED' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('✅'),
            new ButtonBuilder().setCustomId('filter_FAILED').setLabel('Fallite').setStyle(statusFilter === 'FAILED' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('❌'),
            new ButtonBuilder().setCustomId('filter_ALL').setLabel('Tutte').setStyle(statusFilter === 'ALL' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('🌐')
        );
    rows.push(filterRow);

    // Pagination Buttons
    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('page_prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('page_next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const content = `**🛠️ ${actionText} Quest Interattivo**\nFiltro: \`${statusFilter}\` | Pagina: ${page + 1}/${totalPages || 1}`;

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
                const modal = new ModalBuilder().setCustomId('modal_quest_search').setTitle("🔍 Cerca Quest");
                const input = new TextInputBuilder().setCustomId('search_query').setLabel("Titolo o descrizione").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
                await interaction.showModal(modal);

                try {
                    const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_quest_search' && i.user.id === interaction.user.id });
                    const query = submission.fields.getTextInputValue('search_query');
                    await showQuestSelection(ctx, query, 'ALL', 0, submission, mode, targetStatus);
                } catch (e) { }
            } else {
                collector.stop();
                const quest = questRepository.getQuestByTitle(ctx.activeCampaign!.id, val);
                if (!quest) return;

                if (mode === 'DELETE') await showQuestDeleteConfirmation(interaction, quest, ctx);
                else if (mode === 'STATUS_CHANGE') await applyStatusChange(interaction, quest, targetStatus!, ctx);
                else await showQuestFieldSelection(interaction, quest, ctx);
            }
        } else if (interaction.isButton()) {
            if (interaction.customId.startsWith('filter_')) {
                collector.stop();
                const newFilter = interaction.customId.replace('filter_', '');
                await showQuestSelection(ctx, null, newFilter, 0, interaction, mode, targetStatus);
            } else if (interaction.customId === 'page_prev') {
                collector.stop();
                await showQuestSelection(ctx, searchQuery, statusFilter, page - 1, interaction, mode, targetStatus);
            } else if (interaction.customId === 'page_next') {
                collector.stop();
                await showQuestSelection(ctx, searchQuery, statusFilter, page + 1, interaction, mode, targetStatus);
            }
        }
    });
}

async function showQuestDeleteConfirmation(interaction: any, quest: Quest, ctx: CommandContext, isNewMessage: boolean = false) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('btn_confirm_delete').setLabel('Elimina').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('btn_cancel_delete').setLabel('Annulla').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const content = `⚠️ **Confermi l'eliminazione di: ${quest.title}?**\nL'azione è irreversibile.`;
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
            deleteQuestRagSummary(ctx.activeCampaign!.id, quest.title);
            deleteQuestHistory(ctx.activeCampaign!.id, quest.title);
            questRepository.deleteQuest(quest.id);
            await i.update({ content: `✅ Quest **${quest.title}** eliminata.`, components: [] });
        } else {
            await i.update({ content: "❌ Operazione annullata.", components: [] });
        }
    });
}

async function applyStatusChange(interaction: any, quest: Quest, newStatus: string, ctx: CommandContext) {
    // Aggiorna lo stato e marca dirty per sync in background
    questRepository.updateQuestStatusById(quest.id, newStatus as QuestStatus);
    markQuestDirtyForSync(ctx.activeCampaign!.id, quest.title);

    // NON aggiungiamo eventi automatici per cambio stato - sono rumore narrativo
    // La bio verrà rigenerata dal sync in background

    await interaction.update({
        content: `✅ Status di **${quest.title}** aggiornato a **${newStatus}**!`,
        components: []
    });
}

async function showQuestFieldSelection(interaction: any, quest: Quest, ctx: CommandContext, isNewMessage: boolean = false) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('quest_select_field')
        .setPlaceholder(`Modifica: ${quest.title}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Titolo').setValue('title').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Stato').setValue('status').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel('Tipo (Main/Side)').setValue('type').setEmoji('👑'),
            new StringSelectMenuOptionBuilder().setLabel('Nota Narrativa').setValue('note').setEmoji('📝')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = `**🛠️ Modifica Quest: ${quest.title}**\nCosa vuoi cambiare?`;
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
        if (field === 'status') await showQuestStatusUpdate(i, quest, ctx);
        else if (field === 'type') await showQuestTypeUpdate(i, quest, ctx);
        else await showQuestTextModal(i, quest, field, ctx);
    });
}

async function showQuestStatusUpdate(interaction: any, quest: Quest, ctx: CommandContext) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('quest_update_status')
        .setPlaceholder('Nuovo stato...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('APERTA').setValue('OPEN').setEmoji('🔹').setDefault(quest.status === 'OPEN'),
            new StringSelectMenuOptionBuilder().setLabel('IN CORSO').setValue('IN_PROGRESS').setEmoji('⏳').setDefault(quest.status === 'IN_PROGRESS'),
            new StringSelectMenuOptionBuilder().setLabel('COMPLETATA').setValue('COMPLETED').setEmoji('✅').setDefault(quest.status === 'COMPLETED'),
            new StringSelectMenuOptionBuilder().setLabel('FALLITA').setValue('FAILED').setEmoji('❌').setDefault(quest.status === 'FAILED')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ content: `**Aggiorna Stato di: ${quest.title}**`, components: [row] });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newStatus = i.values[0];
        await applyStatusChange(i, quest, newStatus, ctx);
    });
}

async function showQuestTypeUpdate(interaction: any, quest: Quest, ctx: CommandContext) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('quest_update_type')
        .setPlaceholder('Scegli tipo...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('PRINCIPALE (Major)').setValue('MAJOR').setEmoji('👑').setDefault(quest.type === 'MAJOR'),
            new StringSelectMenuOptionBuilder().setLabel('SECONDARIA (Minor)').setValue('MINOR').setEmoji('📜').setDefault(quest.type === 'MINOR')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ content: `**Aggiorna Tipo di: ${quest.title}**`, components: [row] });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newType = i.values[0];
        questRepository.updateQuestFields(quest.id, { type: newType as any });
        await i.update({ content: `✅ Tipo di **${quest.title}** aggiornato a **${newType}**!`, components: [] });
    });
}

async function showQuestTextModal(interaction: any, quest: Quest, field: string, ctx: CommandContext) {
    const modalId = `modal_qtext_${Date.now()}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Modifica ${field}`);

    const valueInput = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'note' ? "Nota Narrativa" : `Nuovo ${field}`)
        .setStyle(field === 'description' || field === 'note' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(field === 'note' ? "" : (quest as any)[field] || "")
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(valueInput));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        const newValue = submission.fields.getTextInputValue('value');

        if (field === 'note') {
            await submission.deferReply(); // Heavy AI stuff coming
            const currentSession = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
            addQuestEvent(ctx.activeCampaign!.id, quest.title, currentSession, newValue, "PROGRESS", true);
            await regenerateQuestBio(ctx.activeCampaign!.id, quest.title, quest.status);
            await submission.editReply(`📝 Nota aggiunta a **${quest.title}**.`);
        } else {
            const updates: any = { [field]: newValue };
            questRepository.updateQuestFields(quest.id, updates);
            if (field === 'title') {
                // Also update history if needed? DB constraints might handle title changes if referenced by ID elsewhere.
                // But quest_history uses titles. Let's update those too.
                db.prepare('UPDATE quest_history SET quest_title = ? WHERE campaign_id = ? AND quest_title = ?')
                    .run(newValue, ctx.activeCampaign!.id, quest.title);
            }
            await submission.reply(`✅ **${quest.title}** aggiornato. Nuovo ${field}: ${newValue}`);
        }
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}
