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
    CommandInteraction,
    Interaction
} from 'discord.js';
import {
    listAtlasEntries,
    updateLocation,
    getAtlasEntryFull,
    updateAtlasEntry,
    setCampaignYear,
    addWorldEvent,
    factionRepository
} from '../../db';

export async function startWorldConfigurationFlow(
    target: Message | ButtonInteraction | CommandInteraction,
    campaignId: number,
    partyFaction: any
) {
    const existingLocations = listAtlasEntries(campaignId, 24, 0);
    const userId = (target instanceof Message) ? target.author.id : target.user.id;

    if (existingLocations.length > 0) {
        // OFFER SELECTION
        const options = existingLocations.map((loc: any) =>
            new StringSelectMenuOptionBuilder()
                .setLabel(`${loc.macro_location} | ${loc.micro_location}`.substring(0, 100))
                .setValue(`${loc.id}`)
                .setDescription(loc.description ? loc.description.substring(0, 50) : "Nessuna descrizione")
                .setEmoji('📍')
        );

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_config_loc')
            .setPlaceholder('Seleziona un luogo esistente...')
            .addOptions(options);

        const btnNew = new ButtonBuilder()
            .setCustomId('btn_conf_new_loc')
            .setLabel('Crea Nuova Posizione')
            .setStyle(ButtonStyle.Success)
            .setEmoji('➕');

        const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        const rowBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(btnNew);

        const content = "**Configurazione Mondo**\nScegli un luogo esistente per iniziare, oppure creane uno nuovo.";

        let response;
        if (target instanceof Message) {
            response = await target.reply({ content, components: [rowSelect, rowBtn] });
        } else {
            // Interaction: use reply (ephemeral true if it's a button click from listener to keep chat clean?)
            // If it's a command interaction (slash), ephemeral depends. 
            // For now, let's say ephemeral true for button clicks to avoid clutter.
            await target.reply({ content, components: [rowSelect, rowBtn], ephemeral: true });
            response = await target.fetchReply();
        }

        // Create collector on the channel (or message if possible, but fetchReply gives us the message)
        // If ephemeral, we can't create collector on message easily in some lib versions, but channel collector works if we filter by user

        const collector = target.channel?.createMessageComponentCollector({
            filter: (i) => i.user.id === userId && (i.customId === 'select_config_loc' || i.customId === 'btn_conf_new_loc'),
            time: 60000
        });

        if (!collector) return;

        collector.on('collect', async (subInt) => {
            if (subInt.customId === 'btn_conf_new_loc') {
                await showWorldConfigModal(subInt, campaignId, partyFaction?.name, true);
                collector.stop();
            } else if (subInt.isStringSelectMenu()) {
                const locId = parseInt(subInt.values[0]);
                const location = existingLocations.find((l: any) => l.id === locId);

                if (location) {
                    updateLocation(campaignId, location.macro_location, location.micro_location, 'SETUP');
                    console.log(`[Setup] 📍 Selezionato luogo esistente: ${location.macro_location} | ${location.micro_location}`);
                    await showWorldConfigModal(subInt, campaignId, partyFaction?.name, false);
                    collector.stop();
                }
            }
        });

    } else {
        // No existing locations -> straight to full modal
        // Note: We can't "reply" with a modal to a Message. We need a button or interaction.
        // If target is Message, we must send a button first.

        if (target instanceof Message) {
            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('btn_trigger_config_modal')
                        .setLabel('Apri Configurazione')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🛠️')
                );
            const msg = await target.reply({
                content: "**Configurazione Mondo**\nNessun luogo trovato. Clicca per creare il primo luogo e configurare il mondo.",
                components: [row]
            });

            const btnCollector = msg.createMessageComponentCollector({
                filter: (i) => i.customId === 'btn_trigger_config_modal' && i.user.id === userId,
                time: 60000,
                max: 1
            });

            btnCollector.on('collect', async (i) => {
                await showWorldConfigModal(i, campaignId, partyFaction?.name, true);
            });

        } else {
            // It's an interaction, we can show modal directly?
            // Yes, if it hasn't been replied to yet. 
            // BUT if startWorldConfigurationFlow was called with a reply already...
            // If target is ButtonInteraction from Listen command, it hasn't been replied to (we usually reply in the collected hook).
            // Actually in listen.ts we might have just clicked.

            // Wait, if we use `target.reply` earlier for locations > 0, we can't show modal there?
            // No, for locations > 0 we sent a menu.
            // For locations == 0, we want to show modal directly.

            await showWorldConfigModal(target as any, campaignId, partyFaction?.name, true);
        }
    }
}

export async function showWorldConfigModal(
    interaction: any, // ButtonInteraction | StringSelectMenuInteraction ...
    campaignId: number,
    currentPartyName: string | undefined,
    includeLocation: boolean
) {
    const modalId = includeLocation ? 'modal_world_config_full' : 'modal_world_config_partial';

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle("Configurazione Iniziale");

    const year0Input = new TextInputBuilder()
        .setCustomId('year0_event')
        .setLabel("Evento Anno 0 (es. Caduta Impero)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("La Grande Frattura")
        .setRequired(true);

    const currentYearInput = new TextInputBuilder()
        .setCustomId('current_year')
        .setLabel("Anno Corrente")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("1247")
        .setRequired(true);

    const partyNameInput = new TextInputBuilder()
        .setCustomId('party_name')
        .setLabel("Nome del Party")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("I Cavalieri dell'Alba")
        .setValue(currentPartyName || "")
        .setRequired(true);

    const rows = [
        new ActionRowBuilder<TextInputBuilder>().addComponents(year0Input),
        new ActionRowBuilder<TextInputBuilder>().addComponents(currentYearInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(partyNameInput)
    ];

    if (includeLocation) {
        const locationInput = new TextInputBuilder()
            .setCustomId('location')
            .setLabel("Luogo Iniziale (Macro | Micro)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Waterdeep | Taverna del Portale")
            .setRequired(true);
        rows.splice(2, 0, new ActionRowBuilder<TextInputBuilder>().addComponents(locationInput));
    }

    modal.addComponents(rows);

    await interaction.showModal(modal);

    try {
        const submission = await interaction.awaitModalSubmit({
            time: 300000,
            filter: (i: any) => (i.customId === 'modal_world_config_full' || i.customId === 'modal_world_config_partial') && i.user.id === interaction.user.id
        });

        const year0Desc = submission.fields.getTextInputValue('year0_event');
        const yearVal = parseInt(submission.fields.getTextInputValue('current_year'));
        const pName = submission.fields.getTextInputValue('party_name');

        if (isNaN(yearVal)) {
            await submission.reply({ content: "❌ L'anno deve essere un numero!", ephemeral: true });
            return;
        }

        // 1. Set Years & Event
        setCampaignYear(campaignId, yearVal);
        addWorldEvent(campaignId, null, year0Desc, 'GENERIC', 0, true);

        // 2. Set Location (Only if Full Modal)
        if (includeLocation) {
            const locVal = submission.fields.getTextInputValue('location');
            let mac = null, mic = null;
            if (locVal.includes('|')) {
                const p = locVal.split('|').map((s: string) => s.trim());
                mac = p[0]; mic = p[1];
            } else {
                mic = locVal.trim();
            }

            if (mac && mic) {
                const existingLoc = getAtlasEntryFull(campaignId, mac, mic);
                if (!existingLoc) {
                    updateAtlasEntry(campaignId, mac, mic, "Posizione iniziale della campagna.", 'SETUP', true);
                    console.log(`[Setup] 🗺️ Creata nuova location Atlas: ${mac} | ${mic}`);
                }
            }
            updateLocation(campaignId, mac, mic, 'SETUP');
        }

        // 3. Set Party Name
        const partyFaction = factionRepository.getPartyFaction(campaignId);
        if (partyFaction) {
            factionRepository.renameFaction(campaignId, partyFaction.name, pName);
        } else {
            factionRepository.createPartyFaction(campaignId, pName);
        }

        await submission.reply({
            content: `✅ **Mondo Configurato!**\n📅 Anno: ${yearVal}\n⚔️ Party: ${pName}\n\nConfigurazione completata con successo!`,
            components: []
        });

    } catch (e) {
        // Modal timeout
    }
}
