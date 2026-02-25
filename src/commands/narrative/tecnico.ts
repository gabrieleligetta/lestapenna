import { EmbedBuilder, TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getAvailableSessions,
    getSessionCampaignId,
    getSessionEncounteredNPCs
} from '../../db';
import { PipelineService } from '../../publisher/services/PipelineService';
import { truncate } from '../../publisher/formatters';

export const tecnicoCommand: Command = {
    name: 'riepilogotecnico',
    aliases: ['tecnico', 'riepilogo'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign } = ctx;
        const channel = message.channel as TextChannel;

        const targetSessionId = args[0];

        if (!targetSessionId) {
            const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id);
            if (sessions.length === 0) {
                await message.reply("Nessuna sessione trovata per questa campagna.");
                return;
            }
            const list = sessions
                .slice(0, 10)
                .map(s => `🆔 \`${s.session_id}\`  📅 ${new Date(s.start_time).toLocaleString('it-IT')}`)
                .join('\n');
            const embed = new EmbedBuilder()
                .setTitle(`📋 Sessioni: ${activeCampaign?.name}`)
                .setDescription(list)
                .setFooter({ text: 'Uso: $riepilogo <sessionId>' });
            await message.reply({ embeds: [embed] });
            return;
        }

        const campaignId = getSessionCampaignId(targetSessionId) || activeCampaign?.id;
        if (!campaignId) {
            await message.reply(`❌ Impossibile trovare la campagna per la sessione \`${targetSessionId}\`.`);
            return;
        }

        const loadingMsg = await channel.send(`🎒 Caricamento riepilogo tecnico per \`${targetSessionId}\`...`);

        try {
            const pipelineService = new PipelineService();

            // Rehydrate summary data from DB (no AI calls)
            const result = await pipelineService.generateSessionSummary(
                targetSessionId,
                campaignId,
                'DM',
                { skipAnalysis: true }
            );

            const encounteredNPCs = getSessionEncounteredNPCs(targetSessionId);

            await loadingMsg.delete().catch(() => { });

            // Build and send only the technical summary embed
            const embed = new EmbedBuilder()
                .setColor("#F1C40F")
                .setTitle("🎒 Riepilogo Tecnico");

            // --- FULL-WIDTH ---
            const lootText = (result.loot && result.loot.length > 0)
                ? result.loot.map((i: any) => {
                    const qtyStr = i.quantity && i.quantity > 1 ? ` (x${i.quantity})` : '';
                    return `• ${i.name}${qtyStr}`;
                }).join('\n')
                : "Nessun bottino recuperato";
            embed.addFields({ name: "💰 Bottino (Loot)", value: truncate(lootText), inline: false });

            const questText = (result.quests && result.quests.length > 0)
                ? result.quests.map((q: any) => {
                    if (typeof q === 'string') return `• ${q}`;
                    const statusEmoji = q.status === 'COMPLETED' ? '✅' :
                        q.status === 'FAILED' ? '❌' :
                            q.status === 'DROPPED' ? '🗑️' : '⚔️';
                    return `${statusEmoji} **${q.title}**${q.description ? ` - ${q.description}` : ''}`;
                }).join('\n')
                : "Nessuna missione attiva";
            embed.addFields({ name: "🗺️ Missioni (Quests)", value: truncate(questText), inline: false });

            // --- GRIGLIA INLINE ---
            let monsterText = "*Nessuno*";
            if (result.monsters && result.monsters.length > 0) {
                monsterText = result.monsters.map((m: any) => {
                    const countText = m.count ? ` (${m.count})` : '';
                    const statusEmoji = m.status === 'DEFEATED' ? '💀' :
                        m.status === 'FLED' ? '🏃' :
                            m.status === 'ALIVE' ? '⚔️' : '❓';
                    return `${statusEmoji} **${m.name}**${countText}`;
                }).join('\n');
            }
            embed.addFields({ name: "🐉 Mostri", value: truncate(monsterText, 512), inline: true });

            let npcText = "*Nessuno*";
            if (encounteredNPCs && encounteredNPCs.length > 0) {
                npcText = encounteredNPCs.map((npc: any) => {
                    const statusEmoji = npc.status === 'DEAD' ? '💀' :
                        npc.status === 'HOSTILE' ? '⚔️' :
                            npc.status === 'FRIENDLY' ? '🤝' :
                                npc.status === 'NEUTRAL' ? '🔷' : '✅';
                    const roleText = npc.role ? ` *${npc.role}*` : '';
                    return `${statusEmoji} **${npc.name}**${roleText}`;
                }).join('\n');
            }
            embed.addFields({ name: '👥 NPC', value: truncate(npcText, 512), inline: true });

            const reputationUpdates = result.faction_updates?.filter((f: any) => f.reputation_change);
            if (reputationUpdates && reputationUpdates.length > 0) {
                const repText = reputationUpdates.map((f: any) => {
                    const val = f.reputation_change.value;
                    const sign = val >= 0 ? '+' : '';
                    const arrow = val > 0 ? '⬆️' : val < 0 ? '⬇️' : '➡️';
                    return `${arrow} **${f.name}**: ${sign}${val}\n*${f.reputation_change.reason}*`;
                }).join('\n');
                embed.addFields({ name: '🏅 Reputazione', value: truncate(repText, 512), inline: true });
            }

            if (result.party_alignment_change) {
                const ac = result.party_alignment_change;
                const moralVal = ac.moral_impact ?? 0;
                const ethicalVal = ac.ethical_impact ?? 0;
                const moralSign = moralVal >= 0 ? '+' : '';
                const ethicalSign = ethicalVal >= 0 ? '+' : '';
                const moralArrow = moralVal > 0 ? '⬆️' : moralVal < 0 ? '⬇️' : '➡️';
                const ethicalArrow = ethicalVal > 0 ? '⬆️' : ethicalVal < 0 ? '⬇️' : '➡️';
                const alignText = `${moralArrow} Morale: **${moralSign}${moralVal}**\n${ethicalArrow} Etico: **${ethicalSign}${ethicalVal}**\n*${ac.reason}*`;
                embed.addFields({ name: '⚖️ Allineamento', value: truncate(alignText, 512), inline: true });
            }

            const artifactLines: string[] = [];
            if (result.artifacts && result.artifacts.length > 0) {
                result.artifacts.forEach((a: any) => {
                    const statusEmoji = a.status === 'DESTROYED' ? '💥' : a.status === 'LOST' ? '❓' : a.status === 'DORMANT' ? '💤' : '✨';
                    artifactLines.push(`${statusEmoji} **${a.name}**`);
                });
            }
            if (result.artifact_events && result.artifact_events.length > 0) {
                result.artifact_events.forEach((e: any) => {
                    const typeEmoji = e.type === 'DISCOVERY' ? '🔍' : e.type === 'ACTIVATION' ? '⚡' :
                        e.type === 'DESTRUCTION' ? '💥' : e.type === 'CURSE' || e.type === 'CURSE_REVEAL' ? '🩸' : '📜';
                    artifactLines.push(`${typeEmoji} **${e.name}**: ${e.event}`);
                });
            }
            if (artifactLines.length > 0) {
                embed.addFields({ name: '🗡️ Artefatti', value: truncate(artifactLines.join('\n'), 512), inline: true });
            }

            if (result.character_growth && result.character_growth.length > 0) {
                const growthText = result.character_growth.map((g: any) => {
                    const typeEmoji = g.type === 'TRAUMA' ? '💔' : g.type === 'ACHIEVEMENT' ? '🏆' :
                        g.type === 'RELATIONSHIP' ? '🤝' : g.type === 'BACKGROUND' ? '📖' : '🎯';
                    return `${typeEmoji} **${g.name}**: ${g.event}`;
                }).join('\n');
                embed.addFields({ name: '🧬 Crescita PG', value: truncate(growthText, 512), inline: true });
            }

            await channel.send({ embeds: [embed] });

        } catch (err: any) {
            console.error(`[Tecnico] ❌ Errore:`, err);
            await loadingMsg.edit(`❌ Errore nel recupero del riepilogo: ${err.message}`);
        }
    }
};
