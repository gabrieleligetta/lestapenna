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
    getNpcEntry,
    markNpcDirty,
    factionRepository
} from '../../db';

export async function startInteractiveNpcUpdate(ctx: CommandContext) {
    // 1. Fetch NPCs for selection (Limit 25 for Select Menu)
    const npcs = listNpcs(ctx.activeCampaign!.id, 25, 0);

    if (npcs.length === 0) {
        await ctx.message.reply("⚠️ Nessun NPC disponibile per l'aggiornamento.");
        return;
    }

    // 2. Build NPC Select Menu
    const npcSelect = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_entity')
        .setPlaceholder('🔍 Seleziona un NPC da modificare...')
        .addOptions(
            npcs.map((n: any) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(n.name)
                    .setDescription(n.role ? n.role.substring(0, 100) : 'Nessun ruolo')
                    .setValue(n.name) // Using name as ID for simplicity in this system
                    .setEmoji(n.status === 'DEAD' ? '💀' : n.status === 'MISSING' ? '❓' : '👤')
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(npcSelect);

    const response = await ctx.message.reply({
        content: "**🛠️ Aggiornamento NPC Interattivo**\nSeleziona un personaggio dalla lista:",
        components: [row]
    });

    // 3. Collector for NPC Selection
    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: i => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async interaction => {
        if (interaction.customId === 'npc_update_select_entity') {
            const selectedNpcName = interaction.values[0];
            const npc = getNpcEntry(ctx.activeCampaign!.id, selectedNpcName);

            if (!npc) {
                await interaction.reply({ content: `❌ Errore: NPC ${selectedNpcName} non trovato.`, ephemeral: true });
                return;
            }

            // 4. Show Field Selection
            await showFieldSelection(interaction, npc, ctx);
        }
    });
}

async function showFieldSelection(interaction: any, npc: any, ctx: CommandContext) {
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

    await interaction.update({
        content: `**🛠️ Modifica di ${npc.name}**\nCosa vuoi aggiornare?`,
        components: [row]
    });

    // Create a new collector for this interaction's channel to handle subsequent steps
    // Note: We need a collector attached to the message, which we updated. 
    // Since 'interaction.update' doesn't return the message, we use the message from the interaction.
    const message = interaction.message;

    const fieldCollector = message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'npc_update_select_field'
    });

    fieldCollector.on('collect', async (i: any) => {
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
        const newStatus = i.values[0];
        updateNpcFields(ctx.activeCampaign!.id, npc.name, { status: newStatus });
        markNpcDirty(ctx.activeCampaign!.id, npc.name);

        await i.update({
            content: `✅ Staus di **${npc.name}** aggiornato a **${newStatus}**!`,
            components: []
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
        const newVal = i.values[0];
        const update = type === 'moral' ? { alignment_moral: newVal } : { alignment_ethical: newVal };

        updateNpcFields(ctx.activeCampaign!.id, npc.name, update);
        markNpcDirty(ctx.activeCampaign!.id, npc.name);

        await i.update({
            content: `✅ Allineamento di **${npc.name}** aggiornato a **${newVal}**!`,
            components: []
        });
    });
}

async function showTextModal(interaction: any, npc: any, field: string, ctx: CommandContext) {
    const modalId = `modal_update_${field}_${Date.now()}`; // Unique ID to avoid conflicts
    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`Modifica ${field.charAt(0).toUpperCase() + field.slice(1)}`);

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

    // Modal submit interaction needs to be handled on the client level or via awaiting submission here?
    // interaction.showModal DOES NOT return a promise that resolves with the submission.
    // We must wait for the modal submission.

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

        await submission.reply({
            content: `✅ **${npc.name}** aggiornato!\n${field}: ${newValue}`,
            ephemeral: false
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
    const factions = factionRepository.listFactions(ctx.activeCampaign!.id, true);

    if (factions.length === 0) {
        // No factions exist, maybe offer to create one via modal? 
        // For now, simpler to just say no factions.
        await interaction.update({
            content: "⚠️ Nessuna fazione trovata. Usa `$faction create` per crearne una prima.",
            components: []
        });
        return;
    }

    const factionOptions = factions.slice(0, 24).map(f =>
        new StringSelectMenuOptionBuilder()
            .setLabel(f.name)
            .setValue(f.id.toString())
            .setDescription(f.description ? f.description.substring(0, 50) : "Nessuna descrizione")
            .setEmoji(f.is_party ? '🛡️' : '⚔️')
    );

    // Add option for "New Faction" if space permits
    factionOptions.push(
        new StringSelectMenuOptionBuilder()
            .setLabel("➕ Crea Nuova Fazione")
            .setValue("NEW_FACTION")
            .setEmoji("✨")
            .setDescription("Crea e affilia a una nuova fazione")
    );

    const select = new StringSelectMenuBuilder()
        .setCustomId('npc_update_select_faction')
        .setPlaceholder('Seleziona Fazione...')
        .addOptions(factionOptions);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.update({
        content: `**Affiliazione: Seleziona Fazione per ${npc.name}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'npc_update_select_faction'
    });

    collector.on('collect', async (i: any) => {
        const selectedValue = i.values[0];

        if (selectedValue === 'NEW_FACTION') {
            // Fallback to Modal for creation
            await showFactionModal(i, npc, ctx);
        } else {
            const factionId = parseInt(selectedValue);
            const faction = factions.find(f => f.id === factionId);
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
        content: `**Ruolo di ${npc.name} in ${faction.name}**`,
        components: [row]
    });

    const collector = interaction.message.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i: any) => i.user.id === interaction.user.id && i.customId === 'npc_update_select_faction_role'
    });

    collector.on('collect', async (i: any) => {
        const role = i.values[0];

        factionRepository.addAffiliation(faction.id, 'npc', npc.id, {
            role: role as any,
            notes: "Interactive Update"
        });
        markNpcDirty(ctx.activeCampaign!.id, npc.name);

        await i.update({
            content: `✅ **${npc.name}** ora affiliato a **${faction.name}** come **${role}**.`,
            components: []
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

            await submission.reply({
                content: `✅ **${npc.name}** ora affiliato a **${faction.name}** come **${role}**.`,
                ephemeral: false
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
