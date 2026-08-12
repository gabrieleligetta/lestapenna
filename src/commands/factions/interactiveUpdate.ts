import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} from 'discord.js';
import { CommandContext } from '../types';
import {
    factionRepository,
    npcRepository,
    locationRepository
} from '../../db';
import { FactionType } from '../../db/types';
import { parseShortId } from '../../utils/shortId';
import { t, eventTypeLabel } from '../../i18n';
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
import { deleteEntityForWizard } from '../utils/entityDelete';

const ICONS: Record<string, string> = {
    'PARTY': '🎭',
    'GUILD': '🛡️',
    'KINGDOM': '👑',
    'CULT': '🕯️',
    'ORGANIZATION': '🏛️',
    'GENERIC': '⚔️'
};

const buildSelectionConfig = (ctx: CommandContext): WizardEntitySelectionConfig<any, 'UPDATE' | 'DELETE'> => ({
    wizardTitle: t(ctx.locale, 'entity.faction'),
    customIdPrefix: 'faction',
    list: (searchQuery) => {
        const all = factionRepository.listFactions(ctx.activeCampaign!.id);
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            return all.filter(f =>
                f.name.toLowerCase().includes(query) ||
                f.type.toLowerCase().includes(query)
            ).slice(0, 24);
        }
        return all.slice(0, 24);
    },
    option: (f) => ({
        label: f.name,
        description: f.description ? f.description.substring(0, 50) : t(ctx.locale, 'faction.noDesc'),
        value: f.name,
        emoji: ICONS[f.type] || '⚔️'
    }),
    resolveByValue: (name) => factionRepository.getFaction(ctx.activeCampaign!.id, name),
    emptyMessage: (searchQuery) => searchQuery ? t(ctx.locale, 'faction.notFound', { name: searchQuery }) : t(ctx.locale, 'faction.listEmpty'),
    actionLabel: (mode) => mode === 'DELETE' ? t(ctx.locale, 'wizard.actionDelete') : t(ctx.locale, 'wizard.actionUpdate'),
    searchLabel: t(ctx.locale, 'faction.searchLabel'),
    onSelect: async (interaction, faction, mode) => {
        if (mode === 'DELETE') {
            await showFactionDeleteConfirmation(interaction, faction, ctx);
        } else {
            await showFieldSelection(interaction, faction, ctx);
        }
    }
});

export async function startInteractiveFactionUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const faction = factionRepository.getFaction(ctx.activeCampaign!.id, ctx.args.join(' '));
        if (faction) {
            await showFieldSelection(null, faction, ctx);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'UPDATE');
}

export async function startInteractiveFactionDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const faction = factionRepository.getFaction(ctx.activeCampaign!.id, ctx.args.join(' '));
        if (faction) {
            await showFactionDeleteConfirmation(null, faction, ctx);
            return;
        }
    }

    await showWizardEntitySelection(ctx, buildSelectionConfig(ctx), 'DELETE');
}

export async function startInteractiveFactionAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_faction_add')
                .setLabel(t(ctx.locale, 'faction.createButton'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('⚔️')
        );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'faction.createPrompt'),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_faction_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        // Step 1: Select Type
        const typeSelect = new StringSelectMenuBuilder()
            .setCustomId('faction_add_select_type')
            .setPlaceholder(t(ctx.locale, 'faction.selectTypePlaceholder'))
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'enum.GUILD')).setValue('GUILD').setEmoji('📜'),
                new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'enum.KINGDOM')).setValue('KINGDOM').setEmoji('👑'),
                new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'enum.CULT')).setValue('CULT').setEmoji('🐙'),
                new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'enum.ORGANIZATION')).setValue('ORGANIZATION').setEmoji('🏢'),
                new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'enum.GENERIC')).setValue('GENERIC').setEmoji('🏳️')
            );

        await interaction.update({
            content: t(ctx.locale, 'faction.selectTypePrompt'),
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(typeSelect)]
        });

        // Collector for Type Selection
        const typeCollector = interaction.message.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 60000,
            filter: (i: any) => i.customId === 'faction_add_select_type' && i.user.id === ctx.message.author.id
        });

        typeCollector.on('collect', async (i: any) => {
            const selectedType = i.values[0] as FactionType;

            // Step 2: Modal
            const result = await promptWizardModal(i, {
                title: t(ctx.locale, 'faction.detailsModalTitle'),
                inputs: [
                    { id: 'faction_name', label: t(ctx.locale, 'faction.nameLabel') },
                    { id: 'faction_description', label: t(ctx.locale, 'faction.descLabelOptional'), style: TextInputStyle.Paragraph, required: false }
                ]
            });
            if (!result) return;

            const name = result.values.faction_name;
            const desc = result.values.faction_description || t(ctx.locale, 'faction.noDesc');
            const submission = result.submission;

            // Check existence
            const existing = factionRepository.getFaction(ctx.activeCampaign!.id, name);
            if (existing) {
                await submission.reply({
                    content: t(ctx.locale, 'faction.alreadyExists', { name: name }),
                    ephemeral: true
                });
                return;
            }

            // Create
            factionRepository.createFaction(ctx.activeCampaign!.id, name, {
                type: selectedType,
                description: desc,
                isManual: true
            });

            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_faction')
                        .setLabel(t(ctx.locale, 'faction.editDetails'))
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: t(ctx.locale, 'faction.created', { icon: '⚔️', name: name, type: selectedType, desc: desc }),
                components: [successRow]
            });

            try { await reply.delete(); } catch { }

            // Edit Listener
            const message = await submission.fetchReply();
            attachUpdateAgain(message, 'edit_created_faction', ctx.message.author.id, async (btn) => {
                const fact = factionRepository.getFaction(ctx.activeCampaign!.id, name);
                if (fact) {
                    await showFieldSelection(btn, fact, ctx);
                } else {
                    await btn.reply({ content: t(ctx.locale, 'faction.notFoundShort'), ephemeral: true });
                }
            });
        });
    });
}

async function showFactionDeleteConfirmation(interaction: any | null, faction: any, ctx: CommandContext) {
    if (faction.is_party) {
        const warning = t(ctx.locale, 'faction.cantDeleteParty');
        if (!interaction) await ctx.message.reply(warning);
        else await interaction.update({ content: warning, components: [] });
        return;
    }

    await showWizardDeleteConfirmation(ctx, interaction, {
        content: t(ctx.locale, 'faction.deleteConfirm', { name: faction.name }),
        onConfirm: () => deleteEntityForWizard(ctx, 'factions', faction),
        successContent: t(ctx.locale, 'faction.deleted', { name: faction.name }),
        failureContent: t(ctx.locale, 'faction.deleteError')
    });
}

/** Reopens the field selection after an "Edit Again", reloading the faction. */
function reopenFieldSelection(ctx: CommandContext, factionName: string) {
    return async (btn: any) => {
        const freshFaction = factionRepository.getFaction(ctx.activeCampaign!.id, factionName);
        if (freshFaction) await showFieldSelection(btn, freshFaction, ctx);
        else await btn.reply({ content: t(ctx.locale, 'faction.reloadError'), ephemeral: true });
    };
}

async function showFieldSelection(interaction: any | null, faction: any, ctx: CommandContext) {
    await showWizardFieldSelection(ctx, interaction, {
        content: t(ctx.locale, 'faction.editTitle', { name: faction.name }),
        placeholder: t(ctx.locale, 'faction.editPlaceholder', { name: faction.name }),
        customIdPrefix: 'faction',
        fields: [
            { label: t(ctx.locale, 'faction.fieldName'), value: 'name', description: t(ctx.locale, 'faction.fieldNameDesc'), emoji: '🏷️' },
            { label: t(ctx.locale, 'faction.fieldType'), value: 'type', description: t(ctx.locale, 'faction.fieldTypeDesc'), emoji: '🏰' },
            { label: t(ctx.locale, 'faction.fieldStatus'), value: 'status', description: t(ctx.locale, 'faction.fieldStatusDesc'), emoji: '💓' },
            { label: t(ctx.locale, 'faction.fieldDesc'), value: 'description', description: t(ctx.locale, 'faction.fieldDescDesc'), emoji: '📜' },
            { label: t(ctx.locale, 'faction.fieldLeader'), value: 'leader', description: t(ctx.locale, 'faction.fieldLeaderDesc'), emoji: '👑' },
            // Alignment options removed - now event-driven
            { label: t(ctx.locale, 'faction.fieldHq'), value: 'hq', description: t(ctx.locale, 'faction.fieldHqDesc'), emoji: '📍' }
        ],
        onField: async (i, field) => {
            if (field === 'type') await showTypeSelection(i, faction, ctx);
            else if (field === 'status') await showStatusSelection(i, faction, ctx);
            else await showTextModal(i, faction, field, ctx);
        }
    });
}

async function showTypeSelection(interaction: any, faction: any, ctx: CommandContext) {
    const types = ['GUILD', 'KINGDOM', 'CULT', 'ORGANIZATION', 'GENERIC', 'PARTY'];

    await showWizardEnumSelection(ctx, interaction, {
        content: t(ctx.locale, 'faction.updateTypeTitle', { name: faction.name }),
        customId: 'faction_update_select_type',
        placeholder: t(ctx.locale, 'faction.selectTypePlaceholder'),
        options: types.map(t => ({
            label: t,
            value: t,
            emoji: ICONS[t] || '⚔️',
            isDefault: t === faction.type
        })),
        onPick: async (i, newVal) => {
            factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, { type: newVal as any });

            await i.update({
                content: t(ctx.locale, 'faction.typeUpdated', { name: faction.name, type: newVal }),
                components: [buildUpdateAgainRow('btn_faction_update_again_type', ctx.locale)]
            });

            attachUpdateAgain(i.message, 'btn_faction_update_again_type', interaction.user.id, reopenFieldSelection(ctx, faction.name));
        }
    });
}

async function showStatusSelection(interaction: any, faction: any, ctx: CommandContext) {
    const statuses = ['ACTIVE', 'DISBANDED', 'DESTROYED'];

    await showWizardEnumSelection(ctx, interaction, {
        content: t(ctx.locale, 'faction.updateStatusTitle', { name: faction.name }),
        customId: 'faction_update_select_status',
        placeholder: t(ctx.locale, 'faction.selectStatusPlaceholder'),
        options: statuses.map(s => ({
            label: s,
            value: s,
            isDefault: s === faction.status
        })),
        onPick: async (i, newVal) => {
            factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, { status: newVal as any });

            await i.update({
                content: t(ctx.locale, 'faction.statusUpdated', { name: faction.name, status: newVal }),
                components: [buildUpdateAgainRow('btn_faction_update_again_status', ctx.locale)]
            });

            attachUpdateAgain(i.message, 'btn_faction_update_again_status', interaction.user.id, reopenFieldSelection(ctx, faction.name));
        }
    });
}

async function showTextModal(interaction: any, faction: any, field: string, ctx: CommandContext) {
    let currentValue = '';
    let label = t(ctx.locale, 'faction.newValueFor', { field: field });

    if (field === 'name') currentValue = faction.name;
    else if (field === 'description') currentValue = faction.description || '';
    else if (field === 'leader') {
        const leader = faction.leader_npc_id
            ? npcRepository.getNpcEntry(ctx.activeCampaign!.id, faction.leader_npc_id as any)?.name
            : '';
        currentValue = leader || '';
        label = t(ctx.locale, 'faction.leaderInputLabel');
    }
    else if (field === 'hq') {
        // Try to get current hq short id or name
        if (faction.headquarters_location_id) {
            const hq = locationRepository.getAtlasEntryById(ctx.activeCampaign!.id, faction.headquarters_location_id);
            if (hq) currentValue = `#${hq.short_id}`;
        }
        label = t(ctx.locale, 'faction.hqInputLabel');
    }

    const result = await promptWizardModal(interaction, {
        title: t(ctx.locale, 'faction.editFieldTitle', { field: field.toUpperCase(), name: faction.name }),
        inputs: [{
            id: 'input_value',
            label,
            style: field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short,
            value: currentValue,
            required: field !== 'description' && field !== 'leader' && field !== 'hq'
        }]
    });
    if (!result) return;

    const submission = result.submission;
    const newValue = result.values.input_value;
    const updates: any = {};
    let successMsg = "";

    if (field === 'name') {
        const renamed = factionRepository.renameFaction(ctx.activeCampaign!.id, faction.name, newValue);
        if (!renamed) {
            await submission.reply({ content: t(ctx.locale, 'faction.renameError'), ephemeral: true });
            return;
        }
        successMsg = t(ctx.locale, 'faction.renamed', { old: faction.name, new: newValue });
    } else if (field === 'description') {
        updates.description = newValue;
        factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, updates);
        successMsg = t(ctx.locale, 'faction.descUpdated', { name: faction.name });
    } else if (field === 'leader') {
        const rawName = newValue.trim();
        if (!rawName) {
            updates.leader_npc_id = null;
            successMsg = t(ctx.locale, 'faction.leaderRemoved');
        } else {
            const npc = npcRepository.getNpcEntry(ctx.activeCampaign!.id, rawName);
            if (!npc) {
                await submission.reply({ content: t(ctx.locale, 'faction.leaderNotFound', { name: rawName }), ephemeral: true });
                return;
            }
            updates.leader_npc_id = npc.id;
            successMsg = t(ctx.locale, 'faction.leaderSet', { faction: faction.name, npc: npc.name });
        }
        factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, updates);
    } else if (field === 'hq') {
        const rawVal = newValue.trim();
        if (!rawVal) {
            updates.headquarters_location_id = null;
            successMsg = t(ctx.locale, 'faction.hqRemoved');
        } else {
            let loc;
            const sid = parseShortId(rawVal);
            if (sid) {
                loc = locationRepository.getAtlasEntryByShortId(ctx.activeCampaign!.id, sid);
            }
            if (!loc) {
                const all = locationRepository.listAllAtlasEntries(ctx.activeCampaign!.id);
                loc = all.find(l =>
                    l.micro_location?.toLowerCase() === rawVal.toLowerCase() ||
                    l.macro_location?.toLowerCase() === rawVal.toLowerCase()
                );
            }

            if (!loc) {
                await submission.reply({ content: t(ctx.locale, 'faction.hqLocNotFound', { value: rawVal }), ephemeral: true });
                return;
            }
            updates.headquarters_location_id = loc.id;
            successMsg = t(ctx.locale, 'faction.hqSet', { faction: faction.name, loc: loc.micro_location || loc.macro_location, shortId: loc.short_id });
        }
        factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, updates);
    }

    await submission.reply({
        content: t(ctx.locale, 'faction.updated', { msg: successMsg }),
        ephemeral: false,
        components: [buildUpdateAgainRow('btn_faction_update_again_text', ctx.locale)]
    });

    const msg = await submission.fetchReply();
    // When renamed, the reload must use the new name
    const reloadName = field === 'name' ? newValue : faction.name;
    attachUpdateAgain(msg, 'btn_faction_update_again_text', interaction.user.id, reopenFieldSelection(ctx, reloadName));

    try { await interaction.message.edit({ components: [] }); } catch (e) { }
}
