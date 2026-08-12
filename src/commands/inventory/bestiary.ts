/**
 * $bestiario / $bestiary command - Monster bestiary
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import { bestiaryRepository } from '../../db';
import { getActiveSession } from '../../state/sessionState';
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
    startInteractiveBestiaryUpdate,
    startInteractiveBestiaryDelete
} from './bestiaryInteractive';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';
import { Locale, t } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';

const monsterStatusIcon = (status: string) =>
    status === 'ALIVE' ? '⚔️' :
        status === 'DEFEATED' ? '💀' :
            status === 'FLED' ? '🏃' : '👹';

const monsterStatusLabel = (locale: Locale, status: string) =>
    status === 'ALIVE' ? t(locale, 'bestiary.statusAlive') :
        status === 'DEFEATED' ? t(locale, 'bestiary.statusDefeated') :
            status === 'FLED' ? t(locale, 'bestiary.statusFled') : status;

const bestiarySpec: EntityCrudSpec<any> = {
    labelKey: 'entity.monster',
    gender: 'm',
    emoji: '👹',
    historyTable: 'bestiary_history',
    historyKeyColumn: 'monster_name',
    getByShortId: (cid, sid) => bestiaryRepository.getMonsterByShortId(cid, sid),
    getByName: (cid, name) => bestiaryRepository.getMonsterByName(cid, name),
    name: (m) => m.name,
    listForEvents: (cid) => bestiaryRepository.listAllMonsters(cid),
    selectionDescription: (m, locale) => `#${m.short_id} - ${monsterStatusLabel(locale, m.status)}`,
    selectionEmoji: (m) => monsterStatusIcon(m.status),
    emptyEventsKey: 'entity.emptyBestiary'
};

// Helper for regeneration - used ONLY for narrative notes
async function regenerateMonsterBio(campaignId: number, monsterName: string) {
    const history = bestiaryRepository.getBestiaryHistory(campaignId, monsterName);
    const monster = bestiaryRepository.getMonsterByName(campaignId, monsterName);
    const currentDesc = monster?.description || "";

    const simpleHistory = history.map((h: any) => ({ description: h.description, event_type: h.event_type }));
    await generateBio('MONSTER', { campaignId, name: monsterName, currentDesc }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markBestiaryDirtyForSync(campaignId: number, name: string) {
    bestiaryRepository.markBestiaryDirty(campaignId, name);
}

export const bestiaryCommand: Command = {
    name: 'bestiary',
    category: 'entita',
    descriptionKey: 'help.cmd.bestiary',
    aliases: ['bestiario', 'mostri', 'monsters'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const firstArg = ctx.args[0]?.toLowerCase();
        const arg = ctx.args.join(' ');

        // Events Subcommand: $bestiario events [action] [Target]
        if (firstArg === 'events' || firstArg === 'eventi') {
            await handleEntityEventsSubcommand(ctx, bestiarySpec);
            return;
        }

        const generateMonsterDetailEmbed = (monster: any) => {
            const statusColor = monster.status === 'ALIVE' ? "#00FF00" :
                monster.status === 'DEFEATED' ? "#FF0000" :
                    monster.status === 'FLED' ? "#FFFF00" : "#7289DA";

            const embed = new EmbedBuilder()
                .setTitle(`${monsterStatusIcon(monster.status)} ${monster.name}`)
                .setColor(statusColor)
                .setDescription(monster.description || t(ctx.locale, 'inventory.noDescription'))
                .addFields(
                    { name: t(ctx.locale, 'artifact.fieldStatus'), value: monsterStatusLabel(ctx.locale, monster.status), inline: true },
                    { name: t(ctx.locale, 'inventory.id'), value: `\`#${monster.short_id}\``, inline: true }
                );

            const abilities = monster.abilities ? JSON.parse(monster.abilities) : [];
            const weaknesses = monster.weaknesses ? JSON.parse(monster.weaknesses) : [];
            const resistances = monster.resistances ? JSON.parse(monster.resistances) : [];

            if (abilities.length > 0) embed.addFields({ name: t(ctx.locale, 'bestiary.abilitiesField'), value: abilities.join(', ') });
            if (weaknesses.length > 0) embed.addFields({ name: t(ctx.locale, 'bestiary.weaknessesField'), value: weaknesses.join(', ') });
            if (resistances.length > 0) embed.addFields({ name: t(ctx.locale, 'bestiary.resistancesField'), value: resistances.join(', ') });
            if (monster.notes) embed.addFields({ name: t(ctx.locale, 'inventory.notes'), value: monster.notes });

            embed.setFooter({ text: t(ctx.locale, 'bestiary.updateFooter', { id: monster.short_id || '?????' }) });
            return embed;
        };

        // SUBCOMMAND: $bestiario update <Name or ID> [| <Note> OR <field> <value>]
        if (arg.toLowerCase() === 'update' || arg.toLowerCase().startsWith('update ')) {
            const fullContent = arg.substring(7).trim();

            if (!fullContent) {
                await startInteractiveBestiaryUpdate(ctx);
                return;
            }

            const { targetIdentifier, remainingArgs } = parseUpdateTarget(fullContent, ['status', 'stato']);

            const monster = resolveEntity(bestiarySpec, ctx.activeCampaign!.id, targetIdentifier);
            if (!monster) {
                await ctx.message.reply(t(ctx.locale, 'bestiary.notFound', { monster: targetIdentifier }));
                return;
            }

            if (!remainingArgs) {
                await startInteractiveBestiaryUpdate({ ...ctx, args: [targetIdentifier] });
                return;
            }

            // Case A: Narrative Update
            if (remainingArgs.trim().startsWith('|')) {
                const note = remainingArgs.replace('|', '').trim();
                const currentSession = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
                bestiaryRepository.addBestiaryEvent(ctx.activeCampaign!.id, monster.name, currentSession, note, "MANUAL_UPDATE", true);

                await ctx.message.reply(t(ctx.locale, 'bestiary.noteAddedRegenerating', { monster: monster.name }));
                await regenerateMonsterBio(ctx.activeCampaign!.id, monster.name);
                return;
            }

            // Case B: Metadata Update
            const args = remainingArgs.trim().split(/\s+/);
            const field = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ').toUpperCase();

            const showUpdateHelp = (errorMsg?: string) => showUpdateHelpEmbed(ctx, {
                title: t(ctx.locale, 'bestiary.updateHelpTitle', { id: monster.short_id || '?????', monster: monster.name }),
                errorMsg,
                currentValues: t(ctx.locale, 'bestiary.currentValues', {
                    status: `${monsterStatusIcon(monster.status)} ${monsterStatusLabel(ctx.locale, monster.status)}`
                }),
                fieldsHelp: t(ctx.locale, 'bestiary.fieldsHelp', { id: monster.short_id || '?????' })
            });

            if (!field || !args[1]) {
                await showUpdateHelp();
                return;
            }

            if (field === 'status' || field === 'stato') {
                const map: Record<string, string> = {
                    'ALIVE': 'ALIVE', 'VIVO': 'ALIVE', 'ACTIVE': 'ALIVE',
                    'DEFEATED': 'DEFEATED', 'SCONFITTO': 'DEFEATED', 'MORTO': 'DEFEATED', 'DEAD': 'DEFEATED', 'UCCISO': 'DEFEATED',
                    'FLED': 'FLED', 'FUGGITO': 'FLED', 'SCAPPATO': 'FLED',
                    'VIVIENTE': 'ALIVE', 'VIVANT': 'ALIVE', 'LEBENDIG': 'ALIVE',
                    'DERROTADO': 'DEFEATED', 'VAINCU': 'DEFEATED', 'BESIEGT': 'DEFEATED',
                    'HUIDO': 'FLED', 'ENFUI': 'FLED', 'GEFLOHEN': 'FLED', 'FUGIU': 'FLED'
                };

                const mapped = map[value] || map[value.replace(' ', '_')];

                if (!mapped) {
                    await showUpdateHelp(t(ctx.locale, 'bestiary.invalidValue', { field, value }));
                    return;
                }

                bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { status: mapped }, true);
                // We do NOT add events for a status change - mark dirty for background sync
                markBestiaryDirtyForSync(ctx.activeCampaign!.id, monster.name);

                await ctx.message.reply(t(ctx.locale, 'bestiary.statusUpdated', { monster: monster.name, status: monsterStatusLabel(ctx.locale, mapped) }));
                return;
            }

            await showUpdateHelp(t(ctx.locale, 'artifact.unknownField', { field }));
            return;
        }

        // SUBCOMMAND: $bestiario delete <Name>
        if (arg.toLowerCase() === 'delete' || arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            const rawTarget = arg.split(' ').slice(1).join(' ').trim();

            if (!rawTarget) {
                await startInteractiveBestiaryDelete(ctx);
                return;
            }

            const name = resolveEntityName(bestiarySpec, ctx.activeCampaign!.id, rawTarget);
            const existing = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, name);
            if (!existing) {
                await ctx.message.reply(t(ctx.locale, 'bestiary.notFound', { monster: name }));
                return;
            }

            const outcome = await deleteEntityFromCommand(ctx, 'bestiary', existing);
            if (outcome.denied) return;
            if (outcome.ok) {
                await ctx.message.reply(
                    t(ctx.locale, 'bestiary.deleted', { monster: name })
                    + deleteSummaryLine(ctx.locale, outcome.report),
                );
            } else {
                await ctx.message.reply(t(ctx.locale, 'bestiary.deleteFailed', { monster: name }));
            }
            return;
        }

        // SUBCOMMAND: $bestiario merge [Source] | [Target]
        if (firstArg === 'merge' || firstArg === 'unisci') {
            const content = arg.substring(firstArg.length).trim();

            const mergeConfig: MergeConfig = {
                entityTypeKey: 'entity.monster',
                emoji: '👹',
                campaignId: ctx.activeCampaign!.id,
                listEntities: (cid) => bestiaryRepository.listAllMonsters(cid).map(m => ({
                    id: m.name,
                    shortId: m.short_id || '?????',
                    name: m.name,
                    description: m.description || '',
                    metadata: m.status
                })),
                resolveEntity: (cid, query) => {
                    const monster = resolveEntity(bestiarySpec, cid, query);
                    if (!monster) return null;
                    return {
                        id: monster.name,
                        shortId: monster.short_id || '?????',
                        name: monster.name,
                        description: monster.description || '',
                        metadata: monster.status
                    };
                },
                executeMerge: async (cid, source, target, mergedDesc) => {
                    return bestiaryRepository.mergeMonsters(cid, source.name as string, target.name as string, mergedDesc || undefined);
                }
            };

            await startInteractiveMerge(ctx, mergeConfig, content);
            return;
        }

        // SUBCOMMAND: events - $bestiario <name/#id> events [page]
        const trailingEvents = matchTrailingEvents(arg);
        if (trailingEvents) {
            const found = await showEventsByIdentifier(ctx, bestiarySpec, trailingEvents.identifier, trailingEvents.page);
            if (!found) {
                await ctx.message.reply(notFoundMessage(bestiarySpec, trailingEvents.identifier, ctx.locale));
            }
            return;
        }

        // VIEW: Show specific monster details (ID or Name, partial match on the name)
        if (arg && !arg.toLowerCase().startsWith('list') && !arg.toLowerCase().startsWith('lista') && !arg.includes('|')) {
            const search = resolveEntityName(bestiarySpec, ctx.activeCampaign!.id, arg);

            const monster = bestiaryRepository.listAllMonsters(ctx.activeCampaign!.id).find((m: any) =>
                m.name.toLowerCase().includes(search.toLowerCase())
            );
            if (!monster) {
                await ctx.message.reply(t(ctx.locale, 'bestiary.notFoundInBestiary', { monster: arg }));
                return;
            }

            await ctx.message.reply({ embeds: [generateMonsterDetailEmbed(monster)] });
            return;
        }

        // VIEW: List all monsters (Paginated)
        let initialPage = 1;
        if (arg) {
            const listParts = arg.split(' ');
            if (listParts.length > 1 && !isNaN(parseInt(listParts[1]))) {
                initialPage = parseInt(listParts[1]);
            }
        }

        const monsters = bestiaryRepository.listAllMonsters(ctx.activeCampaign!.id);

        // Sort: ALIVE first, then FLED, then DEFEATED
        const statusOrder: Record<string, number> = { 'ALIVE': 0, 'FLED': 1, 'DEFEATED': 2 };
        monsters.sort((a: any, b: any) => {
            const sA = statusOrder[a.status] ?? 99;
            const sB = statusOrder[b.status] ?? 99;
            return sA - sB;
        });

        await runPaginatedEntityList(ctx, {
            perPage: 5,
            fetchPage: (page, perPage) => ({
                items: monsters.slice(page * perPage, (page + 1) * perPage),
                total: monsters.length
            }),
            buildEmbed: (items, page, totalPages, total) => {
                const list = items.map((m: any) => {
                    const desc = m.description ? `\n> *${m.description.substring(0, 80)}${m.description.length > 80 ? '...' : ''}*` : '';
                    return `\`#${m.short_id}\` ${monsterStatusIcon(m.status)} **${m.name}** [${monsterStatusLabel(ctx.locale, m.status)}]${desc}`;
                }).join('\n\n');

                return new EmbedBuilder()
                    .setTitle(t(ctx.locale, 'bestiary.listTitle', { campaign: ctx.activeCampaign?.name || '' }))
                    .setColor("#7289DA")
                    .setDescription(list)
                    .setFooter({ text: t(ctx.locale, 'inventory.pageTotal', { page: page + 1, totalPages, total }) });
            },
            emptyEmbed: () => t(ctx.locale, 'bestiary.empty'),
            buildDetailEmbed: generateMonsterDetailEmbed,
            selectOption: (m: any) => ({
                label: m.name,
                description: t(ctx.locale, 'bestiary.optionDescription', { id: m.short_id || '?????', status: monsterStatusLabel(ctx.locale, m.status) }),
                emoji: monsterStatusIcon(m.status)
            }),
            resolveSelected: (name) => bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, name)
        }, initialPage);
    }
};
