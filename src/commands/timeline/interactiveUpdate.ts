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
    Message,
    InteractionResponse
} from 'discord.js';
import { CommandContext } from '../types';
import {
    addWorldEvent,
    getWorldTimeline,
    deleteWorldEvent,
    getWorldEventByShortId,
    updateWorldEvent,
    markWorldEventDirty
} from '../../db';

const EVENT_TYPES = [
    { label: 'GUERRA', value: 'WAR', emoji: '⚔️' },
    { label: 'POLITICA', value: 'POLITICS', emoji: '👑' },
    { label: 'SCOPERTA', value: 'DISCOVERY', emoji: '💎' },
    { label: 'CALAMITÀ', value: 'CALAMITY', emoji: '🌋' },
    { label: 'SOVRANNATURALE', value: 'SUPERNATURAL', emoji: '🔮' },
    { label: 'MITO', value: 'MYTH', emoji: '🏺' },
    { label: 'RELIGIONE', value: 'RELIGION', emoji: '⚜️' },
    { label: 'NASCITA', value: 'BIRTH', emoji: '👶' },
    { label: 'MORTE', value: 'DEATH', emoji: '💀' },
    { label: 'COSTRUZIONE', value: 'CONSTRUCTION', emoji: '🏛️' },
    { label: 'GENERICO', value: 'GENERIC', emoji: '🔹' }
];

export async function startInteractiveTimelineAdd(ctx: CommandContext) {
    const typeSelect = new StringSelectMenuBuilder()
        .setCustomId('select_timeline_add_type')
        .setPlaceholder('Seleziona il tipo di evento...')
        .addOptions(
            EVENT_TYPES.map(t =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(t.label)
                    .setValue(t.value)
                    .setEmoji(t.emoji)
            )
        );

    const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(typeSelect);

    const reply = await ctx.message.reply({
        content: "**🛠️ Aggiunta Evento Cronologia**\nPer prima cosa, seleziona il **tipo** di evento che vuoi registrare:",
        components: [rowSelect]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_timeline_add_type' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const selectedType = interaction.values[0];
        const typeInfo = EVENT_TYPES.find(t => t.value === selectedType);

        const modalId = `modal_timeline_add_${Date.now()}`;
        const modal = new ModalBuilder()
            .setCustomId(modalId)
            .setTitle(`Nuovo Evento: ${typeInfo?.label || selectedType}`);

        const yearInput = new TextInputBuilder()
            .setCustomId('event_year')
            .setLabel("Anno (es. -500 o 1247)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("0")
            .setValue(ctx.activeCampaign?.current_year?.toString() || "0")
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('event_description')
            .setLabel("Descrizione")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Descrivi cosa è successo...")
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(yearInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
        );

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === modalId && i.user.id === interaction.user.id
            });

            const yearStr = submission.fields.getTextInputValue('event_year');
            const description = submission.fields.getTextInputValue('event_description');
            const year = parseInt(yearStr);

            if (isNaN(year)) {
                await submission.reply({ content: "❌ L'anno deve essere un numero!", ephemeral: true });
                return;
            }

            addWorldEvent(ctx.activeCampaign!.id, null, description, selectedType, year, true);

            await submission.reply({
                content: `✅ **Evento Storico Aggiunto!**\n📅 Anno: **${year}**\n${typeInfo?.emoji || '🔹'} Tipo: **${typeInfo?.label || selectedType}**\n📜 ${description}`
            });

            try { await reply.delete(); } catch { }
        } catch (err) { }
    });
}

export async function startInteractiveTimelineUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args[0];
        const event = getWorldEventByShortId(ctx.activeCampaign!.id, query);
        if (event) {
            await showEventFieldSelection(ctx.message as any, event, ctx, true);
            return;
        }
    }

    await showEventSelection(ctx, null, null, 'UPDATE');
}

export async function startInteractiveTimelineDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args[0];
        const event = getWorldEventByShortId(ctx.activeCampaign!.id, query);
        if (event) {
            await showEventDeleteConfirmation(ctx.message as any, event, ctx, true);
            return;
        }
    }

    await showEventSelection(ctx, null, null, 'DELETE');
}

async function showEventSelection(ctx: CommandContext, searchQuery: string | null, interactionToUpdate: any | null, mode: 'UPDATE' | 'DELETE') {
    let events = getWorldTimeline(ctx.activeCampaign!.id);

    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        events = events.filter(e =>
            e.description.toLowerCase().includes(query) ||
            e.event_type.toLowerCase().includes(query) ||
            e.short_id.toLowerCase().includes(query.replace('#', ''))
        );
    }

    const displayedEvents = events.slice(-24).reverse();

    if (events.length === 0) {
        const content = searchQuery ? `❌ Nessun evento trovato per "${searchQuery}".` : "📜 La cronologia è vuota.";
        if (interactionToUpdate) await interactionToUpdate.update({ content, components: [] });
        else await ctx.message.reply(content);
        return;
    }

    const options = displayedEvents.map(e => {
        const yearLabel = e.year === 0 ? "Anno 0" : (e.year > 0 ? `${e.year} D.E.` : `${Math.abs(e.year)} P.E.`);
        return new StringSelectMenuOptionBuilder()
            .setLabel(`[${yearLabel}] ${e.description.substring(0, 50)}`)
            .setDescription(`ID: #${e.short_id} | Tipo: ${e.event_type}`)
            .setValue(e.short_id)
            .setEmoji(EVENT_TYPES.find(t => t.value === e.event_type)?.emoji || '🔹');
    });

    options.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel("🔍 Cerca...")
            .setDescription("Filtra eventi per descrizione o tipo")
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    const actionText = mode === 'DELETE' ? "Eliminazione" : "Aggiornamento";
    const eventSelect = new StringSelectMenuBuilder()
        .setCustomId('timeline_update_select_event')
        .setPlaceholder(searchQuery ? `Risultati per: ${searchQuery}` : `🔍 Seleziona un evento da ${actionText.toLowerCase()}...`)
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(eventSelect);
    const content = searchQuery
        ? `**📜 ${actionText} Cronologia**\nRisultati per "${searchQuery}":`
        : `**📜 ${actionText} Cronologia Interattiva**\nSeleziona un evento dalla lista:`;

    let response: Message;
    if (interactionToUpdate) {
        if (interactionToUpdate.isMessageComponent()) {
            await interactionToUpdate.update({ content, components: [row] });
            response = interactionToUpdate.message as Message;
        } else {
            // Modal submit or other interaction that already replied/updated
            response = await interactionToUpdate.editReply({ content, components: [row] }) as Message;
        }
    } else {
        response = await ctx.message.reply({ content, components: [row] });
    }

    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.user.id === ctx.message.author.id && i.customId === 'timeline_update_select_event'
    });

    collector.on('collect', async (interaction) => {
        const val = interaction.values[0];

        if (val === 'SEARCH_ACTION') {
            collector.stop();
            const modal = new ModalBuilder()
                .setCustomId('modal_timeline_search')
                .setTitle("🔍 Cerca Evento");

            const input = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel("Descrizione o tipo")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

            await interaction.showModal(modal);

            try {
                const submission = await interaction.awaitModalSubmit({
                    time: 60000,
                    filter: (i) => i.customId === 'modal_timeline_search' && i.user.id === interaction.user.id
                });
                const query = submission.fields.getTextInputValue('search_query');
                await showEventSelection(ctx, query, submission, mode);
            } catch (e) { }
        } else {
            collector.stop();
            const event = getWorldEventByShortId(ctx.activeCampaign!.id, val);

            if (!event) {
                await interaction.reply({ content: `❌ Errore: Evento #${val} non trovato.`, ephemeral: true });
                return;
            }

            if (mode === 'DELETE') {
                await showEventDeleteConfirmation(interaction, event, ctx);
            } else {
                await showEventFieldSelection(interaction, event, ctx);
            }
        }
    });
}

async function showEventDeleteConfirmation(interaction: any, event: any, ctx: CommandContext, isNewMessage: boolean = false) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_confirm_timeline_delete')
                .setLabel('ELIMINA EVENTO')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️'),
            new ButtonBuilder()
                .setCustomId('btn_cancel_timeline_delete')
                .setLabel('Annulla')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('❌')
        );

    const yearLabel = event.year === 0 ? "Anno 0" : (event.year > 0 ? `${event.year} D.E.` : `${Math.abs(event.year)} P.E.`);
    const content = `⚠️ **ATTENZIONE** ⚠️\nSei sicuro di voler eliminare l'evento di cronologia:\n\n**[${yearLabel}]** ${event.description}\n\n*Questa azione è irreversibile.*`;

    let response: Message;
    if (isNewMessage) {
        response = await interaction.reply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
        response = interaction.message;
    }

    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30000,
        filter: (i) => i.user.id === ctx.message.author.id && ['btn_confirm_timeline_delete', 'btn_cancel_timeline_delete'].includes(i.customId)
    });

    collector.on('collect', async (i) => {
        collector.stop();
        if (i.customId === 'btn_confirm_timeline_delete') {
            const success = deleteWorldEvent(event.id);
            if (success) {
                await i.update({ content: `✅ Evento **#${event.short_id}** eliminato dalla cronologia.`, components: [] });
            } else {
                await i.update({ content: `❌ Errore durante l'eliminazione dell'evento.`, components: [] });
            }
        } else {
            await i.update({ content: `❌ Operazione annullata.`, components: [] });
        }
    });
}

async function showEventFieldSelection(interaction: any, event: any, ctx: CommandContext, isNewMessage: boolean = false) {
    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId('timeline_update_select_field')
        .setPlaceholder(`Modifica Evento #${event.short_id}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Anno').setValue('year').setDescription('Cambia l\'anno dell\'evento').setEmoji('📅'),
            new StringSelectMenuOptionBuilder().setLabel('Tipo').setValue('type').setDescription('Cambia il tipo (WAR, POLITICS...)').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setDescription('Modifica il testo dell\'evento').setEmoji('📜')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fieldSelect);
    const content = `**🛠️ Modifica Evento Storico #${event.short_id}**\nCosa vuoi cambiare?`;

    let response: Message;
    if (isNewMessage) {
        response = await interaction.reply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
        response = interaction.message;
    }

    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.user.id === ctx.message.author.id && i.customId === 'timeline_update_select_field'
    });

    collector.on('collect', async (i) => {
        collector.stop();
        const field = i.values[0];

        if (field === 'type') {
            await showEventTypeSelection(i, event, ctx);
        } else {
            await showEventTextModal(i, event, field, ctx);
        }
    });
}

async function showEventTypeSelection(interaction: any, event: any, ctx: CommandContext) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('timeline_update_select_type')
        .setPlaceholder('Seleziona tipo evento...')
        .addOptions(
            EVENT_TYPES.map(t =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(t.label)
                    .setValue(t.value)
                    .setEmoji(t.emoji)
                    .setDefault(t.value === event.event_type)
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Aggiorna Tipo per l'Evento #${event.short_id}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'timeline_update_select_type'
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newType = i.values[0];
        updateWorldEvent(event.id, { event_type: newType });
        markWorldEventDirty(event.id);

        await i.update({
            content: `✅ Tipo dell'evento **#${event.short_id}** aggiornato a **${newType}**!`,
            components: []
        });
    });
}

async function showEventTextModal(interaction: any, event: any, field: string, ctx: CommandContext) {
    const modalId = `modal_timeline_update_${field}_${Date.now()}`;
    const label = field === 'year' ? 'Anno' : 'Descrizione';

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`Modifica ${label}`);

    const input = new TextInputBuilder()
        .setCustomId('input_value')
        .setLabel(`Nuovo valore per ${label}`)
        .setStyle(field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(field === 'year' ? event.year.toString() : event.description)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        const newValue = submission.fields.getTextInputValue('input_value');
        const updates: any = {};

        if (field === 'year') {
            const year = parseInt(newValue);
            if (isNaN(year)) {
                await submission.reply({ content: "❌ L'anno deve essere un numero!", ephemeral: true });
                return;
            }
            updates.year = year;
        } else {
            updates.description = newValue;
        }

        updateWorldEvent(event.id, updates);
        markWorldEventDirty(event.id);

        await submission.reply({
            content: `✅ Evento **#${event.short_id}** aggiornato!\n${label}: ${newValue}`,
        });

        try { await interaction.message.edit({ components: [] }); } catch (e) { }

    } catch (err) { }
}
