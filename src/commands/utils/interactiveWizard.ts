/**
 * Shared scaffolding of the interactive wizards (update/delete via select menu).
 *
 * Each interactiveUpdate.ts (npc, factions, atlas, timeline) used to duplicate:
 * entity selection with a "🔍 Search..." entry + search modal, delete
 * confirmation with buttons, field selection, text modal and enum select.
 * It lives here once; the per-entity files keep only their specific fields
 * and their persistence logic.
 */

import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ComponentType,
    ButtonBuilder,
    ButtonStyle,
    Message
} from 'discord.js';
import { CommandContext } from '../types';
import { Locale, t } from '../../i18n';
import { assertCampaignWrite } from './campaignWrite';

/**
 * Shows a payload in the right place: reply on the command message, update of
 * the interaction (component, or modal-from-component), or a brand new reply.
 * Returns the Message the collectors should be attached to.
 */
export async function presentStep(
    ctx: CommandContext,
    interaction: any | null,
    payload: { content: string; components: any[] },
    newMessage: boolean = false
): Promise<Message> {
    if (!interaction) {
        return await ctx.message.reply(payload);
    }
    if (newMessage) {
        return await interaction.reply(payload);
    }
    if (typeof interaction.update === 'function') {
        await interaction.update(payload);
        return interaction.message as Message;
    }
    return await interaction.reply(payload);
}

export interface WizardSelectOption {
    label: string;
    description: string;
    value: string;
    emoji: string;
}

export interface WizardEntitySelectionConfig<T, M extends string> {
    /** Section name used in titles, e.g. 'Atlante', 'Cronologia'. */
    wizardTitle: string;
    /** customId prefix, e.g. 'atlas' → 'atlas_wizard_select_entity'. */
    customIdPrefix: string;
    /** List (already capped at ≤24 entries) for an optional search query. */
    list(searchQuery: string | null): T[];
    option(entity: T): WizardSelectOption;
    /** Re-fetches the entity from the option's value. */
    resolveByValue(value: string): T | null | undefined;
    /** Message shown when the list is empty. */
    emptyMessage(searchQuery: string | null): string;
    /** Action label per mode, e.g. DELETE → 'Eliminazione'. */
    actionLabel(mode: M): string;
    /** Label of the field in the search modal. */
    searchLabel?: string;
    onSelect(interaction: any, entity: T, mode: M): Promise<void>;
}

/**
 * Entity selection with a leading "🔍 Search..." entry: the standard way the
 * update/delete wizards open.
 */
export async function showWizardEntitySelection<T, M extends string>(
    ctx: CommandContext,
    cfg: WizardEntitySelectionConfig<T, M>,
    mode: M,
    searchQuery: string | null = null,
    interactionToUpdate: any | null = null
): Promise<void> {
    // Single entry point of the four wizards: every way it gets called
    // (UPDATE, DELETE, EVENTS_*) is a write, so the check lives here and not
    // in fifteen different starting points.
    if (!await assertCampaignWrite(ctx)) return;

    const entities = cfg.list(searchQuery);

    if (entities.length === 0) {
        const content = cfg.emptyMessage(searchQuery);
        if (interactionToUpdate) await interactionToUpdate.update({ content, components: [] });
        else await ctx.message.reply(content);
        return;
    }

    const options = entities.map(e => {
        const o = cfg.option(e);
        return new StringSelectMenuOptionBuilder()
            .setLabel(o.label.substring(0, 100))
            .setDescription(o.description.substring(0, 100))
            .setValue(o.value)
            .setEmoji(o.emoji);
    });

    options.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel(t(ctx.locale, 'wizard.searchOption'))
            .setDescription(t(ctx.locale, 'wizard.searchOptionDesc'))
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    const selectId = `${cfg.customIdPrefix}_wizard_select_entity`;
    const actionText = cfg.actionLabel(mode);
    const select = new StringSelectMenuBuilder()
        .setCustomId(selectId)
        .setPlaceholder(searchQuery ? t(ctx.locale, 'wizard.resultsFor', { q: searchQuery }) : t(ctx.locale, 'wizard.selectFor', { action: actionText.toLowerCase() }))
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = searchQuery
        ? t(ctx.locale, 'wizard.headerSearch', { action: actionText, title: cfg.wizardTitle, q: searchQuery })
        : t(ctx.locale, 'wizard.header', { action: actionText, title: cfg.wizardTitle });

    const response = await presentStep(ctx, interactionToUpdate, { content, components: [row] });

    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === selectId
    });

    collector.on('collect', async (interaction: any) => {
        collector.stop();
        const val = interaction.values[0];

        if (val === 'SEARCH_ACTION') {
            const modalId = `modal_${cfg.customIdPrefix}_wizard_search`;
            const modal = new ModalBuilder()
                .setCustomId(modalId)
                .setTitle(t(ctx.locale, 'wizard.searchModalTitle'));

            const input = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel(cfg.searchLabel || t(ctx.locale, 'wizard.searchDefaultLabel'))
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

            await interaction.showModal(modal);

            try {
                const submission = await interaction.awaitModalSubmit({
                    time: 60000,
                    filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
                });
                const query = submission.fields.getTextInputValue('search_query');
                await showWizardEntitySelection(ctx, cfg, mode, query, submission);
            } catch (e) {
                // timeout
            }
            return;
        }

        const entity = cfg.resolveByValue(val);
        if (!entity) {
            await interaction.reply({ content: t(ctx.locale, 'wizard.elementNotFound', { val }), ephemeral: true });
            return;
        }

        await cfg.onSelect(interaction, entity, mode);
    });
}

/** Delete confirmation with Danger/Cancel buttons. */
export async function showWizardDeleteConfirmation(
    ctx: CommandContext,
    interaction: any,
    opts: {
        content: string;
        confirmLabel?: string;
        /** Performs the deletion; returns false to show failureContent. */
        onConfirm(): boolean | Promise<boolean>;
        successContent: string;
        failureContent?: string;
        newMessage?: boolean;
    }
): Promise<void> {
    // The check also lives inside deleteEntityFromCommand; here it avoids
    // showing a confirmation to someone who could not proceed anyway.
    if (!await assertCampaignWrite(ctx)) return;

    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_wizard_confirm_delete')
                .setLabel(opts.confirmLabel || t(ctx.locale, 'wizard.confirmDelete'))
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️'),
            new ButtonBuilder()
                .setCustomId('btn_wizard_cancel_delete')
                .setLabel(t(ctx.locale, 'common.cancel'))
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('❌')
        );

    const message = await presentStep(ctx, interaction, { content: opts.content, components: [row] }, opts.newMessage);

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id && ['btn_wizard_confirm_delete', 'btn_wizard_cancel_delete'].includes(i.customId)
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        if (i.customId === 'btn_wizard_confirm_delete') {
            const success = await opts.onConfirm();
            if (success) {
                await i.update({ content: opts.successContent, components: [] });
            } else {
                await i.update({ content: opts.failureContent || t(ctx.locale, 'wizard.deleteError'), components: [] });
            }
        } else {
            await i.update({ content: t(ctx.locale, 'wizard.cancelled'), components: [] });
        }
    });
}

export interface WizardFieldOption {
    label: string;
    value: string;
    description: string;
    emoji: string;
}

/** "Which field do you want to edit?" menu. */
export async function showWizardFieldSelection(
    ctx: CommandContext,
    interaction: any,
    opts: {
        content: string;
        placeholder: string;
        customIdPrefix: string;
        fields: WizardFieldOption[];
        onField(interaction: any, field: string): Promise<void>;
        newMessage?: boolean;
    }
): Promise<void> {
    // Single entry point of the edit path of the four wizards
    // (npc/factions/atlas/timeline).
    if (!await assertCampaignWrite(ctx)) return;

    const selectId = `${opts.customIdPrefix}_wizard_select_field`;
    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId(selectId)
        .setPlaceholder(opts.placeholder)
        .addOptions(
            opts.fields.map(f =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(f.label)
                    .setValue(f.value)
                    .setDescription(f.description)
                    .setEmoji(f.emoji)
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fieldSelect);
    const message = await presentStep(ctx, interaction, { content: opts.content, components: [row] }, opts.newMessage);

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === selectId
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        await opts.onField(i, i.values[0]);
    });
}

/** Select of enum values (status, type…) with onPick. */
export async function showWizardEnumSelection(
    ctx: CommandContext,
    interaction: any,
    opts: {
        content: string;
        customId: string;
        placeholder?: string;
        options: Array<{ label: string; value: string; emoji?: string; description?: string; isDefault?: boolean }>;
        onPick(interaction: any, value: string): Promise<void>;
    }
): Promise<void> {
    const select = new StringSelectMenuBuilder()
        .setCustomId(opts.customId)
        .setPlaceholder(opts.placeholder || t(ctx.locale, 'wizard.selectPlaceholder'))
        .addOptions(
            opts.options.map(o => {
                const builder = new StringSelectMenuOptionBuilder()
                    .setLabel(o.label)
                    .setValue(o.value)
                    .setDefault(o.isDefault || false);
                if (o.emoji) builder.setEmoji(o.emoji);
                if (o.description) builder.setDescription(o.description.substring(0, 100));
                return builder;
            })
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ content: opts.content, components: [row] });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === opts.customId
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        await opts.onPick(i, i.values[0]);
    });
}

export interface WizardModalInput {
    id: string;
    label: string;
    style?: TextInputStyle;
    value?: string;
    placeholder?: string;
    required?: boolean;
}

/**
 * Text modal: shows it, awaits the submit and returns the values
 * (null on timeout). The title is truncated to the Discord limit (45).
 */
export async function promptWizardModal(
    interaction: any,
    opts: { title: string; inputs: WizardModalInput[]; time?: number }
): Promise<{ submission: any; values: Record<string, string> } | null> {
    const modalId = `modal_wizard_${Date.now()}`;
    const title = opts.title.length > 45 ? opts.title.substring(0, 42) + '...' : opts.title;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    for (const input of opts.inputs) {
        const builder = new TextInputBuilder()
            .setCustomId(input.id)
            .setLabel(input.label.substring(0, 45))
            .setStyle(input.style ?? TextInputStyle.Short)
            .setRequired(input.required ?? true);
        if (input.value !== undefined) builder.setValue(input.value);
        if (input.placeholder) builder.setPlaceholder(input.placeholder);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(builder));
    }

    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: opts.time ?? 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        const values: Record<string, string> = {};
        for (const input of opts.inputs) {
            values[input.id] = submission.fields.getTextInputValue(input.id);
        }
        return { submission, values };
    } catch (err) {
        return null;
    }
}

/**
 * "Edit Again" button after a successful update: on click it calls
 * onAgain with the button's interaction.
 */
export function buildUpdateAgainRow(customId: string, locale: Locale = 'it'): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(customId)
                .setLabel(t(locale, 'wizard.editAgain'))
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('✏️')
        );
}

export function attachUpdateAgain(
    message: Message,
    customId: string,
    authorId: string,
    onAgain: (interaction: any) => Promise<void>
): void {
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (btn: any) => btn.customId === customId && btn.user.id === authorId
    });
    collector.on('collect', async (btn: any) => {
        collector.stop();
        await onAgain(btn);
    });
}
