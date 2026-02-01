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
import { guildSessions } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';

// Helper for Bio Regen
async function regenerateArtifactBio(campaignId: number, name: string) {
    const history = artifactRepository.getArtifactHistory(campaignId, name);
    const artifact = artifactRepository.getArtifactByName(campaignId, name);
    const currentDesc = artifact?.description || "";
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('ARTIFACT', { campaignId, name, currentDesc }, simpleHistory);
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
                .setLabel('Registra Nuovo Artefatto')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔮')
        );

    const reply = await ctx.message.reply({
        content: "**🛠️ Registrazione Artefatto**\nClicca sul bottone qui sotto per aprire il modulo.",
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
            .setTitle("Nuovo Artefatto");

        const nameInput = new TextInputBuilder()
            .setCustomId('artifact_name')
            .setLabel("Nome dell'Artefatto")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('artifact_description')
            .setLabel("Descrizione / Origine")
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
            const currentSession = guildSessions.get(ctx.guildId);

            artifactRepository.upsertArtifact(ctx.activeCampaign!.id, name, 'FUNZIONANTE', currentSession, { description }, true);

            if (currentSession) {
                addArtifactEvent(ctx.activeCampaign!.id, name, currentSession, "Artefatto scoperto/registrato.", "DISCOVERY", true);
                regenerateArtifactBio(ctx.activeCampaign!.id, name);
            }

            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_artifact')
                        .setLabel('Configura Dettagli')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ **Artefatto Registrato!**\n🔮 **${name}**\n📜 ${description || "Nessuna descrizione"}\n\n*Puoi aggiungere effetti, maledizioni o proprietario ora:*`,
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
        const icon = a.status === 'FUNZIONANTE' ? '✨' : a.is_cursed ? '☠️' : '🔮';
        return new StringSelectMenuOptionBuilder()
            .setLabel(a.name.substring(0, 100))
            .setDescription(`ID: #${a.short_id} | ${a.status}`)
            .setValue(a.name)
            .setEmoji(icon);
    });

    if (page === 0 && options.length < 25) {
        options.unshift(
            new StringSelectMenuOptionBuilder()
                .setLabel("🔍 Cerca...")
                .setValue("SEARCH_ACTION")
                .setEmoji('🔍')
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('artifact_select_entity')
        .setPlaceholder(`Seleziona un artefatto...`)
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    const filterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('filter_FUNZIONANTE').setLabel('Sani').setStyle(statusFilter === 'FUNZIONANTE' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('✨'),
        new ButtonBuilder().setCustomId('filter_SIGILLATO').setLabel('Sigillati').setStyle(statusFilter === 'SIGILLATO' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('filter_PERDUTO').setLabel('Perduti').setStyle(statusFilter === 'PERDUTO' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('❓'),
        new ButtonBuilder().setCustomId('filter_ALL').setLabel('Tutti').setStyle(statusFilter === 'ALL' ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji('🌐')
    );
    rows.push(filterRow);

    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('page_prev').setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('page_next').setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const content = `**🛠️ ${mode === 'DELETE' ? 'Eliminazione' : 'Aggiornamento'} Artefatto**\nFiltro: \`${statusFilter}\` | Pagina: ${page + 1}/${totalPages || 1}`;

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
                const modal = new ModalBuilder().setCustomId('modal_art_search').setTitle("🔍 Cerca Artefatto");
                const input = new TextInputBuilder().setCustomId('search_query').setLabel("Nome o descrizione").setStyle(TextInputStyle.Short).setRequired(true);
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
        new ButtonBuilder().setCustomId('btn_confirm_delete').setLabel('Conferma Eliminazione').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('btn_cancel_delete').setLabel('Annulla').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const content = `⚠️ **Sei sicuro di voler eliminare definitivamente: ${artifact.name}?**`;
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
            artifactRepository.deleteArtifact(ctx.activeCampaign!.id, artifact.name);
            await i.update({ content: `✅ Artefatto **${artifact.name}** eliminato.`, components: [] });
        } else {
            await i.update({ content: "❌ Eliminazione annullata.", components: [] });
        }
    });
}

async function showArtifactFieldSelection(interaction: any, artifact: ArtifactEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('artifact_select_field')
        .setPlaceholder(`Modifica: ${artifact.name}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Nome').setValue('name').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Effetti').setValue('effects').setEmoji('⚡'),
            new StringSelectMenuOptionBuilder().setLabel('Stato').setValue('status').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel('Maledizione').setValue('curse').setEmoji('☠️'),
            new StringSelectMenuOptionBuilder().setLabel('Proprietario').setValue('owner').setEmoji('👤'),
            new StringSelectMenuOptionBuilder().setLabel('Nota Narrativa').setValue('note').setEmoji('📝')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const content = `**🛠️ Modifica Artefatto: ${artifact.name}**\nCosa vuoi aggiornare?`;
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
            new StringSelectMenuOptionBuilder().setLabel('FUNZIONANTE').setValue('FUNZIONANTE').setEmoji('✨').setDefault(artifact.status === 'FUNZIONANTE'),
            new StringSelectMenuOptionBuilder().setLabel('SIGILLATO').setValue('SIGILLATO').setEmoji('🔒').setDefault(artifact.status === 'SIGILLATO'),
            new StringSelectMenuOptionBuilder().setLabel('DORMIENTE').setValue('DORMIENTE').setEmoji('💤').setDefault(artifact.status === 'DORMIENTE'),
            new StringSelectMenuOptionBuilder().setLabel('PERDUTO').setValue('PERDUTO').setEmoji('❓').setDefault(artifact.status === 'PERDUTO'),
            new StringSelectMenuOptionBuilder().setLabel('DISTRUTTO').setValue('DISTRUTTO').setEmoji('💥').setDefault(artifact.status === 'DISTRUTTO')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.update({ content: `**Aggiorna Stato di: ${artifact.name}**`, components: [row] });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newStatus = i.values[0] as ArtifactStatus;

        await i.deferUpdate();

        artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { status: newStatus }, true);

        const session = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
        addArtifactEvent(ctx.activeCampaign!.id, artifact.name, session, `Stato aggiornato a ${newStatus}`, "MANUAL_UPDATE", true);
        await regenerateArtifactBio(ctx.activeCampaign!.id, artifact.name);

        await i.editReply({ content: `✅ Stato di **${artifact.name}** aggiornato a **${newStatus}**!`, components: [] });
    });
}

async function showArtifactOwnerUpdate(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const modal = new ModalBuilder().setCustomId('modal_art_owner').setTitle("Aggiorna Proprietario");
    const nameInput = new TextInputBuilder().setCustomId('owner_name').setLabel("Nome Proprietario").setStyle(TextInputStyle.Short).setValue(artifact.owner_name || "").setRequired(true);
    const typeInput = new TextInputBuilder().setCustomId('owner_type').setLabel("Tipo (PC, NPC, FACTION, LOCATION, NONE)").setStyle(TextInputStyle.Short).setValue(artifact.owner_type || "NPC").setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput), new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_art_owner' && i.user.id === interaction.user.id });
        const name = submission.fields.getTextInputValue('owner_name');
        const type = submission.fields.getTextInputValue('owner_type').toUpperCase() as ArtifactOwnerType;

        artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { owner_name: name, owner_type: type }, true);
        await submission.reply(`✅ Proprietario di **${artifact.name}** aggiornato a **${name}** (${type}).`);
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showArtifactCurseUpdate(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const modal = new ModalBuilder().setCustomId('modal_art_curse').setTitle("Aggiorna Maledizione");
    const isCursedInput = new TextInputBuilder().setCustomId('is_cursed').setLabel("Maledetto? (si/no)").setStyle(TextInputStyle.Short).setValue(artifact.is_cursed ? "si" : "no").setRequired(true);
    const descInput = new TextInputBuilder().setCustomId('curse_desc').setLabel("Descrizione Maledizione").setStyle(TextInputStyle.Paragraph).setValue(artifact.curse_description || "").setRequired(false);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(isCursedInput), new ActionRowBuilder<TextInputBuilder>().addComponents(descInput));
    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({ time: 60000, filter: (i: any) => i.customId === 'modal_art_curse' && i.user.id === interaction.user.id });
        const isCursed = submission.fields.getTextInputValue('is_cursed').toLowerCase() === "si";
        const desc = submission.fields.getTextInputValue('curse_desc');

        artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { is_cursed: isCursed, curse_description: desc }, true);
        await submission.reply(`✅ Maledizione di **${artifact.name}** aggiornata.`);
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}

async function showArtifactTextModal(interaction: any, artifact: ArtifactEntry, field: string, ctx: CommandContext) {
    const modalId = `modal_atext_${Date.now()}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Modifica ${field}`);
    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(field === 'note' ? "Nota Narrativa" : `Nuovo ${field}`)
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
            const session = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addArtifactEvent(ctx.activeCampaign!.id, artifact.name, session, newValue, "MANUAL_UPDATE", true);
            await regenerateArtifactBio(ctx.activeCampaign!.id, artifact.name);
            await submission.editReply(`📝 Nota aggiunta a **${artifact.name}**.`);
        } else {
            artifactRepository.updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { [field]: newValue }, true);
            await submission.reply(`✅ **${artifact.name}** aggiornato (${field}).`);
        }
        try { await interaction.message.edit({ components: [] }); } catch { }
    } catch (e) { }
}
