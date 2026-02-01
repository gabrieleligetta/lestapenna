import { Command, CommandContext } from '../types';
import { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, EmbedBuilder } from 'discord.js';
import { db } from '../../db';
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

export const syncCommand: Command = {
    name: 'sync',
    aliases: ['sincronizza'],
    requiresCampaign: false, // We handle campaign selection manually

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const author = message.author;

        // 1. Campaign Selection
        const campaigns = db.prepare('SELECT id, name FROM campaigns').all() as { id: number; name: string }[];

        if (campaigns.length === 0) {
            await message.reply("❌ Nessuna campagna trovata nel database.");
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
            .setPlaceholder('Seleziona la campagna da sincronizzare')
            .addOptions(campaignOptions);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        const reply = await message.reply({
            content: '🔄 **Sincronizzazione RAG**\nSeleziona la campagna per cui vuoi avviare la sincronizzazione delle entità modificate ("dirty"):',
            components: [row]
        });

        try {
            const selection = await reply.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                filter: i => i.user.id === author.id,
                time: 60000
            });

            targetCampaignId = parseInt(selection.values[0]);
            targetCampaignName = campaigns.find(c => c.id === targetCampaignId)?.name || "Sconosciuta";

            await selection.update({
                content: `⏳ **Sincronizzazione avviata** per campagna: **${targetCampaignName}**...\nAttendere prego...`,
                components: []
            });

        } catch (e) {
            await reply.edit({ content: '⌛ Tempo scaduto. Comando annullato.', components: [] });
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
                .setTitle(`✅ Sincronizzazione Completata`)
                .setDescription(`Campagna: **${targetCampaignName}**\nTempo: ${duration}s`)
                .setColor("#00FF00")
                .addFields(
                    { name: 'Entità Aggiornate', value: total.toString(), inline: false },
                    {
                        name: 'Dettagli', value:
                            `👤 NPC: **${rNpc}**\n` +
                            `🌍 Luoghi: **${rAtlas}**\n` +
                            `⏳ Timeline: **${rTimeline}**\n` +
                            `🧙 Personaggi: **${rChar}**\n` +
                            `🐉 Bestiario: **${rBestiary}**\n` +
                            `🎒 Inventario: **${rInventory}**\n` +
                            `📜 Quest: **${rQuest}**\n` +
                            `⚔️ Fazioni: **${rFaction}**\n` +
                            `🔮 Artefatti: **${rArtifact}**`
                    }
                )
                .setFooter({ text: "Il RAG è ora aggiornato con le ultime modifiche." });

            await reply.edit({ content: '', embeds: [embed] });

        } catch (error: any) {
            console.error(`[Sync] Errore critico:`, error);
            await reply.edit({ content: `❌ **Errore durante la sincronizzazione:**\n${error.message}` });
        }
    }
};
