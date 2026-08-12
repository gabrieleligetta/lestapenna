/**
 * $npc / $dossier command - NPC management with many subcommands
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    listNpcs,
    countNpcs,
    getNpcEntry,
    getNpcHistory,
    updateNpcEntry,
    renameNpcEntry,
    updateNpcFields,
    migrateKnowledgeFragments,
    markNpcDirty,
    getSessionEncounteredNPCs,
    addNpcAlias,
    removeNpcAlias,
    db,
    addNpcEvent,
    getNpcByShortId,
    factionRepository
} from '../../db';
import {
    smartMergeBios,
    syncNpcDossierIfNeeded,
    syncAllDirtyNpcs,
    mergeNpcsByName
} from '../../bard';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { assertSessionInActiveCampaign } from '../utils/sessionScope';
import { parseShortId } from '../../utils/shortId';
import { safeReply } from '../../utils/discordHelper';
import { formatAlignmentSpectrum } from '../../utils/alignmentUtils';
import { showEntityEvents } from '../utils/eventsViewer';
import { handleEventsAction } from '../utils/eventsSubcommand';
import { startInteractiveNpcAdd, startInteractiveNpcUpdate, startInteractiveNpcDelete, startInteractiveEventsAdd, startInteractiveEventsUpdate, startInteractiveEventsDelete } from './interactiveUpdate';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';
import { t, eventTypeLabel, getCampaignLocale } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';
import { assertCampaignWrite } from '../utils/campaignWrite';

export const npcCommand: Command = {
    name: 'npc',
    category: 'entita',
    descriptionKey: 'help.cmd.npc',
    aliases: ['dossier'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const firstArg = ctx.args[0];
        const argsStr = ctx.args.join(' ');
        const subCommand = firstArg?.toLowerCase();

        // 🆕 Interactive Subcommands
        if (subCommand === 'add') { await startInteractiveNpcAdd(ctx); return; }
        if (subCommand === 'update') { await startInteractiveNpcUpdate(ctx); return; }
        if (subCommand === 'delete') { await startInteractiveNpcDelete(ctx); return; }

        // 🆕 Events Subcommand: $npc events [action] [nome/ID] [pagina]
        if (subCommand === 'events') {
            const remainder = ctx.args.slice(1);

            const handled = await handleEventsAction(ctx, remainder, {
                tableName: 'npc_history',
                entityKeyColumn: 'npc_name',
                emoji: '👤',
                labelKey: 'entity.npc',
                resolve: (campaignId, identifier) => {
                    const sid = parseShortId(identifier.trim().split(/\s+/)[0]);
                    const npc = getNpcEntry(campaignId, identifier) || (sid ? getNpcByShortId(campaignId, sid) : null);
                    return npc ? { keyValue: npc.name, displayName: npc.name, entityId: npc.id ?? null } : null;
                },
                interactive: {
                    ADD: startInteractiveEventsAdd,
                    UPDATE: startInteractiveEventsUpdate,
                    DELETE: startInteractiveEventsDelete,
                }
            });
            if (handled) return;

            const target = remainder.join(' ').trim().toLowerCase();

            if (remainder.length === 0 || target === 'list' || target === 'lista') {
                await startEventsInteractiveSelection(ctx);
                return;
            }

            // Try to parse page number at the end
            let page = 1;
            let npcTarget = remainder.join(' ');
            const lastArg = remainder[remainder.length - 1];
            if (remainder.length > 1 && !isNaN(parseInt(lastArg))) {
                page = parseInt(lastArg);
                npcTarget = remainder.slice(0, -1).join(' ');
            }

            const found = await showNpcEventsByIdentifier(ctx, npcTarget, page);
            if (!found) {
                await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name: npcTarget }));
            }
            return;
        }

        const generateDossierEmbed = (npc: any) => {
            const statusIcon = npc.status === 'DEAD' ? '💀' : npc.status === 'MISSING' ? '❓' : '👤';
            const statusColor = npc.status === 'DEAD' ? "#FF0000" : npc.status === 'MISSING' ? "#FFFF00" : "#00FF00";

            const embed = new EmbedBuilder()
                .setTitle(`${statusIcon} ${npc.name}`)
                .setColor(statusColor)
                .setDescription(npc.description || t(ctx.locale, 'npc.noNotes'))
                .addFields(
                    { name: t(ctx.locale, 'npc.fieldRole'), value: npc.role || t(ctx.locale, 'npc.unknownRole'), inline: true },
                    { name: t(ctx.locale, 'npc.fieldStatus'), value: npc.status ? eventTypeLabel(ctx.locale, npc.status) : t(ctx.locale, 'enum.ALIVE'), inline: true },
                    { name: "ID", value: `\`#${npc.short_id}\``, inline: true }
                );

            if (npc.aliases) {
                embed.addFields({ name: t(ctx.locale, 'npc.fieldAliases'), value: npc.aliases.split(',').join(', ') });
            }

            // 🆕 Alignment - Visual spectrum
            if (npc.alignment_moral || npc.alignment_ethical || npc.moral_score || npc.ethical_score) {
                const moralScore = npc.moral_score ?? 0;
                const ethicalScore = npc.ethical_score ?? 0;

                embed.addFields({
                    name: t(ctx.locale, 'npc.fieldAlignment'),
                    value: formatAlignmentSpectrum(ctx.locale, moralScore, ethicalScore),
                    inline: false
                });
            }

            // 🆕 Show faction affiliations
            const factionAffiliations = factionRepository.getEntityFactions('npc', npc.id);
            if (factionAffiliations.length > 0) {
                const factionText = factionAffiliations.map(a => {
                    const roleIcon = a.role === 'LEADER' ? '👑' : a.role === 'ALLY' ? '🤝' : a.role === 'ENEMY' ? '⚔️' : '👤';
                    return `${roleIcon} ${a.faction_name} (${eventTypeLabel(ctx.locale, a.role)})`;
                }).join('\n');
                embed.addFields({ name: t(ctx.locale, 'npc.fieldFactions'), value: factionText });
            }

            const history = getNpcHistory(ctx.activeCampaign!.id, npc.name).slice(-3);
            if (history.length > 0) {
                const historyText = history.map((h: any) => {
                    const typeIcon = h.event_type === 'ALLIANCE' ? '🤝' : h.event_type === 'BETRAYAL' ? '🗡️' : h.event_type === 'DEATH' ? '💀' : '📝';
                    return `${typeIcon} ${h.description}`;
                }).join('\n');
                embed.addFields({ name: t(ctx.locale, 'npc.fieldRecentHistory'), value: historyText });
            }

            embed.setFooter({ text: t(ctx.locale, 'npc.dossierFooter', { shortId: npc.short_id }) });
            return embed;
        };

        // --- SESSION SPECIFIC: $npc <session_id> ---
        if (isSessionId(argsStr)) {
            const sessionId = extractSessionId(argsStr);
            if (!await assertSessionInActiveCampaign(ctx, sessionId)) return;
            const encounteredNPCs = getSessionEncounteredNPCs(sessionId);

            if (encounteredNPCs.length === 0) {
                await ctx.message.reply(t(ctx.locale, 'npc.sessionNone', { id: sessionId }));
                return;
            }

            let msg = t(ctx.locale, 'npc.sessionHeader', { id: sessionId }) + '\n\n';
            encounteredNPCs.forEach((npc: any) => {
                const statusIcon = npc.status === 'DEAD' ? '💀' : npc.status === 'MISSING' ? '❓' : '👤';
                msg += `${statusIcon} **${npc.name}** (${npc.role || '?'}) [${eventTypeLabel(ctx.locale, npc.status)}]\n`;
                if (npc.description) {
                    const preview = npc.description.substring(0, 100) + (npc.description.length > 100 ? '...' : '');
                    msg += `   └ _${preview}_\n`;
                }
            });
            msg += '\n' + t(ctx.locale, 'npc.sessionFooter');

            await safeReply(ctx.message, msg);
            return;
        }

        // SUBCOMMAND: add / create
        if (argsStr.toLowerCase() === 'add' || argsStr.toLowerCase().startsWith('add ') || argsStr.toLowerCase() === 'create' || argsStr.toLowerCase().startsWith('create ') || argsStr.toLowerCase() === 'crea' || argsStr.toLowerCase().startsWith('crea ')) {
            const content = argsStr.replace(/^(add|create|crea)\s*/i, '').trim();
            const parts = content.split('|').map(s => s.trim());

            if (!content) {
                await startInteractiveNpcAdd(ctx);
                return;
            }

            if (parts.length < 3) {
                await ctx.message.reply(t(ctx.locale, 'npc.addUsage'));
                return;
            }

            const [name, role, description] = parts;

            const existing = getNpcEntry(ctx.activeCampaign!.id, name);
            if (existing) {
                await ctx.message.reply(t(ctx.locale, 'npc.alreadyExists', { name }));
                return;
            }

            updateNpcEntry(ctx.activeCampaign!.id, name, description, role, 'ALIVE', undefined, true);
            await ctx.message.reply(t(ctx.locale, 'npc.created', { name, role, description }));
            return;
        }

        // SUBCOMMAND: faction
        if (argsStr.toLowerCase().startsWith('faction ')) {
            const subArgs = argsStr.substring(8).trim();

            // Usage: $npc faction add <NPC> | <Faction> | [Role]
            // Usage: $npc faction remove <NPC> | <Faction>

            if (subArgs.startsWith('add ')) {
                const parts = subArgs.substring(4).split('|').map(s => s.trim());
                if (parts.length < 2) {
                    await ctx.message.reply(t(ctx.locale, 'npc.factionAddUsage'));
                    return;
                }

                let [npcName, factionName, role] = parts;

                // Resolve NPC
                let targetNpc = getNpcEntry(ctx.activeCampaign!.id, npcName);
                if (!targetNpc && npcName.startsWith('#')) {
                    const found = getNpcByShortId(ctx.activeCampaign!.id, npcName);
                    if (found) targetNpc = found;
                }

                if (!targetNpc) {
                    await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name: npcName }));
                    return;
                }

                // Resolve Faction
                let faction = factionRepository.getFaction(ctx.activeCampaign!.id, factionName);
                if (!faction) {
                    faction = factionRepository.createFaction(ctx.activeCampaign!.id, factionName, {
                        isManual: true,
                        description: t(getCampaignLocale(ctx.activeCampaign!.id), 'npc.manualCreationNote')
                    });
                }

                if (!faction) {
                    await ctx.message.reply(t(ctx.locale, 'npc.factionCreateError', { name: factionName }));
                    return;
                }

                const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED'];
                const cleanRole = role ? role.toUpperCase() : 'MEMBER';

                if (!validRoles.includes(cleanRole)) {
                    await ctx.message.reply(t(ctx.locale, 'npc.factionInvalidRole', { roles: validRoles.join(', ') }));
                }

                factionRepository.addAffiliation(faction.id, 'npc', targetNpc.id, {
                    role: (validRoles.includes(cleanRole) ? cleanRole : 'MEMBER') as any,
                    notes: t(getCampaignLocale(ctx.activeCampaign!.id), 'npc.manualAffiliationNote')
                });

                await ctx.message.reply(t(ctx.locale, 'npc.factionAdded', { npc: targetNpc.name, faction: faction.name, role: cleanRole }));
                markNpcDirty(ctx.activeCampaign!.id, targetNpc.name);
                return;

            } else if (subArgs.startsWith('remove ')) {
                const parts = subArgs.substring(7).split('|').map(s => s.trim());
                if (parts.length < 2) {
                    await ctx.message.reply(t(ctx.locale, 'npc.factionRemoveUsage'));
                    return;
                }

                let [npcName, factionName] = parts;

                // Resolve NPC
                let targetNpc = getNpcEntry(ctx.activeCampaign!.id, npcName);
                if (!targetNpc && npcName.startsWith('#')) {
                    const found = getNpcByShortId(ctx.activeCampaign!.id, npcName);
                    if (found) targetNpc = found;
                }

                if (!targetNpc) {
                    await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name: npcName }));
                    return;
                }

                const faction = factionRepository.getFaction(ctx.activeCampaign!.id, factionName);
                if (!faction) {
                    await ctx.message.reply(t(ctx.locale, 'npc.factionNotFound', { name: factionName }));
                    return;
                }

                const success = factionRepository.removeAffiliation(faction.id, 'npc', targetNpc.id);
                if (success) {
                    await ctx.message.reply(t(ctx.locale, 'npc.factionRemoved', { npc: targetNpc.name, faction: faction.name }));
                    markNpcDirty(ctx.activeCampaign!.id, targetNpc.name);
                } else {
                    await ctx.message.reply(t(ctx.locale, 'npc.factionNoAffiliation', { npc: targetNpc.name, faction: faction.name }));
                }
                return;
            } else {
                await ctx.message.reply(t(ctx.locale, 'npc.factionUsage'));
                return;
            }
        }

        // SUBCOMMAND: merge
        if (argsStr.toLowerCase().startsWith('merge')) {
            const content = argsStr.substring(5).trim();

            const mergeConfig: MergeConfig = {
                entityTypeKey: 'entity.npc',
                emoji: '👤',
                campaignId: ctx.activeCampaign!.id,
                listEntities: (cid) => listNpcs(cid, 100, 0).map(n => ({
                    id: n.name,
                    shortId: n.short_id || '?????',
                    name: n.name,
                    description: n.description || '',
                    metadata: n.role || ''
                })),
                resolveEntity: (cid, query) => {
                    const sidMatch = query.match(/^#([a-z0-9]{5})$/i);
                    let npc = null;
                    if (sidMatch) {
                        npc = getNpcByShortId(cid, sidMatch[1]);
                    } else {
                        npc = getNpcEntry(cid, query);
                    }
                    if (!npc) return null;
                    return {
                        id: npc.name,
                        shortId: npc.short_id || '?????',
                        name: npc.name,
                        description: npc.description || '',
                        metadata: npc.role || ''
                    };
                },
                executeMerge: async (cid, source, target, mergedDesc) => {
                    // Logic extracted into bard/reconciliation/merge.ts#mergeNpcsByName so it is
                    // reused by the web app's HTTP path. It also covers migrateRagNpcReferences
                    // (associated_entity_ids npc:OLD→NEW) and short_id/manual propagation.
                    const report = await mergeNpcsByName(
                        cid,
                        source.name as string,
                        target.name as string,
                        { mergedDescription: mergedDesc || undefined }
                    );
                    return report !== null;
                }
            };

            await startInteractiveMerge(ctx, mergeConfig, content);
            return;
        }

        // SUBCOMMAND: delete
        if (argsStr.toLowerCase().startsWith('delete ')) {
            let name = argsStr.substring(7).trim();

            // ID Resolution
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (npc) name = npc.name;
            }

            const target = getNpcEntry(ctx.activeCampaign!.id, name);
            if (!target) {
                await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name }));
                return;
            }

            if (!await assertCampaignWrite(ctx)) return;
            await ctx.message.reply(t(ctx.locale, 'npc.deleting', { name }));

            // Cascade shared with the web CRUD: record + history + RAG memory +
            // affiliations + image. There used to be three manual calls here, and
            // the faction affiliations were left orphaned anyway.
            const outcome = await deleteEntityFromCommand(ctx, 'npcs', target);
            if (outcome.denied) return;

            if (outcome.ok) {
                await ctx.message.reply(
                    t(ctx.locale, 'npc.deleted', { name }) + deleteSummaryLine(ctx.locale, outcome.report),
                );
            } else {
                await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name }));
            }
            return;
        }

        // SUBCOMMAND: alias
        if (argsStr.toLowerCase().startsWith('alias ')) {
            const parts = argsStr.substring(6).split('|').map(s => s.trim());

            if (parts.length < 2) {
                const npc = getNpcEntry(ctx.activeCampaign!.id, parts[0]);
                if (!npc) {
                    await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name: parts[0] }));
                    return;
                }

                const aliases = npc.aliases?.split(',').filter(a => a.trim()) || [];
                if (aliases.length === 0) {
                    await ctx.message.reply(t(ctx.locale, 'npc.aliasNone', { name: npc.name }));
                } else {
                    await ctx.message.reply(
                        t(ctx.locale, 'npc.aliasListHeader', { name: npc.name }) + '\n' +
                        aliases.map(a => `• ${a.trim()}`).join('\n') +
                        '\n\n' + t(ctx.locale, 'npc.aliasHint')
                    );
                }
                return;
            }

            const [npcName, action, alias] = parts;
            const npc = getNpcEntry(ctx.activeCampaign!.id, npcName);
            if (!npc) {
                await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name: npcName }));
                return;
            }

            if (action.toLowerCase() === 'add') {
                if (!alias) {
                    await ctx.message.reply(t(ctx.locale, 'npc.aliasAddUsage'));
                    return;
                }

                const success = addNpcAlias(ctx.activeCampaign!.id, npc.name, alias);
                if (success) {
                    await ctx.message.reply(t(ctx.locale, 'npc.aliasAdded', { alias, name: npc.name }));
                } else {
                    await ctx.message.reply(t(ctx.locale, 'npc.aliasExists', { alias, name: npc.name }));
                }
                return;
            }

            if (action.toLowerCase() === 'remove' || action.toLowerCase() === 'del') {
                if (!alias) {
                    await ctx.message.reply(t(ctx.locale, 'npc.aliasRemoveUsage'));
                    return;
                }

                const success = removeNpcAlias(ctx.activeCampaign!.id, npc.name, alias);
                if (success) {
                    await ctx.message.reply(t(ctx.locale, 'npc.aliasRemoved', { alias, name: npc.name }));
                } else {
                    await ctx.message.reply(t(ctx.locale, 'npc.aliasNotFound', { alias, name: npc.name }));
                }
                return;
            }

            await ctx.message.reply(t(ctx.locale, 'npc.aliasInvalidAction'));
            return;
        }

        // SUBCOMMAND: update
        // SUBCOMMAND: update
        if (argsStr.toLowerCase().startsWith('update')) {
            const content = argsStr.substring(7).trim();

            if (!content) {
                await startInteractiveNpcUpdate(ctx);
                return;
            }

            if (content.includes('|')) {
                // Type 1: Narrative Update
                const parts = content.split('|').map(s => s.trim());
                if (parts.length < 2) {
                    await startInteractiveNpcUpdate(ctx);
                    return;
                }
                let name = parts[0];
                const note = parts.slice(1).join('|').trim();

                // ID Resolution
                const sidMatchArea = name.match(/^#?([a-z0-9]{5})$/i);

                if (sidMatchArea) {
                    const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatchArea[1]);
                    if (npc) name = npc.name;
                }

                const npc = getNpcEntry(ctx.activeCampaign!.id, name);
                if (!npc) {
                    await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name }));
                    return;
                }

                const loadingMsg = await ctx.message.reply(t(ctx.locale, 'npc.addingNote', { name }));

                const eventDesc = `[NOTA DM] ${note}`;
                addNpcEvent(ctx.activeCampaign!.id, npc.name, 'MANUAL', eventDesc, 'DM_NOTE', true);

                // Trigger regen
                const newDesc = await syncNpcDossierIfNeeded(ctx.activeCampaign!.id, npc.name, true);

                await loadingMsg.edit(t(ctx.locale, 'npc.noteAdded', { bio: `${newDesc ? newDesc.substring(0, 500) : ''}${newDesc && newDesc.length > 500 ? '...' : ''}` }));
                return;
            } else {
                // Type 2: Metadata Update
                let name = '';
                let fieldKey = '';
                let value = '';

                // Case A: Explicit 'field:' syntax
                const fieldLower = content.toLowerCase();
                const fieldIndex = fieldLower.indexOf('field:');

                if (fieldIndex !== -1) {
                    name = content.substring(0, fieldIndex).trim();
                    const remainder = content.substring(fieldIndex); // field:status DEAD
                    const firstSpace = remainder.indexOf(' ');

                    if (firstSpace === -1) {
                        await ctx.message.reply(t(ctx.locale, 'npc.missingValue'));
                        return;
                    }

                    fieldKey = remainder.substring(6, firstSpace).toLowerCase(); // remove field:
                    value = remainder.substring(firstSpace + 1).trim();
                } else {
                    // Case B: Implicit simplified syntax (e.g. "zpvbh status DEAD")
                    // Regex helps find known keywords preceded by space
                    const keywordMatch = content.match(/\s+(status|role|ruolo|name|nome|desc|description|moral|morale|ethical|ethic|etica|faction|fazione)\s+/i);

                    if (keywordMatch && keywordMatch.index !== undefined) {
                        name = content.substring(0, keywordMatch.index).trim();
                        fieldKey = keywordMatch[1].toLowerCase();
                        value = content.substring(keywordMatch.index + keywordMatch[0].length).trim();
                    } else {
                        // Assume the whole content is the name/ID (show help for this NPC)
                        name = content.trim();
                    }
                }

                // ID Resolution
                const sidMatchMeta = name.match(/^#?([a-z0-9]{5})$/i);

                let resolvedName = name;
                if (sidMatchMeta) {
                    const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatchMeta[1]);
                    if (npc) resolvedName = npc.name;
                }

                const npc = getNpcEntry(ctx.activeCampaign!.id, resolvedName);
                if (!npc) {
                    if (fieldKey) {
                        await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name }));
                    } else {
                        await ctx.message.reply(t(ctx.locale, 'npc.updateUsage'));
                    }
                    return;
                }

                // If found NPC but no action, show context
                if (!fieldKey || !value) {
                    await ctx.message.reply(t(ctx.locale, 'npc.updateContext', {
                        name: npc.name,
                        status: npc.status ? eventTypeLabel(ctx.locale, npc.status) : '—',
                        role: npc.role || t(ctx.locale, 'npc.noRoleValue'),
                        shortId: npc.short_id || '',
                    }));
                    return;
                }

                const updates: any = {};
                if (fieldKey === 'name' || fieldKey === 'nome') {
                    updates.name = value;
                } else if (fieldKey === 'role' || fieldKey === 'ruolo') {
                    updates.role = value;
                } else if (fieldKey === 'status') {
                    updates.status = value.toUpperCase();
                } else if (fieldKey === 'desc' || fieldKey === 'description') {
                    updates.description = value;
                } else if (fieldKey === 'moral' || fieldKey === 'morale') {
                    // updates.alignment_moral = value.toUpperCase();
                    await ctx.message.reply(t(ctx.locale, 'npc.alignmentAutoMoral'));
                    return;
                } else if (fieldKey === 'ethical' || fieldKey === 'ethic' || fieldKey === 'etica') {
                    // updates.alignment_ethical = value.toUpperCase();
                    await ctx.message.reply(t(ctx.locale, 'npc.alignmentAutoEthical'));
                    return;
                } else if (fieldKey === 'faction' || fieldKey === 'fazione') {
                    // Special handling for faction relations
                    const [factionName, roleInput] = value.split('|').map(s => s.trim());

                    let faction = factionRepository.getFaction(ctx.activeCampaign!.id, factionName);
                    if (!faction) {
                        faction = factionRepository.createFaction(ctx.activeCampaign!.id, factionName, {
                            isManual: true,
                            description: t(getCampaignLocale(ctx.activeCampaign!.id), 'npc.manualCreationNote')
                        });
                    }

                    if (faction) {
                        const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED'];
                        const role = roleInput ? roleInput.toUpperCase() : 'MEMBER';
                        const finalRole = validRoles.includes(role) ? role : 'MEMBER';

                        factionRepository.addAffiliation(faction.id, 'npc', npc.id, {
                            role: finalRole as any,
                            notes: t(getCampaignLocale(ctx.activeCampaign!.id), 'npc.quickUpdateNote')
                        });

                        await ctx.message.reply(t(ctx.locale, 'npc.factionAdded', { npc: npc.name, faction: faction.name, role: finalRole }));
                        markNpcDirty(ctx.activeCampaign!.id, npc.name);
                        return;
                    } else {
                        await ctx.message.reply(t(ctx.locale, 'npc.factionCreateError', { name: factionName }));
                        return;
                    }
                } else {
                    await ctx.message.reply(t(ctx.locale, 'npc.invalidField'));
                    return;
                }

                const success = updates.name
                    ? renameNpcEntry(ctx.activeCampaign!.id, resolvedName, updates.name)
                    : updateNpcFields(ctx.activeCampaign!.id, resolvedName, updates);

                if (success) {
                    if (updates.name) {
                        migrateKnowledgeFragments(ctx.activeCampaign!.id, resolvedName, updates.name);
                        markNpcDirty(ctx.activeCampaign!.id, updates.name);
                        await ctx.message.reply(t(ctx.locale, 'npc.renamed', { old: resolvedName, new: updates.name }));
                        return;
                    }
                    await ctx.message.reply(t(ctx.locale, 'npc.updated', { name: resolvedName, field: fieldKey, value: updates.status || value }));
                } else {
                    await ctx.message.reply(t(ctx.locale, 'npc.updateError'));
                }
                return;
            }
        }

        // SUBCOMMAND: regen
        if (argsStr.toLowerCase().startsWith('regen')) {
            if (!await assertCampaignWrite(ctx)) return;
            const arg = argsStr.substring(6).trim();

            // regen <session_id> — regenerates the bio of every NPC in that session
            if (isSessionId(arg)) {
                const sessionId = extractSessionId(arg);
                if (!await assertSessionInActiveCampaign(ctx, sessionId)) return;
                const npcs = getSessionEncounteredNPCs(sessionId);

                if (npcs.length === 0) {
                    await ctx.message.reply(t(ctx.locale, 'npc.regenSessionNone', { id: sessionId }));
                    return;
                }

                const loadingMsg = await ctx.message.reply(t(ctx.locale, 'npc.regenBatchStart', { n: npcs.length, id: sessionId }));

                let successCount = 0;
                let errorCount = 0;

                for (const npc of npcs) {
                    try {
                        await syncNpcDossierIfNeeded(ctx.activeCampaign!.id, npc.name, true);
                        successCount++;
                    } catch (e) {
                        errorCount++;
                        console.error(`[NPC Regen] Errore per ${npc.name}:`, e);
                    }
                }

                const status = errorCount === 0
                    ? t(ctx.locale, 'npc.regenBatchDone', { ok: successCount, total: npcs.length })
                    : t(ctx.locale, 'npc.regenBatchErrors', { ok: successCount, failed: errorCount });

                await loadingMsg.edit(status);
                return;
            }

            // regen <nome> — rigenera bio di un singolo NPC
            const npc = getNpcEntry(ctx.activeCampaign!.id, arg);
            if (!npc) {
                await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name: arg }));
                return;
            }

            const loadingMsg = await ctx.message.reply(t(ctx.locale, 'npc.regenStart', { name: arg }));

            const newDesc = await syncNpcDossierIfNeeded(
                ctx.activeCampaign!.id,
                npc.name,
                true
            );

            if (newDesc) {
                await loadingMsg.delete().catch(() => { });
                await safeReply(ctx.message, t(ctx.locale, 'npc.regenDone', { bio: newDesc }));
            } else {
                await loadingMsg.edit(t(ctx.locale, 'npc.regenError'));
            }
            return;
        }

        // SUBCOMMAND: sync
        if (argsStr.toLowerCase().startsWith('sync')) {
            const name = argsStr.substring(5).trim();

            if (!name || name === 'all') {
                const loadingMsg = await ctx.message.reply(t(ctx.locale, 'npc.syncBatchStart'));
                const count = await syncAllDirtyNpcs(ctx.activeCampaign!.id);

                if (count > 0) {
                    await loadingMsg.edit(t(ctx.locale, 'npc.syncBatchDone', { n: count }));
                } else {
                    await loadingMsg.edit(t(ctx.locale, 'npc.syncAllClean'));
                }
            } else {
                const npc = getNpcEntry(ctx.activeCampaign!.id, name);
                if (!npc) {
                    await ctx.message.reply(t(ctx.locale, 'npc.notFound', { name }));
                    return;
                }

                const loadingMsg = await ctx.message.reply(t(ctx.locale, 'npc.syncStart', { name }));
                await syncNpcDossierIfNeeded(ctx.activeCampaign!.id, name, true);
                await loadingMsg.edit(t(ctx.locale, 'npc.syncDone', { name }));
            }
            return;
        }

        // SUBCOMMAND: events - $npc <name/#id> events [page]
        // Pattern: something events [page]
        const eventsMatch = argsStr.match(/^(.+?)\s+events(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            const target = eventsMatch[1].trim();
            const page = eventsMatch[2] ? parseInt(eventsMatch[2]) : 1;

            const found = await showNpcEventsByIdentifier(ctx, target, page);
            if (found) return;
            // If not found, fall through - maybe it's an NPC named "something events"?
        }

        // SETTER: $npc Nome | Descrizione
        if (argsStr.includes('|')) {
            const [name, desc] = argsStr.split('|').map(s => s.trim());
            updateNpcEntry(ctx.activeCampaign!.id, name, desc, undefined, undefined, undefined, true);
            await ctx.message.reply(t(ctx.locale, 'npc.sheetUpdated', { name }));
            return;
        }

        // --- GETTER: $npc Nome / #abcde ---
        // Check if it's a list command first
        if (!firstArg || firstArg === 'list' || firstArg === 'lista') {
            // Check if user specifically asked for events list
            if (ctx.args.includes('events')) {
                await startEventsInteractiveSelection(ctx);
                return;
            }

            let initialPage = 1;
            if (argsStr) {
                const listParts = argsStr.split(' ');
                if (listParts.length > 1 && !isNaN(parseInt(listParts[1]))) {
                    initialPage = parseInt(listParts[1]);
                }
            }

            const ITEMS_PER_PAGE = 5;
            let currentPage = Math.max(0, initialPage - 1);

            const generateEmbed = (page: number) => {
                const offset = page * ITEMS_PER_PAGE;
                const npcs = listNpcs(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);
                const total = countNpcs(ctx.activeCampaign!.id);
                const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

                if (npcs.length === 0 && total > 0 && page > 0) {
                    return { embed: new EmbedBuilder().setDescription(t(ctx.locale, 'npc.pageNotExist')), totalPages: Math.ceil(total / ITEMS_PER_PAGE) };
                }

                if (total === 0) {
                    return { embed: new EmbedBuilder().setDescription(t(ctx.locale, 'npc.archiveEmpty')), totalPages: 0 };
                }

                const list = npcs.map((n: any) => {
                    const statusIcon = n.status === 'DEAD' ? '💀' : n.status === 'MISSING' ? '❓' : '👤';
                    const descPreview = (n.description && n.description.trim().length > 0)
                        ? `\n> *${n.description.substring(0, 80)}${n.description.length > 80 ? '...' : ''}*`
                        : '';
                    return `\`#${n.short_id}\` ${statusIcon} **${n.name}** (${n.role || '?'}) [${eventTypeLabel(ctx.locale, n.status)}]${descPreview}`;
                }).join('\n\n');

                const embed = new EmbedBuilder()
                    .setTitle(t(ctx.locale, 'npc.listTitle', { campaign: ctx.activeCampaign?.name || '' }))
                    .setColor("#E67E22")
                    .setDescription(list)
                    .setFooter({ text: t(ctx.locale, 'npc.listFooter', { page: page + 1, total: totalPages, n: total }) });

                return { embed, totalPages };
            };

            const generateButtons = (page: number, totalPages: number) => {
                const row = new ActionRowBuilder<ButtonBuilder>();
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page')
                        .setLabel(t(ctx.locale, 'common.prevButton'))
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel(t(ctx.locale, 'common.nextButton'))
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1)
                );
                return row;
            };

            const generateSelectMenu = (npcs: any[]) => {
                if (npcs.length === 0) return null;

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_npc')
                    .setPlaceholder(t(ctx.locale, 'npc.selectPlaceholder'))
                    .addOptions(
                        npcs.map((n: any) =>
                            new StringSelectMenuOptionBuilder()
                                .setLabel(n.name)
                                .setDescription(n.role || t(ctx.locale, 'npc.noRole'))
                                .setValue(n.name)
                                .setEmoji(n.status === 'DEAD' ? '💀' : n.status === 'MISSING' ? '❓' : '👤')
                        )
                    );

                return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
            };

            const initialData = generateEmbed(currentPage);
            const offset = currentPage * ITEMS_PER_PAGE;
            const currentNpcs = listNpcs(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);

            if (initialData.totalPages === 0 || !initialData.embed.data.title) {
                await ctx.message.reply({ embeds: [initialData.embed] });
                return;
            }

            const components: any[] = [];
            if (initialData.totalPages > 1) components.push(generateButtons(currentPage, initialData.totalPages));
            const selectMenuRow = generateSelectMenu(currentNpcs);
            if (selectMenuRow) components.push(selectMenuRow);

            const reply = await ctx.message.reply({
                embeds: [initialData.embed],
                components
            });

            if (initialData.totalPages > 1 || currentNpcs.length > 0) {
                const collector = reply.createMessageComponentCollector({
                    time: 60000 * 5 // 5 minutes
                });

                collector.on('collect', async (interaction: MessageComponentInteraction) => {
                    if (interaction.user.id !== ctx.message.author.id) {
                        await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
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
                        const newNpcs = listNpcs(ctx.activeCampaign!.id, ITEMS_PER_PAGE, newOffset);

                        const newComponents: any[] = [];
                        if (newData.totalPages > 1) newComponents.push(generateButtons(currentPage, newData.totalPages));
                        const newSelectRow = generateSelectMenu(newNpcs);
                        if (newSelectRow) newComponents.push(newSelectRow);

                        await interaction.update({
                            embeds: [newData.embed],
                            components: newComponents
                        });
                    } else if (interaction.isStringSelectMenu()) {
                        if (interaction.customId === 'select_npc') {
                            const selectedName = interaction.values[0];
                            const npc = getNpcEntry(ctx.activeCampaign!.id, selectedName);
                            if (npc) {
                                const dossierEmbed = generateDossierEmbed(npc);
                                await interaction.reply({ embeds: [dossierEmbed] });
                            } else {
                                await interaction.reply({ content: t(ctx.locale, 'npc.notFoundShort'), ephemeral: true });
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

        // Specific NPC View
        let searchName = argsStr;
        const sidMatchFinal = argsStr.match(/^#([a-z0-9]{5})$/i);
        if (sidMatchFinal) {
            const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatchFinal[1]);
            if (npc) searchName = npc.name;
        }

        const npc = getNpcEntry(ctx.activeCampaign!.id, searchName);
        if (!npc) {
            await ctx.message.reply(t(ctx.locale, 'npc.notFoundShort'));
            return;
        }

        const dossierEmbed = generateDossierEmbed(npc);
        await ctx.message.reply({ embeds: [dossierEmbed] });
    }
};

/**
 * Helper to show events for an NPC by name or ID
 */
async function showNpcEventsByIdentifier(ctx: CommandContext, identifier: string, page: number = 1): Promise<boolean> {
    let npcIdentifier = identifier.trim();

    // Resolve short ID (with or without #, tolerates uppercase)
    const sid = parseShortId(npcIdentifier);
    if (sid) {
        const npc = getNpcByShortId(ctx.activeCampaign!.id, sid);
        if (npc) npcIdentifier = npc.name;
        else if (npcIdentifier.startsWith('#')) {
            await ctx.message.reply(t(ctx.locale, 'npc.notFoundById', { id: sid }));
            return true;
        }
    }

    // Verify NPC exists
    const npc = getNpcEntry(ctx.activeCampaign!.id, npcIdentifier);
    if (!npc) return false;

    await showEntityEvents(ctx, {
        tableName: 'npc_history',
        entityKeyColumn: 'npc_name',
        entityKeyValue: npc.name,
        campaignId: ctx.activeCampaign!.id,
        entityDisplayName: npc.name,
        entityEmoji: '👤',
        entityId: npc.id ?? null
    }, page);
    return true;
}

/**
 * Interactive selection for NPC events
 */
async function startEventsInteractiveSelection(ctx: CommandContext) {
    const ITEMS_PER_PAGE = 25;
    const npcs = listNpcs(ctx.activeCampaign!.id, ITEMS_PER_PAGE, 0);
    const total = countNpcs(ctx.activeCampaign!.id);

    if (total === 0) {
        await ctx.message.reply(t(ctx.locale, 'npc.archiveEmpty'));
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(t(ctx.locale, 'npc.eventsSelTitle'))
        .setColor("#9B59B6")
        .setDescription(t(ctx.locale, 'npc.eventsSelDesc'));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_npc_events')
        .setPlaceholder(t(ctx.locale, 'npc.selectPlaceholderShort'))
        .addOptions(
            npcs.map((n: any) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(n.name)
                    .setDescription(n.role || t(ctx.locale, 'npc.noRole'))
                    .setValue(n.name)
                    .setEmoji(n.status === 'DEAD' ? '💀' : n.status === 'MISSING' ? '❓' : '👤')
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const reply = await ctx.message.reply({
        embeds: [embed],
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000 * 5
    });

    collector.on('collect', async (interaction: MessageComponentInteraction) => {
        if (interaction.user.id !== ctx.message.author.id) {
            await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'select_npc_events') {
            const selectedName = interaction.values[0];
            const npc = getNpcEntry(ctx.activeCampaign!.id, selectedName);
            if (npc) {
                await interaction.update({ content: t(ctx.locale, 'npc.showingEvents', { name: npc.name }), embeds: [], components: [] });
                await showNpcEventsByIdentifier(ctx, npc.name, 1);
            }
        }
    });
}
