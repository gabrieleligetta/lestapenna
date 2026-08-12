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
    artifactRepository,
    addArtifactEvent,
    db
} from '../../db';
import { ArtifactEntry, ArtifactStatus, ArtifactOwnerType } from '../../db/types';
import { getActiveSession } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';
import { getCampaignLocale, t } from '../../i18n';
import { deleteEntityFromCommand } from '../utils/entityDelete';

// Helper for bio regeneration - used ONLY for narrative notes
async function regenerateArtifactBio(campaignId: number, name: string) {
    const history = artifactRepository.getArtifactHistory(campaignId, name);
    const artifact = artifactRepository.getArtifactByName(campaignId, name);
    const currentDesc = artifact?.description || "";
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('ARTIFACT', { campaignId, name, currentDesc }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markArtifactDirtyForSync(campaignId: number, name: string) {
    artifactRepository.markArtifactDirty(campaignId, name);
}

export async function startInteractiveArtifactUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let artifact = artifactRepository.getArtifactByShortId(ctx.activeCampaign!.id, query);
        if (!artifact) artifact = artifactRepository.getArtifactByName(ctx.activeCampaign!.id, query);

        if (artifact) {
            await showArtifactFieldSelection(ctx.message as any, artifact, ctx, true);
            return;
        }
    }
    await showArtifactSelection(ctx, null, 'ALL', 0, null, 'UPDATE');
}

export async function startInteractiveArtifactDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let artifact = artifactRepository.getArtifactByShortId(ctx.activeCampaign!.id, query);
        if (!artifact) artifact = artifactRepository.getArtifactByName(ctx.activeCampaign!.id, query);

        if (artifact) {
            await showArtifactDeleteConfirmation(ctx.message as any, artifact, ctx, true);
            return;
        }
    }
    await showArtifactSelection(ctx, null, 'ALL', 0, null, 'DELETE');
}

export async function startInteractiveArtifactAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_artifact_add')
                .setLabel(t(ctx.locale, 'artifact.addButton'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔮')
        );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'artifact.managePrompt'),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_artifact_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const modal = new ModalBuilder()
            .setCustomId('modal_artifact_add_new')
            .setTitle(t(ctx.locale, 'artifact.newTitle'));

        const nameInput = new TextInputBuilder()
            .setCustomId('artifact_name')
            .setLabel(t(ctx.locale, 'artifact.nameLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('artifact_description')
            .setLabel(t(ctx.locale, 'artifact.descriptionOriginLabel'))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
        );

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === 'modal_artifact_add_new' && i.user.id === interaction.user.id
            });

            const name = submission.fields.getTextInputValue('artifact_name');
            const description = submission.fields.getTextInputValue('artifact_description') || "";
            const currentSession = (await getActiveSession(ctx.guildId));

            artifactRepository.upsertArtifact(ctx.activeCampaign!.id, name, 'FUNCTIONAL', currentSession, { description }, true);

            if (currentSession) {
                // The "Artifact discovered" event is legitimate narrative
                addArtifactEvent(ctx.activeCampaign!.id, name, currentSession, t(getCampaignLocale(ctx.activeCampaign!.id), 'artifact.eventDiscovered'), "DISCOVERY", true);
                // Marca dirty per sync in background
                markArtifactDirtyForSync(ctx.activeCampaign!.id, name);
            }

            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_artifact')
                        .setLabel(t(ctx.locale, 'artifact.configureDetails'))
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: t(ctx.locale, 'artifact.addedDetails', {
                    artifact: name,
                    description: description || t(ctx.locale, 'inventory.noDescriptionPlain')
                }),
                components: [successRow]
            });

            try { await reply.delete(); } catch { }

            const message = await submission.fetchReply();
            const editCollector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (i) => i.customId === 'edit_created_artifact' && i.user.id === ctx.message.author.id
            });

            editCollector.on('collect', async (i) => {
                const artifact = artifactRepository.getArtifactByName(ctx.activeCampaign!.id, name);
                if (artifact) await showArtifactFieldSelection(i, artifact, ctx);
            });

        } catch (err) { }
    });

    collector.on('end', () => {
        if (reply.editable) {
            reply.edit({ components: [] }).catch(() => { });
        }
    });
}

async function showArtifactSelection(
    ctx: CommandContext,
    searchQuery: string | null,
    statusFilter: string,
    page: number,
    interactionToUpdate: any | null,
    mode: 'UPDATE' | 'DELETE'
) {
    const ITEMS_PER_PAGE = 20;
    const offset = page * ITEMS_PER_PAGE;
    let artifacts: ArtifactEntry[] = [];

    // Simplistic fetching logic for now
    const all = artifactRepository.listAllArtifacts(ctx.activeCampaign!.id);
    let filtered = all;

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = all.filter(a => a.name.toLowerCase().includes(q) || (a.description && a.description.toLowerCase().includes(q)));
    } else if (statusFilter !== 'ALL') {
        filtered = all.filter(a => a.status === statusFilter);
    }

    const total = filtered.length;
    artifacts = filtered.slice(offset, offset + ITEMS_PER_PAGE);
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    const options = artifacts.map(a => {
        const icon = a.status === 'FUNCTIONAL' ? '✨' : a.is_cursed ? '☠️' : '🔮';
        return new StringSelectMenuOptionBuilder()
            .setLabel(a.name.substring(0, 100))
            .setDescription(t(ctx.locale, 'artifact.optionDescription', { id: a.short_id || '?????', status: artifactStatusLabel(ctx, a.status) }))
            .setValue(a.name)
            .setEmoji(icon);
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
        .setCustomId('artifact_select_entity')
        .setPlaceholder(t(ctx.locale, 'artifact.selectPlaceholder'))
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    const filterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('filter_FUNCTIONAL').setLabel(t(ctx.locale, 'artifact.filterFunctional')).setStyle(statusFilter === 'FUNCTIONAL' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('✨'),
        new ButtonBuilder().setCustomId('filter_SEALED').setLabel(t(ctx.locale, 'artifact.filterSealed')).setStyle(statusFilter === 'SEALED' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('filter_LOST').setLabel(t(ctx.locale, 'artifact.filterLost')).setStyle(statusFilter === 'LOST' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('❓'),
        new ButtonBuilder().setCustomId('filter_ALL').setLabel(t(ctx.locale, 'artifact.filterAll')).setStyle(statusFilter === 'ALL' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('🌐')
    );
    rows.push(filterRow);

    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('page_prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('page_next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const content = t(ctx.locale, 'artifact.managePage', {
        action: t(ctx.locale, mode === 'DELETE' ? 'inventory.deleteMode' : 'inventory.updateMode'),
        filter: statusFilter === 'ALL' ? t(ctx.locale, 'artifact.filterAll') : artifactStatusLabel(ctx, statusFilter as ArtifactStatus),
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
                const modal = new ModalBuilder().setCustomId('modal_art_search').setTitle(t(ctx.locale, 'artifact.searchTitle'));
                const input = new TextInputBuilder().setCustomId('search_query').setLabel(t(ctx.locale, 'inventory.searchQueryLabel')).setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
                await interaction.showModal(modal);

                try {
                    const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_art_search' && i.user.id === interaction.user.id });
                    await showArtifactSelection(ctx, submission.fields.getTextInputValue('search_query'), 'ALL', 0, submission, mode);
                } catch (e) { }
            } else {
                collector.stop();
                const artifact = artifactRepository.getArtifactByName(ctx.activeCampaign!.id, val);
                if (!artifact) return;
                if (mode === 'DELETE') await showArtifactDeleteConfirmation(interaction, artifact, ctx);
                else await showArtifactFieldSelection(interaction, artifact, ctx);
            }
        } else if (interaction.isButton()) {
            collector.stop();
            if (interaction.customId.startsWith('filter_')) {
                await showArtifactSelection(ctx, null, interaction.customId.replace('filter_', ''), 0, interaction, mode);
            } else if (interaction.customId === 'page_prev') {
                await showArtifactSelection(ctx, searchQuery, statusFilter, page - 1, interaction, mode);
            } else if (interaction.customId === 'page_next') {
                await showArtifactSelection(ctx, searchQuery, statusFilter, page + 1, interaction, mode);
            }
        }
    });
}

async function showArtifactDeleteConfirmation(interaction: any, artifact: ArtifactEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('btn_confirm_delete').setLabel(t(ctx.locale, 'inventory.confirmDeleteButton')).setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('btn_cancel_delete').setLabel(t(ctx.locale, 'common.cancel')).setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const content = t(ctx.locale, 'artifact.confirmDeleteInteractive', { artifact: artifact.name });
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
            await deleteEntityFromCommand(ctx, 'artifacts', artifact);
            await i.update({ content: t(ctx.locale, 'artifact.deletedSuccess', { artifact: artifact.name }), components: [] });
        } else {
            await i.update({ content: t(ctx.locale, 'inventory.deleteCancelled'), components: [] });
        }
    });
}

async function showArtifactFieldSelection(interaction: any, artifact: ArtifactEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('artifact_select_field')
        .setPlaceholder(t(ctx.locale, 'inventory.editPlaceholder', { item: artifact.name }))
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldName')).setValue('name').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldDescription')).setValue('description').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.effects')).setValue('effects').setEmoji('⚡'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.status')).setValue('status').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.curse')).setValue('curse').setEmoji('☠️'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.owner')).setValue('owner').setEmoji('👤'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'inventory.fieldNarrativeNote')).setValue('note').setEmoji('📝')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = t(ctx.locale, 'artifact.editPrompt', { artifact: artifact.name });
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
        if (field === 'status') await showArtifactStatusUpdate(i, artifact, ctx);
        else if (field === 'owner') await showArtifactOwnerUpdate(i, artifact, ctx);
        else if (field === 'curse') await showArtifactCurseUpdate(i, artifact, ctx);
        else await showArtifactTextModal(i, artifact, field, ctx);
    });
}

async function showArtifactStatusUpdate(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('artifact_update_status')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.statusFunctional')).setValue('FUNCTIONAL').setEmoji('✨').setDefault(artifact.status === 'FUNCTIONAL'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.statusSealed')).setValue('SEALED').setEmoji('🔒').setDefault(artifact.status === 'SEALED'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.statusDormant')).setValue('DORMANT').setEmoji('💤').setDefault(artifact.status === 'DORMANT'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.statusLost')).setValue('LOST').setEmoji('❓').setDefault(artifact.status === 'LOST'),
            new StringSelectMenuOptionBuilder().setLabel(t(ctx.locale, 'artifact.statusDestroyed')).setValue('DESTROYED').setEmoji('💥').setDefault(artifact.status === 'DESTROYED')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ content: t(ctx.locale, 'artifact.updateStatusPrompt', { artifact: artifact.name }), components: [row] });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newStatus = i.values[0] as ArtifactStatus;

        // Update the status and mark dirty for the background sync
        const success = artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { status: newStatus }, true);
        if (!success) {
            await i.update({ content: t(ctx.locale, 'artifact.statusUpdateError', { artifact: artifact.name }), components: [] });
            return;
        }
        markArtifactDirtyForSync(ctx.activeCampaign!.id, artifact.name);

        // We do NOT add automatic events for a status change - they are narrative noise

        await i.update({ content: t(ctx.locale, 'artifact.statusUpdatedInteractive', { artifact: artifact.name, status: artifactStatusLabel(ctx, newStatus) }), components: [] });
    });
}

async function showArtifactOwnerUpdate(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const modal = new ModalBuilder().setCustomId('modal_art_owner').setTitle(t(ctx.locale, 'artifact.ownerModalTitle'));
    const nameInput = new TextInputBuilder().setCustomId('owner_name').setLabel(t(ctx.locale, 'artifact.ownerNameLabel')).setStyle(TextInputStyle.Short).setValue(artifact.owner_name || "").setRequired(true);
    const typeInput = new TextInputBuilder().setCustomId('owner_type').setLabel(t(ctx.locale, 'artifact.ownerTypeLabel')).setStyle(TextInputStyle.Short).setValue(artifact.owner_type || "NPC").setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput), new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_art_owner' && i.user.id === interaction.user.id });
        const name = submission.fields.getTextInputValue('owner_name');
        const typeInput = submission.fields.getTextInputValue('owner_type').toUpperCase();
        const validTypes: ArtifactOwnerType[] = ['PC', 'NPC', 'FACTION', 'LOCATION', 'NONE'];
        if (!validTypes.includes(typeInput as ArtifactOwnerType)) {
            await submission.reply({ content: t(ctx.locale, 'artifact.invalidOwnerType', { type: typeInput }), ephemeral: true });
            return;
        }

        const type = typeInput as ArtifactOwnerType;
        const success = artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { owner_name: name, owner_type: type }, true);
        if (!success) {
            await submission.reply({ content: t(ctx.locale, 'artifact.ownerUpdateError', { artifact: artifact.name }), ephemeral: true });
            return;
        }
        await submission.reply(t(ctx.locale, 'artifact.ownerUpdatedInteractive', { artifact: artifact.name, owner: name, type }));
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showArtifactCurseUpdate(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const modal = new ModalBuilder().setCustomId('modal_art_curse').setTitle(t(ctx.locale, 'artifact.curseModalTitle'));
    const isCursedInput = new TextInputBuilder().setCustomId('is_cursed').setLabel(t(ctx.locale, 'artifact.isCursedLabel')).setStyle(TextInputStyle.Short).setValue(t(ctx.locale, artifact.is_cursed ? 'common.yes' : 'common.no')).setRequired(true);
    const descInput = new TextInputBuilder().setCustomId('curse_desc').setLabel(t(ctx.locale, 'artifact.curseDescriptionLabel')).setStyle(TextInputStyle.Paragraph).setValue(artifact.curse_description || "").setRequired(false);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(isCursedInput), new ActionRowBuilder<TextInputBuilder>().addComponents(descInput));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_art_curse' && i.user.id === interaction.user.id });
        const isCursed = isAffirmative(submission.fields.getTextInputValue('is_cursed'));
        const desc = submission.fields.getTextInputValue('curse_desc');

        const success = artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { is_cursed: isCursed, curse_description: desc }, true);
        if (!success) {
            await submission.reply({ content: t(ctx.locale, 'artifact.curseUpdateError', { artifact: artifact.name }), ephemeral: true });
            return;
        }
        await submission.reply(t(ctx.locale, 'artifact.curseUpdated', { artifact: artifact.name }));
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showArtifactTextModal(interaction: any, artifact: ArtifactEntry, field: string, ctx: CommandContext) {
    const modalId = `modal_atext_${Date.now()}`;
    const fieldLabel = artifactFieldLabel(ctx, field);
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(t(ctx.locale, 'inventory.editFieldTitle', { field: fieldLabel }));
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'note' ? t(ctx.locale, 'inventory.fieldNarrativeNote') : t(ctx.locale, 'inventory.newFieldLabel', { field: fieldLabel }))
        .setStyle(field === 'description' || field === 'effects' || field === 'note' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(field === 'note' ? "" : (artifact as any)[field] || "")
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 300000, filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id });
        const newValue = submission.fields.getTextInputValue('value');

        if (field === 'note') {
            await submission.deferReply();
            const session = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
            addArtifactEvent(ctx.activeCampaign!.id, artifact.name, session, newValue, "MANUAL_UPDATE", true);
            await regenerateArtifactBio(ctx.activeCampaign!.id, artifact.name);
            await submission.editReply(t(ctx.locale, 'artifact.noteAdded', { artifact: artifact.name }));
        } else {
            const success = artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { [field]: newValue }, true);
            if (!success) {
                await submission.reply({ content: t(ctx.locale, 'artifact.updateError', { artifact: artifact.name, field: fieldLabel }), ephemeral: true });
                return;
            }
            await submission.reply(t(ctx.locale, 'artifact.updated', { artifact: artifact.name, field: fieldLabel }));
        }
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

function artifactStatusLabel(ctx: CommandContext, status: ArtifactStatus): string {
    const keys = {
        FUNCTIONAL: 'artifact.statusFunctional',
        DESTROYED: 'artifact.statusDestroyed',
        LOST: 'artifact.statusLost',
        SEALED: 'artifact.statusSealed',
        DORMANT: 'artifact.statusDormant'
    } as const;
    return t(ctx.locale, keys[status] || 'artifact.statusFunctional');
}

function artifactFieldLabel(ctx: CommandContext, field: string): string {
    switch (field) {
        case 'name': return t(ctx.locale, 'inventory.fieldName');
        case 'description': return t(ctx.locale, 'inventory.fieldDescription');
        case 'effects': return t(ctx.locale, 'artifact.effects');
        case 'status': return t(ctx.locale, 'artifact.status');
        case 'curse': return t(ctx.locale, 'artifact.curse');
        case 'owner': return t(ctx.locale, 'artifact.owner');
        case 'note': return t(ctx.locale, 'inventory.fieldNarrativeNote');
        default: return field;
    }
}

function isAffirmative(value: string): boolean {
    return ['true', '1', 'yes', 'y', 'sì', 'si', 'sí', 'oui', 'ja', 'sim'].includes(value.trim().toLowerCase());
}
