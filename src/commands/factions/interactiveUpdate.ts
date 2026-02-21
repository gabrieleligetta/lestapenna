
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} from 'discord.js';
import { CommandContext } from '../types';
import {
    listFactions,
    updateFaction,
    factionRepository,
    npcRepository,
    locationRepository
} from '../../db';
import { FactionType } from '../../db/types';
import { FACTION_TYPE_ICONS } from './faction'; // Check if we can export this or need to redefine

const REPUTATION_ICONS: Record<string, string> = {
    'HOSTILE': '🔴',
    'DISTRUSTFUL': '🟠',
    'COLD': '🟡',
    'NEUTRAL': '⚪',
    'CORDIAL': '🟢',
    'FRIENDLY': '💚',
    'ALLIED': '⭐'
};

const ICONS: Record<string, string> = {
    'PARTY': '🎭',
    'GUILD': '🛡️',
    'KINGDOM': '👑',
    'CULT': '🕯️',
    'ORGANIZATION': '🏛️',
    'GENERIC': '⚔️'
};

export async function startInteractiveFactionUpdate(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        const faction = factionRepository.getFaction(ctx.activeCampaign!.id, query);
        if (faction) {
            // Create a fake interaction to start the flow, or just reply
            // Since showFieldSelection expects an interaction, we start by sending a message
            // and then simulating or creating a fresh interaction context might be tricky
            // BUT, showFieldSelection uses `interaction.update` or `interaction.reply`.
            // If we come from a command, `ctx.message` is the trigger.
            // We can send a message with the menu, which effectively IS what showFieldSelection does (it updates or replies).

            // However, showFieldSelection expects an INTERACTION key for .update().
            // If we pass a Message object (like ctx.message), it doesn't have .update().
            // We should adapt showFieldSelection or handle the initial reply differently.

            // Actually, let's look at `showFieldSelection`. It uses `interaction.update` usually.
            // If we pass `ctx.message` (Message), we can't use .update().
            // valid strategy: Send a reply with the components, then attach collector.

            // Let's modify showFieldSelection to handle Message or Interaction?
            // Or just inline the logic here to "jumpstart" it.

            await showFieldSelection(ctx.message as any, faction, ctx, true);
            return;
        }
    }

    // 2. Build Faction Select Menu
    await showFactionSelectionMain(ctx, null, null, 'UPDATE');
}

export async function startInteractiveFactionDelete(ctx: CommandContext) {
    if (ctx.args.length > 0) {
        const query = ctx.args.join(' ');
        const faction = factionRepository.getFaction(ctx.activeCampaign!.id, query);
        if (faction) {
            await showFactionDeleteConfirmation(ctx.message as any, faction, ctx, true);
            return;
        }
    }

    await showFactionSelectionMain(ctx, null, null, 'DELETE');
}

export async function startInteractiveFactionAdd(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_faction_add')
                .setLabel('Crea Nuova Fazione')
                .setStyle(ButtonStyle.Success)
                .setEmoji('⚔️')
        );

    const reply = await ctx.message.reply({
        content: "**⚔️ Nuova Fazione**\nClicca per creare una nuova fazione.",
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
            .setPlaceholder('Seleziona Tipo di Fazione...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Gilda').setValue('GUILD').setEmoji('📜'),
                new StringSelectMenuOptionBuilder().setLabel('Regno').setValue('KINGDOM').setEmoji('👑'),
                new StringSelectMenuOptionBuilder().setLabel('Culto').setValue('CULT').setEmoji('🐙'),
                new StringSelectMenuOptionBuilder().setLabel('Organizzazione').setValue('ORGANIZATION').setEmoji('🏢'),
                new StringSelectMenuOptionBuilder().setLabel('Altro / Generico').setValue('GENERIC').setEmoji('🏳️')
            );

        await interaction.update({
            content: "**Tipo di Fazione**\nSeleziona la tipologia per continuare:",
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
            const modal = new ModalBuilder()
                .setCustomId('modal_faction_add_new')
                .setTitle("Dettagli Fazione");

            const nameInput = new TextInputBuilder()
                .setCustomId('faction_name')
                .setLabel("Nome Fazione")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const descInput = new TextInputBuilder()
                .setCustomId('faction_description')
                .setLabel("Descrizione (Opzionale)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
            );

            await i.showModal(modal);

            try {
                const submission = await i.awaitModalSubmit({
                    time: 300000,
                    filter: (sub: any) => sub.customId === 'modal_faction_add_new' && sub.user.id === i.user.id
                });

                const name = submission.fields.getTextInputValue('faction_name');
                const desc = submission.fields.getTextInputValue('faction_description') || "Nessuna descrizione.";

                // Check existence
                const existing = factionRepository.getFaction(ctx.activeCampaign!.id, name);
                if (existing) {
                    await submission.reply({
                        content: `⚠️ La fazione ** ${name}** esiste già! Usa \`$faction update\` per modificarla.`,
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

                // Success Reply
                const successRow = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('edit_created_faction')
                            .setLabel('Modifica Dettagli')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('✏️')
                    );

                await submission.reply({
                    content: `✅ **Fazione Creata!**\n⚔️ **${name}** (${selectedType})\n📜 ${desc}`,
                    components: [successRow]
                });

                try { await reply.delete(); } catch { }

                // Edit Listener
                const message = await submission.fetchReply();
                const editCollector = message.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 60000,
                    filter: (btn: any) => btn.customId === 'edit_created_faction' && btn.user.id === ctx.message.author.id
                });

                editCollector.on('collect', async (btn: any) => {
                    editCollector.stop();
                    const fact = factionRepository.getFaction(ctx.activeCampaign!.id, name);
                    if (fact) {
                        await showFieldSelection(btn, fact, ctx);
                    } else {
                        await btn.reply({ content: "❌ Fazione non trovata.", ephemeral: true });
                    }
                });

            } catch (e) { }
        });
    });
}

async function showFactionSelectionMain(ctx: CommandContext, searchQuery: string | null, interactionToUpdate: any | null, mode: 'UPDATE' | 'DELETE' = 'UPDATE') {
    let factions: any[] = [];

    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const all = factionRepository.listFactions(ctx.activeCampaign!.id);
        factions = all.filter(f =>
            f.name.toLowerCase().includes(query) ||
            f.type.toLowerCase().includes(query)
        ).slice(0, 24);
    } else {
        factions = factionRepository.listFactions(ctx.activeCampaign!.id).slice(0, 24);
    }

    const options = factions.map(f => {
        const typeIcon = ICONS[f.type] || '⚔️';
        return new StringSelectMenuOptionBuilder()
            .setLabel(f.name)
            .setDescription(f.description ? f.description.substring(0, 50) : 'Nessuna descrizione')
            .setValue(f.name)
            .setEmoji(typeIcon);
    });

    options.unshift(
        new StringSelectMenuOptionBuilder()
            .setLabel("🔍 Cerca...")
            .setDescription("Filtra fazioni per nome o tipo")
            .setValue("SEARCH_ACTION")
            .setEmoji('🔍')
    );

    const actionText = mode === 'DELETE' ? "Eliminazione" : "Aggiornamento";
    const factionSelect = new StringSelectMenuBuilder()
        .setCustomId('faction_update_select_entity')
        .setPlaceholder(searchQuery ? `Risultati per: ${searchQuery}` : `🔍 Seleziona una fazione per ${actionText.toLowerCase()}...`)
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(factionSelect);

    const content = searchQuery
        ? `**🛠️ ${actionText} Fazione**\nRisultati ricerca per "${searchQuery}":`
        : `**🛠️ ${actionText} Fazione Interattivo**\nSeleziona una fazione dalla lista o usa Cerca:`;

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
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'faction_update_select_entity'
    });

    collector.on('collect', async (interaction: any) => {
        const val = interaction.values[0];

        if (val === 'SEARCH_ACTION') {
            collector.stop();
            const modal = new ModalBuilder()
                .setCustomId('modal_faction_search')
                .setTitle("🔍 Cerca Fazione");

            const input = new TextInputBuilder()
                .setCustomId('search_query')
                .setLabel("Nome o tipo")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

            await interaction.showModal(modal);

            try {
                const submission = await interaction.awaitModalSubmit({
                    time: 60000,
                    filter: (i: any) => i.customId === 'modal_faction_search' && i.user.id === interaction.user.id
                });

                const query = submission.fields.getTextInputValue('search_query');
                await showFactionSelectionMain(ctx, query, submission, mode);
            } catch (e) { }
        } else {
            collector.stop();
            const selectedName = val;
            const faction = factionRepository.getFaction(ctx.activeCampaign!.id, selectedName);

            if (!faction) {
                await interaction.reply({ content: `❌ Errore: Fazione ${selectedName} non trovata.`, ephemeral: true });
                return;
            }

            // Fresh fetch
            const freshFaction = factionRepository.getFaction(ctx.activeCampaign!.id, faction.name);

            if (mode === 'DELETE') {
                if (freshFaction) await showFactionDeleteConfirmation(interaction, freshFaction, ctx);
            } else {
                if (freshFaction) await showFieldSelection(interaction, freshFaction, ctx);
            }
        }
    });
}

async function showFactionDeleteConfirmation(interaction: any, faction: any, ctx: CommandContext, isNewMessage: boolean = false) {
    if (faction.is_party) {
        const warning = "❌ Non è possibile eliminare la fazione **Party**.";
        if (isNewMessage) await interaction.reply({ content: warning, ephemeral: true });
        else await interaction.update({ content: warning, components: [] });
        return;
    }

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

    const content = `⚠️ **ATTENZIONE** ⚠️\nSei sicuro di voler eliminare definitivamente la fazione **${faction.name}**?\nQuesta azione è irreversibile.`;

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
            const success = factionRepository.deleteFaction(ctx.activeCampaign!.id, faction.name);
            if (success) {
                await i.update({ content: `✅ Fazione **${faction.name}** eliminata correttamente.`, components: [] });
            } else {
                await i.update({ content: `❌ Errore durante l'eliminazione (o impossibile eliminare).`, components: [] });
            }
        } else {
            await i.update({ content: `❌ Operazione annullata.`, components: [] });
        }
    });
}

async function showFieldSelection(interaction: any, faction: any, ctx: CommandContext, isNewMessage: boolean = false) {
    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId('faction_update_select_field')
        .setPlaceholder(`Modifica ${faction.name}...`)
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Nome').setValue('name').setDescription('Rinomina la fazione').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Tipo').setValue('type').setDescription('Gilda, Regno, Culto...').setEmoji('🏰'),
            new StringSelectMenuOptionBuilder().setLabel('Status').setValue('status').setDescription('Attiva, Distrutta, Sciolta...').setEmoji('💓'),
            new StringSelectMenuOptionBuilder().setLabel('Descrizione').setValue('description').setDescription('Modifica la descrizione').setEmoji('📜'),
            new StringSelectMenuOptionBuilder().setLabel('Leader').setValue('leader').setDescription('Imposta NPC capo').setEmoji('👑'),
            // Alignment options removed - now event-driven
            new StringSelectMenuOptionBuilder().setLabel('Sede Principale').setValue('hq').setDescription('Imposta luogo HQ').setEmoji('📍')
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fieldSelect);

    const content = `**🛠️ Modifica di ${faction.name}**\nCosa vuoi aggiornare?`;

    let message;
    if (isNewMessage) {
        message = await interaction.reply({ content, components: [row] });
    } else {
        await interaction.update({ content, components: [row] });
        message = interaction.message; // Use the message from the interaction
    }

    // If we sent a new reply, message is the Message object.
    // If update, message is reference to interaction.message, but we need the actual message object for collector.
    // interaction.message is the resolved message on component interactions.

    // Safety check: if isNewMessage, `message` is the sent message.
    // If not, `interaction.message` is the message.

    const targetMessage = isNewMessage ? message : interaction.message;

    const fieldCollector = targetMessage.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id && i.customId === 'faction_update_select_field' // Check author ID from context as interaction might be Message
    });

    fieldCollector.on('collect', async (i: any) => {
        fieldCollector.stop();
        const field = i.values[0];

        if (field === 'type') await showTypeSelection(i, faction, ctx);
        else if (field === 'status') await showStatusSelection(i, faction, ctx);
        else await showTextModal(i, faction, field, ctx);
    });
}

async function showTypeSelection(interaction: any, faction: any, ctx: CommandContext) {
    const types = ['GUILD', 'KINGDOM', 'CULT', 'ORGANIZATION', 'GENERIC', 'PARTY'];

    // Check current type
    const current = faction.type;

    const select = new StringSelectMenuBuilder()
        .setCustomId('faction_update_select_type')
        .setPlaceholder('Seleziona Tipo...')
        .addOptions(
            types.map(t => new StringSelectMenuOptionBuilder()
                .setLabel(t)
                .setValue(t)
                .setEmoji(ICONS[t] || '⚔️')
                .setDefault(t === current)
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Aggiorna Tipo di ${faction.name}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'faction_update_select_type'
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newVal = i.values[0];
        factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, { type: newVal as any });

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_faction_update_again_type')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ Tipo di **${faction.name}** aggiornato a **${newVal}**!`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_faction_update_again_type' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const freshFaction = factionRepository.getFaction(ctx.activeCampaign!.id, faction.name);
            if (freshFaction) await showFieldSelection(btn, freshFaction, ctx);
            else await btn.reply({ content: "❌ Errore reload fazione.", ephemeral: true });
        });
    });
}

async function showStatusSelection(interaction: any, faction: any, ctx: CommandContext) {
    const statuses = ['ACTIVE', 'DISBANDED', 'DESTROYED'];

    const select = new StringSelectMenuBuilder()
        .setCustomId('faction_update_select_status')
        .setPlaceholder('Seleziona Status...')
        .addOptions(
            statuses.map(s => new StringSelectMenuOptionBuilder()
                .setLabel(s)
                .setValue(s)
                .setDefault(s === faction.status)
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Aggiorna Status di ${faction.name}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'faction_update_select_status'
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newVal = i.values[0];
        factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, { status: newVal as any });

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_faction_update_again_status')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ Status di **${faction.name}** aggiornato a **${newVal}**!`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_faction_update_again_status' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const freshFaction = factionRepository.getFaction(ctx.activeCampaign!.id, faction.name);
            if (freshFaction) await showFieldSelection(btn, freshFaction, ctx);
            else await btn.reply({ content: "❌ Errore reload fazione.", ephemeral: true });
        });
    });
}

async function showAlignmentSelection(interaction: any, faction: any, type: 'moral' | 'ethical', ctx: CommandContext) {
    const options = type === 'moral'
        ? ['GOOD', 'NEUTRAL', 'EVIL']
        : ['LAWFUL', 'NEUTRAL', 'CHAOTIC'];

    const currentVal = type === 'moral' ? faction.alignment_moral : faction.alignment_ethical;

    const select = new StringSelectMenuBuilder()
        .setCustomId(`faction_update_select_align_${type}`)
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
        content: `**Aggiorna Allineamento ${type === 'moral' ? 'Morale' : 'Etico'} di ${faction.name}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === `faction_update_select_align_${type}`
    });

    collector.on('collect', async (i: any) => {
        collector.stop();
        const newVal = i.values[0];
        const update = type === 'moral' ? { alignment_moral: newVal } : { alignment_ethical: newVal };

        factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, update);

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_faction_update_again_align')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await i.update({
            content: `✅ Allineamento di **${faction.name}** aggiornato a **${newVal}**!`,
            components: [updateAgainRow]
        });

        const btnCollector = i.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_faction_update_again_align' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            const freshFaction = factionRepository.getFaction(ctx.activeCampaign!.id, faction.name);
            if (freshFaction) await showFieldSelection(btn, freshFaction, ctx);
            else await btn.reply({ content: "❌ Errore reload fazione.", ephemeral: true });
        });
    });
}

async function showTextModal(interaction: any, faction: any, field: string, ctx: CommandContext) {
    const modalId = `modal_faction_update_${field}_${Date.now()}`;
    const baseTitle = `Modifica ${field.toUpperCase()}: ${faction.name}`;
    const title = baseTitle.length > 45 ? baseTitle.substring(0, 42) + '...' : baseTitle;

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(title);

    let currentValue = '';
    let label = `Nuovo valore per ${field}`;

    if (field === 'name') currentValue = faction.name;
    else if (field === 'description') currentValue = faction.description || '';
    else if (field === 'leader') {
        const leader = faction.leader_npc_id
            ? npcRepository.getNpcEntry(ctx.activeCampaign!.id, faction.leader_npc_id as any)?.name
            : '';
        currentValue = leader || '';
        label = "Nome o ID dell'NPC Leader";
    }
    else if (field === 'hq') {
        // Try to get current hq short id or name
        if (faction.headquarters_location_id) {
            const hq = locationRepository.getAtlasEntryById(ctx.activeCampaign!.id, faction.headquarters_location_id);
            if (hq) currentValue = `#${hq.short_id}`;
        }
        label = "Nome o Short ID (#abc12) della Sede";
    }

    const input = new TextInputBuilder()
        .setCustomId('input_value')
        .setLabel(label)
        .setStyle(field === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setValue(currentValue)
        .setRequired(field !== 'description' && field !== 'leader' && field !== 'hq');

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => i.customId === modalId && i.user.id === interaction.user.id
        });

        const newValue = submission.fields.getTextInputValue('input_value');
        let updates: any = {};
        let successMsg = "";

        if (field === 'name') {
            const renamed = factionRepository.renameFaction(ctx.activeCampaign!.id, faction.name, newValue);
            if (!renamed) {
                await submission.reply({ content: "❌ Errore durante la rinomina (nome duplicato?).", ephemeral: true });
                return;
            }
            successMsg = `Fazione rinominata in **${newValue}**.`;
        } else if (field === 'description') {
            updates.description = newValue;
            factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, updates);
            successMsg = "Descrizione aggiornata.";
        } else if (field === 'leader') {
            const rawName = newValue.trim();
            if (!rawName) {
                updates.leader_npc_id = null;
                successMsg = "Leader rimosso.";
            } else {
                let npc = npcRepository.getNpcEntry(ctx.activeCampaign!.id, rawName);
                if (!npc && rawName.match(/^\d+$/)) {
                    // check numeric? not supported by basic get
                    // For now assume name or existing lookup logic
                }

                if (!npc) {
                    await submission.reply({ content: `❌ NPC "${rawName}" non trovato.`, ephemeral: true });
                    return;
                }
                updates.leader_npc_id = npc.id;
                successMsg = `Leader impostato su **${npc.name}**.`;
            }
            factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, updates);
        } else if (field === 'hq') {
            const rawVal = newValue.trim();
            if (!rawVal) {
                updates.headquarters_location_id = null;
                successMsg = "Sede rimossa.";
            } else {
                let loc;
                const sidMatch = rawVal.match(/^#?([a-z0-9]{5})$/i);
                if (sidMatch) {
                    loc = locationRepository.getAtlasEntryByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                }
                if (!loc) {
                    // try name match approx?
                    const all = locationRepository.listAllAtlasEntries(ctx.activeCampaign!.id);
                    loc = all.find(l =>
                        l.micro_location?.toLowerCase() === rawVal.toLowerCase() ||
                        l.macro_location?.toLowerCase() === rawVal.toLowerCase()
                    );
                }

                if (!loc) {
                    await submission.reply({ content: `❌ Luogo "${rawVal}" non trovato.`, ephemeral: true });
                    return;
                }
                updates.headquarters_location_id = loc.id;
                successMsg = `Sede impostata su **${loc.micro_location || loc.macro_location}**.`;
            }
            factionRepository.updateFaction(ctx.activeCampaign!.id, faction.name, updates);
        }

        const updateAgainRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_faction_update_again_text')
                    .setLabel('Modifica Ancora')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        await submission.reply({
            content: `✅ **Aggiornato!** ${successMsg}`,
            ephemeral: false,
            components: [updateAgainRow]
        });

        const msg = await submission.fetchReply();
        const btnCollector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: (btn: any) => btn.customId === 'btn_faction_update_again_text' && btn.user.id === interaction.user.id
        });
        btnCollector.on('collect', async (btn: any) => {
            btnCollector.stop();
            if (field === 'name') {
                // Reload if renamed
                const loaded = factionRepository.getFaction(ctx.activeCampaign!.id, newValue);
                if (loaded) await showFieldSelection(btn, loaded, ctx);
                else await btn.reply({ content: "Errore reload fazione", ephemeral: true });
            } else {
                const freshFaction = factionRepository.getFaction(ctx.activeCampaign!.id, faction.name);
                if (freshFaction) await showFieldSelection(btn, freshFaction, ctx);
                else await btn.reply({ content: "❌ Errore reload fazione.", ephemeral: true });
            }
        });

        try { await interaction.message.edit({ components: [] }); } catch (e) { }

    } catch (e) {
        // timeout
    }
}
