import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    TextChannel,
    EmbedBuilder
} from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getAvailableSessions,
    getSessionCampaignId,
    getSessionEncounteredNPCs,
    getGuildConfig
} from '../../db';
import { PipelineService } from '../../publisher/services/PipelineService';
import { truncate } from '../../publisher/formatters';
import { t, getCampaignLocale, dateLocale, Locale } from '../../i18n';

const SESSIONS_PER_PAGE = 20;

export const tecnicoCommand: Command = {
    name: 'riepilogotecnico',
    category: 'narrativa',
    descriptionKey: 'help.cmd.riepilogotecnico',
    aliases: ['tecnico', 'riepilogo'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        await showSessionSelection(ctx, null, 0, null);
    }
};

async function showSessionSelection(
    ctx: CommandContext,
    searchQuery: string | null,
    page: number,
    interactionToUpdate: any | null
) {
    // Fetch all sessions (limit=0 → no limit in SQL)
    const allSessions = getAvailableSessions(ctx.message.guild!.id, ctx.activeCampaign!.id, 0);

    // Filter by search query
    let filtered = allSessions;
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = allSessions.filter(s =>
            s.session_id.toLowerCase().includes(q) ||
            (s.title && s.title.toLowerCase().includes(q)) ||
            (s.session_number && String(s.session_number).includes(q)) ||
            new Date(s.start_time).toLocaleDateString(dateLocale(ctx.locale)).includes(q)
        );
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / SESSIONS_PER_PAGE));
    const safePage = Math.min(page, totalPages - 1);
    const pageItems = filtered.slice(safePage * SESSIONS_PER_PAGE, (safePage + 1) * SESSIONS_PER_PAGE);

    if (total === 0) {
        const msg = searchQuery
            ? t(ctx.locale, 'narrative.noSessionsSearch', { query: searchQuery })
            : t(ctx.locale, 'narrative.noSessions');
        if (interactionToUpdate) {
            await interactionToUpdate.update({ content: msg, components: [] });
        } else {
            await ctx.message.reply(msg);
        }
        return;
    }

    // Build select options
    const options = pageItems.map(s => {
        const date = new Date(s.start_time).toLocaleDateString(dateLocale(ctx.locale), { day: '2-digit', month: '2-digit', year: '2-digit' });
        const num = s.session_number ? `#${s.session_number}` : '';
        const label = [num, date, s.title].filter(Boolean).join(' · ').substring(0, 100) || s.session_id.substring(0, 100);
        const desc = `ID: ${s.session_id.substring(0, 40)} | ${s.fragments} frammenti`;
        return new StringSelectMenuOptionBuilder()
            .setLabel(label)
            .setDescription(desc.substring(0, 100))
            .setValue(s.session_id)
            .setEmoji('📜');
    });

    // Add search option only on first page
    if (safePage === 0) {
        options.unshift(
            new StringSelectMenuOptionBuilder()
                .setLabel(t(ctx.locale, 'wizard.searchOption'))
                .setDescription(t(ctx.locale, 'narrative.searchModalLabel'))
                .setValue('SEARCH_ACTION')
                .setEmoji('🔍')
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('tecnico_session_select')
        .setPlaceholder(searchQuery ? t(ctx.locale, 'wizard.resultsFor', { q: searchQuery }) : t(ctx.locale, 'narrative.selectSession'))
        .addOptions(options);

    const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder().addComponents(select)];

    if (totalPages > 1) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('tecnico_page_prev')
                .setLabel('⬅️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage === 0),
            new ButtonBuilder()
                .setCustomId('tecnico_page_next')
                .setLabel('➡️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage >= totalPages - 1)
        );
        rows.push(navRow);
    }

    const header = searchQuery
        ? t(ctx.locale, 'narrative.techHeaderSearch', { query: searchQuery })
        : t(ctx.locale, 'narrative.techHeader', { name: ctx.activeCampaign!.name });
    const content = `${header}\n${t(ctx.locale, 'common.pageFooterTotal', { page: safePage + 1, total: totalPages, n: total })}`;

    let response: any;
    if (interactionToUpdate) {
        await interactionToUpdate.update({ content, components: rows });
        response = interactionToUpdate.message;
    } else {
        response = await ctx.message.reply({ content, components: rows });
    }

    const collector = response.createMessageComponentCollector({
        time: 120000,
        filter: (i: any) => i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction: any) => {
        if (interaction.isStringSelectMenu()) {
            const val = interaction.values[0];

            if (val === 'SEARCH_ACTION') {
                collector.stop();
                const modal = new ModalBuilder()
                    .setCustomId('modal_tecnico_search')
                    .setTitle(t(ctx.locale, 'wizard.searchModalTitle'));
                const input = new TextInputBuilder()
                    .setCustomId('search_query')
                    .setLabel(t(ctx.locale, 'narrative.searchModalLabel'))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
                await interaction.showModal(modal);

                try {
                    const submission = await interaction.awaitModalSubmit({
                        time: 60000,
                        filter: (i: any) => i.customId === 'modal_tecnico_search' && i.user.id === interaction.user.id
                    });
                    await showSessionSelection(ctx, submission.fields.getTextInputValue('search_query'), 0, submission);
                } catch { }

            } else {
                collector.stop();
                await interaction.deferUpdate();
                await response.delete().catch(() => { });
                await generateAndSendEmbed(ctx, val);
            }

        } else if (interaction.isButton()) {
            collector.stop();
            if (interaction.customId === 'tecnico_page_prev') {
                await showSessionSelection(ctx, searchQuery, safePage - 1, interaction);
            } else if (interaction.customId === 'tecnico_page_next') {
                await showSessionSelection(ctx, searchQuery, safePage + 1, interaction);
            }
        }
    });

    collector.on('end', (_: any, reason: string) => {
        if (reason === 'time' && response.editable) {
            response.edit({ components: [] }).catch(() => { });
        }
    });
}

async function generateAndSendEmbed(ctx: CommandContext, sessionId: string) {
    const cmdChannel = ctx.message.channel as TextChannel;
    const guildId = ctx.message.guild!.id;

    // Resolve the summaries channel (same mechanism as publishSummary)
    let targetChannel: TextChannel = cmdChannel;
    const summaryChannelId = getGuildConfig(guildId, 'summary_channel_id');
    if (summaryChannelId) {
        try {
            const ch = await ctx.client.channels.fetch(summaryChannelId);
            if (ch && ch.isTextBased()) {
                targetChannel = ch as TextChannel;
            }
        } catch (e) {
            console.error('[Tecnico] ❌ Impossibile recuperare il canale dei riassunti:', e);
        }
    }

    const campaignId = getSessionCampaignId(sessionId) || ctx.activeCampaign!.id;
    const cLocale = getCampaignLocale(campaignId);

    const loadingMsg = await cmdChannel.send(t(ctx.locale, 'narrative.techLoading', { id: sessionId }));

    try {
        const pipelineService = new PipelineService();
        const result = await pipelineService.generateSessionSummary(
            sessionId,
            campaignId,
            'DM',
            { skipAnalysis: true, skipNormalization: true }
        );

        const encounteredNPCs = getSessionEncounteredNPCs(sessionId);

        await loadingMsg.delete().catch(() => { });

        // Notify in the command channel when the embed goes elsewhere
        if (targetChannel.id !== cmdChannel.id) {
            await cmdChannel.send(t(ctx.locale, 'narrative.techSentTo', { channel: targetChannel.id }));
        }

        // --- EMBED 1: the session's core (campaign content) ---
        const embed1 = new EmbedBuilder()
            .setColor('#F1C40F')
            .setTitle(t(cLocale, 'publish.techRecapTitle'));

        const lootText = (result.loot && result.loot.length > 0)
            ? result.loot.map((i: any) => {
                const qtyStr = i.quantity && i.quantity > 1 ? ` (x${i.quantity})` : '';
                return `• ${i.name}${qtyStr}`;
            }).join('\n')
            : t(cLocale, 'publish.noLoot');
        embed1.addFields({ name: t(cLocale, 'publish.lootField'), value: truncate(lootText) });

        const questText = (result.quests && result.quests.length > 0)
            ? result.quests.map((q: any) => {
                if (typeof q === 'string') return `• ${q}`;
                const statusEmoji = q.status === 'COMPLETED' ? '✅' :
                    q.status === 'FAILED' ? '❌' :
                        q.status === 'DROPPED' ? '🗑️' : '⚔️';
                return `${statusEmoji} **${q.title}**${q.description ? ` - ${q.description}` : ''}`;
            }).join('\n')
            : t(cLocale, 'publish.noQuests');
        embed1.addFields({ name: t(cLocale, 'publish.questsField'), value: truncate(questText) });

        let monsterText = t(cLocale, 'publish.none');
        if (result.monsters && result.monsters.length > 0) {
            monsterText = result.monsters.map((m: any) => {
                const statusEmoji = m.status === 'DEFEATED' ? '💀' :
                    m.status === 'FLED' ? '🏃' :
                        m.status === 'ALIVE' ? '⚔️' : '❓';
                return `${statusEmoji} **${m.name}**`;
            }).join('\n');
        }
        embed1.addFields({ name: t(cLocale, 'publish.monstersField'), value: truncate(monsterText) });

        let npcText = t(cLocale, 'publish.none');
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
        embed1.addFields({ name: t(cLocale, 'publish.npcsField'), value: truncate(npcText) });

        await targetChannel.send({ embeds: [embed1] });

        // --- EMBED 2: developments (only if there is at least one field) ---
        const embed2 = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(t(cLocale, 'publish.developmentsTitle'));

        let embed2HasFields = false;

        const reputationUpdates = result.faction_updates?.filter((f: any) => f.reputation_change);
        if (reputationUpdates && reputationUpdates.length > 0) {
            const repText = reputationUpdates.map((f: any) => {
                const val = f.reputation_change.value;
                const sign = val >= 0 ? '+' : '';
                const arrow = val > 0 ? '⬆️' : val < 0 ? '⬇️' : '➡️';
                return `${arrow} **${f.name}**: ${sign}${val}\n*${f.reputation_change.reason}*`;
            }).join('\n');
            embed2.addFields({ name: t(cLocale, 'publish.reputationField'), value: truncate(repText) });
            embed2HasFields = true;
        }

        if (result.party_alignment_change) {
            const ac = result.party_alignment_change;
            const moralVal = ac.moral_impact ?? 0;
            const ethicalVal = ac.ethical_impact ?? 0;
            const moralSign = moralVal >= 0 ? '+' : '';
            const ethicalSign = ethicalVal >= 0 ? '+' : '';
            const moralArrow = moralVal > 0 ? '⬆️' : moralVal < 0 ? '⬇️' : '➡️';
            const ethicalArrow = ethicalVal > 0 ? '⬆️' : ethicalVal < 0 ? '⬇️' : '➡️';
            const alignText = `${moralArrow} ${t(cLocale, 'publish.alignmentMoral')}: **${moralSign}${moralVal}**\n${ethicalArrow} ${t(cLocale, 'publish.alignmentEthical')}: **${ethicalSign}${ethicalVal}**\n*${ac.reason}*`;
            embed2.addFields({ name: t(cLocale, 'publish.alignmentField'), value: truncate(alignText) });
            embed2HasFields = true;
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
                    e.type === 'DESTRUCTION' ? '💥' : (e.type === 'CURSE' || e.type === 'CURSE_REVEAL') ? '🩸' :
                    e.type === 'TRANSFER' ? '🔄' : e.type === 'REVELATION' ? '💡' :
                    e.type === 'OBSERVATION' ? '👁️' : e.type === 'MANUAL_UPDATE' ? '✏️' : '📜';
                artifactLines.push(`${typeEmoji} **${e.name}**: ${e.event}`);
            });
        }
        if (artifactLines.length > 0) {
            embed2.addFields({ name: t(cLocale, 'publish.artifactsField'), value: truncate(artifactLines.join('\n')) });
            embed2HasFields = true;
        }

        if (result.character_growth && result.character_growth.length > 0) {
            const growthText = result.character_growth.map((g: any) => {
                const typeEmoji = g.type === 'TRAUMA' ? '💔' : g.type === 'ACHIEVEMENT' ? '🏆' :
                    g.type === 'GOAL_CHANGE' ? '🎯' : g.type === 'RELATIONSHIP' ? '🤝' :
                    g.type === 'BACKGROUND' ? '📖' : '📈';
                return `${typeEmoji} **${g.name}**: ${g.event}`;
            }).join('\n');
            embed2.addFields({ name: t(cLocale, 'publish.growthField'), value: truncate(growthText) });
            embed2HasFields = true;
        }

        const significantNpcTypes = new Set(['BETRAYAL', 'DEATH', 'REVELATION', 'ALLIANCE', 'COMBAT']);
        const significantNpcEvents = (result.npc_events || []).filter((e: any) => significantNpcTypes.has(e.type));
        if (significantNpcEvents.length > 0) {
            const npcEventsText = significantNpcEvents.map((e: any) => {
                const typeEmoji = e.type === 'DEATH' ? '💀' : e.type === 'BETRAYAL' ? '🗡️' :
                    e.type === 'REVELATION' ? '💡' : e.type === 'ALLIANCE' ? '🤝' :
                    e.type === 'COMBAT' ? '⚔️' : '📋';
                return `${typeEmoji} **${e.name}**: ${e.event}`;
            }).join('\n');
            embed2.addFields({ name: t(cLocale, 'publish.significantNpcsField'), value: truncate(npcEventsText) });
            embed2HasFields = true;
        }

        if (result.world_events && result.world_events.length > 0) {
            const worldEventsText = result.world_events.map((e: any) => {
                const typeEmoji = e.type === 'WAR' ? '⚔️' : e.type === 'POLITICS' ? '🏛️' :
                    e.type === 'DISCOVERY' ? '🔍' : e.type === 'CALAMITY' ? '🌋' :
                    e.type === 'SUPERNATURAL' ? '✨' : e.type === 'DISASTER' ? '🔥' :
                    e.type === 'MYTH' ? '📖' : e.type === 'RELIGION' ? '🙏' :
                    e.type === 'BIRTH' ? '🌱' : e.type === 'DEATH' ? '💀' :
                    e.type === 'CONSTRUCTION' ? '🏗️' : '🌍';
                return `${typeEmoji} ${e.event}`;
            }).join('\n');
            embed2.addFields({ name: t(cLocale, 'publish.worldChronicleField'), value: truncate(worldEventsText) });
            embed2HasFields = true;
        }

        if (embed2HasFields) {
            await targetChannel.send({ embeds: [embed2] });
        }

    } catch (err: any) {
        console.error(`[Tecnico] ❌ Errore:`, err);
        await loadingMsg.edit(t(ctx.locale, 'narrative.techError', { error: err.message })).catch(() => { });
    }
}
