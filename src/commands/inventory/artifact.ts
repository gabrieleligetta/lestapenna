/**
 * $artifact / $artefatto command - Magical artifacts registry
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    listAllArtifacts,
    mergeArtifacts,
    addArtifactEvent,
    getArtifactByName,
    getArtifactByShortId,
    deleteArtifact,
    updateArtifactFields
} from '../../db';
import { ArtifactEntry, ArtifactStatus } from '../../db/types';
import { getActiveSession } from '../../state/sessionState';
import {
    EntityCrudSpec,
    handleEntityEventsSubcommand,
    matchTrailingEvents,
    showEventsByIdentifier,
    resolveEntity,
    notFoundMessage,
    parseUpdateTarget,
    showUpdateHelpEmbed,
    runPaginatedEntityList
} from '../utils/entityCrud';
import { startInteractiveArtifactUpdate, startInteractiveArtifactAdd, startInteractiveArtifactDelete } from './artifactInteractive';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';
import { Locale, t } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';

// Status icons and colors
const getStatusDisplay = (status: ArtifactStatus, locale: Locale) => {
    switch (status) {
        case 'FUNCTIONAL': return { icon: '✨', color: '#00FF00' as const, label: t(locale, 'artifact.statusFunctional') };
        case 'DESTROYED': return { icon: '💥', color: '#FF0000' as const, label: t(locale, 'artifact.statusDestroyed') };
        case 'LOST': return { icon: '❓', color: '#808080' as const, label: t(locale, 'artifact.statusLost') };
        case 'SEALED': return { icon: '🔒', color: '#9932CC' as const, label: t(locale, 'artifact.statusSealed') };
        case 'DORMANT': return { icon: '💤', color: '#4169E1' as const, label: t(locale, 'artifact.statusDormant') };
        default: return { icon: '🔮', color: '#7289DA' as const, label: status };
    }
};

const artifactSpec: EntityCrudSpec<ArtifactEntry> = {
    labelKey: 'entity.artifact',
    gender: 'm',
    emoji: '🔮',
    historyTable: 'artifact_history',
    historyKeyColumn: 'artifact_name',
    getByShortId: (cid, sid) => getArtifactByShortId(cid, sid),
    getByName: (cid, name) => getArtifactByName(cid, name),
    name: (a) => a.name,
    listForEvents: (cid) => listAllArtifacts(cid),
    selectionDescription: (a, locale) => `#${a.short_id} - ${getStatusDisplay(a.status, locale).label}`,
    selectionEmoji: (a) => getStatusDisplay(a.status, 'en').icon,
    emptyEventsKey: 'entity.emptyArtifacts'
};

export const artifactCommand: Command = {
    name: 'artifact',
    category: 'entita',
    descriptionKey: 'help.cmd.artifact',
    aliases: ['artefatto', 'artefatti', 'artifacts'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const firstArg = ctx.args[0]?.toLowerCase();
        const arg = ctx.args.join(' ');

        if (firstArg === 'delete') {
            await startInteractiveArtifactDelete(ctx);
            return;
        }

        // Events Subcommand: $artifact events [action] [nome/ID]
        if (firstArg === 'events' || firstArg === 'eventi') {
            await handleEntityEventsSubcommand(ctx, artifactSpec);
            return;
        }

        const generateArtifactDetailEmbed = (artifact: ArtifactEntry) => {
            const statusDisplay = getStatusDisplay(artifact.status, ctx.locale);

            const embed = new EmbedBuilder()
                .setTitle(`${statusDisplay.icon} ${artifact.name}`)
                .setColor(statusDisplay.color)
                .setDescription(artifact.description || t(ctx.locale, 'inventory.noDescription'))
                .addFields(
                    { name: t(ctx.locale, 'artifact.fieldStatus'), value: statusDisplay.label, inline: true },
                    { name: t(ctx.locale, 'inventory.id'), value: `\`#${artifact.short_id}\``, inline: true }
                );

            if (artifact.effects) embed.addFields({ name: t(ctx.locale, 'artifact.fieldEffects'), value: artifact.effects });

            if (artifact.is_cursed) {
                embed.addFields({
                    name: t(ctx.locale, 'artifact.fieldCursed'),
                    value: artifact.curse_description || t(ctx.locale, 'artifact.cursedUnknown')
                });
            }

            if (artifact.owner_name) {
                embed.addFields({
                    name: t(ctx.locale, 'artifact.fieldOwner'),
                    value: `${artifact.owner_name} (${artifact.owner_type || t(ctx.locale, 'inventory.unknown')})`,
                    inline: true
                });
            }

            if (artifact.location_macro || artifact.location_micro) {
                const location = [artifact.location_macro, artifact.location_micro].filter(Boolean).join(' - ');
                embed.addFields({ name: t(ctx.locale, 'artifact.fieldLocation'), value: location, inline: true });
            }

            embed.setFooter({ text: t(ctx.locale, 'artifact.updateFooter', { id: artifact.short_id || '?????' }) });
            return embed;
        };

        // SUBCOMMAND: $artifact update <Name or ID> [| <Note> OR <field> <value>]
        if (arg.toLowerCase().startsWith('update')) {
            const fullContent = arg.substring(6).trim();

            if (!fullContent) {
                await startInteractiveArtifactUpdate(ctx);
                return;
            }

            const { targetIdentifier, remainingArgs } = parseUpdateTarget(
                fullContent,
                ['status', 'stato', 'owner', 'proprietario', 'cursed', 'maledetto']
            );

            const artifact = resolveEntity(artifactSpec, ctx.activeCampaign!.id, targetIdentifier);
            if (!artifact) {
                await ctx.message.reply(t(ctx.locale, 'artifact.notFound', { artifact: targetIdentifier }));
                return;
            }

            // Case A: Narrative Update
            if (remainingArgs.trim().startsWith('|')) {
                const note = remainingArgs.replace('|', '').trim();
                const currentSession = (await getActiveSession(ctx.guildId)) || 'UNKNOWN_SESSION';
                addArtifactEvent(ctx.activeCampaign!.id, artifact.name, currentSession, note, "MANUAL_UPDATE", true);

                await ctx.message.reply(t(ctx.locale, 'artifact.noteAdded', { artifact: artifact.name }));
                return;
            }

            // Case B: Metadata Update
            const args = remainingArgs.trim().split(/\s+/);
            const field = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ');

            const statusDisplay = getStatusDisplay(artifact.status, ctx.locale);
            const showUpdateHelp = (errorMsg?: string) => showUpdateHelpEmbed(ctx, {
                title: t(ctx.locale, 'artifact.updateHelpTitle', { id: artifact.short_id || '?????', artifact: artifact.name }),
                errorMsg,
                currentValues: t(ctx.locale, 'artifact.currentValues', {
                    status: `${statusDisplay.icon} ${statusDisplay.label}`,
                    cursed: t(ctx.locale, artifact.is_cursed ? 'common.yes' : 'common.no'),
                    owner: artifact.owner_name || t(ctx.locale, 'artifact.noOwner')
                }),
                fieldsHelp: t(ctx.locale, 'artifact.fieldsHelp', { id: artifact.short_id || '?????' })
            });

            if (!field || !value) {
                await showUpdateHelp(t(ctx.locale, 'artifact.specifyFieldValue'));
                return;
            }

            switch (field) {
                case 'status':
                case 'stato': {
                    const statusMap: Record<string, string> = {
                        'FUNZIONANTE': 'FUNCTIONAL', 'FUNCTIONAL': 'FUNCTIONAL',
                        'DISTRUTTO': 'DESTROYED', 'DESTROYED': 'DESTROYED',
                        'PERDUTO': 'LOST', 'LOST': 'LOST',
                        'SIGILLATO': 'SEALED', 'SEALED': 'SEALED',
                        'DORMIENTE': 'DORMANT', 'DORMANT': 'DORMANT',
                        'FUNCIONAL': 'FUNCTIONAL', 'DESTRUIDO': 'DESTROYED', 'DESTRUÍDO': 'DESTROYED', 'PERDIDO': 'LOST', 'SELLADO': 'SEALED', 'SELADO': 'SEALED', 'LATENTE': 'DORMANT', 'ADORMECIDO': 'DORMANT',
                        'FONCTIONNEL': 'FUNCTIONAL', 'DÉTRUIT': 'DESTROYED', 'PERDU': 'LOST', 'SCELLÉ': 'SEALED', 'ENDORMI': 'DORMANT',
                        'FUNKTIONSFÄHIG': 'FUNCTIONAL', 'ZERSTÖRT': 'DESTROYED', 'VERLOREN': 'LOST', 'VERSIEGELT': 'SEALED', 'RUHEND': 'DORMANT'
                    };
                    const upperValue = value.toUpperCase();
                    const mappedStatus = statusMap[upperValue];
                    if (!mappedStatus) {
                        await showUpdateHelp(t(ctx.locale, 'artifact.invalidStatus', { status: value }));
                        return;
                    }
                    updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { status: mappedStatus as ArtifactStatus }, true);
                    await ctx.message.reply(t(ctx.locale, 'artifact.statusUpdated', {
                        artifact: artifact.name,
                        status: getStatusDisplay(mappedStatus as ArtifactStatus, ctx.locale).label
                    }));
                    break;
                }
                case 'owner':
                case 'proprietario': {
                    updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { owner_name: value }, true);
                    await ctx.message.reply(t(ctx.locale, 'artifact.ownerUpdated', { artifact: artifact.name, owner: value }));
                    break;
                }
                case 'cursed':
                case 'maledetto': {
                    const isCursed = isAffirmative(value);
                    updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { is_cursed: isCursed }, true);
                    await ctx.message.reply(t(ctx.locale, isCursed ? 'artifact.nowCursed' : 'artifact.noLongerCursed', { artifact: artifact.name }));
                    break;
                }
                default:
                    await showUpdateHelp(t(ctx.locale, 'artifact.unknownField', { field }));
            }
            return;
        }

        // SUBCOMMAND: $artifact delete <Name or ID> (confirmed with buttons)
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            const target = arg.replace(/^(delete|elimina)\s+/i, '').trim();

            const artifact = resolveEntity(artifactSpec, ctx.activeCampaign!.id, target);
            if (!artifact) {
                await ctx.message.reply(t(ctx.locale, 'artifact.notFound', { artifact: target }));
                return;
            }

            const confirm = new ButtonBuilder().setCustomId('confirm_delete').setLabel(t(ctx.locale, 'artifact.deleteButton')).setStyle(ButtonStyle.Danger);
            const cancel = new ButtonBuilder().setCustomId('cancel_delete').setLabel(t(ctx.locale, 'common.cancel')).setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);

            const msg = await ctx.message.reply({
                content: t(ctx.locale, 'artifact.confirmDelete', { artifact: artifact.name, id: artifact.short_id || '?????' }),
                components: [row]
            });

            try {
                const i = await msg.awaitMessageComponent({ componentType: ComponentType.Button, time: 30000 });
                if (i.customId === 'confirm_delete') {
                    const outcome = await deleteEntityFromCommand(ctx, 'artifacts', artifact);
                    if (outcome.denied) return;
                    await i.update({
                        content: t(ctx.locale, 'artifact.deleted', { artifact: artifact.name })
                            + deleteSummaryLine(ctx.locale, outcome.report),
                        components: [],
                    });
                } else {
                    await i.update({ content: t(ctx.locale, 'wizard.cancelled'), components: [] });
                }
            } catch {
                await msg.edit({ content: t(ctx.locale, 'events.timeout'), components: [] });
            }
            return;
        }

        if (arg.toLowerCase() === 'add' || arg.toLowerCase().startsWith('add ')) {
            const content = arg.substring(3).trim();
            if (!content) {
                await startInteractiveArtifactAdd(ctx);
                return;
            }
        }

        // SUBCOMMAND: $artifact merge <old> | <new>
        if (arg.toLowerCase().startsWith('merge') || arg.toLowerCase().startsWith('unisci')) {
            const content = arg.replace(/^(merge|unisci)\s*/i, '').trim();

            const mergeConfig: MergeConfig = {
                entityTypeKey: 'entity.artifact',
                emoji: '✨',
                campaignId: ctx.activeCampaign!.id,
                listEntities: (cid) => listAllArtifacts(cid).map(a => ({
                    id: a.name,
                    shortId: a.short_id || '?????',
                    name: a.name,
                    description: a.description || '',
                    metadata: a.status || ''
                })),
                resolveEntity: (cid, query) => {
                    const art = resolveEntity(artifactSpec, cid, query);
                    if (!art) return null;
                    return {
                        id: art.name,
                        shortId: art.short_id || '?????',
                        name: art.name,
                        description: art.description || '',
                        metadata: art.status || ''
                    };
                },
                executeMerge: async (cid, source, target, mergedDesc) => {
                    return mergeArtifacts(cid, source.name as string, target.name as string, mergedDesc || undefined);
                }
            };

            await startInteractiveMerge(ctx, mergeConfig, content);
            return;
        }

        // SUBCOMMAND: $artifact [name/#id] events [page]
        const trailingEvents = matchTrailingEvents(arg);
        if (trailingEvents) {
            const found = await showEventsByIdentifier(ctx, artifactSpec, trailingEvents.identifier, trailingEvents.page);
            if (!found) {
                await ctx.message.reply(notFoundMessage(artifactSpec, trailingEvents.identifier, ctx.locale));
            }
            return;
        }

        // DEFAULT or VIEW: $artifact [list] or $artifact <name/#id>
        if (!arg || arg.toLowerCase() === 'list' || arg.toLowerCase() === 'lista') {
            const artifacts = listAllArtifacts(ctx.activeCampaign!.id);

            await runPaginatedEntityList(ctx, {
                perPage: 10,
                fetchPage: (page, perPage) => ({
                    items: artifacts.slice(page * perPage, (page + 1) * perPage),
                    total: artifacts.length
                }),
                buildEmbed: (items, page, totalPages) => {
                    const lines = items.map(a => {
                        const statusDisplay = getStatusDisplay(a.status, ctx.locale);
                        const cursedTag = a.is_cursed ? ' ☠️' : '';
                        return `${statusDisplay.icon} **${a.name}**${cursedTag} \`#${a.short_id}\``;
                    });

                    return new EmbedBuilder()
                        .setTitle(t(ctx.locale, 'artifact.listTitle', { count: artifacts.length }))
                        .setColor("#9932CC")
                        .setDescription(lines.join('\n'))
                        .setFooter({ text: t(ctx.locale, 'artifact.listFooter', { page: page + 1, total: totalPages }) });
                },
                emptyEmbed: () => t(ctx.locale, 'artifact.empty'),
                buildDetailEmbed: generateArtifactDetailEmbed,
                selectOption: (a) => ({
                    label: a.name,
                    description: `#${a.short_id} - ${getStatusDisplay(a.status, ctx.locale).label}`,
                    emoji: getStatusDisplay(a.status, ctx.locale).icon
                }),
                resolveSelected: (name) => getArtifactByName(ctx.activeCampaign!.id, name),
                detailEphemeral: true
            });
            return;
        }

        // View specific artifact by name or ID
        const artifact = resolveEntity(artifactSpec, ctx.activeCampaign!.id, arg);
        if (!artifact) {
            await ctx.message.reply(t(ctx.locale, 'artifact.notFound', { artifact: arg }));
            return;
        }

        await ctx.message.reply({ embeds: [generateArtifactDetailEmbed(artifact)] });
    }
};

function isAffirmative(value: string): boolean {
    return ['true', '1', 'yes', 'y', 'sì', 'si', 'sí', 'oui', 'ja', 'sim'].includes(value.trim().toLowerCase());
}
