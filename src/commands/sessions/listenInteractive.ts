import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    Message,
    ButtonInteraction,
    MessageComponentInteraction,
    CommandInteraction
} from 'discord.js';
import {
    listAtlasEntries,
    updateLocation,
    getAtlasEntryFull,
    updateAtlasEntry
} from '../../db';
import { CommandContext } from '../types';

/**
 * Starts the interactive location selection flow for the session.
 * This is triggered when $listen is called without arguments and no location is set.
 */
export async function startInteractiveLocationSelection(
    ctx: CommandContext,
    onLocationSelected: (macro: string, micro: string) => Promise<void>
) {
    const campaignId = ctx.activeCampaign!.id;
    const existingLocations = listAtlasEntries(campaignId, 25, 0); // Get top 25 locations
    const userId = ctx.message.author.id;

    // 1. Prepare UI Components
    const rows: ActionRowBuilder<any>[] = [];

    // Dropdown for existing locations (if any)
    if (existingLocations.length > 0) {
        const options = existingLocations.map((loc: any) =>
            new StringSelectMenuOptionBuilder()
                .setLabel(`${loc.macro_location} | ${loc.micro_location}`.substring(0, 100))
                .setValue(`${loc.macro_location}|${loc.micro_location}`) // Pass both as value
                .setDescription(loc.description ? loc.description.substring(0, 50) : "Nessuna descrizione")
                .setEmoji('📍')
        );

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_session_loc')
            .setPlaceholder('📍 Seleziona un luogo recente...')
            .addOptions(options);

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
    }

    // Button to create new location
    const btnNew = new ButtonBuilder()
        .setCustomId('btn_new_session_loc')
        .setLabel('✨ Crea Nuovo Luogo')
        .setStyle(ButtonStyle.Success);

    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btnNew));

    const content = existingLocations.length > 0
        ? "🌍 **Dove vi trovate?**\nSeleziona un luogo conosciuto o creane uno nuovo per iniziare la sessione."
        : "🌍 **Dove vi trovate?**\nNon ci sono luoghi registrati. Crea il primo luogo per iniziare!";

    const reply = await ctx.message.reply({
        content,
        components: rows
    });

    // 2. Setup Collector
    const collector = reply.createMessageComponentCollector({
        filter: (i: MessageComponentInteraction) => {
            if (i.user.id !== userId) {
                i.reply({ content: "Solo chi ha invocato il comando può scegliere.", ephemeral: true });
                return false;
            }
            return true;
        },
        time: 60000
    });

    collector.on('collect', async (interaction: MessageComponentInteraction) => {
        if (interaction.customId === 'select_session_loc' && interaction.isStringSelectMenu()) {
            // Existing Location Selected
            const [macro, micro] = interaction.values[0].split('|');
            await interaction.update({ content: `✅ Scelto: **${macro}** | **${micro}**`, components: [] });

            // Invoke callback
            await onLocationSelected(macro, micro);
            collector.stop('selected');

        } else if (interaction.customId === 'btn_new_session_loc') {
            // New Location Requested -> Show Modal
            await showNewLocationModal(interaction, campaignId, async (macro, micro) => {
                await interaction.editReply({ content: `✅ Creato e scelto: **${macro}** | **${micro}**`, components: [] });
                await onLocationSelected(macro, micro);
                collector.stop('created');
            });
        }
    });

    collector.on('end', (_collected: any, reason: string) => {
        if (reason !== 'selected' && reason !== 'created') {
            reply.edit({ content: "⏱️ Tempo scaduto. Sessione non iniziata.", components: [] }).catch(() => { });
        }
    });
}

async function showNewLocationModal(
    interaction: MessageComponentInteraction,
    campaignId: number,
    onSuccess: (macro: string, micro: string) => Promise<void>
) {
    const modal = new ModalBuilder()
        .setCustomId('modal_new_session_loc')
        .setTitle("Nuovo Luogo Sessione");

    const macroInput = new TextInputBuilder()
        .setCustomId('macro_loc')
        .setLabel("Macro Luogo (es. Città, Regione)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Waterdeep")
        .setRequired(true);

    const microInput = new TextInputBuilder()
        .setCustomId('micro_loc')
        .setLabel("Micro Luogo (es. Taverna, Stanza)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Il Portale Spalancato")
        .setRequired(true);

    const descInput = new TextInputBuilder()
        .setCustomId('loc_desc')
        .setLabel("Descrizione (Opzionale)")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Atmosfera, odori, dettagli...")
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
            filter: (i) => i.customId === 'modal_new_session_loc' && i.user.id === interaction.user.id
        });

        const macro = submission.fields.getTextInputValue('macro_loc').trim();
        const micro = submission.fields.getTextInputValue('micro_loc').trim();
        const desc = submission.fields.getTextInputValue('loc_desc').trim();

        // Save to Atlas if new
        const existing = getAtlasEntryFull(campaignId, macro, micro);
        if (!existing) {
            updateAtlasEntry(campaignId, macro, micro, desc || "Luogo creato all'avvio sessione", 'SESSION_START', true);
        } else if (desc) {
            // Update description if provided and wasn't there? Or just leave it. 
            // Let's safe-update if existing has no description
            if (!existing.description) {
                updateAtlasEntry(campaignId, macro, micro, desc, 'SESSION_UPDATE', true);
            }
        }

        await submission.deferUpdate(); // Acknowledge the modal submission
        await onSuccess(macro, micro);

    } catch (err) {
        // Timeout or error
    }
}
