import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ComponentType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { CommandContext } from '../types';
import {
    listAllArtifacts,
    updateArtifactFields,
    getArtifactByName,
    markArtifactDirty,
    getArtifactByShortId,
    addArtifactEvent,
    upsertArtifact,
    deleteArtifact
} from '../../db'; // Check correct imports from index
import { ArtifactEntry, ArtifactStatus } from '../../db/types';

export async function startInteractiveArtifactUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let art = getArtifactByName(ctx.activeCampaign!.id, query);
        if (!art) {
            const clean = query.replace('#', '').toLowerCase();
            const all = listAllArtifacts(ctx.activeCampaign!.id);
            art = all.find(a => a.short_id && a.short_id.toLowerCase() === clean) || null;
        }

        if (art) {
            await showFieldSelection(ctx.message as any, art, ctx, true);
            return;
        }
    }

    // 2. Build Selection
    await showArtifactSelection(ctx, null, null, 'UPDATE');
}

export async function startInteractiveArtifactDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let art = getArtifactByName(ctx.activeCampaign!.id, query);
        if (!art) {
            const clean = query.replace('#', '').toLowerCase();
            const all = listAllArtifacts(ctx.activeCampaign!.id);
            art = all.find(a => a.short_id && a.short_id.toLowerCase() === clean) || null;
        }

        if (art) {
            await showArtifactDeleteConfirmation(ctx.message as any, art, ctx, true);
            return;
        }
    }

    await showArtifactSelection(ctx, null, null, 'DELETE');
}

export async function startInteractiveArtifactAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_artifact_add')
                .setLabel('Crea Nuovo Artefatto')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔮')
        );

    const reply = await ctx.message.reply({
        content: "**🔮 Nuovo Artefatto**\nClicca per registrare un nuovo artefatto.",
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
            .setCustomId('art_name')
            .setLabel("Nome Artefatto")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('art_desc')
            .setLabel("Descrizione (Opzionale)")
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

            const name = submission.fields.getTextInputValue('art_name');
            const desc = submission.fields.getTextInputValue('art_desc') || undefined;

            // Check existing
            const existing = getArtifactByName(ctx.activeCampaign!.id, name);
            if (existing) {
                await submission.reply({
                    content: `⚠️ L'artefatto **${name}** esiste già. Usa \`$artifact update\` per modificarlo.`,
                    ephemeral: true
                });
                return;
            }

            // Create
            upsertArtifact(
                ctx.activeCampaign!.id,
                name,
                'FUNZIONANTE',
                undefined,
                { description: desc },
                true
            );

            // Success Reply
            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_art')
                        .setLabel('Modifica Dettagli')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ **Artefatto Creato!**\n🔮 **${name}**\n📜 ${desc || "Nessuna descrizione"}\n✨ Stato: Funzionante`,
                components: [successRow]
            });

            try { await reply.delete(); } catch { }

            // Edit Listener
            const message = await submission.fetchReply();
            const editCollector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (i) => i.customId === 'edit_created_art' && i.user.id === ctx.message.author.id
            });

            editCollector.on('collect', async (i) => {
                editCollector.stop();
                const art = getArtifactByName(ctx.activeCampaign!.id, name);
                if (art) {
                    await showFieldSelection(i, art, ctx);
                } else {
                    await i.reply({ content: "❌ Artefatto non trovato.", ephemeral: true });
                }
            });

        } catch (e) { }
    });

    collector.on('end', () => {
        if (reply.editable) reply.edit({ components: [] }).catch(() => { });
    });
}

async function showArtifactSelection(ctx: CommandContext, searchQuery: string | null, interactionToUpdate: any | null, mode: 'UPDATE' | 'DELETE' = 'UPDATE') {
    let artifacts: ArtifactEntry[] = [];

    // We fetch all because listAllArtifacts usually returns all. 
    // If it's too heavy, we might need a search function in DB, but for now filtering in memory is consistent with other commands.
    const allArtifacts = listAllArtifacts(ctx.activeCampaign!.id);

    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        artifacts = allArtifacts.filter(a =>
            a.name.toLowerCase().includes(query) ||
            (a.description && a.description.toLowerCase().includes(query))
        ).slice(0, 24);
    } else {
        artifacts = allArtifacts.slice(0, 24);
    }

    if (artifacts.length === 0 && !searchQuery) {
        const content = "⚠️ Nessun artefatto trovato. Usa `$artifact add` per aggiungerne uno.";
        if (interactionToUpdate) await interactionToUpdate.update({ content, components: [] });
        else await ctx.message.reply(content);
        return;
    }

    const options = artifacts.map(a =>
        new StringSelectMenuOptionBuilder()
            .setLabel(a.name)
            .setDescription(a.short_id ? `#${a.short_id} - ${a.status}` : a.status)
            .setValue(a.short_id || a.name) // Prefer short_id
            .setEmoji(getArtifactEmoji(a.status))
    );

    options.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel("🔍 Cerca...")
            .setDescription("Filtra artefatti per nome o nota")
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    const actionText = mode === 'DELETE' ? "Eliminazione" : "Aggiornamento";
    const select = new StringSelectMenuBuilder()
        .setCustomId('artifact_update_select_entity')
        .setPlaceholder(searchQuery ? `Risultati per: ${searchQuery}` : `🔍 Seleziona un artefatto per ${actionText.toLowerCase()}...`)
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const content = searchQuery
        ? `**🛠️ ${actionText} Artefatto**\nRisultati ricerca per "${searchQuery}":`
        : `**🛠️ ${actionText} Artefatto Interattivo**\nSeleziona un oggetto dalla lista o usa Cerca:`;

    let response;
    if (interactionToUpdate) {
        if (interactionToUpdate.isModalSubmit && interactionToUpdate.isModalSubmit()) {
            await interactionToUpdate.update({ content, components: [row] });
            response = interactionToUpdate.message;
        } else {
            await interactionToUpdate.update({ content, components: [row] });
            response = interactionToUpdate.message;
        }
    } else {
        response = await ctx.message.reply({ content, components: [row] });
    }

    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'artifact_update_select_entity'
    });

    collector.on('collect', async (interaction: any) => {
        const val = interaction.values[0];

        if (val === 'SEARCH_ACTION') {
            collector.stop();
            const modal = new ModalBuilder()
                .setCustomId('modal_artifact_search')
                .setTitle("🔍 Cerca Artefatto");

            const input = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel("Nome o contenuto")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

            await interaction.showModal(modal);

            try {
                const submission = await interaction.awaitModalSubmit({
                    time: 60000,
                    filter: (i: any) => i.customId === 'modal_artifact_search' && i.user.id === interaction.user.id
                });

                const query = submission.fields.getTextInputValue('search_query');
                await showArtifactSelection(ctx, query, submission, mode);
            } catch (e) { }
        } else {
            collector.stop();
            const selectedVal = val;
            // Try by ID first if looks like ID, or name
            let artifact = getArtifactByShortId(ctx.activeCampaign!.id, selectedVal);
            if (!artifact) artifact = getArtifactByName(ctx.activeCampaign!.id, selectedVal);

            if (!artifact) {
                await interaction.reply({ content: `❌ Errore: Artefatto non trovato.`, ephemeral: true });
                return;
            }

            if (mode === 'DELETE') {
                await showArtifactDeleteConfirmation(interaction, artifact, ctx);
            } else {
                await showFieldSelection(interaction, artifact, ctx);
            }
        }
    });
}

async function showArtifactDeleteConfirmation(interaction: any, art: any, ctx: CommandContext, isNewMessage: boolean = false) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_confirm_delete')
                .setLabel('CONFERMA ELIMINAZIONE')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️'),
            new ButtonBuilder()
                .setCustomId('btn_cancel_delete')
                .setLabel('Annulla')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('❌')
        );

    const content = `⚠️ **ATTENZIONE** ⚠️\nSei sicuro di voler eliminare definitivamente l'artefatto **${art.name}**?\nQuesta azione è irreversibile.`;

    let message;
    if (isNewMessage) {
        message = await interaction.reply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
        message = interaction.message;
    }

    const targetMessage = isNewMessage ? message : interaction.message;

    const collector = targetMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30000,
        filter: (i: any) => i.user.id === ctx.message.author.id && ['btn_confirm_delete', 'btn_cancel_delete'].includes(i.customId)
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        if (i.customId === 'btn_confirm_delete') {
            const success = deleteArtifact(ctx.activeCampaign!.id, art.name);
            if (success) {
                await i.update({ content: `✅ Artefatto **${art.name}** eliminato correttamente.`, components: [] });
            } else {
                await i.update({ content: `❌ Errore durante l'eliminazione.`, components: [] });
            }
        } else {
            await i.update({ content: `❌ Operazione annullata.`, components: [] });
        }
    });
}

async function showFieldSelection(interaction: any, artifact: ArtifactEntry, ctx: CommandContext, isNewMessage: boolean = false) {
    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId('artifact_update_select_field')
        .setPlaceholder(`Modifica ${artifact.name}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Status').setValue('status').setDescription('Funzionante, Distrutto...').setEmoji('✨'),
            new StringSelectMenuOptionBuilder().setLabel('Proprietario').setValue('owner_name').setDescription('Chi lo possiede?').setEmoji('👤'),
            new StringSelectMenuOptionBuilder().setLabel('Maledizione').setValue('is_cursed').setDescription('È maledetto?').setEmoji('☠️'),
            new StringSelectMenuOptionBuilder().setLabel('Posizione').setValue('location').setDescription('Macro/Micro posizione').setEmoji('📍'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setDescription('Modifica descrizione').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Nota Narrativa').setValue('note').setDescription('Aggiungi un evento/nota').setEmoji('📝')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fieldSelect);

    const content = `**🛠️ Modifica di ${artifact.name}**\nCosa vuoi aggiornare?`;

    let message;
    if (isNewMessage) {
        message = await interaction.reply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
        message = interaction.message;
    }

    const targetMessage = isNewMessage ? message : interaction.message;

    const collector = targetMessage.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'artifact_update_select_field' // Check author ID
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const field = i.values[0];

        if (field === 'status') {
            await showStatusSelection(i, artifact, ctx);
        } else if (field === 'is_cursed') {
            await showCursedSelection(i, artifact, ctx);
        } else if (field === 'note') {
            await showNoteModal(i, artifact, ctx);
        } else {
            // Text fields
            await showTextModal(i, artifact, field, ctx);
        }
    });
}

async function showStatusSelection(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const validStatuses = ['FUNZIONANTE', 'DISTRUTTO', 'PERDUTO', 'SIGILLATO', 'DORMIENTE'];

    const select = new StringSelectMenuBuilder()
        .setCustomId('artifact_status_select')
        .setPlaceholder('Nuovo Status...')
        .addOptions(validStatuses.map(s =>
            new StringSelectMenuOptionBuilder()
                .setLabel(s)
                .setValue(s)
                .setEmoji(getArtifactEmoji(s as ArtifactStatus))
                .setDefault(s === artifact.status)
        ));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Stato di ${artifact.name}**`,
        components: [row]
    });

    const col = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'artifact_status_select'
    });

    col.on('collect', async (i: any) => {
        col.stop();
        const newStatus = i.values[0];
        updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { status: newStatus as ArtifactStatus }, true);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_art_update_again_status')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ Stus di **${artifact.name}** aggiornato a **${newStatus}**!`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_art_update_again_status' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const fresh = getArtifactByName(ctx.activeCampaign!.id, artifact.name);
            if (fresh) await showFieldSelection(btn, fresh, ctx);
        });
    });
}

async function showCursedSelection(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const select = new StringSelectMenuBuilder()
        .setCustomId('artifact_cursed_select')
        .setPlaceholder('È maledetto?')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel("SÌ - Maledetto").setValue("true").setEmoji('☠️').setDefault(!!artifact.is_cursed),
            new StringSelectMenuOptionBuilder().setLabel("NO - Sicuro").setValue("false").setEmoji('🛡️').setDefault(!artifact.is_cursed)
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Maledizione di ${artifact.name}**`,
        components: [row]
    });

    const col = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'artifact_cursed_select'
    });

    col.on('collect', async (i: any) => {
        col.stop();
        const val = i.values[0];
        const isCursed = val === 'true';
        updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { is_cursed: isCursed }, true);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_art_update_again_cursed')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ **${artifact.name}** ${isCursed ? 'è ora MALEDETTO ☠️' : 'è ora sicuro 🛡️'}.`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_art_update_again_cursed' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const fresh = getArtifactByName(ctx.activeCampaign!.id, artifact.name);
            if (fresh) await showFieldSelection(btn, fresh, ctx);
        });
    });
}

async function showTextModal(interaction: any, artifact: ArtifactEntry, field: string, ctx: CommandContext) {
    const modalId = `modal_art_update_${field}_${Date.now()}`;
    const baseTitle = `Modifica ${field}: ${artifact.name}`;
    const title = baseTitle.length > 45 ? baseTitle.substring(0, 42) + '...' : baseTitle;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    let val = '';
    if (field === 'owner_name') val = artifact.owner_name || '';
    if (field === 'description') val = artifact.description || '';
    if (field === 'location') val = [artifact.location_macro, artifact.location_micro].filter(Boolean).join(', ');

    const input = new TextInputBuilder()
        .setCustomId('input_val')
        .setLabel(`Nuovo valore`)
        .setStyle(field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(val)
        .setRequired(false);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

    await interaction.showModal(modal);

    try {
        const sub = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        let newVal = sub.fields.getTextInputValue('input_val');
        const updates: any = {};

        if (field === 'location') {
            // Naive split for macro/micro
            const parts = newVal.split(',').map((s: string) => s.trim());
            updates.location_macro = parts[0] || null;
            updates.location_micro = parts.length > 1 ? parts.slice(1).join(', ') : null;
        } else {
            updates[field] = newVal;
        }

        updateArtifactFields(ctx.activeCampaign!.id, artifact.name, updates, true);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_art_update_again_text')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await sub.reply({
            content: `✅ **${artifact.name}** aggiornato!\n${field}: ${newVal}`,
            ephemeral: false,
            components: [updateAgainRow]
        });

        const msg = await sub.fetchReply();
        const btnCollector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_art_update_again_text' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const fresh = getArtifactByName(ctx.activeCampaign!.id, artifact.name);
            if (fresh) await showFieldSelection(btn, fresh, ctx);
        });

        // Try cleanup
        try { await interaction.message.edit({ components: [] }); } catch { }

    } catch (e) { }
}

async function showNoteModal(interaction: any, artifact: ArtifactEntry, ctx: CommandContext) {
    const modalId = `modal_art_note_${Date.now()}`;
    const baseTitle = `Nota: ${artifact.name}`;
    const title = baseTitle.length > 45 ? baseTitle.substring(0, 42) + '...' : baseTitle;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    const input = new TextInputBuilder()
        .setCustomId('note_val')
        .setLabel("Nota/Evento")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("L'artefatto ha iniziato a vibrare...")
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

    await interaction.showModal(modal);

    try {
        const sub = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        const note = sub.fields.getTextInputValue('note_val');

        // Add event
        const sessionId = "MANUAL"; // Or try to get current if available
        addArtifactEvent(ctx.activeCampaign!.id, artifact.name, sessionId, note, "MANUAL_UPDATE", true);
        markArtifactDirty(ctx.activeCampaign!.id, artifact.name);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_art_update_again_note')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await sub.reply({
            content: `📝 Nota aggiunta a **${artifact.name}**!`,
            ephemeral: false,
            components: [updateAgainRow]
        });

        const msg = await sub.fetchReply();
        const btnCollector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_art_update_again_note' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const fresh = getArtifactByName(ctx.activeCampaign!.id, artifact.name);
            if (fresh) await showFieldSelection(btn, fresh, ctx);
        });

        try { await interaction.message.edit({ components: [] }); } catch { }

    } catch (e) { }
}

function getArtifactEmoji(status: string) {
    switch (status) {
        case 'FUNZIONANTE': return '✨';
        case 'DISTRUTTO': return '💥';
        case 'PERDUTO': return '❓';
        case 'SIGILLATO': return '🔒';
        case 'DORMIENTE': return '💤';
        default: return '🔮';
    }
}
