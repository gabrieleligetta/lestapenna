import { Command, CommandContext } from '../types';
import { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, EmbedBuilder } from 'discord.js';
import { db, getCampaigns } from '../../db';
import {
    syncAllDirtyNpcs,
    syncAllDirtyAtlas,
    syncAllDirtyTimeline,
    syncAllDirtyCharacters,
    syncAllDirtyBestiary,
    syncAllDirtyInventory,
    syncAllDirtyQuests,
    syncAllDirtyFactions,
    syncAllDirtyArtifacts
} from '../../bard/sync';
import { t } from '../../i18n';

export const syncCommand: Command = {
    name: 'sync',
    category: 'dev',
    descriptionKey: 'help.cmd.sync',
    aliases: ['sincronizza'],
    requiresCampaign: false, // We handle campaign selection manually
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const author = message.author;

        // 1. Campaign Selection
        // Only THIS guild's campaigns: the query used to be global, so from any
        // command channel you could see — and touch — the campaigns of other
        // servers.
        const campaigns = getCampaigns(ctx.guildId).map((c) => ({ id: c.id, name: c.name }));

        if (campaigns.length === 0) {
            await message.reply(t(ctx.locale, 'admin.noCampaignsDb'));
            return;
        }

        let targetCampaignId: number | null = null;
        let targetCampaignName: string | null = null;

        // If only 1 campaign, suggest it but still allow confirm/select logic? 
        // Or just prompt user to select.

        const campaignOptions = campaigns.map(c =>
            new StringSelectMenuOptionBuilder()
                .setLabel(c.name)
                .setValue(c.id.toString())
                .setDescription(`ID: ${c.id}`)
        );

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('sync_campaign_select')
            .setPlaceholder(t(ctx.locale, 'admin.syncSelectPlaceholder'))
            .addOptions(campaignOptions);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        const reply = await message.reply({
            content: t(ctx.locale, 'admin.syncSelectPrompt'),
            components: [row]
        });

        try {
            const selection = await reply.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                filter: i => i.user.id === author.id,
                time: 60000
            });

            targetCampaignId = parseInt(selection.values[0]);
            targetCampaignName = campaigns.find(c => c.id === targetCampaignId)?.name || t(ctx.locale, 'char.unknown');

            await selection.update({
                content: t(ctx.locale, 'admin.syncStarted', { campaign: targetCampaignName }),
                components: []
            });

        } catch (e) {
            await reply.edit({ content: t(ctx.locale, 'admin.timeoutCancelled'), components: [] });
            return;
        }

        if (!targetCampaignId) return;

        // 2. Execute Sync
        const start = Date.now();

        try {
            // Run all syncs
            // We expect all these functions to return number (count of synced items).
            // If any returns an object, we cast or extract the count.

            const rNpc = await syncAllDirtyNpcs(targetCampaignId);
            const rAtlas = await syncAllDirtyAtlas(targetCampaignId);
            const rTimeline = await syncAllDirtyTimeline(targetCampaignId);

            // Character sync might return complex object? Checking...
            const rCharRaw: any = await syncAllDirtyCharacters(targetCampaignId);
            const rChar = typeof rCharRaw === 'number' ? rCharRaw : (rCharRaw?.synced || 0);

            const rBestiary = await syncAllDirtyBestiary(targetCampaignId);
            const rInventory = await syncAllDirtyInventory(targetCampaignId);
            const rQuest = await syncAllDirtyQuests(targetCampaignId);
            const rFaction = await syncAllDirtyFactions(targetCampaignId);
            const rArtifact = await syncAllDirtyArtifacts(targetCampaignId);

            const duration = ((Date.now() - start) / 1000).toFixed(1);
            const total = rNpc + rAtlas + rTimeline + rChar + rBestiary + rInventory + rQuest + rFaction + rArtifact;

            const embed = new EmbedBuilder()
                .setTitle(t(ctx.locale, 'admin.syncCompleteTitle'))
                .setDescription(t(ctx.locale, 'admin.syncCompleteDesc', { campaign: targetCampaignName, duration }))
                .setColor("#00FF00")
                .addFields(
                    { name: t(ctx.locale, 'admin.syncUpdated'), value: total.toString(), inline: false },
                    {
                        name: t(ctx.locale, 'admin.details'),
                        value: t(ctx.locale, 'admin.syncDetails', {
                            npcs: rNpc, places: rAtlas, timeline: rTimeline,
                            characters: rChar, bestiary: rBestiary, inventory: rInventory,
                            quests: rQuest, factions: rFaction, artifacts: rArtifact,
                        })
                    }
                )
                .setFooter({ text: t(ctx.locale, 'admin.syncFooter') });

            await reply.edit({ content: '', embeds: [embed] });

        } catch (error: any) {
            console.error(`[Sync] Errore critico:`, error);
            await reply.edit({ content: t(ctx.locale, 'admin.syncError', { message: error.message }) });
        }
    }
};
