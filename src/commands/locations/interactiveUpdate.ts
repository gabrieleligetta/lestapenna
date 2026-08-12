import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputStyle,
    ComponentType,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { CommandContext } from '../types';
import {
    locationRepository,
    factionRepository,
} from '../../db';
import { parseShortId } from '../../utils/shortId';
import {
    showWizardEntitySelection,
    showWizardDeleteConfirmation,
    showWizardFieldSelection,
    promptWizardModal,
    buildUpdateAgainRow,
    attachUpdateAgain,
    WizardEntitySelectionConfig
} from '../utils/interactiveWizard';
import { t, getCampaignLocale } from '../../i18n';
import { deleteEntityForWizard } from '../utils/entityDelete';

/** Risoluzione per short-id o nome esatto (macro, micro o "macro micro"). */
function resolveLocationByQuery(campaignId: number, query: string): any | null {
    const sid = parseShortId(query);
    if (sid) {
        const loc = locationRepository.getAtlasEntryByShortId(campaignId, sid);
        if (loc) return loc;
    }

    const all = locationRepository.listAllAtlasEntries(campaignId);
    const cleanQuery = query.toLowerCase();
    return all.find(l =>
        l.micro_location.toLowerCase() === cleanQuery ||
        l.macro_location.toLowerCase() === cleanQuery ||
        `${l.macro_location} ${l.micro_location}`.toLowerCase() === cleanQuery
    ) || null;
}

const buildSelectionConfig = (ctx: CommandContext): WizardEntitySelectionConfig<any, 'UPDATE' | 'DELETE'> => ({
    wizardTitle: 'Atlante',
    customIdPrefix: 'atlas',
    list: (searchQuery) => {
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            return locationRepository.listAllAtlasEntries(ctx.activeCampaign!.id).filter(l =>
                l.macro_location.toLowerCase().includes(query) ||
                l.micro_location.toLowerCase().includes(query) ||
                l.short_id.toLowerCase().includes(query)
            ).slice(0, 24);
        }
        return locationRepository.listAtlasEntries(ctx.activeCampaign!.id, 24, 0);
    },
    option: (l) => ({
        label: `${l.macro_location} - ${l.micro_location}`,
        description: l.description ? l.description.substring(0, 50) : t(ctx.locale, 'npc.noDescription'),
        value: `#${l.short_id}`,
        emoji: '🌍'
    }),
    resolveByValue: (val) => locationRepository.getAtlasEntryByShortId(ctx.activeCampaign!.id, val.replace('#', '')),
    emptyMessage: (searchQuery) => searchQuery ? t(ctx.locale, 'atlas.wizNoResults', { query: searchQuery }) : t(ctx.locale, 'atlas.wizEmptyMap'),
    actionLabel: (mode) => mode === 'DELETE' ? t(ctx.locale, 'wizard.actionDelete') : t(ctx.locale, 'wizard.actionUpdate'),
    onSelect: async (interaction, loc, mode) => {
        if (mode === 'DELETE') {
            await showAtlasDeleteConfirmation(interaction, loc, ctx);
        } else {
            await showFieldSelection(interaction, loc, ctx);
        }
    }
});

export async function startInteractiveAtlasUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const loc = resolveLocationByQuery(ctx.activeCampaign!.id, ctx.args.join(' '));
        if (loc) {
            await showFieldSelection(null, loc, ctx);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'UPDATE');
}

export async function startInteractiveAtlasDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const loc = resolveLocationByQuery(ctx.activeCampaign!.id, ctx.args.join(' '));
        if (loc) {
            await showAtlasDeleteConfirmation(null, loc, ctx);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'DELETE');
}

export async function startInteractiveAtlasAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_atlas_add')
                .setLabel(t(ctx.locale, 'atlas.wizAddBtn'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('🗺️')
        );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'atlas.wizAddPrompt'),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_atlas_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const result = await promptWizardModal(interaction, {
            title: t(ctx.locale, 'atlas.wizModalTitle'),
            inputs: [
                { id: 'atlas_macro', label: t(ctx.locale, 'atlas.wizModalMacro'), placeholder: t(ctx.locale, 'atlas.wizModalMacroPh') },
                { id: 'atlas_micro', label: t(ctx.locale, 'atlas.wizModalMicro'), placeholder: t(ctx.locale, 'atlas.wizModalMicroPh') },
                { id: 'atlas_desc', label: t(ctx.locale, 'atlas.wizModalDesc'), style: TextInputStyle.Paragraph, required: false }
            ]
        });
        if (!result) return;

        const macro = result.values.atlas_macro;
        const micro = result.values.atlas_micro;
        const desc = result.values.atlas_desc || t(getCampaignLocale(ctx.activeCampaign!.id), 'atlas.wizDefaultDesc');
        const submission = result.submission;

        // Check existence
        const existing = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);
        if (existing) {
            await submission.reply({
                content: t(ctx.locale, 'atlas.wizExists', { macro, micro, shortId: existing.short_id || '' }),
                ephemeral: true
            });
            return;
        }

        // Create
        locationRepository.updateAtlasEntry(ctx.activeCampaign!.id, macro, micro, desc, undefined, true);

        // Success Reply with Edit Button
        const successRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('edit_created_atlas')
                    .setLabel(t(ctx.locale, 'npc.wizEditDetailsBtn'))
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('✏️')
            );

        await submission.reply({
            content: t(ctx.locale, 'atlas.wizCreated', { macro, micro, desc }),
            components: [successRow]
        });

        try { await reply.delete(); } catch { }

        // Edit Listener
        const message = await submission.fetchReply();
        attachUpdateAgain(message, 'edit_created_atlas', ctx.message.author.id, async (i) => {
            const loc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);
            if (loc) {
                await showFieldSelection(i, loc, ctx);
            } else {
                await i.reply({ content: t(ctx.locale, 'atlas.wizFetchError'), ephemeral: true });
            }
        });
    });

    collector.on('end', () => {
        if (reply.editable) reply.edit({ components: [] }).catch(() => { });
    });
}

async function showAtlasDeleteConfirmation(interaction: any | null, loc: any, ctx: CommandContext) {
    await showWizardDeleteConfirmation(ctx, interaction, {
        content: t(ctx.locale, 'atlas.wizDeleteConfirm', { macro: loc.macro_location, micro: loc.micro_location }),
        onConfirm: () => deleteEntityForWizard(ctx, 'locations', loc),
        successContent: t(ctx.locale, 'atlas.wizDeleted', { macro: loc.macro_location, micro: loc.micro_location })
    });
}

async function showFieldSelection(interaction: any | null, location: any, ctx: CommandContext) {
    await showWizardFieldSelection(ctx, interaction, {
        content: t(ctx.locale, 'atlas.wizEditTitle', { macro: location.macro_location, micro: location.micro_location }),
        placeholder: t(ctx.locale, 'atlas.wizEditPlaceholder', { micro: location.micro_location }),
        customIdPrefix: 'atlas',
        fields: [
            { label: t(ctx.locale, 'atlas.wizFieldDesc'), value: 'description', description: t(ctx.locale, 'atlas.wizFieldDescDesc'), emoji: '📜' },
            { label: t(ctx.locale, 'atlas.wizFieldFaction'), value: 'faction', description: t(ctx.locale, 'atlas.wizFieldFactionDesc'), emoji: '⚔️' },
            { label: t(ctx.locale, 'atlas.wizFieldRename'), value: 'rename', description: t(ctx.locale, 'atlas.wizFieldRenameDesc'), emoji: '🏷️' }
        ],
        onField: async (i, field) => {
            if (field === 'faction') await showFactionSelection(i, location, ctx);
            else await showTextModal(i, location, field, ctx);
        }
    });
}

async function showFactionSelection(interaction: any, location: any, ctx: CommandContext) {
    const factions = factionRepository.listFactions(ctx.activeCampaign!.id);

    if (factions.length === 0) {
        await interaction.update({
            content: t(ctx.locale, 'atlas.wizNoFactions'),
            components: []
        });
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('atlas_update_select_faction')
        .setPlaceholder(t(ctx.locale, 'atlas.wizFactionPlaceholder'))
        .addOptions(
            factions.slice(0, 25).map(f => new StringSelectMenuOptionBuilder()
                .setLabel(f.name)
                .setValue(f.id.toString())
                .setDescription(f.type)
                .setEmoji('🛡️')
            )
        );

    // Add option to remove control
    select.addOptions(
        new StringSelectMenuOptionBuilder()
            .setLabel(t(ctx.locale, 'atlas.wizRemoveControl'))
            .setValue("REMOVE_CONTROL")
            .setDescription(t(ctx.locale, 'atlas.wizRemoveControlDesc'))
            .setEmoji('🏳️')
    );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: t(ctx.locale, 'atlas.wizFactionTitle', { micro: location.micro_location }),
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'atlas_update_select_faction'
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const value = i.values[0];

        const updateAgainRow = buildUpdateAgainRow('btn_atlas_update_again_faction', ctx.locale);

        if (value === 'REMOVE_CONTROL') {
            // ... logic ...
            await i.update({
                content: t(ctx.locale, 'atlas.wizFactionRemoved', { micro: location.micro_location }),
                components: [updateAgainRow]
            });
        } else {
            const factionId = parseInt(value);
            const faction = factions.find(f => f.id === factionId);

            if (faction) {
                // ... logic ...
                await i.update({
                    content: t(ctx.locale, 'atlas.wizControlledBy', { micro: location.micro_location, faction: faction.name }),
                    components: [updateAgainRow]
                });
            }
        }

        attachUpdateAgain(i.message, 'btn_atlas_update_again_faction', interaction.user.id, async (btn) => {
            const freshLoc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, location.macro_location, location.micro_location);
            if (freshLoc) await showFieldSelection(btn, freshLoc, ctx);
            else await btn.reply({ content: t(ctx.locale, 'atlas.wizReloadError'), ephemeral: true });
        });
    });
}

async function showTextModal(interaction: any, location: any, field: string, ctx: CommandContext) {
    const label = field === 'rename' ? t(ctx.locale, 'atlas.wizRenameLabel') : t(ctx.locale, 'atlas.wizDescLabel');

    const inputs = field === 'description'
        ? [{ id: 'input_desc', label: t(ctx.locale, 'atlas.wizNewDescLabel'), style: TextInputStyle.Paragraph, value: location.description || '' }]
        : [
            { id: 'input_macro', label: t(ctx.locale, 'atlas.wizMacroLabel'), value: location.macro_location },
            { id: 'input_micro', label: t(ctx.locale, 'atlas.wizMicroLabel'), value: location.micro_location }
        ];

    const result = await promptWizardModal(interaction, {
        title: t(ctx.locale, 'atlas.wizTextModalTitle', { label, micro: location.micro_location }),
        inputs
    });
    if (!result) return;

    const submission = result.submission;

    if (field === 'description') {
        const newDesc = result.values.input_desc;
        locationRepository.updateAtlasEntry(ctx.activeCampaign!.id, location.macro_location, location.micro_location, newDesc, undefined, true);

        await submission.reply({
            content: t(ctx.locale, 'atlas.wizDescUpdated', { micro: location.micro_location }),
            ephemeral: false,
            components: [buildUpdateAgainRow('btn_atlas_update_again_desc', ctx.locale)]
        });

        const msg = await submission.fetchReply();
        attachUpdateAgain(msg, 'btn_atlas_update_again_desc', interaction.user.id, async (btn) => {
            const freshLoc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, location.macro_location, location.micro_location);
            if (freshLoc) await showFieldSelection(btn, freshLoc, ctx);
            else await btn.reply({ content: t(ctx.locale, 'atlas.wizReloadError'), ephemeral: true });
        });

    } else if (field === 'rename') {
        const newMacro = result.values.input_macro;
        const newMicro = result.values.input_micro;

        const success = locationRepository.renameAtlasEntry(ctx.activeCampaign!.id, location.macro_location, location.micro_location, newMacro, newMicro, true);

        if (success) {
            await submission.reply({
                content: t(ctx.locale, 'atlas.wizRenamed', { macro: newMacro, micro: newMicro }),
                ephemeral: false,
                components: [buildUpdateAgainRow('btn_atlas_update_again_rename', ctx.locale)]
            });

            const msg = await submission.fetchReply();
            attachUpdateAgain(msg, 'btn_atlas_update_again_rename', interaction.user.id, async (btn) => {
                // Re-fetch location with new name
                const newLoc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, newMacro, newMicro);
                if (newLoc) await showFieldSelection(btn, newLoc, ctx);
                else await btn.reply({ content: t(ctx.locale, 'atlas.wizNewFetchError'), ephemeral: true });
            });

        } else {
            await submission.reply({ content: t(ctx.locale, 'atlas.wizRenameError'), ephemeral: true });
        }
    }

    try { await interaction.message.edit({ components: [] }); } catch (e) { }
}
