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
    listNpcs,
    updateNpcFields,
    updateNpcEntry,
    getNpcEntry,
    markNpcDirty,
    factionRepository
} from '../../db';

export async function startInteractiveNpcUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        let npc = getNpcEntry(ctx.activeCampaign!.id, query);

        if (!npc) {
            // Try ID search
            const cleanQuery = query.replace('#', '').toLowerCase();
            const all = listNpcs(ctx.activeCampaign!.id);
            npc = all.find(n => n.short_id && n.short_id.toLowerCase() === cleanQuery) || null;
        }

        if (npc) {
            await showFieldSelection(ctx.message as any, npc, ctx, true);
            return;
        }
    }

    // 2. Build NPC Select Menu
    await showNpcSelection(ctx, null, null);
}

export async function startInteractiveNpcAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_npc_add')
                .setLabel('Crea Nuovo NPC')
                .setStyle(ButtonStyle.Success)
                .setEmoji('👤')
        );

    const reply = await ctx.message.reply({
        content: "**🛠️ Creazione NPC**\nClicca sul bottone qui sotto per aprire il modulo di creazione.",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_npc_add' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        // Show Modal
        const modal = new ModalBuilder()
            .setCustomId('modal_npc_add_new')
            .setTitle("Nuovo NPC");

        const nameInput = new TextInputBuilder()
            .setCustomId('npc_name')
            .setLabel("Nome NPC")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const roleInput = new TextInputBuilder()
            .setCustomId('npc_role')
            .setLabel("Ruolo (Opzionale)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const descInput = new TextInputBuilder()
            .setCustomId('npc_description')
            .setLabel("Descrizione (Opzionale)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
        );

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === 'modal_npc_add_new' && i.user.id === interaction.user.id
            });

            const name = submission.fields.getTextInputValue('npc_name');
            const role = submission.fields.getTextInputValue('npc_role') || "";
            const description = submission.fields.getTextInputValue('npc_description') || "";

            const existing = getNpcEntry(ctx.activeCampaign!.id, name);
            if (existing) {
                await submission.reply({
                    content: `⚠️ L'NPC **${name}** esiste già! Usa \`$npc update\` per modificarlo.`,
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
                        .setLabel('Modifica Dettagli')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ **Nuovo NPC Creato!**\n👤 **${name}**\n🎭 Ruolo: ${role || "Nessuno"}\n📜 ${description || "Nessuna descrizione"}\n\n*Puoi aggiungere altri dettagli ora:*`,
                components: [successRow]
            });

            // Cleanup the trigger button
            try { await reply.delete(); } catch { }

            // Optional: Listen for Edit button
            const message = await submission.fetchReply();
            const editCollector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (i) => i.customId === 'edit_created_npc' && i.user.id === ctx.message.author.id
            });

            editCollector.on('collect', async (i) => {
                const npc = getNpcEntry(ctx.activeCampaign!.id, name);
                if (npc) {
                    await showFieldSelection(i, npc, ctx);
                } else {
                    await i.reply({ content: "❌ NPC non trovato.", ephemeral: true });
                }
            });

        } catch (err) {
            // Modal timeout
        }
    });

    collector.on('end', () => {
        if (reply.editable) {
            reply.edit({ components: [] }).catch(() => { });
        }
    });
}

async function showNpcSelection(ctx: CommandContext, searchQuery: string | null, interactionToUpdate: any | null) {
    let npcs: any[] = [];

    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        // Since listNpcs handles pagination but not filtering by name in the repository query (usually),
        // we might need to fetch all and filter, or add search support to repository.
        // For now, let's fetch a larger batch or all if possible. 
        // listNpcs signature: (campaignId, limit, offset)
        // Let's assume for now we filter in memory from a larger fetch or add a proper search capability later.
        // Or if listNpcs supports search? It doesn't seem to based on arg names.
        // Let's list 100 recent and filter, or rely on precise search if user types it.
        // A better approach for scalability would be adding searchNpcs to repository, but let's stick to in-memory filter of a reasonable set for now
        // OR better: use listNpcs(id, 100, 0) and filter.

        // Actually, db/index.ts exports listNpcs. Let's assume we can get a good enough list.
        // If the workspace is huge, this is inefficient, but for a Discord bot command usually fine.
        const allNpcs = listNpcs(ctx.activeCampaign!.id, 500, 0);
        npcs = allNpcs.filter((n: any) =>
            n.name.toLowerCase().includes(query) ||
            (n.role && n.role.toLowerCase().includes(query))
        ).slice(0, 24);
    } else {
        npcs = listNpcs(ctx.activeCampaign!.id, 24, 0);
    }

    const options = npcs.map((n: any) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(n.name)
            .setDescription(n.role ? n.role.substring(0, 100) : 'Nessun ruolo')
            .setValue(n.name)
            .setEmoji(n.status === 'DEAD' ? '💀' : n.status === 'MISSING' ? '❓' : '👤')
    );

    options.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel("🔍 Cerca...")
            .setDescription("Filtra NPC per nome o ruolo")
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    const npcSelect = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_entity')
        .setPlaceholder(searchQuery ? `Risultati per: ${searchQuery}` : '🔍 Seleziona un NPC da modificare...')
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(npcSelect);

    const content = searchQuery
        ? `**🛠️ Aggiornamento NPC**\nRisultati ricerca per "${searchQuery}":`
        : "**🛠️ Aggiornamento NPC Interattivo**\nSeleziona un personaggio dalla lista o usa Cerca:";

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
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'npc_update_select_entity'
    });

    collector.on('collect', async (interaction: any) => {
        const val = interaction.values[0];

        if (val === 'SEARCH_ACTION') {
            collector.stop();
            const modal = new ModalBuilder()
                .setCustomId('modal_npc_search')
                .setTitle("🔍 Cerca NPC");

            const input = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel("Nome o ruolo")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

            await interaction.showModal(modal);

            try {
                const submission = await interaction.awaitModalSubmit({
                    time: 60000,
                    filter: (i: any) => i.customId === 'modal_npc_search' && i.user.id === interaction.user.id
                });

                const query = submission.fields.getTextInputValue('search_query');
                await showNpcSelection(ctx, query, submission);
            } catch (e) { }
        } else {
            collector.stop();
            const selectedNpcName = val;
            const npc = getNpcEntry(ctx.activeCampaign!.id, selectedNpcName);

            if (!npc) {
                await interaction.reply({ content: `❌ Errore: NPC ${selectedNpcName} non trovato.`, ephemeral: true });
                return;
            }

            await showFieldSelection(interaction, npc, ctx);
        }
    });
}

async function showFieldSelection(interaction: any, npc: any, ctx: CommandContext, isNewMessage: boolean = false) {
    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_field')
        .setPlaceholder(`Modifica ${npc.name}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Nome').setValue('name').setDescription('Cambia il nome del personaggio').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Ruolo').setValue('role').setDescription('Aggiorna il ruolo o professione').setEmoji('🎭'),
            new StringSelectMenuOptionBuilder().setLabel('Status').setValue('status').setDescription('Imposta Vivo, Morto, Disperso...').setEmoji('💓'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setDescription('Modifica la biografia/descrizione').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Allineamento (B/M)').setValue('alignment_moral').setDescription('Buono, Neutrale, Malvagio').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel('Allineamento (L/C)').setValue('alignment_ethical').setDescription('Legale, Neutrale, Caotico').setEmoji('🏛️'),
            new StringSelectMenuOptionBuilder().setLabel('Affiliazione Fazione').setValue('faction').setDescription('Collega a una fazione').setEmoji('⚔️'),
            new StringSelectMenuOptionBuilder().setLabel('Alias / Soprannomi').setValue('aliases').setDescription('Aggiungi alias per RAG').setEmoji('📇'),
            new StringSelectMenuOptionBuilder().setLabel('Ultima Posizione').setValue('last_seen_location').setDescription('Dove è stato visto l\'ultima volta?').setEmoji('📍')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fieldSelect);

    const content = `**🛠️ Modifica di ${npc.name}**\nCosa vuoi aggiornare?`;

    let message;
    if (isNewMessage) {
        message = await interaction.reply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
        message = interaction.message;
    }

    const targetMessage = isNewMessage ? message : interaction.message;

    // Create a new collector for this interaction's channel to handle subsequent steps
    const fieldCollector = targetMessage.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'npc_update_select_field' // Check author ID from context
    });

    fieldCollector.on('collect', async (i: any) => {
        fieldCollector.stop();
        const field = i.values[0];

        if (field === 'status') {
            await showStatusSelection(i, npc, ctx);
        } else if (field === 'alignment_moral') {
            await showAlignmentSelection(i, npc, 'moral', ctx);
        } else if (field === 'alignment_ethical') {
            await showAlignmentSelection(i, npc, 'ethical', ctx);
        } else if (field === 'faction') {
            await showFactionSelection(i, npc, ctx);
        } else {
            // Text fields: Name, Role, Description
            await showTextModal(i, npc, field, ctx);
        }
    });
}

async function showStatusSelection(interaction: any, npc: any, ctx: CommandContext) {
    const statusSelect = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_status')
        .setPlaceholder('Seleziona nuovo status...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('VIVO').setValue('ALIVE').setEmoji('👤').setDefault(npc.status === 'ALIVE'),
            new StringSelectMenuOptionBuilder().setLabel('MORTO').setValue('DEAD').setEmoji('💀').setDefault(npc.status === 'DEAD'),
            new StringSelectMenuOptionBuilder().setLabel('DISPERSO').setValue('MISSING').setEmoji('❓').setDefault(npc.status === 'MISSING'),
            new StringSelectMenuOptionBuilder().setLabel('SCONOSCIUTO').setValue('UNKNOWN').setEmoji('🌫️').setDefault(npc.status === 'UNKNOWN')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(statusSelect);

    await interaction.update({
        content: `**Aggiorna Status di ${npc.name}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'npc_update_select_status'
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newStatus = i.values[0];
        updateNpcFields(ctx.activeCampaign!.id, npc.name, { status: newStatus });
        markNpcDirty(ctx.activeCampaign!.id, npc.name);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_npc_update_again')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ Staus di **${npc.name}** aggiornato a **${newStatus}**!`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_npc_update_again' && btn.user.id === interaction.user.id
        });

        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const freshNpc = getNpcEntry(ctx.activeCampaign!.id, npc.name);
            if (freshNpc) await showFieldSelection(btn, freshNpc, ctx);
            else await btn.reply({ content: "❌ Errore reload NPC.", ephemeral: true });
        });
    });
}

async function showAlignmentSelection(interaction: any, npc: any, type: 'moral' | 'ethical', ctx: CommandContext) {
    const options = type === 'moral'
        ? ['BUONO', 'NEUTRALE', 'MALVAGIO']
        : ['LEGALE', 'NEUTRALE', 'CAOTICO'];

    // Get current value
    const currentVal = type === 'moral' ? npc.alignment_moral : npc.alignment_ethical;

    const select = new StringSelectMenuBuilder()
        .setCustomId(`npc_update_select_align_${type}`)
        .setPlaceholder(`Seleziona allineamento ${type === 'moral' ? 'Morale' : 'Etico'}...`)
        .addOptions(
            options.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(opt)
                    .setValue(opt)
                    .setDefault(opt === currentVal)
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Aggiorna Allineamento ${type === 'moral' ? 'Morale' : 'Etico'} di ${npc.name}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === `npc_update_select_align_${type}`
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newVal = i.values[0];
        const update = type === 'moral' ? { alignment_moral: newVal } : { alignment_ethical: newVal };

        updateNpcFields(ctx.activeCampaign!.id, npc.name, update);
        markNpcDirty(ctx.activeCampaign!.id, npc.name);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_npc_update_again_align')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ Allineamento di **${npc.name}** aggiornato a **${newVal}**!`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_npc_update_again_align' && btn.user.id === interaction.user.id
        });

        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const freshNpc = getNpcEntry(ctx.activeCampaign!.id, npc.name);
            if (freshNpc) await showFieldSelection(btn, freshNpc, ctx);
            else await btn.reply({ content: "❌ Errore reload NPC.", ephemeral: true });
        });
    });
}

async function showTextModal(interaction: any, npc: any, field: string, ctx: CommandContext) {
    const modalId = `modal_update_${field}_${Date.now()}`; // Unique ID to avoid conflicts
    const label = field.charAt(0).toUpperCase() + field.slice(1);
    const baseTitle = `Modifica ${label}: ${npc.name}`;
    const title = baseTitle.length > 45 ? baseTitle.substring(0, 42) + '...' : baseTitle;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    let currentValue = '';
    if (field === 'name') currentValue = npc.name;
    else if (field === 'role') currentValue = npc.role || '';
    else if (field === 'description') currentValue = npc.description || '';
    else if (field === 'aliases') currentValue = npc.aliases || '';
    else if (field === 'last_seen_location') currentValue = npc.last_seen_location || '';

    const input = new TextInputBuilder()
        .setCustomId('input_value')
        .setLabel(`Nuovo valore per ${field}`)
        .setStyle(field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(currentValue)
        .setRequired(true);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        const newValue = submission.fields.getTextInputValue('input_value');
        const updates: any = {};
        updates[field] = newValue;

        updateNpcFields(ctx.activeCampaign!.id, npc.name, updates);
        markNpcDirty(ctx.activeCampaign!.id, field === 'name' ? newValue : npc.name);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_npc_update_again_text')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await submission.reply({
            content: `✅ **${npc.name}** aggiornato!\n${field}: ${newValue}`,
            ephemeral: false,
            components: [updateAgainRow]
        });

        const msg = await submission.fetchReply();
        const btnCollector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_npc_update_again_text' && btn.user.id === interaction.user.id
        });

        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            // Handle rename case carefully
            const nameToFetch = (field === 'name') ? newValue : npc.name;
            const freshNpc = getNpcEntry(ctx.activeCampaign!.id, nameToFetch);
            if (freshNpc) await showFieldSelection(btn, freshNpc, ctx);
            else await btn.reply({ content: "❌ Errore reload NPC.", ephemeral: true });
        });

        // Cleanup original selection message if possible
        try {
            await interaction.message.edit({ components: [] });
        } catch (e) { }

    } catch (err) {
        // Timeout or error
    }
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
            content: "⚠️ Nessuna fazione trovata. Usa `$faction create` per crearne una prima.",
            components: []
        });
        return;
    }

    const factionOptions = factions.map(f =>
        new StringSelectMenuOptionBuilder()
            .setLabel(f.name)
            .setValue(f.id.toString())
            .setDescription(f.description ? f.description.substring(0, 50) : "Nessuna descrizione")
            .setEmoji(f.is_party ? '🛡️' : '⚔️')
    );

    // Search Option
    factionOptions.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel("🔍 Cerca...")
            .setDescription("Filtra fazioni")
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    // New Faction Option
    if (!searchQuery) {
        factionOptions.push(
            new StringSelectMenuOptionBuilder()
                .setLabel("➕ Crea Nuova Fazione")
                .setValue("NEW_FACTION")
                .setEmoji("✨")
                .setDescription("Crea e affilia a una nuova fazione")
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_faction')
        .setPlaceholder(searchQuery ? `Risultati per: ${searchQuery}` : 'Seleziona Fazione...')
        .addOptions(factionOptions);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const content = searchQuery
        ? `**Affiliazione per ${npc.name}**\nRisultati ricerca "${searchQuery}":`
        : `**Affiliazione: Seleziona Fazione per ${npc.name}**`;

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
            collector.stop();
            const modal = new ModalBuilder()
                .setCustomId('modal_npc_faction_search')
                .setTitle("🔍 Cerca Fazione");

            const input = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel("Nome o tipo")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

            await i.showModal(modal);

            try {
                const submission = await i.awaitModalSubmit({
                    time: 60000,
                    filter: (sub: any) => sub.customId === 'modal_npc_faction_search' && sub.user.id === i.user.id
                });
                const query = submission.fields.getTextInputValue('search_query');
                await showFactionSelectionRecursively(submission, npc, ctx, query);
            } catch (e) { }

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

    const select = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_faction_role')
        .setPlaceholder(`Seleziona Ruolo in ${faction.name}...`)
        .addOptions(
            roles.map(r => new StringSelectMenuOptionBuilder()
                .setLabel(r)
                .setValue(r)
                .setEmoji('🎭')
                .setDefault(r === currentRole)
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Affiliazione incompleta!**\nSeleziona un **Ruolo** per **${npc.name}** in **${faction.name}** per confermare l'aggiornamento.`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'npc_update_select_faction_role'
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const role = i.values[0];

        factionRepository.addAffiliation(faction.id, 'npc', npc.id, {
            role: role as any,
            notes: "Interactive Update"
        });
        markNpcDirty(ctx.activeCampaign!.id, npc.name);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_npc_update_again_role')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ **${npc.name}** ora affiliato a **${faction.name}** come **${role}**.`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_npc_update_again_role' && btn.user.id === interaction.user.id
        });

        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const freshNpc = getNpcEntry(ctx.activeCampaign!.id, npc.name);
            if (freshNpc) await showFieldSelection(btn, freshNpc, ctx);
            else await btn.reply({ content: "❌ Errore reload NPC.", ephemeral: true });
        });
    });
}

// Kept for "Create New Faction" fallback
async function showFactionModal(interaction: any, npc: any, ctx: CommandContext) {
    const modalId = `modal_faction_${Date.now()}`;
    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`Nuova Fazione & Affiliazione`);

    const factionInput = new TextInputBuilder()
        .setCustomId('faction_name')
        .setLabel("Nome Nuova Fazione")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const roleInput = new TextInputBuilder()
        .setCustomId('faction_role')
        .setLabel("Ruolo (MEMBER, LEADER...)")
        .setStyle(TextInputStyle.Short)
        .setValue('MEMBER')
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(factionInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput)
    );

    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        const factionName = submission.fields.getTextInputValue('faction_name');
        let role = submission.fields.getTextInputValue('faction_role').toUpperCase();

        const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED'];
        if (!validRoles.includes(role)) role = 'MEMBER';

        // This modal is now specifically for creating a NEW faction
        let faction = factionRepository.createFaction(ctx.activeCampaign!.id, factionName, {
            isManual: true,
            description: "Creata via Interactive Update"
        });

        if (faction) {
            factionRepository.addAffiliation(faction.id, 'npc', npc.id, {
                role: role as any,
                notes: "Interactive Update"
            });
            markNpcDirty(ctx.activeCampaign!.id, npc.name);

            const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('btn_npc_update_again_new_fact')
                        .setLabel('Modifica Ancora')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('✏️')
                );

            await submission.reply({
                content: `✅ **${npc.name}** ora affiliato a **${faction.name}** come **${role}**.`,
                ephemeral: false,
                components: [updateAgainRow]
            });

            const msg = await submission.fetchReply();
            const btnCollector = msg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000,
                filter: (btn: any) => btn.customId === 'btn_npc_update_again_new_fact' && btn.user.id === interaction.user.id
            });

            btnCollector.on('collect', async (btn: any) => {
                btnCollector.stop();
                const freshNpc = getNpcEntry(ctx.activeCampaign!.id, npc.name);
                if (freshNpc) await showFieldSelection(btn, freshNpc, ctx);
                else await btn.reply({ content: "❌ Errore reload NPC.", ephemeral: true });
            });
            try {
                await interaction.message.edit({ components: [] });
            } catch (e) { }
        } else {
            await submission.reply({
                content: `❌ Errore creazione fazione.`,
                ephemeral: true
            });
        }

    } catch (err) {
        // Timeout
    }
}
