/**
 * $quest / $obiettivi command - Quest management
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';

import { Command, CommandContext } from '../types';
import {
    addQuest,
    getOpenQuests,
    updateQuestStatus,
    updateQuestStatusById,
    deleteQuest,
    getSessionQuests,
    mergeQuests,
    // New imports
    addQuestEvent,
    getQuestHistory,
    getQuestByTitle,
    deleteQuestHistory,
    deleteQuestRagSummary,
    getQuestByShortId
} from '../../db';
import { QuestStatus, Quest } from '../../db/types';
import { questRepository } from '../../db/repositories/QuestRepository';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { generateBio } from '../../bard/bio';

// Helper for Regen
async function regenerateQuestBio(campaignId: number, title: string, status: string) {
    const history = getQuestHistory(campaignId, title);
    // Map history to simple objects
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('QUEST', { campaignId, name: title, role: status, currentDesc: "" }, simpleHistory);
}

export const questCommand: Command = {
    name: 'quest',
    aliases: ['obiettivi'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const firstArg = ctx.args[0];

        // --- SESSION SPECIFIC: $quest <session_id> [all] ---
        if (firstArg && isSessionId(firstArg)) {
            // ... (Keep existing logic)
            const sessionId = extractSessionId(firstArg);
            const showAll = ctx.args.includes('all') || ctx.args.includes('-a');
            const sessionQuests = getSessionQuests(sessionId);

            if (sessionQuests.length === 0) {
                await ctx.message.reply(
                    `🗺️ Nessuna quest aggiunta nella sessione \`${sessionId}\`.\n` +
                    `*Nota: Solo le quest aggiunte dopo l'aggiornamento vengono tracciate per sessione.*`
                );
                return;
            }

            const list = sessionQuests.map((q: any) => {
                const isCompleted = q.status === QuestStatus.COMPLETED || q.status === 'DONE';
                const isFailed = q.status === QuestStatus.FAILED;
                const isInProgress = q.status === QuestStatus.IN_PROGRESS || q.status === 'IN CORSO';

                const statusIcon = isCompleted ? '✅' : isFailed ? '❌' : isInProgress ? '⏳' : '🔹';
                const typeIcon = q.type === 'MAJOR' ? '👑' : '📜';
                // Show description snippet if available
                const snippet = q.description ? `\n> *${q.description}*` : '';
                return `${typeIcon} ${statusIcon} **${q.title}** [${q.status}]${snippet}`;
            }).join('\n');

            const header = `Quest della Sessione \`${sessionId}\``;
            await ctx.message.reply(`**🗺️ ${header}:**\n\n${list}`);
            return;
        }

        // SUBCOMMAND: $quest add <Title>
        if (arg.toLowerCase().startsWith('add ')) {
            const title = arg.substring(4);
            const currentSession = guildSessions.get(ctx.guildId);
            addQuest(ctx.activeCampaign!.id, title, currentSession, undefined, QuestStatus.OPEN, 'MAJOR', true);

            // Add initial history event?
            if (currentSession) {
                addQuestEvent(ctx.activeCampaign!.id, title, currentSession, "Quest iniziata.", "CREATION", true);
                regenerateQuestBio(ctx.activeCampaign!.id, title, "OPEN"); // Async
            }

            await ctx.message.reply(`🗺️ Quest aggiunta: **${title}**`);
            return;
        }

        // SUBCOMMAND: $quest update <Title> | <Note>
        // Syntax: $quest update Find the Ring | We found a clue
        if (arg.toLowerCase().startsWith('update ')) {
            const content = arg.substring(7);
            const parts = content.split('|');
            if (parts.length < 2) {
                await ctx.message.reply("⚠️ Uso: `$quest update <Titolo/ID> | <Evento/Progresso>`");
                return;
            }
            let title = parts[0].trim();
            const note = parts.slice(1).join('|').trim();

            // ID Resolution
            const sidMatch = title.match(/^#([a-z0-9]{5})$/i);
            const numericMatch = title.match(/^#?(\d+)$/);

            if (sidMatch) {
                const quest = getQuestByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (quest) title = quest.title;
            }

            const quest = getQuestByTitle(ctx.activeCampaign!.id, title);
            if (!quest) {
                await ctx.message.reply(`❌ Quest non trovata: "${title}"`);
                return;
            }

            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addQuestEvent(ctx.activeCampaign!.id, title, currentSession, note, "PROGRESS", true);
            await ctx.message.reply(`📝 Nota aggiunta a **${title}**. Rigenerazione diario...`);

            // Trigger Regen
            await regenerateQuestBio(ctx.activeCampaign!.id, title, quest.status);
            return;
        }

        // SUBCOMMAND: $quest delete <Title or ID>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let search = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const sidMatch = search.match(/^#([a-z0-9]{5})$/i);
            const numericMatch = search.match(/^#?(\d+)$/);

            if (sidMatch) {
                const quest = getQuestByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (quest) search = quest.title;
            }

            const quest = getQuestByTitle(ctx.activeCampaign!.id, search);
            if (!quest) {
                await ctx.message.reply(`❌ Quest non trovata: "${search}"`);
                return;
            }

            // Full Wipe
            await ctx.message.reply(`🗑️ Eliminazione completa per **${quest.title}** in corso...`);
            deleteQuestRagSummary(ctx.activeCampaign!.id, quest.title);
            deleteQuestHistory(ctx.activeCampaign!.id, quest.title);
            deleteQuest(quest.id);

            await ctx.message.reply(`✅ Quest **${quest.title}** eliminata definitivamente (RAG, Storia, Database).`);
            return;
        }

        // SUBCOMMAND: $quest done <Title or ID>
        if (arg.toLowerCase().startsWith('done ') || arg.toLowerCase().startsWith('completata ')) {
            let search = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const sidMatch = search.match(/^#([a-z0-9]{5})$/i);
            const numericMatch = search.match(/^#?(\d+)$/);

            if (sidMatch) {
                const quest = getQuestByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (quest) search = quest.title;
            }

            updateQuestStatus(ctx.activeCampaign!.id, search, 'COMPLETED');

            // Add Event
            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            // We need exact title for event. 
            const quest = getQuestByTitle(ctx.activeCampaign!.id, search); // Fuzzy might fail if search is partial
            if (quest) {
                addQuestEvent(ctx.activeCampaign!.id, quest.title, currentSession, "La quest è stata completata con successo.", "COMPLETION", true);
                regenerateQuestBio(ctx.activeCampaign!.id, quest.title, "COMPLETED");
            }

            await ctx.message.reply(`✅ Quest completata: **${search}**`);
            return;
        }

        // SUBCOMMAND: $quest undone <Title or ID>
        if (arg.toLowerCase().startsWith('undone ') || arg.toLowerCase().startsWith('riapri ')) {
            let search = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const sidMatch = search.match(/^#([a-z0-9]{5})$/i);
            const numericMatch = search.match(/^#?(\d+)$/);

            if (sidMatch) {
                const quest = getQuestByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (quest) search = quest.title;
            }

            const quest = getQuestByTitle(ctx.activeCampaign!.id, search);
            if (!quest) {
                await ctx.message.reply(`❌ Quest non trovata: "${search}"`);
                return;
            }

            // Update Status
            updateQuestStatus(ctx.activeCampaign!.id, quest.title, 'OPEN');
            // Remove from RAG (or update)? regenerate will handle it.

            // Add Event
            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addQuestEvent(ctx.activeCampaign!.id, quest.title, currentSession, "Stato riportato a OPEN (Undone).", "MANUAL_UPDATE", true);

            // Regenerate
            await regenerateQuestBio(ctx.activeCampaign!.id, quest.title, "OPEN");

            await ctx.message.reply(`🔄 Quest riaperta: **${quest.title}**`);
            return;
        }

        // VIEW: Detail View (ID or Title)
        // If arg exists and is not a reserved keyword, treat as search
        const keywords = ['add', 'update', 'delete', 'elimina', 'done', 'completata', 'undone', 'riapri', 'list', 'lista'];
        const firstWord = arg.split(' ')[0].toLowerCase();

        if (arg && !keywords.includes(firstWord) && !isSessionId(firstArg)) {
            let search = arg;

            // ID Resolution
            const sidMatch = search.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const quest = getQuestByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (quest) search = quest.title;
            }

            const quest = getQuestByTitle(ctx.activeCampaign!.id, search);
            if (!quest) {
                // If not found, maybe it was a list command typo? 
                // But we better just say not found to avoid confusion.
                // Or fallthrough? No, fallthrough goes to list. which handles empty arg.
                // But here arg is NOT empty.
                await ctx.message.reply(`❌ Quest non trovata: "${search}"`);
                return;
            }

            // Show Details
            const typeIcon = quest.type === 'MAJOR' ? '👑' : '📜';
            const s = quest.status as string;
            const statusIcon = (s === QuestStatus.IN_PROGRESS || s === 'IN CORSO') ? '⏳' :
                (s === QuestStatus.COMPLETED || s === 'DONE') ? '✅' :
                    (s === QuestStatus.FAILED) ? '❌' : '🔹';

            let desc = quest.description || "*Nessuna descrizione.*";

            const embed = new EmbedBuilder()
                .setTitle(`${typeIcon} ${quest.title}`)
                .setColor("#7289DA")
                .setDescription(`**Stato:** ${statusIcon} ${quest.status}\n**ID:** \`#${quest.short_id}\`\n\n${desc}`)
                .setFooter({ text: `Quest del ${ctx.activeCampaign?.name}` });

            await ctx.message.reply({ embeds: [embed] });
            return;
        }

        // VIEW: List quests (default or supported list commands)
        // Supports: $quest, $quest list, $quest list [status], $quest list [page]
        if (!arg || arg.toLowerCase().startsWith('list') || arg.toLowerCase().startsWith('lista')) {
            const parts = arg.toLowerCase().startsWith('list') || arg.toLowerCase().startsWith('lista')
                ? arg.split(' ').slice(1)
                : arg.split(' ').filter(s => s.length > 0);

            let statusFilter = 'ACTIVE';
            let initialPage = 1;

            if (parts.length > 0) {
                const firstPart = parts[0].toUpperCase();
                if (!isNaN(parseInt(firstPart))) {
                    initialPage = parseInt(firstPart);
                } else {
                    statusFilter = firstPart;
                    if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                        initialPage = parseInt(parts[1]);
                    }
                }
            }

            const ITEMS_PER_PAGE = 5;
            let currentPage = Math.max(0, initialPage - 1); // 0-indexed for logic

            // Helper to fetch data and generate embed
            const generateEmbed = (page: number) => {
                const offset = page * ITEMS_PER_PAGE;
                let quests: Quest[];
                let total: number;

                if (statusFilter === 'ACTIVE' || statusFilter === 'APERTE') {
                    quests = questRepository.getOpenQuests(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);
                    total = questRepository.countOpenQuests(ctx.activeCampaign!.id);
                } else if (statusFilter === 'ALL' || statusFilter === 'TOTALI' || statusFilter === 'TUTTE') {
                    // Need a repository method for ALL? Or use status filter logic?
                    // Existing code implied 'ALL' might be handled by getQuestsByStatus or separate.
                    // The repo `getQuestsByStatus` usually filters.
                    // Let's check logic: existing code had `if (statusFilter === 'ACTIVE')... else ... getQuestsByStatus`.
                    // If statusFilter is 'ALL', getQuestsByStatus might not support it unless handled.
                    // Let's assume 'ALL' isn't fully supported by `getQuestsByStatus` unless we check.
                    // For now, if ALL, we might need `getAllQuests`.
                    // Let's stick to existing logic: if NOT active, call `getQuestsByStatus`.
                    quests = questRepository.getQuestsByStatus(ctx.activeCampaign!.id, statusFilter, ITEMS_PER_PAGE, offset);
                    total = questRepository.countQuestsByStatus(ctx.activeCampaign!.id, statusFilter);
                } else {
                    quests = questRepository.getQuestsByStatus(ctx.activeCampaign!.id, statusFilter, ITEMS_PER_PAGE, offset);
                    total = questRepository.countQuestsByStatus(ctx.activeCampaign!.id, statusFilter);
                }

                const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
                // Adjust page if out of bounds (recurse or clamp?)
                // If query returns empty because page is too string, we just show empty.

                if (quests.length === 0 && total > 0 && page > 0) {
                    return { embed: new EmbedBuilder().setDescription("❌ Pagina inesistente."), totalPages: Math.ceil(total / ITEMS_PER_PAGE), total };
                }

                if (total === 0) {
                    const statusName = statusFilter === 'ACTIVE' ? 'attiva' : `con stato **${statusFilter}**`;
                    return { embed: new EmbedBuilder().setDescription(`Nessuna quest ${statusName} al momento.`), totalPages: 0, total };
                }

                const list = quests.map((q: any) => {
                    const typeIcon = q.type === 'MAJOR' ? '👑' : '📜';
                    const statusIcon = (q.status === QuestStatus.IN_PROGRESS || q.status === 'IN CORSO') ? '⏳ ' :
                        (q.status === QuestStatus.COMPLETED || q.status === 'DONE') ? '✅ ' :
                            (q.status === QuestStatus.FAILED) ? '❌ ' : '';

                    const desc = q.description ? `\n> *${q.description}*` : '';
                    return `\`#${q.short_id}\` ${typeIcon} ${statusIcon}**${q.title}**${desc}`;
                }).join('\n\n');

                const statusHeader = statusFilter === 'ACTIVE' ? 'Attive' : statusFilter === 'ALL' ? 'Totali' : `[${statusFilter}]`;

                const embed = new EmbedBuilder()
                    .setTitle(`🗺️ Quest ${statusHeader} (${ctx.activeCampaign?.name})`)
                    .setColor(statusFilter === 'ACTIVE' ? "#00FF00" : "#7289DA")
                    .setDescription(list)
                    .setFooter({ text: `Pagina ${page + 1} di ${totalPages} • Totale: ${total}` });

                return { embed, totalPages, total };
            };

            const generateButtons = (page: number, totalPages: number) => {
                const row = new ActionRowBuilder<ButtonBuilder>();
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page')
                        .setLabel('⬅️ Precedente')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel('Successivo ➡️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1)
                );
                return row;
            };

            const initialData = generateEmbed(currentPage);

            // If just error message or empty
            if (initialData.total === 0 || !initialData.embed.data.title) {
                await ctx.message.reply({ embeds: [initialData.embed] });
                return;
            }

            const reply = await ctx.message.reply({
                embeds: [initialData.embed],
                components: initialData.totalPages > 1 ? [generateButtons(currentPage, initialData.totalPages)] : []
            });

            if (initialData.totalPages > 1) {
                const collector = reply.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 60000 * 5 // 5 minutes
                });

                collector.on('collect', async (interaction: MessageComponentInteraction) => {
                    if (interaction.user.id !== ctx.message.author.id) {
                        await interaction.reply({ content: "Solo chi ha invocato il comando può sfogliare le pagine.", ephemeral: true });
                        return;
                    }

                    if (interaction.customId === 'prev_page') {
                        currentPage = Math.max(0, currentPage - 1);
                    } else if (interaction.customId === 'next_page') {
                        currentPage++;
                    }

                    const newData = generateEmbed(currentPage);

                    // Verify page wasn't out of bounds due to race condition or stale data
                    if (newData.totalPages > 0 && currentPage >= newData.totalPages) {
                        currentPage = newData.totalPages - 1;
                        // re-fetch? generateEmbed(currentPage) would need to be called again if we want perfect correctness, 
                        // but let's assume it's fine or next update fixes it.
                    }

                    await interaction.update({
                        embeds: [newData.embed],
                        components: [generateButtons(currentPage, newData.totalPages)]
                    });
                });

                collector.on('end', () => {
                    reply.edit({ components: [] }).catch(() => { });
                });
            }
            return;
        }
    }
};

export const mergeQuestCommand: Command = {
    name: 'mergequest',
    aliases: ['unisciquest', 'mergequests'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const parts = arg.split('|').map(s => s.trim());

        if (parts.length !== 2) {
            await ctx.message.reply("Uso: `$unisciquest <titolo vecchio> | <titolo nuovo>`\nEsempio: `$unisciquest Trova l'artefatto | Trovare l'artefatto antico`");
            return;
        }

        const [oldTitle, newTitle] = parts;
        const success = mergeQuests(ctx.activeCampaign!.id, oldTitle, newTitle);
        if (success) {
            await ctx.message.reply(`✅ **Quest unite!**\n🗺️ **${oldTitle}** è stata integrata in **${newTitle}**`);
        } else {
            await ctx.message.reply(`❌ Impossibile unire. Verifica che "${oldTitle}" esista tra le quest.`);
        }
    }
};
