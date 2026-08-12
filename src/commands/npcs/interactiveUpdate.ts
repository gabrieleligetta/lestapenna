import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ComponentType,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { CommandContext } from '../types';
import {
    listNpcs,
    updateNpcFields,
    updateNpcEntry,
    getNpcEntry,
    renameNpcEntry,
    migrateKnowledgeFragments,
    markNpcDirty,
    factionRepository,
} from '../../db';
import { handleEventAdd, handleEventUpdate, handleEventDelete } from '../utils/eventInteractive';
import { EntityEventsConfig } from '../utils/eventsViewer';
import {
    showWizardEntitySelection,
    showWizardDeleteConfirmation,
    showWizardFieldSelection,
    showWizardEnumSelection,
    promptWizardModal,
    buildUpdateAgainRow,
    attachUpdateAgain,
    WizardEntitySelectionConfig
} from '../utils/interactiveWizard';
import { t, eventTypeLabel, getCampaignLocale } from '../../i18n';
import { deleteEntityForWizard } from '../utils/entityDelete';

type NpcWizardMode = 'UPDATE' | 'DELETE' | 'EVENTS_ADD' | 'EVENTS_UPDATE' | 'EVENTS_DELETE';

const npcStatusEmoji = (status: string) => status === 'DEAD' ? '💀' : status === 'MISSING' ? '❓' : '👤';

/** Resolution by exact name or short-id (scanning the list). */
function resolveNpcByQuery(campaignId: number, query: string): any | undefined {
    const npc = getNpcEntry(campaignId, query);
    if (npc) return npc;

    const cleanQuery = query.replace('#', '').toLowerCase();
    return listNpcs(campaignId).find(n => n.short_id && n.short_id.toLowerCase() === cleanQuery);
}

const buildSelectionConfig = (ctx: CommandContext): WizardEntitySelectionConfig<any, NpcWizardMode> => ({
    wizardTitle: 'NPC',
    customIdPrefix: 'npc',
    list: (searchQuery) => {
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            return listNpcs(ctx.activeCampaign!.id, 500, 0).filter((n: any) =>
                n.name.toLowerCase().includes(query) ||
                (n.role && n.role.toLowerCase().includes(query))
            ).slice(0, 24);
        }
        return listNpcs(ctx.activeCampaign!.id, 24, 0);
    },
    option: (n) => ({
        label: n.name,
        description: n.role ? n.role : t(ctx.locale, 'npc.noRole'),
        value: n.name,
        emoji: npcStatusEmoji(n.status)
    }),
    resolveByValue: (name) => getNpcEntry(ctx.activeCampaign!.id, name),
    emptyMessage: (searchQuery) => searchQuery ? t(ctx.locale, 'npc.wizNoResults', { query: searchQuery }) : t(ctx.locale, 'npc.wizNoneRegistered'),
    actionLabel: (mode) =>
        mode === 'DELETE' ? t(ctx.locale, 'wizard.actionDelete') :
            mode === 'EVENTS_ADD' ? t(ctx.locale, 'wizard.actionEventAdd') :
                mode === 'EVENTS_UPDATE' ? t(ctx.locale, 'wizard.actionEventUpdate') :
                    mode === 'EVENTS_DELETE' ? t(ctx.locale, 'wizard.actionEventDelete') :
                        t(ctx.locale, 'wizard.actionUpdate'),
    searchLabel: t(ctx.locale, 'npc.wizSearchLabel'),
    onSelect: async (interaction, npc, mode) => {
        if (mode === 'DELETE') {
            await showDeleteConfirmation(interaction, npc, ctx);
        } else if (mode === 'EVENTS_ADD' || mode === 'EVENTS_UPDATE' || mode === 'EVENTS_DELETE') {
            await interaction.deferUpdate(); // Acknowledge
            await interaction.message.delete().catch(() => { });

            const config: EntityEventsConfig = {
                tableName: 'npc_history',
                entityKeyColumn: 'npc_name',
                entityKeyValue: npc.name,
                campaignId: ctx.activeCampaign!.id,
                entityDisplayName: npc.name,
                entityEmoji: '👤'
            };

            if (mode === 'EVENTS_ADD') await handleEventAdd(ctx, config);
            else if (mode === 'EVENTS_UPDATE') await handleEventUpdate(ctx, config);
            else await handleEventDelete(ctx, config);
        } else {
            await showFieldSelection(interaction, npc, ctx);
        }
    }
});

export async function startInteractiveNpcUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const npc = resolveNpcByQuery(ctx.activeCampaign!.id, ctx.args.join(' '));
        if (npc) {
            await showFieldSelection(null, npc, ctx);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'UPDATE');
}

export async function startInteractiveNpcDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const npc = resolveNpcByQuery(ctx.activeCampaign!.id, ctx.args.join(' '));
        if (npc) {
            await showDeleteConfirmation(null, npc, ctx);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'DELETE');
}

export async function startInteractiveEventsAdd(ctx: CommandContext) {
    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'EVENTS_ADD');
}

export async function startInteractiveEventsUpdate(ctx: CommandContext) {
    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'EVENTS_UPDATE');
}

export async function startInteractiveEventsDelete(ctx: CommandContext) {
    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'EVENTS_DELETE');
}

export async function startInteractiveNpcAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_npc_add')
                .setLabel(t(ctx.locale, 'npc.wizCreateBtn'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('👤')
        );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'npc.wizCreatePrompt'),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_npc_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const result = await promptWizardModal(interaction, {
            title: t(ctx.locale, 'npc.wizModalTitle'),
            inputs: [
                { id: 'npc_name', label: t(ctx.locale, 'npc.wizModalName') },
                { id: 'npc_role', label: t(ctx.locale, 'npc.wizModalRole'), required: false },
                { id: 'npc_description', label: t(ctx.locale, 'npc.wizModalDesc'), style: TextInputStyle.Paragraph, required: false }
            ]
        });
        if (!result) return;

        const name = result.values.npc_name;
        const role = result.values.npc_role || "";
        const description = result.values.npc_description || "";
        const submission = result.submission;

        const existing = getNpcEntry(ctx.activeCampaign!.id, name);
        if (existing) {
            await submission.reply({
                content: t(ctx.locale, 'npc.alreadyExists', { name }),
                ephemeral: true
            });
            return;
        }

        // Create NPC
        updateNpcEntry(ctx.activeCampaign!.id, name, description, role, 'ALIVE', undefined, true);

        // Reply with success and "Edit" button
        const successRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('edit_created_npc')
                    .setLabel(t(ctx.locale, 'npc.wizEditDetailsBtn'))
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('✏️')
            );

        await submission.reply({
            content: t(ctx.locale, 'npc.wizCreated', { name, role: role || t(ctx.locale, 'npc.noRoleValue'), description: description || t(ctx.locale, 'npc.noDescription') }),
            components: [successRow]
        });

        // Cleanup the trigger button
        try { await reply.delete(); } catch { }

        const message = await submission.fetchReply();
        attachUpdateAgain(message, 'edit_created_npc', ctx.message.author.id, async (i) => {
            const npc = getNpcEntry(ctx.activeCampaign!.id, name);
            if (npc) {
                await showFieldSelection(i, npc, ctx);
            } else {
                await i.reply({ content: t(ctx.locale, 'npc.notFoundShort'), ephemeral: true });
            }
        });
    });

    collector.on('end', () => {
        if (reply.editable) {
            reply.edit({ components: [] }).catch(() => { });
        }
    });
}

async function showDeleteConfirmation(interaction: any | null, npc: any, ctx: CommandContext) {
    await showWizardDeleteConfirmation(ctx, interaction, {
        content: t(ctx.locale, 'npc.wizDeleteConfirm', { name: npc.name }),
        onConfirm: () => deleteEntityForWizard(ctx, 'npcs', npc),
        successContent: t(ctx.locale, 'npc.wizDeleted', { name: npc.name }),
        failureContent: t(ctx.locale, 'npc.wizDeleteError', { name: npc.name })
    });
}

/** Reopens the field selection after an "Edit Again", reloading the NPC. */
function reopenFieldSelection(ctx: CommandContext, npcName: string) {
    return async (btn: any) => {
        const freshNpc = getNpcEntry(ctx.activeCampaign!.id, npcName);
        if (freshNpc) await showFieldSelection(btn, freshNpc, ctx);
        else await btn.reply({ content: t(ctx.locale, 'npc.wizReloadError'), ephemeral: true });
    };
}

async function showFieldSelection(interaction: any | null, npc: any, ctx: CommandContext) {
    await showWizardFieldSelection(ctx, interaction, {
        content: t(ctx.locale, 'npc.wizEditTitle', { name: npc.name }),
        placeholder: t(ctx.locale, 'npc.wizEditPlaceholder', { name: npc.name }),
        customIdPrefix: 'npc',
        fields: [
            { label: t(ctx.locale, 'npc.wizFieldName'), value: 'name', description: t(ctx.locale, 'npc.wizFieldNameDesc'), emoji: '🏷️' },
            { label: t(ctx.locale, 'npc.wizFieldRole'), value: 'role', description: t(ctx.locale, 'npc.wizFieldRoleDesc'), emoji: '🎭' },
            { label: t(ctx.locale, 'npc.wizFieldStatus'), value: 'status', description: t(ctx.locale, 'npc.wizFieldStatusDesc'), emoji: '💓' },
            { label: t(ctx.locale, 'npc.wizFieldDesc'), value: 'description', description: t(ctx.locale, 'npc.wizFieldDescDesc'), emoji: '📜' },
            // Alignment options removed - now event-driven
            { label: t(ctx.locale, 'npc.wizFieldFaction'), value: 'faction', description: t(ctx.locale, 'npc.wizFieldFactionDesc'), emoji: '⚔️' },
            { label: t(ctx.locale, 'npc.wizFieldAliases'), value: 'aliases', description: t(ctx.locale, 'npc.wizFieldAliasesDesc'), emoji: '📇' },
            { label: t(ctx.locale, 'npc.wizFieldLastSeen'), value: 'last_seen_location', description: t(ctx.locale, 'npc.wizFieldLastSeenDesc'), emoji: '📍' }
        ],
        onField: async (i, field) => {
            if (field === 'status') {
                await showStatusSelection(i, npc, ctx);
            } else if (field === 'faction') {
                await showFactionSelection(i, npc, ctx);
            } else {
                // Text fields: Name, Role, Description, Aliases, Last Seen
                await showTextModal(i, npc, field, ctx);
            }
        }
    });
}

async function showStatusSelection(interaction: any, npc: any, ctx: CommandContext) {
    await showWizardEnumSelection(ctx, interaction, {
        content: t(ctx.locale, 'npc.wizStatusTitle', { name: npc.name }),
        customId: 'npc_update_select_status',
        placeholder: t(ctx.locale, 'npc.wizStatusPlaceholder'),
        options: [
            { label: t(ctx.locale, 'enum.ALIVE'), value: 'ALIVE', emoji: '👤', isDefault: npc.status === 'ALIVE' },
            { label: t(ctx.locale, 'enum.DEAD'), value: 'DEAD', emoji: '💀', isDefault: npc.status === 'DEAD' },
            { label: t(ctx.locale, 'enum.MISSING'), value: 'MISSING', emoji: '❓', isDefault: npc.status === 'MISSING' },
            { label: t(ctx.locale, 'enum.UNKNOWN'), value: 'UNKNOWN', emoji: '🌫️', isDefault: npc.status === 'UNKNOWN' }
        ],
        onPick: async (i, newStatus) => {
            updateNpcFields(ctx.activeCampaign!.id, npc.name, { status: newStatus });
            markNpcDirty(ctx.activeCampaign!.id, npc.name);

            await i.update({
                content: t(ctx.locale, 'npc.wizStatusUpdated', { name: npc.name, status: eventTypeLabel(ctx.locale, newStatus) }),
                components: [buildUpdateAgainRow('btn_npc_update_again', ctx.locale)]
            });

            attachUpdateAgain(i.message, 'btn_npc_update_again', interaction.user.id, reopenFieldSelection(ctx, npc.name));
        }
    });
}

async function showTextModal(interaction: any, npc: any, field: string, ctx: CommandContext) {
    const label = field.charAt(0).toUpperCase() + field.slice(1);

    let currentValue = '';
    if (field === 'name') currentValue = npc.name;
    else if (field === 'role') currentValue = npc.role || '';
    else if (field === 'description') currentValue = npc.description || '';
    else if (field === 'aliases') currentValue = npc.aliases || '';
    else if (field === 'last_seen_location') currentValue = npc.last_seen_location || '';

    const result = await promptWizardModal(interaction, {
        title: t(ctx.locale, 'npc.wizTextModalTitle', { field: label, name: npc.name }),
        inputs: [{
            id: 'input_value',
            label: t(ctx.locale, 'npc.wizTextModalLabel', { field }),
            style: field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short,
            value: currentValue
        }]
    });
    if (!result) return;

    const submission = result.submission;
    const newValue = result.values.input_value;
    let success = false;

    if (field === 'name') {
        success = renameNpcEntry(ctx.activeCampaign!.id, npc.name, newValue);
        if (success) {
            migrateKnowledgeFragments(ctx.activeCampaign!.id, npc.name, newValue);
            markNpcDirty(ctx.activeCampaign!.id, newValue);
        }
    } else {
        const updates: any = {};
        updates[field] = newValue;
        success = updateNpcFields(ctx.activeCampaign!.id, npc.name, updates);
        if (success) {
            markNpcDirty(ctx.activeCampaign!.id, npc.name);
        }
    }

    if (!success) {
        await submission.reply({
            content: t(ctx.locale, 'npc.wizUpdateError', { name: npc.name }),
            ephemeral: true
        });
        return;
    }

    await submission.reply({
        content: t(ctx.locale, 'npc.wizUpdated', { name: npc.name, field, value: newValue }),
        ephemeral: false,
        components: [buildUpdateAgainRow('btn_npc_update_again_text', ctx.locale)]
    });

    const msg = await submission.fetchReply();
    // Handle rename case carefully
    const nameToFetch = (field === 'name') ? newValue : npc.name;
    attachUpdateAgain(msg, 'btn_npc_update_again_text', interaction.user.id, reopenFieldSelection(ctx, nameToFetch));

    // Cleanup original selection message if possible
    try {
        await interaction.message.edit({ components: [] });
    } catch (e) { }
}

async function showFactionSelection(interaction: any, npc: any, ctx: CommandContext) {
    await showFactionSelectionRecursively(interaction, npc, ctx, null);
}

async function showFactionSelectionRecursively(interaction: any, npc: any, ctx: CommandContext, searchQuery: string | null) {
    let factions: any[] = [];
    const allFactions = factionRepository.listFactions(ctx.activeCampaign!.id, true);

    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        factions = allFactions.filter(f =>
            f.name.toLowerCase().includes(query) ||
            f.type.toLowerCase().includes(query)
        ).slice(0, 24);
    } else {
        factions = allFactions.slice(0, 24);
    }

    if (allFactions.length === 0 && !searchQuery) {
        await interaction.update({
            content: t(ctx.locale, 'npc.wizNoFactions'),
            components: []
        });
        return;
    }

    const factionOptions = factions.map(f =>
        new StringSelectMenuOptionBuilder()
            .setLabel(f.name)
            .setValue(f.id.toString())
            .setDescription(f.description ? f.description.substring(0, 50) : t(ctx.locale, 'npc.noDescription'))
            .setEmoji(f.is_party ? '🛡️' : '⚔️')
    );

    // Search Option
    factionOptions.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel(t(ctx.locale, 'wizard.searchOption'))
            .setDescription(t(ctx.locale, 'npc.wizFilterFactions'))
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    // New Faction Option
    if (!searchQuery) {
        factionOptions.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(t(ctx.locale, 'npc.wizNewFactionOption'))
                .setValue("NEW_FACTION")
                .setEmoji("✨")
                .setDescription(t(ctx.locale, 'npc.wizNewFactionOptionDesc'))
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_faction')
        .setPlaceholder(searchQuery ? t(ctx.locale, 'wizard.resultsFor', { q: searchQuery }) : t(ctx.locale, 'npc.wizFactionPlaceholder'))
        .addOptions(factionOptions);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const content = searchQuery
        ? t(ctx.locale, 'npc.wizFactionSearchHeader', { name: npc.name, query: searchQuery })
        : t(ctx.locale, 'npc.wizFactionHeader', { name: npc.name });

    // Only attempt to update if we have a valid interaction
    if (interaction.isMessageComponent?.() || interaction.isModalSubmit?.()) {
        await interaction.update({
            content: content,
            components: [row]
        });
    }

    const message = interaction.message;
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'npc_update_select_faction'
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const selectedValue = i.values[0];

        if (selectedValue === 'SEARCH_ACTION') {
            const result = await promptWizardModal(i, {
                title: t(ctx.locale, 'npc.wizSearchFactionTitle'),
                inputs: [{ id: 'search_query', label: t(ctx.locale, 'npc.wizSearchFactionLabel') }],
                time: 60000
            });
            if (result) {
                await showFactionSelectionRecursively(result.submission, npc, ctx, result.values.search_query);
            }
        } else if (selectedValue === 'NEW_FACTION') {
            await showFactionModal(i, npc, ctx);
        } else {
            const factionId = parseInt(selectedValue);
            const faction = allFactions.find((f: any) => f.id === factionId);
            if (faction) {
                await showFactionRoleSelection(i, npc, faction, ctx);
            }
        }
    });
}

async function showFactionRoleSelection(interaction: any, npc: any, faction: any, ctx: CommandContext) {
    const roles = ['MEMBER', 'LEADER', 'ALLY', 'ENEMY', 'CONTROLLED'];

    // Check if NPC is already in this faction to set default
    const affiliations = factionRepository.getEntityFactions('npc', npc.id);
    const existing = affiliations.find(a => a.faction_id === faction.id);
    const currentRole = existing ? existing.role : null;

    await showWizardEnumSelection(ctx, interaction, {
        content: t(ctx.locale, 'npc.wizRolePrompt', { npc: npc.name, faction: faction.name }),
        customId: 'npc_update_select_faction_role',
        placeholder: t(ctx.locale, 'npc.wizRolePlaceholder', { faction: faction.name }),
        options: roles.map(r => ({
            label: eventTypeLabel(ctx.locale, r),
            value: r,
            emoji: '🎭',
            isDefault: r === currentRole
        })),
        onPick: async (i, role) => {
            factionRepository.addAffiliation(faction.id, 'npc', npc.id, {
                role: role as any,
                notes: t(getCampaignLocale(ctx.activeCampaign!.id), 'npc.manualAffiliationNote')
            });
            markNpcDirty(ctx.activeCampaign!.id, npc.name);

            await i.update({
                content: t(ctx.locale, 'npc.factionAdded', { npc: npc.name, faction: faction.name, role: eventTypeLabel(ctx.locale, role) }),
                components: [buildUpdateAgainRow('btn_npc_update_again_role', ctx.locale)]
            });

            attachUpdateAgain(i.message, 'btn_npc_update_again_role', interaction.user.id, reopenFieldSelection(ctx, npc.name));
        }
    });
}

// Kept for "Create New Faction" fallback
async function showFactionModal(interaction: any, npc: any, ctx: CommandContext) {
    const result = await promptWizardModal(interaction, {
        title: t(ctx.locale, 'npc.wizNewFactionTitle'),
        inputs: [
            { id: 'faction_name', label: t(ctx.locale, 'npc.wizNewFactionName') },
            { id: 'faction_role', label: t(ctx.locale, 'npc.wizNewFactionRole'), value: 'MEMBER', required: false }
        ]
    });
    if (!result) return;

    const submission = result.submission;
    const factionName = result.values.faction_name;
    let role = result.values.faction_role.toUpperCase();

    const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED'];
    if (!validRoles.includes(role)) role = 'MEMBER';

    // This modal is now specifically for creating a NEW faction
    const faction = factionRepository.createFaction(ctx.activeCampaign!.id, factionName, {
        isManual: true,
        description: t(getCampaignLocale(ctx.activeCampaign!.id), 'npc.manualCreationNote')
    });

    if (faction) {
        factionRepository.addAffiliation(faction.id, 'npc', npc.id, {
            role: role as any,
            notes: t(getCampaignLocale(ctx.activeCampaign!.id), 'npc.manualAffiliationNote')
        });
        markNpcDirty(ctx.activeCampaign!.id, npc.name);

        await submission.reply({
            content: t(ctx.locale, 'npc.factionAdded', { npc: npc.name, faction: faction.name, role: eventTypeLabel(ctx.locale, role) }),
            ephemeral: false,
            components: [buildUpdateAgainRow('btn_npc_update_again_new_fact', ctx.locale)]
        });

        const msg = await submission.fetchReply();
        attachUpdateAgain(msg, 'btn_npc_update_again_new_fact', interaction.user.id, reopenFieldSelection(ctx, npc.name));

        try {
            await interaction.message.edit({ components: [] });
        } catch (e) { }
    } else {
        await submission.reply({
            content: t(ctx.locale, 'npc.wizFactionCreateError'),
            ephemeral: true
        });
    }
}
