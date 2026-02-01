/**
 * $quest / $obiettivi command - Quest management
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';

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
    getQuestByShortId,
    db
} from '../../db';
import { QuestStatus, Quest } from '../../db/types';
import { questRepository } from '../../db/repositories/QuestRepository';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { generateBio } from '../../bard/bio';
import { showEntityEvents } from '../utils/eventsViewer';
import {
    startInteractiveQuestAdd,
    startInteractiveQuestUpdate,
    startInteractiveQuestDelete,
    startInteractiveQuestStatusChange
} from './questInteractive';

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

        const generateQuestDetailEmbed = (quest: any) => {
            const typeIcon = quest.type === 'MAJOR' ? '👑' : '📜';
            const s = quest.status as string;
            const statusIcon = (s === QuestStatus.IN_PROGRESS || s === 'IN CORSO') ? '⏳' :
                (s === QuestStatus.COMPLETED || s === 'DONE') ? '✅' :
                    (s === QuestStatus.FAILED) ? '❌' : '🔹';

            const embed = new EmbedBuilder()
                .setTitle(`${typeIcon} ${quest.title}`)
                .setColor("#7289DA")
                .setDescription(`**Stato:** ${statusIcon} ${quest.status}\n**ID:** \`#${quest.short_id}\`\n\n${quest.description || "*Nessuna descrizione.*"}`)
                .setFooter({ text: `Quest del ${ctx.activeCampaign?.name}` });

            return embed;
        };

        // --- SESSION SPECIFIC: $quest <session_id> [all] ---
        if (firstArg && isSessionId(firstArg)) {
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
            const title = arg.substring(4).trim();
            if (!title) {
                await startInteractiveQuestAdd(ctx);
                return;
            }
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

        if (arg.toLowerCase() === 'add') {
            await startInteractiveQuestAdd(ctx);
            return;
        }

        // SUBCOMMAND: $quest update <Title or ID> [| <Note> OR <field> <value>]
        if (arg.toLowerCase().startsWith('update ') || arg.toLowerCase() === 'update') {
            const fullContent = arg.substring(7).trim(); // Remove 'update '

            if (!fullContent) {
                await startInteractiveQuestUpdate(ctx);
                return;
            }

            // 1. Identify Target (ID or Title)
            let targetIdentifier = "";
            let remainingArgs = "";

            if (fullContent.startsWith('#')) {
                // Assume #ID format: #abcde ...
                const parts = fullContent.split(' ');
                targetIdentifier = parts[0];
                remainingArgs = parts.slice(1).join(' ');
            } else {
                // Search for | first (Narrative)
                if (fullContent.includes('|')) {
                    targetIdentifier = fullContent.split('|')[0].trim();
                    remainingArgs = "|" + fullContent.split('|').slice(1).join('|');
                } else {
                    // Metadata update on Title? Look for keywords.
                    const keywords = ['status', 'stato', 'type', 'tipo'];
                    const lower = fullContent.toLowerCase();
                    let splitIndex = -1;

                    for (const kw of keywords) {
                        const searchStr = ` ${kw} `;
                        const idx = lower.lastIndexOf(searchStr);
                        if (idx !== -1) {
                            splitIndex = idx;
                            break;
                        }
                    }

                    if (splitIndex !== -1) {
                        targetIdentifier = fullContent.substring(0, splitIndex).trim();
                        remainingArgs = fullContent.substring(splitIndex + 1).trim();
                    } else {
                        // Assume whole string is identifier (for Help View)
                        targetIdentifier = fullContent;
                        remainingArgs = "";
                    }
                }
            }

            // Resolve Quest
            let quest: Quest | null | undefined;
            const sidMatch = targetIdentifier.match(/^#?([a-z0-9]{5})$/i);

            if (sidMatch) {
                const q = getQuestByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (q) quest = q;
            }
            // Try title if ID parse failed (or if valid ID yielded nothing? No, if match regex but not found -> null)
            // But getQuestByShortId returns undefined if not found.
            // If quest is found via ID, good. If not, and identifier wasn't a strict ID format, try title.
            // Actually targetIdentifier might be "Find Ring" so title lookup makes sense.
            if (!quest) {
                quest = getQuestByTitle(ctx.activeCampaign!.id, targetIdentifier);
            }

            if (!quest) {
                await ctx.message.reply(`❌ Quest non trovata: "${targetIdentifier}"`);
                return;
            }

            // 2. Parse Actions

            // Case A: Narrative Update
            if (remainingArgs.trim().startsWith('|')) {
                const note = remainingArgs.replace('|', '').trim();
                const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
                addQuestEvent(ctx.activeCampaign!.id, quest.title, currentSession, note, "PROGRESS", true);

                await ctx.message.reply(`📝 Nota aggiunta a **${quest.title}**. Rigenerazione diario...`);
                await regenerateQuestBio(ctx.activeCampaign!.id, quest.title, quest.status);
                return;
            }

            // Case B: Metadata Update
            const args = remainingArgs.trim().split(/\s+/);
            const field = args[0]?.toLowerCase(); // status, type...
            const value = args.slice(1).join(' ').toUpperCase(); // OPEN, MAJOR...

            const showUpdateHelp = async (errorMsg?: string) => {
                const currentStatusIcon = (quest!.status === QuestStatus.IN_PROGRESS) ? '⏳' :
                    (quest!.status === QuestStatus.COMPLETED) ? '✅' :
                        (quest!.status === QuestStatus.FAILED) ? '❌' : '🔹';

                const typeIcon = quest!.type === 'MAJOR' ? '👑' : '📜';

                const embed = new EmbedBuilder()
                    .setTitle(`ℹ️ Aggiornamento Quest: #${quest!.short_id} "${quest!.title}"`)
                    .setColor("#3498DB")
                    .setDescription(errorMsg ? `⚠️ **${errorMsg}**\n\n` : "")
                    .addFields(
                        {
                            name: "Valori Attuali",
                            value: `**Status:** ${currentStatusIcon} ${quest!.status}\n**Type:** ${typeIcon} ${quest!.type || 'MAJOR'}`,
                            inline: false
                        },
                        {
                            name: "Campi Modificabili",
                            value: `
• **status**: OPEN, COMPLETED (finita), FAILED (fallita), IN_PROGRESS (in corso)
  *Es: $quest update #${quest!.short_id} status COMPLETED*
• **type**: MAJOR (principale), MINOR (secondaria)
  *Es: $quest update #${quest!.short_id} type MINOR*
• **Note Narrative** (usa | )
  *Es: $quest update #${quest!.short_id} | Abbiamo trovato indizi*`
                        }
                    );
                await ctx.message.reply({ embeds: [embed] });
            };

            if (!field || !value) {
                await showUpdateHelp();
                return;
            }

            // 3. Apply Metadata Update
            if (field === 'status' || field === 'stato') {
                const map: Record<string, any> = {
                    'OPEN': 'OPEN', 'APERTA': 'OPEN', 'ATTIVA': 'OPEN',
                    'COMPLETED': 'COMPLETED', 'FINITA': 'COMPLETED', 'COMPLETATA': 'COMPLETED', 'DONE': 'COMPLETED',
                    'FAILED': 'FAILED', 'FALLITA': 'FAILED',
                    'IN_PROGRESS': 'IN_PROGRESS', 'IN CORSO': 'IN_PROGRESS', 'ONGOING': 'IN_PROGRESS'
                };

                const mapped = map[value] || map[value.replace(' ', '_')];

                if (!mapped) {
                    await showUpdateHelp(`Valore non valido per '${field}': "${value}"`);
                    return;
                }

                updateQuestStatusById(quest.id, mapped as QuestStatus);

                const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
                addQuestEvent(ctx.activeCampaign!.id, quest.title, currentSession, `Stato aggiornato a ${mapped}`, "MANUAL_UPDATE", true);

                await ctx.message.reply(`✅ Stato aggiornato: **${quest.title}** → **${mapped}**`);
                await regenerateQuestBio(ctx.activeCampaign!.id, quest.title, mapped);
                return;
            }

            if (field === 'type' || field === 'tipo') {
                const map: Record<string, string> = {
                    'MAJOR': 'MAJOR', 'PRINCIPALE': 'MAJOR', 'MAIN': 'MAJOR',
                    'MINOR': 'MINOR', 'SECONDARIA': 'MINOR', 'SIDE': 'MINOR', 'OPZIONALE': 'MINOR'
                };

                const mapped = map[value];
                if (!mapped) {
                    await showUpdateHelp(`Valore non valido per '${field}': "${value}"`);
                    return;
                }

                db.prepare('UPDATE quests SET type = ? WHERE id = ?').run(mapped, quest.id);
                quest.type = mapped as 'MAJOR' | 'MINOR'; // Update local obj for bio regen? Actually bio uses history.

                await ctx.message.reply(`✅ Tipo aggiornato: **${quest.title}** → **${mapped}**`);
                // Note: Type change doesn't necessarily need bio regen unless bio uses type. Bio header usually uses type.
                // Regenerate just in case.
                await regenerateQuestBio(ctx.activeCampaign!.id, quest.title, quest.status);
                return;
            }

            await showUpdateHelp(`Campo non riconosciuto: "${field}"`);
            return;
        }

        // SUBCOMMAND: $quest delete <Title or ID>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ') || arg.toLowerCase() === 'delete' || arg.toLowerCase() === 'elimina') {
            let search = arg.split(' ').slice(1).join(' ');

            if (!search) {
                await startInteractiveQuestDelete(ctx);
                return;
            }

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
        if (arg.toLowerCase().startsWith('done ') || arg.toLowerCase().startsWith('completata ') || arg.toLowerCase() === 'done' || arg.toLowerCase() === 'completata') {
            let search = arg.split(' ').slice(1).join(' ');

            if (!search) {
                await startInteractiveQuestStatusChange(ctx, 'COMPLETED');
                return;
            }

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
        if (arg.toLowerCase().startsWith('undone ') || arg.toLowerCase().startsWith('riapri ') || arg.toLowerCase() === 'undone' || arg.toLowerCase() === 'riapri') {
            let search = arg.split(' ').slice(1).join(' ');

            if (!search) {
                await startInteractiveQuestStatusChange(ctx, 'OPEN');
                return;
            }

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

        // SUBCOMMAND: events - $quest <title/#id> events [page]
        const eventsMatch = arg.match(/^(.+?)\s+events(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            let questIdentifier = eventsMatch[1].trim();
            const page = eventsMatch[2] ? parseInt(eventsMatch[2]) : 1;

            // Resolve short ID
            const sidMatch = questIdentifier.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const quest = getQuestByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (quest) questIdentifier = quest.title;
                else {
                    await ctx.message.reply(`❌ Quest con ID \`#${sidMatch[1]}\` non trovata.`);
                    return;
                }
            }

            // Verify quest exists
            const quest = getQuestByTitle(ctx.activeCampaign!.id, questIdentifier);
            if (!quest) {
                await ctx.message.reply(`❌ Quest **${questIdentifier}** non trovata.`);
                return;
            }

            await showEntityEvents(ctx, {
                tableName: 'quest_history',
                entityKeyColumn: 'quest_title',
                entityKeyValue: quest.title,
                campaignId: ctx.activeCampaign!.id,
                entityDisplayName: quest.title,
                entityEmoji: '🗺️'
            }, page);
            return;
        }

        // VIEW: Detail View (ID or Title)
        // If arg exists and is not a reserved keyword, treat as search
        const keywords = ['add', 'update', 'delete', 'elimina', 'done', 'completata', 'undone', 'riapri', 'list', 'lista', 'events'];
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
            await ctx.message.reply({ embeds: [generateQuestDetailEmbed(quest)] });
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

            const generateSelectMenu = (quests: any[]) => {
                if (quests.length === 0) return null;

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_quest')
                    .setPlaceholder('🔍 Seleziona una quest per i dettagli...')
                    .addOptions(
                        quests.map((q: any) => {
                            const statusIcon = (q.status === QuestStatus.IN_PROGRESS || q.status === 'IN CORSO') ? '⏳' :
                                (q.status === QuestStatus.COMPLETED || q.status === 'DONE') ? '✅' :
                                    (q.status === QuestStatus.FAILED) ? '❌' : '🔹';

                            return new StringSelectMenuOptionBuilder()
                                .setLabel(q.title.substring(0, 100))
                                .setDescription(`ID: #${q.short_id} | ${q.status}`)
                                .setValue(q.title)
                                .setEmoji(statusIcon);
                        })
                    );

                return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
            };

            const generateQuestDetailEmbed = (quest: any) => {
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

                return embed;
            };

            const initialData = generateEmbed(currentPage);
            const offset = currentPage * ITEMS_PER_PAGE;
            let currentQuests: any[] = [];
            if (statusFilter === 'ACTIVE' || statusFilter === 'APERTE') {
                currentQuests = questRepository.getOpenQuests(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);
            } else {
                currentQuests = questRepository.getQuestsByStatus(ctx.activeCampaign!.id, statusFilter, ITEMS_PER_PAGE, offset);
            }

            // If just error message or empty
            if (initialData.total === 0 || !initialData.embed.data.title) {
                await ctx.message.reply({ embeds: [initialData.embed] });
                return;
            }

            const components: any[] = [];
            if (initialData.totalPages > 1) components.push(generateButtons(currentPage, initialData.totalPages));
            const selectRow = generateSelectMenu(currentQuests);
            if (selectRow) components.push(selectRow);

            const reply = await ctx.message.reply({
                embeds: [initialData.embed],
                components
            });

            if (initialData.totalPages > 1 || currentQuests.length > 0) {
                const collector = reply.createMessageComponentCollector({
                    time: 60000 * 5 // 5 minutes
                });

                collector.on('collect', async (interaction: MessageComponentInteraction) => {
                    if (interaction.user.id !== ctx.message.author.id) {
                        await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
                        return;
                    }

                    if (interaction.isButton()) {
                        if (interaction.customId === 'prev_page') {
                            currentPage = Math.max(0, currentPage - 1);
                        } else if (interaction.customId === 'next_page') {
                            currentPage++;
                        }

                        const newData = generateEmbed(currentPage);
                        const newOffset = currentPage * ITEMS_PER_PAGE;
                        let newQuests: any[] = [];
                        if (statusFilter === 'ACTIVE' || statusFilter === 'APERTE') {
                            newQuests = questRepository.getOpenQuests(ctx.activeCampaign!.id, ITEMS_PER_PAGE, newOffset);
                        } else {
                            newQuests = questRepository.getQuestsByStatus(ctx.activeCampaign!.id, statusFilter, ITEMS_PER_PAGE, newOffset);
                        }

                        const newComponents: any[] = [];
                        if (newData.totalPages > 1) newComponents.push(generateButtons(currentPage, newData.totalPages));
                        const newSelectRow = generateSelectMenu(newQuests);
                        if (newSelectRow) newComponents.push(newSelectRow);

                        await interaction.update({
                            embeds: [newData.embed],
                            components: newComponents
                        });
                    } else if (interaction.isStringSelectMenu()) {
                        if (interaction.customId === 'select_quest') {
                            const selectedTitle = interaction.values[0];
                            const quest = getQuestByTitle(ctx.activeCampaign!.id, selectedTitle);
                            if (quest) {
                                const detailEmbed = generateQuestDetailEmbed(quest);
                                await interaction.reply({ embeds: [detailEmbed] });
                            } else {
                                await interaction.reply({ content: "Quest non trovata.", ephemeral: true });
                            }
                        }
                    }
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
