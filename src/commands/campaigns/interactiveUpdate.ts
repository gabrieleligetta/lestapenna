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
import { promptCampaignLanguage } from '../utils/campaignLanguage';
import {
    getCampaigns,
    setActiveCampaign
} from '../../db';
import { createCampaignWithParty } from '../../services/campaignSetup';
import { t } from '../../i18n';

export async function startInteractiveCampaignCreate(ctx: CommandContext) {
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('btn_trigger_campaign_create')
                .setLabel(t(ctx.locale, 'campaign.createButton'))
                .setStyle(ButtonStyle.Success)
                .setEmoji('✨')
        );

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'campaign.createPrompt'),
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
            .setTitle(t(ctx.locale, 'campaign.createModalTitle'));

        const nameInput = new TextInputBuilder()
            .setCustomId('campaign_name')
            .setLabel(t(ctx.locale, 'campaign.nameLabel'))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(t(ctx.locale, 'campaign.namePlaceholder'))
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));

        await interaction.showModal(modal);

        try {
            const submission = await interaction.awaitModalSubmit({
                time: 300000,
                filter: (i) => i.customId === 'modal_campaign_create' && i.user.id === interaction.user.id
            });

            const name = submission.fields.getTextInputValue('campaign_name');

            // Campaign + party faction + enrolling the creator as MASTER.
            const campaign = createCampaignWithParty({
                guildId: ctx.guildId,
                name,
                creatorUserId: ctx.message.author.id,
            });
            if (campaign) {
                // Optional: Auto-select? The user usually wants to select it.
                // Let's offer a button to select it immediately.
                const selectRow = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`btn_select_created_${campaign.id}`)
                            .setLabel(t(ctx.locale, 'campaign.activateNow'))
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('✅')
                    );

                await submission.reply({
                    content: t(ctx.locale, 'campaign.createdAskActivate', { name }),
                    components: [selectRow]
                });

                const selectCollector = (await submission.fetchReply()).createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 60000,
                    filter: (i) => i.customId === `btn_select_created_${campaign.id}` && i.user.id === ctx.message.author.id
                });

                selectCollector.on('collect', async (i) => {
                    setActiveCampaign(ctx.guildId, campaign.id);
                    await i.update({ content: t(ctx.locale, 'campaign.activatedJourney', { name }), components: [] });
                });

                // 🆕 The campaign's spoken language (transcription + summaries);
                // on timeout it inherits the guild's language.
                const createdMsg = await submission.fetchReply();
                promptCampaignLanguage(createdMsg, ctx.locale, campaign.id, name, ctx.message.author.id)
                    .catch(() => { });

            } else {
                await submission.reply({ content: t(ctx.locale, 'campaign.createdShort', { name }) });
            }

            try { await reply.delete(); } catch { }

        } catch (err) { }
    });
}

export async function startInteractiveCampaignSelect(ctx: CommandContext) {
    const campaigns = getCampaigns(ctx.guildId);

    if (campaigns.length === 0) {
        await ctx.message.reply(t(ctx.locale, 'campaign.noneInteractive'));
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
        .setPlaceholder(t(ctx.locale, 'campaign.selectActive'))
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'campaign.selectPrompt'),
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
                content: t(ctx.locale, 'campaign.activeSetReady', { name: campaign.name }),
                components: []
            });
        }
    });
}
