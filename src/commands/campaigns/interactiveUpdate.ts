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
    Message
} from 'discord.js';
import { CommandContext } from '../types';
import {
    createCampaign,
    getCampaigns,
    setActiveCampaign,
    factionRepository
} from '../../db';

export async function startInteractiveCampaignCreate(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_campaign_create')
                .setLabel('Crea Nuova Campagna')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✨')
        );

    const reply = await ctx.message.reply({
        content: "**🆕 Nuova Avventura**\nClicca sul bottone per dare un nome alla tua prossima campagna!",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
        filter: (i) => i.customId === 'btn_trigger_campaign_create' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const modal = new ModalBuilder()
            .setCustomId('modal_campaign_create')
            .setTitle("Nuova Campagna");

        const nameInput = new TextInputBuilder()
            .setCustomId('campaign_name')
            .setLabel("Nome della Campagna")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Es: Le Cronache di Eldoria")
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === 'modal_campaign_create' && i.user.id === interaction.user.id
            });

            const name = submission.fields.getTextInputValue('campaign_name');

            // 1. Create Campaign
            createCampaign(ctx.guildId, name);

            // 2. Setup Party Faction
            const campaigns = getCampaigns(ctx.guildId);
            const campaign = campaigns.find(c => c.name === name);
            if (campaign) {
                factionRepository.createPartyFaction(campaign.id);

                // Optional: Auto-select? The user usually wants to select it.
                // Let's offer a button to select it immediately.
                const selectRow = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`btn_select_created_${campaign.id}`)
                            .setLabel('Attiva Ora')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('✅')
                    );

                await submission.reply({
                    content: `🎊 **Campagna "${name}" creata con successo!**\nVuoi attivarla immediatamente?`,
                    components: [selectRow]
                });

                const selectCollector = (await submission.fetchReply()).createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 60000,
                    filter: (i) => i.customId === `btn_select_created_${campaign.id}` && i.user.id === ctx.message.author.id
                });

                selectCollector.on('collect', async (i) => {
                    setActiveCampaign(ctx.guildId, campaign.id);
                    await i.update({ content: `✅ Campagna **${name}** ora attiva! Buon viaggio, DM.`, components: [] });
                });

            } else {
                await submission.reply({ content: `✅ Campagna **${name}** creata!` });
            }

            try { await reply.delete(); } catch { }

        } catch (err) { }
    });
}

export async function startInteractiveCampaignSelect(ctx: CommandContext) {
    const campaigns = getCampaigns(ctx.guildId);

    if (campaigns.length === 0) {
        await ctx.message.reply("⚠️ Non ci sono campagne in questo server. Usa `$creacampagna` per iniziare!");
        return;
    }

    const options = campaigns.map(c =>
        new StringSelectMenuOptionBuilder()
            .setLabel(c.name)
            .setValue(c.id.toString())
            .setDescription(`ID: ${c.id}`)
            .setEmoji('📜')
    );

    const select = new StringSelectMenuBuilder()
        .setCustomId('select_campaign_active')
        .setPlaceholder('Scegli la campagna attiva...')
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const reply = await ctx.message.reply({
        content: "**🧭 Selezione Campagna**\nQuale cronaca vuoi continuare oggi?",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_campaign_active' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const campaignId = parseInt(interaction.values[0]);
        const campaign = campaigns.find(c => c.id === campaignId);

        if (campaign) {
            setActiveCampaign(ctx.guildId, campaign.id);
            await interaction.update({
                content: `✅ Campagna attiva impostata su: **${campaign.name}**.\nI bardi sono pronti ad ascoltare.`,
                components: []
            });
        }
    });
}
