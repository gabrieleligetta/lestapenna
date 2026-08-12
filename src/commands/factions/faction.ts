/**
 * $faction command - Faction management with subcommands
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    factionRepository,
    npcRepository,
    locationRepository,
    campaignRepository,
    db
} from '../../db';
import { FactionEntry, ReputationLevel, REPUTATION_SPECTRUM } from '../../db/types';
import { syncFactionEntryIfNeeded, syncAllDirtyFactions } from '../../bard';
import { safeReply } from '../../utils/discordHelper';
import { showEntityEvents } from '../utils/eventsViewer';
import { handleEventsAction } from '../utils/eventsSubcommand';
import { parseShortId } from '../../utils/shortId';
import { startInteractiveFactionUpdate, startInteractiveFactionAdd, startInteractiveFactionDelete } from './interactiveUpdate';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';
import { formatAlignmentSpectrum } from '../../utils/alignmentUtils';
import { t, eventTypeLabel, getCampaignLocale } from '../../i18n';
import { deleteEntityFromCommand, deleteSummaryLine } from '../utils/entityDelete';

// Helper: Get NPC by ID (for internal use)
function getNpcById(npcId: number): { id: number; name: string; role?: string } | null {
    return db.prepare(`SELECT id, name, role FROM npc_dossier WHERE id = ?`).get(npcId) as any;
}

// Helper: Get Atlas entry by ID
function getAtlasEntryById(entryId: number): { id: number; macro_location: string; micro_location: string; short_id: string } | null {
    return db.prepare(`SELECT id, macro_location, micro_location, short_id FROM location_atlas WHERE id = ?`).get(entryId) as any;
}

const REPUTATION_ICONS: Record<ReputationLevel, string> = {
    'HOSTILE': '🔴',
    'DISTRUSTFUL': '🟠',
    'COLD': '🟡',
    'NEUTRAL': '⚪',
    'CORDIAL': '🟢',
    'FRIENDLY': '💚',
    'ALLIED': '⭐'
};

export const FACTION_TYPE_ICONS: Record<string, string> = {
    'PARTY': '🎭',
    'GUILD': '🛡️',
    'KINGDOM': '👑',
    'CULT': '🕯️',
    'ORGANIZATION': '🏛️',
    'GENERIC': '⚔️'
};

export const factionCommand: Command = {
    name: 'faction',
    category: 'entita',
    descriptionKey: 'help.cmd.faction',
    aliases: ['fazione', 'fazioni'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const campaignId = ctx.activeCampaign!.id;
        const firstArg = ctx.args[0];
        const argsStr = ctx.args.join(' ');

        if (firstArg?.toLowerCase() === 'delete') {
            await startInteractiveFactionDelete(ctx);
            return;
        }

        // 🆕 Events Subcommand: $faction events [action] [Target]
        if (firstArg?.toLowerCase() === 'events' || firstArg?.toLowerCase() === 'eventi') {
            const remainder = ctx.args.slice(1);

            const handled = await handleEventsAction(ctx, remainder, {
                tableName: 'faction_history',
                entityKeyColumn: 'faction_name',
                emoji: '⚔️',
                labelKey: 'entity.faction',
                gender: 'f',
                resolve: (cid, identifier) => {
                    let factionName = identifier;
                    const sid = parseShortId(identifier);
                    if (sid) {
                        const byShort = factionRepository.getFactionByShortId(cid, sid);
                        if (byShort) factionName = byShort.name;
                    }
                    const faction = factionRepository.getFaction(cid, factionName);
                    if (!faction) return null;
                    return {
                        keyValue: faction.name,
                        displayName: faction.name,
                        emoji: FACTION_TYPE_ICONS[faction.type] || '⚔️',
                        entityId: faction.id ?? null
                    };
                }
            });
            if (handled) return;

            const target = remainder.join(' ').trim().toLowerCase();

            if (remainder.length === 0 || target === 'list' || target === 'lista') {
                await startFactionEventsInteractiveSelection(ctx);
                return;
            }

            // Try to parse page number
            let page = 1;
            let factionTarget = remainder.join(' ');
            const lastArg = remainder[remainder.length - 1];
            if (remainder.length > 1 && !isNaN(parseInt(lastArg))) {
                page = parseInt(lastArg);
                factionTarget = remainder.slice(0, -1).join(' ');
            }

            const found = await showFactionEventsByIdentifier(ctx, factionTarget, page);
            if (!found) {
                await ctx.message.reply(t(ctx.locale, 'faction.notFound', { name: factionTarget }));
            }
            return;
        }

        // Helper: Generate faction detail embed
        const generateFactionEmbed = (faction: FactionEntry) => {
            const typeIcon = FACTION_TYPE_ICONS[faction.type] || '⚔️';
            const reputation = factionRepository.getFactionReputation(campaignId, faction.id);
            const repIcon = REPUTATION_ICONS[reputation];
            const members = factionRepository.countFactionMembers(faction.id);

            const embed = new EmbedBuilder()
                .setTitle(`${typeIcon} ${faction.name}${faction.is_party ? t(ctx.locale, 'faction.partyTag') : ''}`)
                .setColor(faction.is_party ? "#FFD700" : "#3498DB")
                .setDescription(faction.description || t(ctx.locale, 'faction.noDesc'));

            // Main info
            embed.addFields(
                { name: t(ctx.locale, 'faction.fieldType'), value: eventTypeLabel(ctx.locale, faction.type), inline: true },
                { name: t(ctx.locale, 'faction.fieldStatus'), value: eventTypeLabel(ctx.locale, faction.status), inline: true },
                { name: "ID", value: `\`#${faction.short_id}\``, inline: true }
            );

            // Reputation (only for non-party factions)
            if (!faction.is_party) {
                embed.addFields({
                    name: t(ctx.locale, 'faction.fieldReputation'),
                    value: `${repIcon} ${eventTypeLabel(ctx.locale, reputation)}`,
                    inline: true
                });
            }

            // 🆕 Alignment - Computed on-demand from faction + member events
            const computed = factionRepository.getComputedFactionAlignment(campaignId, faction.id);
            if (faction.is_party || computed.moralScore !== 0 || computed.ethicalScore !== 0) {
                const spectrumDisplay = formatAlignmentSpectrum(ctx.locale, computed.moralScore, computed.ethicalScore);

                // Add breakdown info if there are contributing members
                let breakdownText = '';
                if (computed.breakdown.memberCount > 0) {
                    const sign = (v: number) => `${v >= 0 ? '+' : ''}${v}`;
                    breakdownText = t(ctx.locale, 'faction.breakdownLine', {
                        fm: sign(computed.breakdown.factionMoral), fe: sign(computed.breakdown.factionEthical),
                        n: computed.breakdown.memberCount,
                        mm: sign(computed.breakdown.membersMoral), me: sign(computed.breakdown.membersEthical),
                    });
                }

                embed.addFields({
                    name: t(ctx.locale, 'npc.fieldAlignment'),
                    value: spectrumDisplay + breakdownText,
                    inline: false
                });
            }

            // Members count
            const memberParts: string[] = [];
            if (members.npcs > 0) memberParts.push(t(ctx.locale, 'faction.membersNpc', { n: members.npcs }));
            if (members.pcs > 0) memberParts.push(t(ctx.locale, 'faction.membersPc', { n: members.pcs }));
            if (members.locations > 0) memberParts.push(t(ctx.locale, 'faction.membersLoc', { n: members.locations }));

            embed.addFields({
                name: t(ctx.locale, 'faction.fieldMembers'),
                value: memberParts.length > 0 ? memberParts.join(', ') : t(ctx.locale, 'faction.noMembers'),
                inline: true
            });

            // Get affiliated NPCs (max 5)
            const npcAffiliations = factionRepository.getFactionMembers(faction.id, 'npc');
            if (npcAffiliations.length > 0) {
                const npcList = npcAffiliations.slice(0, 5).map(a => {
                    const npc = getNpcById(a.entity_id);
                    const roleIcon = a.role === 'LEADER' ? '👑' : a.role === 'ALLY' ? '🤝' : a.role === 'ENEMY' ? '⚔️' : '👤';
                    return `${roleIcon} ${npc?.name || `ID:${a.entity_id}`} (${eventTypeLabel(ctx.locale, a.role)})`;
                }).join('\n');
                embed.addFields({
                    name: t(ctx.locale, 'faction.affiliatedNpcs'),
                    value: npcList + (npcAffiliations.length > 5 ? t(ctx.locale, 'faction.andOthers', { n: npcAffiliations.length - 5 }) : ''),
                    inline: false
                });
            }

            // Get affiliated Locations
            if (faction.headquarters_location_id) {
                const hq = getAtlasEntryById(faction.headquarters_location_id);
                if (hq) {
                    embed.addFields({
                        name: t(ctx.locale, 'faction.hqField'),
                        value: `**${hq.micro_location || hq.macro_location}**` + (hq.macro_location && hq.micro_location ? ` (${hq.macro_location})` : ''),
                        inline: true
                    });
                }
            }

            const locationAffiliations = factionRepository.getFactionMembers(faction.id, 'location');
            if (locationAffiliations.length > 0) {
                const locList = locationAffiliations.slice(0, 5).map(a => {
                    // Try to get location name (assuming entity_id is atlas_id)
                    const loc = getAtlasEntryById(a.entity_id);
                    let locDisplay: string;
                    if (loc) {
                        const parts: string[] = [];
                        if (loc.macro_location) parts.push(loc.macro_location);
                        if (loc.micro_location) parts.push(loc.micro_location);
                        locDisplay = parts.join(' > ') + ` (#${loc.short_id})`;
                    } else {
                        locDisplay = t(ctx.locale, 'faction.locIdNotFound', { id: a.entity_id });
                    }
                    return `📍 ${locDisplay} (${eventTypeLabel(ctx.locale, a.role)})`;
                }).join('\n');
                embed.addFields({
                    name: t(ctx.locale, 'faction.controlledPlaces'),
                    value: locList + (locationAffiliations.length > 5 ? t(ctx.locale, 'faction.andOthers', { n: locationAffiliations.length - 5 }) : ''),
                    inline: false
                });
            }

            // Recent history (max 3)
            const history = factionRepository.getFactionHistory(campaignId, faction.name).slice(-3);
            if (history.length > 0) {
                const historyText = history.map(h => {
                    const typeIcon = h.event_type === 'REPUTATION_CHANGE' ? '📊' :
                        h.event_type === 'MEMBER_JOIN' ? '➕' :
                            h.event_type === 'MEMBER_LEAVE' ? '➖' :
                                h.event_type === 'ALLIANCE' ? '🤝' :
                                    h.event_type === 'CONFLICT' ? '⚔️' : '📝';
                    return `${typeIcon} ${h.description}`;
                }).join('\n');
                embed.addFields({ name: t(ctx.locale, 'npc.fieldRecentHistory'), value: historyText });
            }

            embed.setFooter({ text: t(ctx.locale, 'faction.detailFooter', { shortId: faction.short_id || '' }) });
            return embed;
        };

        // =============================================
        // SUBCOMMAND: create / add / crea
        // =============================================
        if (/^(add|create|crea)(\s|$)/i.test(argsStr)) {
            const content = argsStr.replace(/^(add|create|crea)\s*/i, '').trim();
            const parts = content.split('|').map(s => s.trim());

            if (!content) {
                await startInteractiveFactionAdd(ctx);
                return;
            }

            if (parts.length < 1 || !parts[0]) {
                await ctx.message.reply(t(ctx.locale, 'faction.createUsage'));
                return;
            }

            const name = parts[0];
            const type = (parts[1]?.toUpperCase() || 'GENERIC') as any;
            const description = parts[2] || undefined;

            const validTypes = ['GUILD', 'KINGDOM', 'CULT', 'ORGANIZATION', 'GENERIC'];
            if (!validTypes.includes(type)) {
                await ctx.message.reply(t(ctx.locale, 'faction.invalidType', { types: validTypes.join(', ') }));
                return;
            }

            const existing = factionRepository.getFaction(campaignId, name);
            if (existing) {
                await ctx.message.reply(t(ctx.locale, 'faction.alreadyExists', { name }));
                return;
            }

            const faction = factionRepository.createFaction(campaignId, name, {
                type,
                description,
                isManual: true
            });

            if (faction) {
                const typeIcon = FACTION_TYPE_ICONS[type] || '⚔️';
                await ctx.message.reply(t(ctx.locale, 'faction.created', { icon: typeIcon, name, type: eventTypeLabel(ctx.locale, type), desc: description ? `📜 ${description}` : '' }));
            } else {
                await ctx.message.reply(t(ctx.locale, 'faction.createError'));
            }
            return;
        }

        // =============================================
        // SUBCOMMAND: delete
        // =============================================
        if (/^delete\s/i.test(argsStr)) {
            const name = argsStr.substring(7).trim();

            // Resolve short ID
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);
            let factionName = name;

            if (sidMatch) {
                const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
                if (faction) factionName = faction.name;
            }

            const faction = factionRepository.getFaction(campaignId, factionName);
            if (!faction) {
                await ctx.message.reply(t(ctx.locale, 'faction.notFound', { name: factionName }));
                return;
            }

            if (faction.is_party) {
                await ctx.message.reply(t(ctx.locale, 'faction.cantDeleteParty'));
                return;
            }

            const outcome = await deleteEntityFromCommand(ctx, 'factions', faction);
            if (outcome.denied) return;
            if (outcome.ok) {
                await ctx.message.reply(
                    t(ctx.locale, 'faction.deleted', { name: factionName })
                    + deleteSummaryLine(ctx.locale, outcome.report),
                );
            } else {
                await ctx.message.reply(t(ctx.locale, 'faction.deleteError'));
            }
            return;
        }

        // =============================================
        // SUBCOMMAND: rename
        // =============================================
        if (/^rename\s/i.test(argsStr)) {
            const content = argsStr.substring(7).trim();
            const parts = content.split('|').map(s => s.trim());

            if (parts.length < 2) {
                await ctx.message.reply(t(ctx.locale, 'faction.renameUsage'));
                return;
            }

            let oldName = parts[0];
            const newName = parts[1];

            // Handle "party" as special keyword
            if (oldName.toLowerCase() === 'party') {
                const party = factionRepository.getPartyFaction(campaignId);
                if (party) oldName = party.name;
            }

            // Resolve short ID
            const sidMatch = oldName.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
                if (faction) oldName = faction.name;
            }

            const success = factionRepository.renameFaction(campaignId, oldName, newName);
            if (success) {
                await ctx.message.reply(t(ctx.locale, 'faction.renamed', { old: oldName, new: newName }));
            } else {
                await ctx.message.reply(t(ctx.locale, 'faction.renameError'));
            }
            return;
        }

        // =============================================
        // SUBCOMMAND: merge
        // =============================================
        if (/^merge\s/i.test(argsStr) || /^unisci\s/i.test(argsStr)) {
            const content = argsStr.replace(/^(merge|unisci)\s*/i, '').trim();

            const mergeConfig: MergeConfig = {
                entityTypeKey: 'entity.faction',
                emoji: '🛡️',
                campaignId: ctx.activeCampaign!.id,
                listEntities: (cid) => factionRepository.listFactions(cid).map(f => ({
                    id: f.name,
                    shortId: f.short_id || '?????',
                    name: f.name,
                    description: f.description || '',
                    metadata: f.type
                })),
                resolveEntity: (cid, query) => {
                    const sidMatch = query.match(/^#?([a-z0-9]{5})$/i);
                    let faction = null;
                    if (sidMatch) {
                        faction = factionRepository.getFactionByShortId(cid, sidMatch[1]);
                    } else if (query.toLowerCase() === 'party') {
                        faction = factionRepository.getPartyFaction(cid);
                    } else {
                        faction = factionRepository.getFaction(cid, query);
                    }
                    if (!faction) return null;
                    return {
                        id: faction.name,
                        shortId: faction.short_id || '?????',
                        name: faction.name,
                        description: faction.description || '',
                        metadata: faction.type
                    };
                },
                executeMerge: async (cid, source, target, mergedDesc) => {
                    return factionRepository.mergeFactions(cid, source.name as string, target.name as string, mergedDesc || undefined);
                }
            };

            await startInteractiveMerge(ctx, mergeConfig, content);
            return;
        }

        // SUBCOMMAND: $faction update <Name or ID> [| <Desc> OR <field> <value>]
        if (argsStr.toLowerCase() === 'update' || argsStr.toLowerCase().startsWith('update ')) {
            const fullContent = argsStr.substring(7).trim();

            // 1. Identify Target (ID or Name)
            let targetIdentifier = "";
            let remainingArgs = "";


            if (fullContent.length === 0) {
                await startInteractiveFactionUpdate(ctx);
                return;
            }

            if (fullContent.startsWith('#')) {
                const parts = fullContent.split(' ');
                targetIdentifier = parts[0];
                remainingArgs = parts.slice(1).join(' ');
            } else {
                if (fullContent.includes('|')) {
                    targetIdentifier = fullContent.split('|')[0].trim();
                    remainingArgs = "|" + fullContent.split('|').slice(1).join('|');
                } else {
                    const keywords = ['status', 'stato', 'type', 'tipo', 'leader', 'capo'];
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
                        targetIdentifier = fullContent;
                        remainingArgs = "";
                    }
                }
            }

            // Resolve Faction
            let factionName = targetIdentifier;
            const sidMatch = targetIdentifier.match(/^#?([a-z0-9]{5})$/i);
            if (sidMatch) {
                const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
                if (faction) factionName = faction.name;
            }

            const faction = factionRepository.getFaction(campaignId, factionName);
            if (!faction) {
                await ctx.message.reply(t(ctx.locale, 'faction.notFound', { name: factionName }));
                return;
            }

            // 2. Parse Actions

            // Case A: Narrative Update (Description)
            if (remainingArgs.trim().startsWith('|')) {
                const description = remainingArgs.replace('|', '').trim();
                const success = factionRepository.updateFaction(campaignId, faction.name, { description });
                if (success) {
                    await ctx.message.reply(t(ctx.locale, 'faction.descUpdated', { name: faction.name }));
                } else {
                    await ctx.message.reply(t(ctx.locale, 'faction.descUpdateError'));
                }
                return;
            }

            // Case B: Metadata Update
            const args = remainingArgs.trim().split(/\s+/);
            const field = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ').toUpperCase(); // basic upper for enums

            const showUpdateHelp = async (errorMsg?: string) => {
                const typeIcon = FACTION_TYPE_ICONS[faction.type] || '⚔️';

                const embed = new EmbedBuilder()
                    .setTitle(t(ctx.locale, 'faction.updateHelpTitle', { shortId: faction.short_id || '', name: faction.name }))
                    .setColor("#3498DB")
                    .setDescription(errorMsg ? `⚠️ **${errorMsg}**\n\n` : "")
                    .addFields(
                        {
                            name: t(ctx.locale, 'faction.updateHelpCurrentName'),
                            value: t(ctx.locale, 'faction.updateHelpCurrent', {
                                status: eventTypeLabel(ctx.locale, faction.status),
                                type: `${typeIcon} ${eventTypeLabel(ctx.locale, faction.type)}`,
                                leader: faction.leader_npc_id ? `NPC #${faction.leader_npc_id}` : t(ctx.locale, 'faction.noLeader'),
                            }),
                            inline: false
                        },
                        {
                            name: t(ctx.locale, 'faction.updateHelpFieldsName'),
                            value: t(ctx.locale, 'faction.updateHelpFields', { shortId: faction.short_id || '' })
                        }
                    );
                await ctx.message.reply({ embeds: [embed] });
            };

            if (!field || !args[1]) {
                await showUpdateHelp();
                return;
            }

            // 3. Apply Metadata Update
            if (field === 'status' || field === 'stato') {
                const map: Record<string, string> = {
                    'ACTIVE': 'ACTIVE', 'ATTIVA': 'ACTIVE',
                    'DISBANDED': 'DISBANDED', 'SCIOLTA': 'DISBANDED', 'CHIUSA': 'DISBANDED',
                    'DESTROYED': 'DESTROYED', 'DISTRUTTA': 'DESTROYED', 'ELIMINATA': 'DESTROYED', 'MORTA': 'DESTROYED'
                };

                const mapped = map[value] || map[value.replace(' ', '_')];

                if (!mapped) {
                    await showUpdateHelp(t(ctx.locale, 'faction.invalidValue', { field, value }));
                    return;
                }

                factionRepository.updateFaction(campaignId, faction.name, { status: mapped as any });
                await ctx.message.reply(t(ctx.locale, 'faction.statusUpdated', { name: faction.name, status: eventTypeLabel(ctx.locale, mapped) }));
                return;
            }

            if (field === 'type' || field === 'tipo') {
                const map: Record<string, string> = {
                    'GUILD': 'GUILD', 'GILDA': 'GUILD',
                    'KINGDOM': 'KINGDOM', 'REGNO': 'KINGDOM', 'IMPERO': 'KINGDOM',
                    'CULT': 'CULT', 'CULTO': 'CULT', 'SETTA': 'CULT',
                    'ORGANIZATION': 'ORGANIZATION', 'ORGANIZZAZIONE': 'ORGANIZATION', 'ORG': 'ORGANIZATION',
                    'GENERIC': 'GENERIC', 'GENERICA': 'GENERIC', 'ALTRO': 'GENERIC', 'PARTY': 'PARTY'
                };

                const mapped = map[value];
                if (!mapped) {
                    await showUpdateHelp(t(ctx.locale, 'faction.invalidValue', { field, value }));
                    return;
                }

                factionRepository.updateFaction(campaignId, faction.name, { type: mapped as any });
                await ctx.message.reply(t(ctx.locale, 'faction.typeUpdated', { name: faction.name, type: eventTypeLabel(ctx.locale, mapped) }));
                return;
            }

            if (field === 'leader' || field === 'capo') {
                // Determine NPC
                const rawName = args.slice(1).join(' ');

                let npcId: number | null = null;
                let npcName = rawName;

                // Try to find NPC by name
                const npc = npcRepository.getNpcEntry(campaignId, rawName);
                if (npc) {
                    npcId = npc.id;
                    npcName = npc.name;
                } else {
                    // Try numeric ID?
                    if (!isNaN(Number(rawName))) {
                        // Check if ID exists?
                        // Minimal validation
                        npcId = Number(rawName);
                        npcName = `NPC #${npcId}`;
                    } else {
                        // Try to see if it's "NONE" or "NESSUNO"
                        const upper = rawName.toUpperCase();
                        if (upper === 'NONE' || upper === 'NESSUNO' || upper === '0' || upper === '-') {
                            npcId = null;
                            npcName = t(ctx.locale, 'faction.noLeader');
                        } else {
                            await showUpdateHelp(t(ctx.locale, 'faction.leaderNotFound', { name: rawName }));
                            return;
                        }
                    }
                }

                factionRepository.updateFaction(campaignId, faction.name, { leader_npc_id: npcId });
                await ctx.message.reply(t(ctx.locale, 'faction.leaderSet', { faction: faction.name, npc: npcName }));
                return;
            }

            // moral / alignment_moral
            if (field === 'moral' || field === 'allineamento') {
                await ctx.message.reply(t(ctx.locale, 'faction.alignmentAuto'));
                return;
            }

            // ethical / alignment_ethical
            if (field === 'ethical' || field === 'etico') {
                await ctx.message.reply(t(ctx.locale, 'faction.alignmentAuto'));
                return;
            }

            // Helper: resolve location by shortId or "Macro | Micro"
            const resolveLocation = (locValue: string) => {
                const trimmed = locValue.trim();
                // Try shortId first
                const sidMatch = trimmed.match(/^#?([a-z0-9]{5})$/i);
                if (sidMatch) {
                    return locationRepository.getAtlasEntryByShortId(campaignId, sidMatch[1]);
                }
                // Try "Macro | Micro" syntax
                if (trimmed.includes('|')) {
                    const [macro, micro] = trimmed.split('|').map(s => s.trim());
                    return locationRepository.getAtlasEntryFull(campaignId, macro, micro);
                }
                // Try as micro location name only (search all)
                const allLocations = locationRepository.listAllAtlasEntries(campaignId);
                const match = allLocations.find((l: any) =>
                    l.micro_location?.toLowerCase() === trimmed.toLowerCase() ||
                    l.macro_location?.toLowerCase() === trimmed.toLowerCase()
                );
                return match ? locationRepository.getAtlasEntryFull(campaignId, match.macro_location, match.micro_location) : null;
            };

            // HQ / Sede Principale
            if (field === 'hq' || field === 'sede' || field === 'headquarter') {
                const rawValue = args.slice(1).join(' ');
                const location = resolveLocation(rawValue);

                if (!location) {
                    await ctx.message.reply(t(ctx.locale, 'faction.hqLocNotFound', { value: rawValue }));
                    return;
                }

                factionRepository.updateFaction(campaignId, faction.name, { headquarters_location_id: location.id });
                const locName = location.micro_location || location.macro_location;
                await ctx.message.reply(t(ctx.locale, 'faction.hqSet', { faction: faction.name, loc: locName, shortId: location.short_id || '' }));
                return;
            }

            // addloc / adds a controlled location
            if (field === 'addloc' || field === 'addluogo') {
                const rawValue = args.slice(1).join(' ');
                const location = resolveLocation(rawValue);

                if (!location) {
                    await ctx.message.reply(t(ctx.locale, 'faction.hqLocNotFound', { value: rawValue }));
                    return;
                }

                factionRepository.addAffiliation(faction.id, 'location', location.id, { role: 'CONTROLLED' });
                const locName = location.micro_location || location.macro_location;
                await ctx.message.reply(t(ctx.locale, 'faction.locAdded', { loc: locName, shortId: location.short_id || '', faction: faction.name }));
                return;
            }

            // remloc / removes a controlled location
            if (field === 'remloc' || field === 'remluogo') {
                const rawValue = args.slice(1).join(' ');
                const location = resolveLocation(rawValue);

                if (!location) {
                    await ctx.message.reply(t(ctx.locale, 'faction.hqLocNotFound', { value: rawValue }));
                    return;
                }

                const success = factionRepository.removeAffiliation(faction.id, 'location', location.id);
                const locName = location.micro_location || location.macro_location;
                if (success) {
                    await ctx.message.reply(t(ctx.locale, 'faction.locRemoved', { loc: locName, faction: faction.name }));
                } else {
                    await ctx.message.reply(t(ctx.locale, 'faction.locNotControlled', { loc: locName, faction: faction.name }));
                }
                return;
            }

            await showUpdateHelp(t(ctx.locale, 'faction.unknownField', { field }));
            return;
        }

        // =============================================
        // SUBCOMMAND: sync
        // =============================================
        if (/^sync/i.test(argsStr)) {
            const name = argsStr.substring(5).trim();

            if (!name || name === 'all') {
                const loadingMsg = await ctx.message.reply(t(ctx.locale, 'faction.syncBatchStart'));
                const count = await syncAllDirtyFactions(campaignId);

                if (count > 0) {
                    await loadingMsg.edit(t(ctx.locale, 'faction.syncBatchDone', { n: count }));
                } else {
                    await loadingMsg.edit(t(ctx.locale, 'faction.syncAllClean'));
                }
            } else {
                let factionName = name;
                const sidMatch = name.match(/^#([a-z0-9]{5})$/i);
                if (sidMatch) {
                    const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
                    if (faction) factionName = faction.name;
                }

                const faction = factionRepository.getFaction(campaignId, factionName);
                if (!faction) {
                    await ctx.message.reply(t(ctx.locale, 'faction.notFound', { name: factionName }));
                    return;
                }

                const loadingMsg = await ctx.message.reply(t(ctx.locale, 'faction.syncStart', { name: factionName }));
                await syncFactionEntryIfNeeded(campaignId, factionName, true);
                await loadingMsg.edit(t(ctx.locale, 'faction.syncDone', { name: factionName }));
            }
            return;
        }

        // =============================================
        // SUBCOMMAND: reputation / rep
        // =============================================
        if (/^(reputation|rep)\s/i.test(argsStr)) {
            const content = argsStr.replace(/^(reputation|rep)\s/i, '').trim();
            const parts = content.split('|').map(s => s.trim());

            if (parts.length === 0 || !parts[0]) {
                // Show all reputations
                const factions = factionRepository.getReputationWithAllFactions(campaignId);
                if (factions.length === 0) {
                    await ctx.message.reply(t(ctx.locale, 'faction.repNoFactions'));
                    return;
                }

                let msg = t(ctx.locale, 'faction.repHeader') + '\n\n';
                msg += factions.map(f => {
                    const icon = REPUTATION_ICONS[f.reputation];
                    const typeIcon = FACTION_TYPE_ICONS[f.type] || '⚔️';
                    return `${typeIcon} **${f.name}**: ${icon} ${eventTypeLabel(ctx.locale, f.reputation)}`;
                }).join('\n');

                msg += '\n\n' + t(ctx.locale, 'faction.repFooter');
                await safeReply(ctx.message, msg);
                return;
            }

            let factionName = parts[0];
            const action = parts[1]?.trim();

            // Resolve faction
            const sidMatch = factionName.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
                if (faction) factionName = faction.name;
            }

            const faction = factionRepository.getFaction(campaignId, factionName);
            if (!faction) {
                await ctx.message.reply(t(ctx.locale, 'faction.notFound', { name: factionName }));
                return;
            }

            if (faction.is_party) {
                await ctx.message.reply(t(ctx.locale, 'faction.cantRepParty'));
                return;
            }

            if (!action) {
                // Show current reputation
                const rep = factionRepository.getFactionReputation(campaignId, faction.id);
                const icon = REPUTATION_ICONS[rep];
                await ctx.message.reply(t(ctx.locale, 'faction.repShow', { name: faction.name, icon, level: eventTypeLabel(ctx.locale, rep) }));
                return;
            }

            let newRep: ReputationLevel;
            const MANUAL_REP_DELTA = 10; // Score delta for manual +/- adjustments
            if (action === '+') {
                // Use addFactionEvent with positive delta — it accumulates score and derives label
                factionRepository.addFactionEvent(campaignId, faction.name, null, t(getCampaignLocale(campaignId), 'faction.repIncreased', { delta: MANUAL_REP_DELTA }), 'REPUTATION_CHANGE', true, MANUAL_REP_DELTA);
                newRep = factionRepository.getFactionReputation(campaignId, faction.id);
            } else if (action === '-') {
                factionRepository.addFactionEvent(campaignId, faction.name, null, t(getCampaignLocale(campaignId), 'faction.repDecreased', { delta: MANUAL_REP_DELTA }), 'REPUTATION_CHANGE', true, -MANUAL_REP_DELTA);
                newRep = factionRepository.getFactionReputation(campaignId, faction.id);
            } else {
                // Try to set specific level (also syncs score to threshold value)
                // Map Italian input to English (users may type in either language)
                const reputationInputMap: Record<string, ReputationLevel> = {
                    'OSTILE': 'HOSTILE', 'HOSTILE': 'HOSTILE',
                    'DIFFIDENTE': 'DISTRUSTFUL', 'DISTRUSTFUL': 'DISTRUSTFUL',
                    'FREDDO': 'COLD', 'COLD': 'COLD',
                    'NEUTRALE': 'NEUTRAL', 'NEUTRAL': 'NEUTRAL',
                    'CORDIALE': 'CORDIAL', 'CORDIAL': 'CORDIAL',
                    'AMICHEVOLE': 'FRIENDLY', 'FRIENDLY': 'FRIENDLY',
                    'ALLEATO': 'ALLIED', 'ALLIED': 'ALLIED'
                };
                const upperAction = action.toUpperCase();
                const mappedRep = reputationInputMap[upperAction];
                if (!mappedRep) {
                    await ctx.message.reply(t(ctx.locale, 'faction.repInvalid', { levels: REPUTATION_SPECTRUM.join(', ') }));
                    return;
                }
                factionRepository.setFactionReputation(campaignId, faction.id, mappedRep);
                factionRepository.addFactionEvent(campaignId, faction.name, null, t(getCampaignLocale(campaignId), 'faction.repSetEvent', { level: eventTypeLabel(getCampaignLocale(campaignId), mappedRep) }), 'REPUTATION_CHANGE', true);
                newRep = mappedRep;
            }

            const icon = REPUTATION_ICONS[newRep];
            await ctx.message.reply(t(ctx.locale, 'faction.repUpdated', { name: faction.name, icon, level: eventTypeLabel(ctx.locale, newRep) }));
            return;
        }

        // =============================================
        // SUBCOMMAND: events - $faction <nome/#id> events [page]
        // =============================================
        const eventsMatch = argsStr.match(/^(.+?)\s+(events|eventi)(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            let factionIdentifier = eventsMatch[1].trim();
            const page = eventsMatch[3] ? parseInt(eventsMatch[3]) : 1;

            const found = await showFactionEventsByIdentifier(ctx, factionIdentifier, page);
            if (!found) {
                await ctx.message.reply(t(ctx.locale, 'faction.notFound', { name: factionIdentifier }));
            }
            return;
        }

        // =============================================
        // DEFAULT: $faction (list) or $faction <name>
        // =============================================
        if (!firstArg || firstArg === 'list' || firstArg === 'lista') {
            // List all factions (limit 25 for select menu for now)
            const allFactions = factionRepository.listFactions(campaignId);
            const factions = allFactions.slice(0, 25);

            if (allFactions.length === 0) {
                await ctx.message.reply(t(ctx.locale, 'faction.listEmpty'));
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(t(ctx.locale, 'faction.listTitle', { campaign: ctx.activeCampaign?.name || '' }))
                .setColor("#3498DB");

            let description = '';
            for (const f of factions) {
                const typeIcon = FACTION_TYPE_ICONS[f.type] || '⚔️';
                const rep = f.is_party ? '' : factionRepository.getFactionReputation(campaignId, f.id);
                const repIcon = rep ? REPUTATION_ICONS[rep as ReputationLevel] : '';
                const members = factionRepository.countFactionMembers(f.id);
                let memberParts: string[] = [];
                memberParts.push(`${members.npcs}👤`);
                if (members.pcs > 0) memberParts.push(`${members.pcs}PG`);
                memberParts.push(`${members.locations}📍`);
                const memberStr = memberParts.join(' ');

                description += `\`#${f.short_id}\` ${typeIcon} **${f.name}**${f.is_party ? ' 🎭' : ''}\n`;
                description += `└ ${rep ? `${repIcon} ${rep} • ` : ''}${memberStr}\n\n`;
            }

            if (allFactions.length > 25) {
                description += t(ctx.locale, 'faction.listOthers', { n: allFactions.length - 25 });
            }

            embed.setDescription(description);
            embed.setFooter({ text: t(ctx.locale, 'faction.listFooter', { n: allFactions.length }) });

            // Create Select Menu
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_faction')
                .setPlaceholder(t(ctx.locale, 'faction.selectPlaceholder'))
                .addOptions(
                    factions.map(f => {
                        const typeIcon = FACTION_TYPE_ICONS[f.type] || '⚔️';
                        return new StringSelectMenuOptionBuilder()
                            .setLabel(f.name)
                            .setDescription(`${f.type} - #${f.short_id}`)
                            .setValue(f.short_id || 'unknown') // Use short_id for stability
                            .setEmoji(typeIcon);
                    })
                );

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

            const reply = await ctx.message.reply({
                embeds: [embed],
                components: [row]
            });

            // Create Collector
            const collector = reply.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                time: 60000 * 5 // 5 minutes
            });

            collector.on('collect', async (interaction) => {
                if (interaction.user.id !== ctx.message.author.id) {
                    await interaction.reply({ content: t(ctx.locale, 'common.onlyInvoker'), ephemeral: true });
                    return;
                }

                if (interaction.customId === 'select_faction') {
                    const selectedShortId = interaction.values[0];
                    const faction = factionRepository.getFactionByShortId(campaignId, selectedShortId);

                    if (faction) {
                        const detailEmbed = generateFactionEmbed(faction);
                        await interaction.reply({ embeds: [detailEmbed], ephemeral: true });
                    } else {
                        await interaction.reply({ content: t(ctx.locale, 'faction.notFoundShort'), ephemeral: true });
                    }
                }
            });

            collector.on('end', () => {
                // Remove components on timeout
                reply.edit({ components: [] }).catch(() => { });
            });

            return;
        }

        // =============================================
        // SPECIFIC FACTION VIEW: $faction <Name or #ID>
        // =============================================
        let searchName = argsStr;

        // Resolve short ID
        const sidMatch = argsStr.match(/^#([a-z0-9]{5})$/i);
        if (sidMatch) {
            const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
            if (faction) searchName = faction.name;
        }

        // Handle "party" keyword
        if (searchName.toLowerCase() === 'party') {
            const party = factionRepository.getPartyFaction(campaignId);
            if (party) searchName = party.name;
        }

        const faction = factionRepository.getFaction(campaignId, searchName);
        if (!faction) {
            await ctx.message.reply(t(ctx.locale, 'faction.notFound', { name: searchName }));
            return;
        }

        const embed = generateFactionEmbed(faction);
        await ctx.message.reply({ embeds: [embed] });
    }
};

/**
 * Helper: Resolve faction identifier and show events
 */
async function showFactionEventsByIdentifier(ctx: CommandContext, identifier: string, page: number = 1): Promise<boolean> {
    const campaignId = ctx.activeCampaign!.id;
    let faction: FactionEntry | null = null;

    // Resolve short ID
    const sidMatch = identifier.trim().match(/^#?([a-z0-9]{5})$/i);
    if (sidMatch) {
        faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
    }

    if (!faction) {
        faction = factionRepository.getFaction(campaignId, identifier.trim());
    }

    if (!faction) return false;

    await showEntityEvents(ctx, {
        tableName: 'faction_history',
        entityKeyColumn: 'faction_name',
        entityKeyValue: faction.name,
        campaignId: campaignId,
        entityDisplayName: faction.name,
        entityEmoji: '⚔️',
        entityId: faction.id ?? null
    }, page);

    return true;
}

/**
 * Helper: Interactive selection for faction events
 */
async function startFactionEventsInteractiveSelection(ctx: CommandContext) {
    const campaignId = ctx.activeCampaign!.id;
    const factions = factionRepository.listFactions(campaignId);

    if (factions.length === 0) {
        await ctx.message.reply(t(ctx.locale, 'faction.eventsSelEmpty'));
        return;
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_faction_events')
        .setPlaceholder(t(ctx.locale, 'faction.selectPlaceholderShort'))
        .addOptions(
            factions.slice(0, 25).map(f => {
                const icon = FACTION_TYPE_ICONS[f.type] || '⚔️';
                return new StringSelectMenuOptionBuilder()
                    .setLabel(f.name.substring(0, 100))
                    .setDescription(`#${f.short_id} - ${f.type}`)
                    .setValue(f.name)
                    .setEmoji(icon);
            })
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const reply = await ctx.message.reply({
        content: t(ctx.locale, 'faction.eventsSelPrompt'),
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_faction_events' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const factionName = interaction.values[0];
        const faction = factionRepository.getFaction(campaignId, factionName);

        if (faction) {
            await interaction.update({ content: t(ctx.locale, 'crud.loadingEvents', { name: faction.name }), components: [] });

            await showEntityEvents(ctx, {
                tableName: 'faction_history',
                entityKeyColumn: 'faction_name',
                entityKeyValue: faction.name,
                campaignId: campaignId,
                entityDisplayName: faction.name,
                entityEmoji: '⚔️',
                entityId: faction.id ?? null
            }, 1);
        } else {
            await interaction.reply({ content: t(ctx.locale, 'faction.notFoundShort'), ephemeral: true });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            await reply.edit({ content: t(ctx.locale, 'crud.selectionTimeout'), components: [] }).catch(() => { });
        }
    });
}
