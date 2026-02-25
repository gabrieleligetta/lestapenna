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

const SESSIONS_PER_PAGE = 20;

export const tecnicoCommand: Command = {
    name: 'riepilogotecnico',
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
            new Date(s.start_time).toLocaleDateString('it-IT').includes(q)
        );
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / SESSIONS_PER_PAGE));
    const safePage = Math.min(page, totalPages - 1);
    const pageItems = filtered.slice(safePage * SESSIONS_PER_PAGE, (safePage + 1) * SESSIONS_PER_PAGE);

    if (total === 0) {
        const msg = searchQuery
            ? `Nessuna sessione trovata per "${searchQuery}".`
            : "Nessuna sessione trovata per questa campagna.";
        if (interactionToUpdate) {
            await interactionToUpdate.update({ content: msg, components: [] });
        } else {
            await ctx.message.reply(msg);
        }
        return;
    }

    // Build select options
    const options = pageItems.map(s => {
        const date = new Date(s.start_time).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
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
                .setLabel('🔍 Cerca...')
                .setDescription('Filtra per numero, titolo o data')
                .setValue('SEARCH_ACTION')
                .setEmoji('🔍')
        );
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('tecnico_session_select')
        .setPlaceholder(searchQuery ? `Risultati per: "${searchQuery}"` : '📜 Seleziona una sessione...')
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
        ? `**📋 Riepilogo Tecnico — Risultati per "${searchQuery}"**`
        : `**📋 Riepilogo Tecnico — ${ctx.activeCampaign!.name}**`;
    const content = `${header}\nPagina ${safePage + 1}/${totalPages} · ${total} sessioni`;

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
                    .setTitle('🔍 Cerca Sessione');
                const input = new TextInputBuilder()
                    .setCustomId('search_query')
                    .setLabel('Numero, titolo o data (gg/mm/aa)')
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

    // Risolvi il canale dei riassunti (stesso meccanismo di publishSummary)
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

    const loadingMsg = await cmdChannel.send(`🎒 Caricamento riepilogo tecnico per \`${sessionId}\`...`);

    try {
        const pipelineService = new PipelineService();
        const result = await pipelineService.generateSessionSummary(
            sessionId,
            campaignId,
            'DM',
            { skipAnalysis: true }
        );

        const encounteredNPCs = getSessionEncounteredNPCs(sessionId);

        await loadingMsg.delete().catch(() => { });

        // Notifica nel canale comandi se l'embed va altrove
        if (targetChannel.id !== cmdChannel.id) {
            await cmdChannel.send(`✅ Riepilogo tecnico inviato in <#${targetChannel.id}>`);
        }

        const embed = new EmbedBuilder()
            .setColor('#F1C40F')
            .setTitle('🎒 Riepilogo Tecnico');

        // --- FULL-WIDTH ---
        const lootText = (result.loot && result.loot.length > 0)
            ? result.loot.map((i: any) => {
                const qtyStr = i.quantity && i.quantity > 1 ? ` (x${i.quantity})` : '';
                return `• ${i.name}${qtyStr}`;
            }).join('\n')
            : 'Nessun bottino recuperato';
        embed.addFields({ name: '💰 Bottino (Loot)', value: truncate(lootText), inline: false });

        const questText = (result.quests && result.quests.length > 0)
            ? result.quests.map((q: any) => {
                if (typeof q === 'string') return `• ${q}`;
                const statusEmoji = q.status === 'COMPLETED' ? '✅' :
                    q.status === 'FAILED' ? '❌' :
                        q.status === 'DROPPED' ? '🗑️' : '⚔️';
                return `${statusEmoji} **${q.title}**${q.description ? ` - ${q.description}` : ''}`;
            }).join('\n')
            : 'Nessuna missione attiva';
        embed.addFields({ name: '🗺️ Missioni (Quests)', value: truncate(questText), inline: false });

        // --- GRIGLIA INLINE ---
        let monsterText = '*Nessuno*';
        if (result.monsters && result.monsters.length > 0) {
            monsterText = result.monsters.map((m: any) => {
                const countText = m.count ? ` (${m.count})` : '';
                const statusEmoji = m.status === 'DEFEATED' ? '💀' :
                    m.status === 'FLED' ? '🏃' :
                        m.status === 'ALIVE' ? '⚔️' : '❓';
                return `${statusEmoji} **${m.name}**${countText}`;
            }).join('\n');
        }
        embed.addFields({ name: '🐉 Mostri', value: truncate(monsterText, 512), inline: true });

        let npcText = '*Nessuno*';
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
                    e.type === 'DESTRUCTION' ? '💥' : (e.type === 'CURSE' || e.type === 'CURSE_REVEAL') ? '🩸' : '📜';
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

        await targetChannel.send({ embeds: [embed] });

    } catch (err: any) {
        console.error(`[Tecnico] ❌ Errore:`, err);
        await loadingMsg.edit(`❌ Errore nel recupero del riepilogo: ${err.message}`).catch(() => { });
    }
}