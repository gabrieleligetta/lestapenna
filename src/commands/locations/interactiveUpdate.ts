import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
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

export async function startInteractiveAtlasUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let loc;
        const shortIdMatch = query.match(/^#?([a-z0-9]{5})$/i);
        if (shortIdMatch) {
            loc = locationRepository.getAtlasEntryByShortId(ctx.activeCampaign!.id, shortIdMatch[1]);
        }

        if (!loc) {
            // Search by name (micro or macro)
            const all = locationRepository.listAllAtlasEntries(ctx.activeCampaign!.id);
            const cleanQuery = query.toLowerCase();
            loc = all.find(l =>
                l.micro_location.toLowerCase() === cleanQuery ||
                l.macro_location.toLowerCase() === cleanQuery
            );
        }

        if (loc) {
            await showFieldSelection(ctx.message as any, loc, ctx, true);
            return;
        }
    }

    // 2. Build Location Select Menu
    await showLocationSelection(ctx, null, null);
}

export async function startInteractiveAtlasAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_atlas_add')
                .setLabel('Aggiungi Luogo')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🗺️')
        );

    const reply = await ctx.message.reply({
        content: "**🗺️ Nuovo Luogo Atlas**\nClicca per aggiungere un nuovo luogo all'Atlante.",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_atlas_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const modal = new ModalBuilder()
            .setCustomId('modal_atlas_add_new')
            .setTitle("Nuovo Luogo");

        const macroInput = new TextInputBuilder()
            .setCustomId('atlas_macro')
            .setLabel("Regione / Città (Macro)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Es. Terre Esterne")
            .setRequired(true);

        const microInput = new TextInputBuilder()
            .setCustomId('atlas_micro')
            .setLabel("Luogo Specifico (Micro)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Es. La Locanda")
            .setRequired(true);

        const descInput = new TextInputBuilder()
            .setCustomId('atlas_desc')
            .setLabel("Descrizione (Opzionale)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(macroInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(microInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
        );

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === 'modal_atlas_add_new' && i.user.id === interaction.user.id
            });

            const macro = submission.fields.getTextInputValue('atlas_macro');
            const micro = submission.fields.getTextInputValue('atlas_micro');
            const desc = submission.fields.getTextInputValue('atlas_desc') || "Nessuna descrizione inizale.";

            // Check existence
            const existing = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);
            if (existing) {
                await submission.reply({
                    content: `⚠️ Il luogo **${macro} - ${micro}** esiste già (#${existing.short_id}). Usa \`$atlante update\` per modificarlo.`,
                    ephemeral: true
                });
                return;
            }

            // Create
            locationRepository.updateAtlasEntry(ctx.activeCampaign!.id, macro, micro, desc, undefined, true);

            const created = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);

            // Success Reply with Edit Button
            const successRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_created_atlas')
                        .setLabel('Modifica Dettagli')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ **Luogo Aggiunto!**\n🗺️ **${macro}** - **${micro}**\n📜 ${desc}`,
                components: [successRow]
            });

            try { await reply.delete(); } catch { }

            // Edit Listener
            const message = await submission.fetchReply();
            const editCollector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (i) => i.customId === 'edit_created_atlas' && i.user.id === ctx.message.author.id
            });

            editCollector.on('collect', async (i) => {
                editCollector.stop();
                const loc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);
                if (loc) {
                    await showFieldSelection(i, loc, ctx);
                } else {
                    await i.reply({ content: "❌ Errore nel recupero del luogo.", ephemeral: true });
                }
            });

        } catch (e) { }
    });

    collector.on('end', () => {
        if (reply.editable) reply.edit({ components: [] }).catch(() => { });
    });
}

async function showLocationSelection(ctx: CommandContext, searchQuery: string | null, interactionToUpdate: any | null) {
    let locations: any[] = [];

    if (searchQuery) {
        // Search by name (macro or micro)
        const query = searchQuery.toLowerCase();
        const all = locationRepository.listAllAtlasEntries(ctx.activeCampaign!.id);
        locations = all.filter(l =>
            l.macro_location.toLowerCase().includes(query) ||
            l.micro_location.toLowerCase().includes(query) ||
            l.short_id.toLowerCase().includes(query)
        ).slice(0, 24); // Leave 1 spot for "Search"
    } else {
        // Default list
        locations = locationRepository.listAtlasEntries(ctx.activeCampaign!.id, 24, 0);
    }

    const options = locations.map((l: any) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(`${l.macro_location} - ${l.micro_location}`.substring(0, 100))
            .setDescription(l.description ? l.description.substring(0, 50) : 'Nessuna descrizione')
            .setValue(`#${l.short_id}`)
            .setEmoji('🌍')
    );

    // Add Search Option
    options.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel("🔍 Cerca...")
            .setDescription("Filtra luoghi per nome")
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    const locSelect = new StringSelectMenuBuilder()
        .setCustomId('atlas_update_select_entity')
        .setPlaceholder(searchQuery ? `Risultati per: ${searchQuery}` : '🔍 Seleziona un luogo da modificare...')
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(locSelect);
    const content = searchQuery
        ? `**🛠️ Aggiornamento Atlante**\nRisultati ricerca per "${searchQuery}":`
        : "**🛠️ Aggiornamento Atlante Interattivo**\nSeleziona un luogo dalla lista o usa Cerca:";

    let response;
    if (interactionToUpdate) {
        await interactionToUpdate.update({ content, components: [row] });
        response = interactionToUpdate.message;
    } else {
        response = await ctx.message.reply({ content, components: [row] });
    }

    // 3. Collector
    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'atlas_update_select_entity'
    });

    collector.on('collect', async (interaction: any) => {
        const val = interaction.values[0];

        if (val === 'SEARCH_ACTION') {
            // Show Search Modal
            collector.stop();
            const modal = new ModalBuilder()
                .setCustomId('modal_atlas_search')
                .setTitle("🔍 Cerca Luogo");

            const input = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel("Nome o parte del nome")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

            await interaction.showModal(modal);

            try {
                const submission = await interaction.awaitModalSubmit({
                    time: 60000,
                    filter: (i: any) => i.customId === 'modal_atlas_search' && i.user.id === interaction.user.id
                });

                const query = submission.fields.getTextInputValue('search_query');

                // We must reply or update to resolve the modal interaction. 
                // But we want to update the original message.
                // Modal submission gives us an interaction we can use to update the message if we passed it correctly?
                // Actually awaitModalSubmit returns an interaction that can be used to update.

                await showLocationSelection(ctx, query, submission);

            } catch (e) {
                // timeout
            }

        } else {
            collector.stop();
            const selectedId = val.replace('#', '');
            const location = locationRepository.getAtlasEntryByShortId(ctx.activeCampaign!.id, selectedId);

            if (!location) {
                await interaction.reply({ content: `❌ Errore: Luogo ${selectedId} non trovato.`, ephemeral: true });
                return;
            }

            // 4. Show Field Selection
            await showFieldSelection(interaction, location, ctx);
        }
    });
}

async function showFieldSelection(interaction: any, location: any, ctx: CommandContext, isNewMessage: boolean = false) {
    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId('atlas_update_select_field')
        .setPlaceholder(`Modifica ${location.micro_location}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setDescription('Modifica atmosfera/note').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Affiliazione Fazione').setValue('faction').setDescription('Imposta controllo fazione').setEmoji('⚔️'),
            new StringSelectMenuOptionBuilder().setLabel('Rinomina').setValue('rename').setDescription('Cambia nome Macro/Micro').setEmoji('🏷️')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fieldSelect);

    const content = `**🛠️ Modifica di ${location.macro_location} - ${location.micro_location}**\nCosa vuoi aggiornare?`;

    let message;
    if (isNewMessage) {
        message = await interaction.reply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
        message = interaction.message;
    }

    const targetMessage = isNewMessage ? message : interaction.message;

    const fieldCollector = targetMessage.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'atlas_update_select_field' // Check author ID
    });

    fieldCollector.on('collect', async (i: any) => {
        fieldCollector.stop();
        const field = i.values[0];

        if (field === 'faction') await showFactionSelection(i, location, ctx);
        else await showTextModal(i, location, field, ctx);
    });
}

async function showFactionSelection(interaction: any, location: any, ctx: CommandContext) {
    const factions = factionRepository.listFactions(ctx.activeCampaign!.id);

    if (factions.length === 0) {
        await interaction.update({
            content: "⚠️ Nessuna fazione disponibile. Crea prima una fazione con `$faction create`.",
            components: []
        });
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('atlas_update_select_faction')
        .setPlaceholder('Seleziona Fazione Controllante...')
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
            .setLabel("❌ Rimuovi Controllo")
            .setValue("REMOVE_CONTROL")
            .setDescription("Nessuna fazione controlla questo luogo")
            .setEmoji('🏳️')
    );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Aggiorna Controllo Fazione per ${location.micro_location}**`,
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

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_atlas_update_again_faction')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        if (value === 'REMOVE_CONTROL') {
            // ... logic ...
            await i.update({
                content: `✅ Rimossa affiliazione fazione da **${location.micro_location}**.`,
                components: [updateAgainRow]
            });
        } else {
            const factionId = parseInt(value);
            const faction = factions.find(f => f.id === factionId);

            if (faction) {
                // ... logic ...
                await i.update({
                    content: `✅ **${location.micro_location}** ora controllato da **${faction.name}**.`,
                    components: [updateAgainRow]
                });
            }
        }

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_atlas_update_again_faction' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const freshLoc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, location.macro_location, location.micro_location);
            if (freshLoc) await showFieldSelection(btn, freshLoc, ctx);
            else await btn.reply({ content: "❌ Errore reload luogo.", ephemeral: true });
        });
    });
}

async function showTextModal(interaction: any, location: any, field: string, ctx: CommandContext) {
    const modalId = `modal_atlas_update_${field}_${Date.now()}`;
    const label = field === 'rename' ? 'Nomi' : 'Descrizione';
    const baseTitle = `Modifica ${label}: ${location.micro_location}`;
    const title = baseTitle.length > 45 ? baseTitle.substring(0, 42) + '...' : baseTitle;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    if (field === 'description') {
        const input = new TextInputBuilder()
            .setCustomId('input_desc')
            .setLabel("Nuova Descrizione")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(location.description || '')
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    } else if (field === 'rename') {
        const macroInput = new TextInputBuilder()
            .setCustomId('input_macro')
            .setLabel("Regione / Macro Location")
            .setStyle(TextInputStyle.Short)
            .setValue(location.macro_location)
            .setRequired(true);

        const microInput = new TextInputBuilder()
            .setCustomId('input_micro')
            .setLabel("Luogo Specifico / Micro Location")
            .setStyle(TextInputStyle.Short)
            .setValue(location.micro_location)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(macroInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(microInput)
        );
    }

    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        if (field === 'description') {
            const newDesc = submission.fields.getTextInputValue('input_desc');
            locationRepository.updateAtlasEntry(ctx.activeCampaign!.id, location.macro_location, location.micro_location, newDesc, undefined, true);

            const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('btn_atlas_update_again_desc')
                        .setLabel('Modifica Ancora')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ Descrizione aggiornata per **${location.micro_location}**.`,
                ephemeral: false,
                components: [updateAgainRow]
            });

            const msg = await submission.fetchReply();
            const btnCollector = msg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (btn: any) => btn.customId === 'btn_atlas_update_again_desc' && btn.user.id === interaction.user.id
            });
            btnCollector.on('collect', async (btn: any) => {
                btnCollector.stop();
                const freshLoc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, location.macro_location, location.micro_location);
                if (freshLoc) await showFieldSelection(btn, freshLoc, ctx);
                else await btn.reply({ content: "❌ Errore reload luogo.", ephemeral: true });
            });

        } else if (field === 'rename') {
            const newMacro = submission.fields.getTextInputValue('input_macro');
            const newMicro = submission.fields.getTextInputValue('input_micro');

            const success = locationRepository.renameAtlasEntry(ctx.activeCampaign!.id, location.macro_location, location.micro_location, newMacro, newMicro, true);

            if (success) {
                const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('btn_atlas_update_again_rename')
                            .setLabel('Modifica Ancora')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('✏️')
                    );

                await submission.reply({
                    content: `✅ Luogo rinominato in **${newMacro} - ${newMicro}**.`,
                    ephemeral: false,
                    components: [updateAgainRow]
                });

                const msg = await submission.fetchReply();
                const btnCollector = msg.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 60000,
                    filter: (btn: any) => btn.customId === 'btn_atlas_update_again_rename' && btn.user.id === interaction.user.id
                });
                btnCollector.on('collect', async (btn: any) => {
                    btnCollector.stop();
                    // Re-fetch location with new name
                    const newLoc = locationRepository.getAtlasEntryFull(ctx.activeCampaign!.id, newMacro, newMicro);
                    if (newLoc) await showFieldSelection(btn, newLoc, ctx);
                    else await btn.reply({ content: "❌ Errore recupero nuovo luogo.", ephemeral: true });
                });

            } else {
                await submission.reply({ content: `❌ Errore rinomina (forse il nome esiste già?).`, ephemeral: true });
            }
        }

        try { await interaction.message.edit({ components: [] }); } catch (e) { }

    } catch (e) {
        // timeout
    }
}
