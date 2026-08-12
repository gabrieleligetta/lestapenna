/**
 * $quest / $obiettivi command - Quest management
 */

import { EmbedBuilder } from 'discord.js';

import { Command, CommandContext } from '../types';
import {
    addQuest,
    updateQuestStatus,
    updateQuestStatusById,
    deleteQuest,
    getSessionQuests,
    addQuestEvent,
    getQuestHistory,
    getQuestByTitle,
    getQuestByShortId,
    db
} from '../../db';
import { QuestStatus, Quest } from '../../db/types';
import { questRepository } from '../../db/repositories/QuestRepository';
import { getActiveSession } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { assertSessionInActiveCampaign } from '../utils/sessionScope';
import { generateBio } from '../../bard/bio';
import {
    EntityCrudSpec,
    handleEntityEventsSubcommand,
    matchTrailingEvents,
    showEventsByIdentifier,
    resolveEntity,
    resolveEntityName,
    notFoundMessage,
    parseUpdateTarget,
    showUpdateHelpEmbed,
    runPaginatedEntityList
} from '../utils/entityCrud';
import {
    startInteractiveQuestAdd,
    startInteractiveQuestUpdate,
    startInteractiveQuestDelete,
    startInteractiveQuestStatusChange
} from './questInteractive';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';
import { getCampaignLocale, Locale, t } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';
import { assertCampaignWrite } from '../utils/campaignWrite';

const questStatusIcon = (status: string) =>
    (status === QuestStatus.IN_PROGRESS || status === 'IN CORSO') ? '⏳' :
        (status === QuestStatus.COMPLETED || status === 'DONE') ? '✅' :
            (status === QuestStatus.FAILED) ? '❌' : '🔹';

const questTypeIcon = (type?: string) => type === 'MAJOR' ? '👑' : '📜';

const questStatusLabel = (locale: Locale, status: string) =>
    status === QuestStatus.IN_PROGRESS || status === 'IN CORSO' ? t(locale, 'quest.statusInProgress') :
        status === QuestStatus.COMPLETED || status === 'DONE' ? t(locale, 'quest.statusCompleted') :
            status === QuestStatus.FAILED ? t(locale, 'quest.statusFailed') :
                status === QuestStatus.OPEN ? t(locale, 'quest.statusOpen') : status;

const questTypeLabel = (locale: Locale, type?: string) =>
    type === 'MINOR' ? t(locale, 'quest.typeMinor') : t(locale, 'quest.typeMajor');

const questSpec: EntityCrudSpec<Quest> = {
    labelKey: 'entity.quest',
    gender: 'f',
    emoji: '🗺️',
    historyTable: 'quest_history',
    historyKeyColumn: 'quest_title',
    getByShortId: (cid, sid) => getQuestByShortId(cid, sid),
    getByName: (cid, name) => getQuestByTitle(cid, name),
    name: (q) => q.title,
    listForEvents: (cid) => questRepository.getOpenQuests(cid, 25, 0),
    selectionDescription: (q, locale) => `#${q.short_id} - ${questStatusLabel(locale, q.status)}`,
    selectionEmoji: (q) => questStatusIcon(q.status),
    emptyEventsKey: 'entity.emptyQuests'
};

const buildQuestMergeConfig = (campaignId: number, locale: Locale): MergeConfig => ({
    entityTypeKey: 'entity.quest',
    emoji: '🗺️',
    campaignId,
    listEntities: (cid) => questRepository.listAllQuests(cid).map(q => ({
        id: q.title,
        shortId: q.short_id || '?????',
        name: q.title,
        description: q.description || '',
        metadata: q.status
    })),
    resolveEntity: (cid, query) => {
        const quest = resolveEntity(questSpec, cid, query);
        if (!quest) return null;
        return {
            id: quest.title,
            shortId: quest.short_id || '?????',
            name: quest.title,
            description: quest.description || '',
            metadata: quest.status
        };
    },
    executeMerge: async (cid, source, target, mergedDesc) => {
        return questRepository.mergeQuests(cid, source.name as string, target.name as string, mergedDesc || undefined);
    }
});

// Helper for regeneration - used ONLY for narrative notes
async function regenerateQuestBio(campaignId: number, title: string, status: string) {
    const history = getQuestHistory(campaignId, title);
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('QUEST', { campaignId, name: title, role: status, currentDesc: "" }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markQuestDirtyForSync(campaignId: number, title: string) {
    questRepository.markQuestDirty(campaignId, title);
}

export const questCommand: Command = {
    name: 'quest',
    category: 'entita',
    descriptionKey: 'help.cmd.quest',
    aliases: ['obiettivi'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const firstArg = ctx.args[0]?.toLowerCase();

        // Events Subcommand: $quest events [action] [Target]
        if (firstArg === 'events' || firstArg === 'eventi') {
            await handleEntityEventsSubcommand(ctx, questSpec);
            return;
        }

        const generateQuestDetailEmbed = (quest: any) => {
            const embed = new EmbedBuilder()
                .setTitle(`${questTypeIcon(quest.type)} ${quest.title}`)
                .setColor("#7289DA")
                .setDescription(t(ctx.locale, 'quest.detailDescription', {
                    icon: questStatusIcon(quest.status),
                    status: questStatusLabel(ctx.locale, quest.status),
                    id: quest.short_id || '?????',
                    description: quest.description || t(ctx.locale, 'inventory.noDescription')
                }))
                .setFooter({ text: t(ctx.locale, 'quest.campaignFooter', { campaign: ctx.activeCampaign?.name || '' }) });

            return embed;
        };

        // SUBCOMMAND: $quest merge [Source] | [Target]
        if (firstArg === 'merge' || firstArg === 'unisci') {
            const content = arg.substring(firstArg.length).trim();
            await startInteractiveMerge(ctx, buildQuestMergeConfig(ctx.activeCampaign!.id, ctx.locale), content);
            return;
        }

        // --- SESSION SPECIFIC: $quest <session_id> [all] ---
        if (firstArg && isSessionId(firstArg)) {
            const sessionId = extractSessionId(firstArg);
            if (!await assertSessionInActiveCampaign(ctx, sessionId)) return;
            const sessionQuests = getSessionQuests(sessionId);

            if (sessionQuests.length === 0) {
                await ctx.message.reply(t(ctx.locale, 'quest.sessionEmpty', { id: sessionId }));
                return;
            }

            const list = sessionQuests.map((q: any) => {
                const snippet = q.description ? `\n> *${q.description}*` : '';
                return `${questTypeIcon(q.type)} ${questStatusIcon(q.status)} **${q.title}** [${questStatusLabel(ctx.locale, q.status)}]${snippet}`;
            }).join('\n');

            await ctx.message.reply(t(ctx.locale, 'quest.sessionTitle', { id: sessionId, list }));
            return;
        }

        // SUBCOMMAND: $quest add <Title>
        if (arg.toLowerCase() === 'add') {
            await startInteractiveQuestAdd(ctx);
            return;
        }
        if (arg.toLowerCase().startsWith('add ')) {
            const title = arg.substring(4).trim();
            const currentSession = (await getActiveSession(ctx.guildId));
            addQuest(ctx.activeCampaign!.id, title, currentSession, undefined, QuestStatus.OPEN, 'MAJOR', true);

            // Add initial history event
            if (currentSession) {
                addQuestEvent(ctx.activeCampaign!.id, title, currentSession, t(getCampaignLocale(ctx.activeCampaign!.id), 'quest.eventStarted'), "CREATION", true);
                markQuestDirtyForSync(ctx.activeCampaign!.id, title);
            }

            await ctx.message.reply(t(ctx.locale, 'quest.added', { quest: title }));
            return;
        }

        // SUBCOMMAND: $quest update <Title or ID> [| <Note> OR <field> <value>]
        if (arg.toLowerCase().startsWith('update ') || arg.toLowerCase() === 'update') {
            const fullContent = arg.substring(7).trim();

            if (!fullContent) {
                await startInteractiveQuestUpdate(ctx);
                return;
            }

            const { targetIdentifier, remainingArgs } = parseUpdateTarget(fullContent, ['status', 'stato', 'type', 'tipo']);

            const quest = resolveEntity(questSpec, ctx.activeCampaign!.id, targetIdentifier);
            if (!quest) {
                await ctx.message.reply(t(ctx.locale, 'quest.notFound', { quest: targetIdentifier }));
                return;
            }

            // Case A: Narrative Update
            if (remainingArgs.trim().startsWith('|')) {
                const note = remainingArgs.replace('|', '').trim();
                const currentSession = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
                addQuestEvent(ctx.activeCampaign!.id, quest.title, currentSession, note, "PROGRESS", true);

                await ctx.message.reply(t(ctx.locale, 'quest.noteAddedRegenerating', { quest: quest.title }));
                await regenerateQuestBio(ctx.activeCampaign!.id, quest.title, quest.status);
                return;
            }

            // Case B: Metadata Update
            const args = remainingArgs.trim().split(/\s+/);
            const field = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ').toUpperCase();

            const showUpdateHelp = (errorMsg?: string) => showUpdateHelpEmbed(ctx, {
                title: t(ctx.locale, 'quest.updateHelpTitle', { id: quest.short_id || '?????', quest: quest.title }),
                errorMsg,
                currentValues: t(ctx.locale, 'quest.currentValues', {
                    status: `${questStatusIcon(quest.status)} ${questStatusLabel(ctx.locale, quest.status)}`,
                    type: `${questTypeIcon(quest.type)} ${questTypeLabel(ctx.locale, quest.type)}`
                }),
                fieldsHelp: t(ctx.locale, 'quest.fieldsHelp', { id: quest.short_id || '?????' })
            });

            if (!field || !value) {
                await showUpdateHelp();
                return;
            }

            if (field === 'status' || field === 'stato') {
                const map: Record<string, any> = {
                    'OPEN': 'OPEN', 'APERTA': 'OPEN', 'ATTIVA': 'OPEN',
                    'COMPLETED': 'COMPLETED', 'FINITA': 'COMPLETED', 'COMPLETATA': 'COMPLETED', 'DONE': 'COMPLETED',
                    'FAILED': 'FAILED', 'FALLITA': 'FAILED',
                    'IN_PROGRESS': 'IN_PROGRESS', 'IN CORSO': 'IN_PROGRESS', 'ONGOING': 'IN_PROGRESS',
                    'ABIERTA': 'OPEN', 'OUVERTE': 'OPEN', 'OFFEN': 'OPEN', 'ABERTA': 'OPEN',
                    'COMPLETADA': 'COMPLETED', 'TERMINÉE': 'COMPLETED', 'ABGESCHLOSSEN': 'COMPLETED', 'CONCLUÍDA': 'COMPLETED',
                    'FALLIDA': 'FAILED', 'ÉCHOUÉE': 'FAILED', 'GESCHEITERT': 'FAILED', 'FRACASSADA': 'FAILED',
                    'EN CURSO': 'IN_PROGRESS', 'EN COURS': 'IN_PROGRESS', 'IN BEARBEITUNG': 'IN_PROGRESS', 'EM ANDAMENTO': 'IN_PROGRESS'
                };

                const mapped = map[value] || map[value.replace(' ', '_')];

                if (!mapped) {
                    await showUpdateHelp(t(ctx.locale, 'bestiary.invalidValue', { field, value }));
                    return;
                }

                updateQuestStatusById(quest.id, mapped as QuestStatus);
                // We do NOT add events for a status change - mark dirty for background sync
                markQuestDirtyForSync(ctx.activeCampaign!.id, quest.title);

                await ctx.message.reply(t(ctx.locale, 'quest.statusUpdated', { quest: quest.title, status: questStatusLabel(ctx.locale, mapped) }));
                return;
            }

            if (field === 'type' || field === 'tipo') {
                const map: Record<string, string> = {
                    'MAJOR': 'MAJOR', 'PRINCIPALE': 'MAJOR', 'MAIN': 'MAJOR',
                    'MINOR': 'MINOR', 'SECONDARIA': 'MINOR', 'SIDE': 'MINOR', 'OPZIONALE': 'MINOR',
                    'PRINCIPAL': 'MAJOR', 'HAUPT': 'MAJOR',
                    'SECUNDARIA': 'MINOR', 'SECONDAIRE': 'MINOR', 'NEBEN': 'MINOR', 'SECUNDÁRIA': 'MINOR'
                };

                const mapped = map[value];
                if (!mapped) {
                    await showUpdateHelp(t(ctx.locale, 'bestiary.invalidValue', { field, value }));
                    return;
                }

                db.prepare('UPDATE quests SET type = ? WHERE id = ?').run(mapped, quest.id);
                // Marca dirty per sync background
                markQuestDirtyForSync(ctx.activeCampaign!.id, quest.title);

                await ctx.message.reply(t(ctx.locale, 'quest.typeUpdated', { quest: quest.title, type: questTypeLabel(ctx.locale, mapped) }));
                return;
            }

            await showUpdateHelp(t(ctx.locale, 'artifact.unknownField', { field }));
            return;
        }

        // SUBCOMMAND: $quest delete <Title or ID>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ') || arg.toLowerCase() === 'delete' || arg.toLowerCase() === 'elimina') {
            const rawTarget = arg.split(' ').slice(1).join(' ');

            if (!rawTarget) {
                await startInteractiveQuestDelete(ctx);
                return;
            }

            const search = resolveEntityName(questSpec, ctx.activeCampaign!.id, rawTarget);
            const quest = getQuestByTitle(ctx.activeCampaign!.id, search);
            if (!quest) {
                await ctx.message.reply(t(ctx.locale, 'quest.notFound', { quest: search }));
                return;
            }

            if (!await assertCampaignWrite(ctx)) return;
            await ctx.message.reply(t(ctx.locale, 'quest.deleteProgress', { quest: quest.title }));

            // Cascade shared with the web CRUD (services/entityDeletion.ts):
            // deleteQuest already takes away the history, the RAG and the lifecycle proposals.
            const outcome = await deleteEntityFromCommand(ctx, 'quests', quest);
            if (outcome.denied) return;

            await ctx.message.reply(
                t(ctx.locale, 'quest.deletedFull', { quest: quest.title })
                + deleteSummaryLine(ctx.locale, outcome.report),
            );
            return;
        }

        // SUBCOMMAND: $quest done <Title or ID>
        if (arg.toLowerCase().startsWith('done ') || arg.toLowerCase().startsWith('completata ') || arg.toLowerCase() === 'done' || arg.toLowerCase() === 'completata') {
            const rawTarget = arg.split(' ').slice(1).join(' ');

            if (!rawTarget) {
                await startInteractiveQuestStatusChange(ctx, 'COMPLETED');
                return;
            }

            const search = resolveEntityName(questSpec, ctx.activeCampaign!.id, rawTarget);
            updateQuestStatus(ctx.activeCampaign!.id, search, 'COMPLETED');

            // Mark dirty for the background sync - no automatic events
            const quest = getQuestByTitle(ctx.activeCampaign!.id, search);
            if (quest) {
                markQuestDirtyForSync(ctx.activeCampaign!.id, quest.title);
            }

            await ctx.message.reply(t(ctx.locale, 'quest.completed', { quest: search }));
            return;
        }

        // SUBCOMMAND: $quest undone <Title or ID>
        if (arg.toLowerCase().startsWith('undone ') || arg.toLowerCase().startsWith('riapri ') || arg.toLowerCase() === 'undone' || arg.toLowerCase() === 'riapri') {
            const rawTarget = arg.split(' ').slice(1).join(' ');

            if (!rawTarget) {
                await startInteractiveQuestStatusChange(ctx, 'OPEN');
                return;
            }

            const search = resolveEntityName(questSpec, ctx.activeCampaign!.id, rawTarget);
            const quest = getQuestByTitle(ctx.activeCampaign!.id, search);
            if (!quest) {
                await ctx.message.reply(t(ctx.locale, 'quest.notFound', { quest: search }));
                return;
            }

            // Update Status e marca dirty per sync background
            updateQuestStatus(ctx.activeCampaign!.id, quest.title, 'OPEN');
            markQuestDirtyForSync(ctx.activeCampaign!.id, quest.title);

            await ctx.message.reply(t(ctx.locale, 'quest.reopened', { quest: quest.title }));
            return;
        }

        // SUBCOMMAND: events - $quest <title/#id> events [page]
        const trailingEvents = matchTrailingEvents(arg);
        if (trailingEvents) {
            const found = await showEventsByIdentifier(ctx, questSpec, trailingEvents.identifier, trailingEvents.page);
            if (!found) {
                await ctx.message.reply(notFoundMessage(questSpec, trailingEvents.identifier, ctx.locale));
            }
            return;
        }

        // VIEW: Detail View (ID or Title)
        const keywords = ['add', 'update', 'delete', 'elimina', 'done', 'completata', 'undone', 'riapri', 'list', 'lista', 'events'];
        const firstWord = arg.split(' ')[0].toLowerCase();

        if (arg && !keywords.includes(firstWord)) {
            const quest = resolveEntity(questSpec, ctx.activeCampaign!.id, arg);
            if (!quest) {
                await ctx.message.reply(t(ctx.locale, 'quest.notFound', { quest: arg }));
                return;
            }

            await ctx.message.reply({ embeds: [generateQuestDetailEmbed(quest)] });
            return;
        }

        // VIEW: List quests (default or supported list commands)
        // Supports: $quest, $quest list, $quest list [status], $quest list [page]
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
                statusFilter = normalizeQuestStatusInput(firstPart);
                if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                    initialPage = parseInt(parts[1]);
                }
            }
        }

        const isActiveFilter = statusFilter === 'ACTIVE' || statusFilter === 'APERTE';

        await runPaginatedEntityList(ctx, {
            perPage: 5,
            fetchPage: (page, perPage) => {
                const offset = page * perPage;
                if (isActiveFilter) {
                    return {
                        items: questRepository.getOpenQuests(ctx.activeCampaign!.id, perPage, offset),
                        total: questRepository.countOpenQuests(ctx.activeCampaign!.id)
                    };
                }
                return {
                    items: questRepository.getQuestsByStatus(ctx.activeCampaign!.id, statusFilter, perPage, offset),
                    total: questRepository.countQuestsByStatus(ctx.activeCampaign!.id, statusFilter)
                };
            },
            buildEmbed: (items, page, totalPages, total) => {
                const list = items.map((q: any) => {
                    const icon = questStatusIcon(q.status);
                    const statusPrefix = icon === '🔹' ? '' : `${icon} `;
                    const desc = q.description ? `\n> *${q.description}*` : '';
                    return `\`#${q.short_id}\` ${questTypeIcon(q.type)} ${statusPrefix}**${q.title}**${desc}`;
                }).join('\n\n');

                const statusHeader = statusFilter === 'ACTIVE'
                    ? t(ctx.locale, 'quest.filterActive')
                    : statusFilter === 'ALL'
                        ? t(ctx.locale, 'quest.filterAll')
                        : `[${questStatusLabel(ctx.locale, statusFilter)}]`;

                return new EmbedBuilder()
                    .setTitle(t(ctx.locale, 'quest.listTitle', { filter: statusHeader, campaign: ctx.activeCampaign?.name || '' }))
                    .setColor(statusFilter === 'ACTIVE' ? "#00FF00" : "#7289DA")
                    .setDescription(list)
                    .setFooter({ text: t(ctx.locale, 'inventory.pageTotal', { page: page + 1, totalPages, total }) });
            },
            emptyEmbed: () => {
                const statusName = statusFilter === 'ACTIVE'
                    ? t(ctx.locale, 'quest.activeSingular')
                    : t(ctx.locale, 'quest.withStatus', { status: questStatusLabel(ctx.locale, statusFilter) });
                return new EmbedBuilder().setDescription(t(ctx.locale, 'quest.emptyForStatus', { status: statusName }));
            },
            buildDetailEmbed: generateQuestDetailEmbed,
            selectOption: (q: any) => ({
                label: q.title,
                description: t(ctx.locale, 'quest.optionDescription', { id: q.short_id || '?????', status: questStatusLabel(ctx.locale, q.status) }),
                emoji: questStatusIcon(q.status)
            }),
            resolveSelected: (title) => getQuestByTitle(ctx.activeCampaign!.id, title)
        }, initialPage);
    }
};

function normalizeQuestStatusInput(value: string): string {
    const normalized = value.trim().toUpperCase().replace(/-/g, '_');
    const aliases: Record<string, string> = {
        ACTIVE: 'ACTIVE', ATTIVE: 'ACTIVE', ACTIVAS: 'ACTIVE', ACTIVES: 'ACTIVE', AKTIVE: 'ACTIVE', ATIVAS: 'ACTIVE',
        ALL: 'ALL', TUTTE: 'ALL', TODAS: 'ALL', TOUTES: 'ALL', ALLE: 'ALL',
        OPEN: 'OPEN', APERTA: 'OPEN', ABIERTA: 'OPEN', OUVERTE: 'OPEN', OFFEN: 'OPEN', ABERTA: 'OPEN',
        COMPLETED: 'COMPLETED', COMPLETATA: 'COMPLETED', COMPLETADA: 'COMPLETED', TERMINÉE: 'COMPLETED', ABGESCHLOSSEN: 'COMPLETED', CONCLUÍDA: 'COMPLETED',
        FAILED: 'FAILED', FALLITA: 'FAILED', FALLIDA: 'FAILED', ÉCHOUÉE: 'FAILED', GESCHEITERT: 'FAILED', FRACASSADA: 'FAILED',
        IN_PROGRESS: 'IN_PROGRESS', 'IN CORSO': 'IN_PROGRESS', 'EN CURSO': 'IN_PROGRESS', 'EN COURS': 'IN_PROGRESS', 'IN BEARBEITUNG': 'IN_PROGRESS', 'EM ANDAMENTO': 'IN_PROGRESS'
    };
    return aliases[normalized] || normalized;
}
