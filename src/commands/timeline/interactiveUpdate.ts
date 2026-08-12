import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ComponentType,
    TextInputStyle
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
import {
    showWizardEntitySelection,
    showWizardDeleteConfirmation,
    showWizardFieldSelection,
    showWizardEnumSelection,
    promptWizardModal,
    WizardEntitySelectionConfig
} from '../utils/interactiveWizard';
import { t, eventTypeLabel, yearLabel } from '../../i18n';
import { deleteEntityForWizard } from '../utils/entityDelete';

// Labels come from the single i18n catalogue (eventTypeLabel); only canonical values + emoji here.
const EVENT_TYPES = [
    { value: 'WAR', emoji: '⚔️' },
    { value: 'POLITICS', emoji: '👑' },
    { value: 'DISCOVERY', emoji: '💎' },
    { value: 'CALAMITY', emoji: '🌋' },
    { value: 'SUPERNATURAL', emoji: '🔮' },
    { value: 'MYTH', emoji: '🏺' },
    { value: 'RELIGION', emoji: '⚜️' },
    { value: 'BIRTH', emoji: '👶' },
    { value: 'DEATH', emoji: '💀' },
    { value: 'CONSTRUCTION', emoji: '🏛️' },
    { value: 'GENERIC', emoji: '🔹' }
];

const buildSelectionConfig = (ctx: CommandContext): WizardEntitySelectionConfig<any, 'UPDATE' | 'DELETE'> => ({
    wizardTitle: t(ctx.locale, 'timeline.wizardTitle'),
    customIdPrefix: 'timeline',
    list: (searchQuery) => {
        let events = getWorldTimeline(ctx.activeCampaign!.id);
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            events = events.filter(e =>
                e.description.toLowerCase().includes(query) ||
                e.event_type.toLowerCase().includes(query) ||
                e.short_id.toLowerCase().includes(query.replace('#', ''))
            );
        }
        return events.slice(-24).reverse();
    },
    option: (e) => ({
        label: `[${yearLabel(ctx.locale, e.year)}] ${e.description.substring(0, 50)}`,
        description: t(ctx.locale, 'timeline.optionDesc', { id: e.short_id, type: eventTypeLabel(ctx.locale, e.event_type) }),
        value: e.short_id,
        emoji: EVENT_TYPES.find(t => t.value === e.event_type)?.emoji || '🔹'
    }),
    resolveByValue: (val) => getWorldEventByShortId(ctx.activeCampaign!.id, val),
    emptyMessage: (searchQuery) => searchQuery ? t(ctx.locale, 'timeline.noEventsSearch', { query: searchQuery }) : t(ctx.locale, 'timeline.emptyWizard'),
    actionLabel: (mode) => mode === 'DELETE' ? t(ctx.locale, 'wizard.actionDelete') : t(ctx.locale, 'wizard.actionUpdate'),
    searchLabel: t(ctx.locale, 'timeline.searchLabel'),
    onSelect: async (interaction, event, mode) => {
        if (mode === 'DELETE') {
            await showEventDeleteConfirmation(interaction, event, ctx);
        } else {
            await showEventFieldSelection(interaction, event, ctx);
        }
    }
});

export async function startInteractiveTimelineAdd(ctx: CommandContext) {
    const typeSelect = new StringSelectMenuBuilder()
        .setCustomId('select_timeline_add_type')
        .setPlaceholder(t(ctx.locale, 'timeline.selectType'))
        .addOptions(
            EVENT_TYPES.map(et =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(eventTypeLabel(ctx.locale, et.value))
                    .setValue(et.value)
                    .setEmoji(et.emoji)
            )
        );

    const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(typeSelect);

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'timeline.addWizardHeader'),
        components: [rowSelect]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_timeline_add_type' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const selectedType = interaction.values[0];

        const result = await promptWizardModal(interaction, {
            title: t(ctx.locale, 'timeline.newEventModal', { type: eventTypeLabel(ctx.locale, selectedType) }),
            inputs: [
                {
                    id: 'event_year',
                    label: t(ctx.locale, 'timeline.inputYear'),
                    placeholder: "0",
                    value: ctx.activeCampaign?.current_year?.toString() || "0"
                },
                {
                    id: 'event_description',
                    label: t(ctx.locale, 'timeline.inputDescription'),
                    style: TextInputStyle.Paragraph,
                    placeholder: t(ctx.locale, 'timeline.inputDescPlaceholder')
                }
            ]
        });
        if (!result) return;

        const year = parseInt(result.values.event_year);
        const description = result.values.event_description;

        if (isNaN(year)) {
            await result.submission.reply({ content: t(ctx.locale, 'timeline.yearMustBeNumberEx'), ephemeral: true });
            return;
        }

        addWorldEvent(ctx.activeCampaign!.id, null, description, selectedType, year, true);

        await result.submission.reply({
            content: t(ctx.locale, 'timeline.eventAddedFull', {
                year,
                emoji: EVENT_TYPES.find(et => et.value === selectedType)?.emoji || '🔹',
                type: eventTypeLabel(ctx.locale, selectedType),
                desc: description
            })
        });

        try { await reply.delete(); } catch { }
    });
}

export async function startInteractiveTimelineUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const event = getWorldEventByShortId(ctx.activeCampaign!.id, ctx.args[0]);
        if (event) {
            await showEventFieldSelection(ctx.message as any, event, ctx, true);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'UPDATE');
}

export async function startInteractiveTimelineDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const event = getWorldEventByShortId(ctx.activeCampaign!.id, ctx.args[0]);
        if (event) {
            await showEventDeleteConfirmation(ctx.message as any, event, ctx, true);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'DELETE');
}

async function showEventDeleteConfirmation(interaction: any, event: any, ctx: CommandContext, isNewMessage: boolean = false) {
    await showWizardDeleteConfirmation(ctx, isNewMessage ? null : interaction, {
        content: t(ctx.locale, 'timeline.deleteConfirm', { label: yearLabel(ctx.locale, event.year), desc: event.description }),
        confirmLabel: t(ctx.locale, 'timeline.confirmDeleteBtn'),
        onConfirm: () => deleteEntityForWizard(ctx, 'timeline', event),
        successContent: t(ctx.locale, 'timeline.eventDeletedWizard', { id: event.short_id }),
        failureContent: t(ctx.locale, 'wizard.deleteError')
    });
}

async function showEventFieldSelection(interaction: any, event: any, ctx: CommandContext, isNewMessage: boolean = false) {
    await showWizardFieldSelection(ctx, isNewMessage ? null : interaction, {
        content: t(ctx.locale, 'timeline.editHeader', { id: event.short_id }),
        placeholder: t(ctx.locale, 'timeline.editPlaceholder', { id: event.short_id }),
        customIdPrefix: 'timeline',
        fields: [
            { label: t(ctx.locale, 'timeline.wordYear'), value: 'year', description: t(ctx.locale, 'timeline.fieldYearDesc'), emoji: '📅' },
            { label: t(ctx.locale, 'timeline.wordType'), value: 'type', description: t(ctx.locale, 'timeline.fieldTypeDesc'), emoji: '🏷️' },
            { label: t(ctx.locale, 'timeline.wordDescription'), value: 'description', description: t(ctx.locale, 'timeline.fieldDescriptionDesc'), emoji: '📜' }
        ],
        onField: async (i, field) => {
            if (field === 'type') {
                await showEventTypeSelection(i, event, ctx);
            } else {
                await showEventTextModal(i, event, field, ctx);
            }
        }
    });
}

async function showEventTypeSelection(interaction: any, event: any, ctx: CommandContext) {
    await showWizardEnumSelection(ctx, interaction, {
        content: t(ctx.locale, 'timeline.updateTypeHeader', { id: event.short_id }),
        customId: 'timeline_update_select_type',
        placeholder: t(ctx.locale, 'timeline.selectTypeShort'),
        options: EVENT_TYPES.map(et => ({
            label: eventTypeLabel(ctx.locale, et.value),
            value: et.value,
            emoji: et.emoji,
            isDefault: et.value === event.event_type
        })),
        onPick: async (i, newType) => {
            updateWorldEvent(event.id, { event_type: newType });
            markWorldEventDirty(event.id);

            await i.update({
                content: t(ctx.locale, 'timeline.typeUpdated', { id: event.short_id, type: eventTypeLabel(ctx.locale, newType) }),
                components: []
            });
        }
    });
}

async function showEventTextModal(interaction: any, event: any, field: string, ctx: CommandContext) {
    const label = field === 'year' ? t(ctx.locale, 'timeline.wordYear') : t(ctx.locale, 'timeline.wordDescription');

    const result = await promptWizardModal(interaction, {
        title: t(ctx.locale, 'timeline.editModalTitle', { label }),
        inputs: [{
            id: 'input_value',
            label: t(ctx.locale, 'timeline.newValueFor', { label }),
            style: field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short,
            value: field === 'year' ? event.year.toString() : event.description
        }]
    });
    if (!result) return;

    const newValue = result.values.input_value;
    const updates: any = {};

    if (field === 'year') {
        const year = parseInt(newValue);
        if (isNaN(year)) {
            await result.submission.reply({ content: t(ctx.locale, 'timeline.yearMustBeNumberEx'), ephemeral: true });
            return;
        }
        updates.year = year;
    } else {
        updates.description = newValue;
    }

    updateWorldEvent(event.id, updates);
    markWorldEventDirty(event.id);

    await result.submission.reply({
        content: t(ctx.locale, 'timeline.eventUpdated', { id: event.short_id, label, value: newValue }),
    });

    try { await interaction.message.edit({ components: [] }); } catch (e) { }
}
