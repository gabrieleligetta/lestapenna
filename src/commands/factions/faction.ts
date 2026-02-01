/**
 * $faction command - Faction management with subcommands
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    factionRepository,
    npcRepository,
    locationRepository,
    db
} from '../../db';
import { FactionEntry, ReputationLevel, REPUTATION_SPECTRUM } from '../../db/types';
import { syncFactionEntryIfNeeded, syncAllDirtyFactions } from '../../bard';
import { safeReply } from '../../utils/discordHelper';
import { showEntityEvents } from '../utils/eventsViewer';
import { startInteractiveFactionUpdate, startInteractiveFactionAdd } from './interactiveUpdate';

// Helper: Get NPC by ID (for internal use)
function getNpcById(npcId: number): { id: number; name: string; role?: string } | null {
    return db.prepare(`SELECT id, name, role FROM npc_dossier WHERE id = ?`).get(npcId) as any;
}

// Helper: Get Atlas entry by ID
function getAtlasEntryById(entryId: number): { id: number; macro_location: string; micro_location: string; short_id: string } | null {
    return db.prepare(`SELECT id, macro_location, micro_location, short_id FROM location_atlas WHERE id = ?`).get(entryId) as any;
}

const REPUTATION_ICONS: Record<ReputationLevel, string> = {
    'OSTILE': '🔴',
    'DIFFIDENTE': '🟠',
    'FREDDO': '🟡',
    'NEUTRALE': '⚪',
    'CORDIALE': '🟢',
    'AMICHEVOLE': '💚',
    'ALLEATO': '⭐'
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
    aliases: ['fazione', 'fazioni'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const campaignId = ctx.activeCampaign!.id;
        const firstArg = ctx.args[0];
        const argsStr = ctx.args.join(' ');

        // Helper: Generate faction detail embed
        const generateFactionEmbed = (faction: FactionEntry) => {
            const typeIcon = FACTION_TYPE_ICONS[faction.type] || '⚔️';
            const reputation = factionRepository.getFactionReputation(campaignId, faction.id);
            const repIcon = REPUTATION_ICONS[reputation];
            const members = factionRepository.countFactionMembers(faction.id);

            const embed = new EmbedBuilder()
                .setTitle(`${typeIcon} ${faction.name}${faction.is_party ? ' (Il Tuo Party)' : ''}`)
                .setColor(faction.is_party ? "#FFD700" : "#3498DB")
                .setDescription(faction.description || "*Nessuna descrizione.*");

            // Main info
            embed.addFields(
                { name: "Tipo", value: faction.type, inline: true },
                { name: "Stato", value: faction.status, inline: true },
                { name: "ID", value: `\`#${faction.short_id}\``, inline: true }
            );

            // Reputation (only for non-party factions)
            if (!faction.is_party) {
                embed.addFields({
                    name: "Reputazione",
                    value: `${repIcon} ${reputation}`,
                    inline: true
                });
            }

            // 🆕 Alignment (Always show for PARTY, otherwise if set)
            if (faction.is_party || faction.alignment_moral || faction.alignment_ethical) {
                const moralIcon = faction.alignment_moral === 'BUONO' ? '😇' : faction.alignment_moral === 'CATTIVO' ? '😈' : '⚖️';
                const ethicalIcon = faction.alignment_ethical === 'LEGALE' ? '📜' : faction.alignment_ethical === 'CAOTICO' ? '🌀' : '⚖️';
                embed.addFields({
                    name: "⚖️ Allineamento",
                    value: `${moralIcon} ${faction.alignment_moral || 'NEUTRALE'} ${ethicalIcon} ${faction.alignment_ethical || 'NEUTRALE'}`,
                    inline: true
                });
            }

            // Members count
            const memberParts: string[] = [];
            if (members.npcs > 0) memberParts.push(`${members.npcs} NPC`);
            if (members.pcs > 0) memberParts.push(`${members.pcs} PG`);
            if (members.locations > 0) memberParts.push(`${members.locations} Luoghi`);

            embed.addFields({
                name: "Membri",
                value: memberParts.length > 0 ? memberParts.join(', ') : "Nessun membro affiliato",
                inline: true
            });

            // Get affiliated NPCs (max 5)
            const npcAffiliations = factionRepository.getFactionMembers(faction.id, 'npc');
            if (npcAffiliations.length > 0) {
                const npcList = npcAffiliations.slice(0, 5).map(a => {
                    const npc = getNpcById(a.entity_id);
                    const roleIcon = a.role === 'LEADER' ? '👑' : a.role === 'ALLY' ? '🤝' : a.role === 'ENEMY' ? '⚔️' : '👤';
                    return `${roleIcon} ${npc?.name || `ID:${a.entity_id}`} (${a.role})`;
                }).join('\n');
                embed.addFields({
                    name: "NPC Affiliati",
                    value: npcList + (npcAffiliations.length > 5 ? `\n... e altri ${npcAffiliations.length - 5}` : ''),
                    inline: false
                });
            }

            // Get affiliated Locations
            if (faction.headquarters_location_id) {
                const hq = getAtlasEntryById(faction.headquarters_location_id);
                if (hq) {
                    embed.addFields({
                        name: "🏰 Sede Principale",
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
                        locDisplay = `Luogo ID:${a.entity_id} (non trovato)`;
                    }
                    return `📍 ${locDisplay} (${a.role})`;
                }).join('\n');
                embed.addFields({
                    name: "Luoghi Controllati",
                    value: locList + (locationAffiliations.length > 5 ? `\n... e altri ${locationAffiliations.length - 5}` : ''),
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
                embed.addFields({ name: "Cronologia Recente", value: historyText });
            }

            embed.setFooter({ text: `Usa $faction update ${faction.short_id} | <Descrizione> per aggiornare.` });
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
                await ctx.message.reply('Uso: `$faction create <Nome> [| <Tipo>] [| <Descrizione>]`\nTipi: GUILD, KINGDOM, CULT, ORGANIZATION, GENERIC');
                return;
            }

            const name = parts[0];
            const type = (parts[1]?.toUpperCase() || 'GENERIC') as any;
            const description = parts[2] || undefined;

            const validTypes = ['GUILD', 'KINGDOM', 'CULT', 'ORGANIZATION', 'GENERIC'];
            if (!validTypes.includes(type)) {
                await ctx.message.reply(`❌ Tipo non valido. Usa: ${validTypes.join(', ')}`);
                return;
            }

            const existing = factionRepository.getFaction(campaignId, name);
            if (existing) {
                await ctx.message.reply(`⚠️ La fazione **${name}** esiste già. Usa \`$faction update\` per modificarla.`);
                return;
            }

            const faction = factionRepository.createFaction(campaignId, name, {
                type,
                description,
                isManual: true
            });

            if (faction) {
                const typeIcon = FACTION_TYPE_ICONS[type] || '⚔️';
                await ctx.message.reply(`✅ **Nuova Fazione Creata!**\n${typeIcon} **${name}** [${type}]\n${description ? `📜 ${description}` : ''}`);
            } else {
                await ctx.message.reply('❌ Errore durante la creazione della fazione.');
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
                await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
                return;
            }

            if (faction.is_party) {
                await ctx.message.reply('❌ Non puoi eliminare la fazione del party. Puoi rinominarla con `$faction rename party | <Nuovo Nome>`.');
                return;
            }

            const success = factionRepository.deleteFaction(campaignId, factionName);
            if (success) {
                await ctx.message.reply(`✅ Fazione **${factionName}** eliminata.`);
            } else {
                await ctx.message.reply('❌ Errore durante l\'eliminazione.');
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
                await ctx.message.reply('Uso: `$faction rename <Vecchio Nome> | <Nuovo Nome>`');
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
                await ctx.message.reply(`✅ Fazione rinominata: **${oldName}** → **${newName}**`);
            } else {
                await ctx.message.reply(`❌ Impossibile rinominare. Verifica che la fazione esista e il nuovo nome non sia già in uso.`);
            }
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
                await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
                return;
            }

            // 2. Parse Actions

            // Case A: Narrative Update (Description)
            if (remainingArgs.trim().startsWith('|')) {
                const description = remainingArgs.replace('|', '').trim();
                const success = factionRepository.updateFaction(campaignId, faction.name, { description });
                if (success) {
                    await ctx.message.reply(`✅ Descrizione di **${faction.name}** aggiornata.`);
                } else {
                    await ctx.message.reply(`❌ Errore aggiornamento descrizione.`);
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
                    .setTitle(`ℹ️ Aggiornamento Fazione: #${faction.short_id} "${faction.name}"`)
                    .setColor("#3498DB")
                    .setDescription(errorMsg ? `⚠️ **${errorMsg}**\n\n` : "")
                    .addFields(
                        {
                            name: "Valori Attuali",
                            value: `**Status:** ${faction.status}\n**Type:** ${typeIcon} ${faction.type}\n**Leader:** ${faction.leader_npc_id ? `NPC #${faction.leader_npc_id}` : 'Nessuno'}`,
                            inline: false
                        },
                        {
                            name: "Campi Modificabili",
                            value: `
• **status**: ACTIVE (attiva), DISBANDED (sciolta), DESTROYED (distrutta/morta)
  *Es: $faction update #${faction.short_id} status DESTROYED*
• **type**: GUILD (gilda), KINGDOM (regno), CULT (culto), ORGANIZATION (org), GENERIC
  *Es: $faction update #${faction.short_id} type GUILD*
• **leader**: Nome NPC o ID
  *Es: $faction update #${faction.short_id} leader "Mario Rossi"*
• **moral**: BUONO, NEUTRALE, CATTIVO
  *Es: $faction update #${faction.short_id} moral CATTIVO*
• **ethical**: LEGALE, NEUTRALE, CAOTICO
  *Es: $faction update #${faction.short_id} ethical CAOTICO*
• **hq**: Sede principale (#shortId o "Macro | Micro")
  *Es: $faction update #${faction.short_id} hq #abc12*
• **addloc** / **remloc**: Aggiungi/rimuovi luogo controllato
• **Descrizione** (usa | )
  *Es: $faction update #${faction.short_id} | Nuova descrizione*`
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
                    await showUpdateHelp(`Valore non valido per '${field}': "${value}"`);
                    return;
                }

                factionRepository.updateFaction(campaignId, faction.name, { status: mapped as any });
                await ctx.message.reply(`✅ Status di **${faction.name}** aggiornato a **${mapped}**.`);
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
                    await showUpdateHelp(`Valore non valido per '${field}': "${value}"`);
                    return;
                }

                factionRepository.updateFaction(campaignId, faction.name, { type: mapped as any });
                await ctx.message.reply(`✅ Tipo di **${faction.name}** aggiornato a **${mapped}**.`);
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
                            npcName = "Nessuno";
                        } else {
                            await showUpdateHelp(`NPC Leader non trovato: "${rawName}"`);
                            return;
                        }
                    }
                }

                factionRepository.updateFaction(campaignId, faction.name, { leader_npc_id: npcId });
                await ctx.message.reply(`✅ Leader di **${faction.name}** impostato su **${npcName}**.`);
                return;
            }

            // moral / alignment_moral
            if (field === 'moral' || field === 'allineamento') {
                const map: Record<string, string> = {
                    'BUONO': 'BUONO', 'GOOD': 'BUONO', 'BENE': 'BUONO',
                    'NEUTRALE': 'NEUTRALE', 'NEUTRAL': 'NEUTRALE',
                    'CATTIVO': 'CATTIVO', 'EVIL': 'CATTIVO', 'MALE': 'CATTIVO'
                };
                const mapped = map[value];
                if (!mapped) {
                    await showUpdateHelp(`Valore non valido per '${field}': "${value}". Usa BUONO, NEUTRALE, CATTIVO.`);
                    return;
                }
                factionRepository.updateFaction(campaignId, faction.name, { alignment_moral: mapped });
                const icon = mapped === 'BUONO' ? '😇' : mapped === 'CATTIVO' ? '😈' : '⚖️';
                await ctx.message.reply(`✅ Allineamento morale di **${faction.name}** impostato su ${icon} **${mapped}**.`);
                return;
            }

            // ethical / alignment_ethical
            if (field === 'ethical' || field === 'etico') {
                const map: Record<string, string> = {
                    'LEGALE': 'LEGALE', 'LAWFUL': 'LEGALE',
                    'NEUTRALE': 'NEUTRALE', 'NEUTRAL': 'NEUTRALE',
                    'CAOTICO': 'CAOTICO', 'CHAOTIC': 'CAOTICO'
                };
                const mapped = map[value];
                if (!mapped) {
                    await showUpdateHelp(`Valore non valido per '${field}': "${value}". Usa LEGALE, NEUTRALE, CAOTICO.`);
                    return;
                }
                factionRepository.updateFaction(campaignId, faction.name, { alignment_ethical: mapped });
                const icon = mapped === 'LEGALE' ? '📜' : mapped === 'CAOTICO' ? '🌀' : '⚖️';
                await ctx.message.reply(`✅ Allineamento etico di **${faction.name}** impostato su ${icon} **${mapped}**.`);
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
                    await ctx.message.reply(`❌ Luogo **${rawValue}** non trovato nell'Atlas.\\nUsa un #shortId o "Macro | Micro".`);
                    return;
                }

                factionRepository.updateFaction(campaignId, faction.name, { headquarters_location_id: location.id });
                const locName = location.micro_location || location.macro_location;
                await ctx.message.reply(`✅ Sede principale di **${faction.name}** impostata su **${locName}** (#${location.short_id}).`);
                return;
            }

            // addloc / Aggiunge luogo controllato
            if (field === 'addloc' || field === 'addluogo') {
                const rawValue = args.slice(1).join(' ');
                const location = resolveLocation(rawValue);

                if (!location) {
                    await ctx.message.reply(`❌ Luogo **${rawValue}** non trovato nell'Atlas.\\nUsa un #shortId o "Macro | Micro".`);
                    return;
                }

                factionRepository.addAffiliation(faction.id, 'location', location.id, { role: 'CONTROLLED' });
                const locName = location.micro_location || location.macro_location;
                await ctx.message.reply(`✅ Luogo **${locName}** (#${location.short_id}) aggiunto ai luoghi controllati da **${faction.name}**.`);
                return;
            }

            // remloc / Rimuove luogo controllato
            if (field === 'remloc' || field === 'remluogo') {
                const rawValue = args.slice(1).join(' ');
                const location = resolveLocation(rawValue);

                if (!location) {
                    await ctx.message.reply(`❌ Luogo **${rawValue}** non trovato nell'Atlas.\\nUsa un #shortId o "Macro | Micro".`);
                    return;
                }

                const success = factionRepository.removeAffiliation(faction.id, 'location', location.id);
                const locName = location.micro_location || location.macro_location;
                if (success) {
                    await ctx.message.reply(`✅ Luogo **${locName}** rimosso dai luoghi controllati da **${faction.name}**.`);
                } else {
                    await ctx.message.reply(`⚠️ **${locName}** non era tra i luoghi controllati da **${faction.name}**.`);
                }
                return;
            }

            await showUpdateHelp(`Campo non riconosciuto: "${field}"`);
            return;
        }

        // =============================================
        // SUBCOMMAND: sync
        // =============================================
        if (/^sync/i.test(argsStr)) {
            const name = argsStr.substring(5).trim();

            if (!name || name === 'all') {
                const loadingMsg = await ctx.message.reply('⚙️ Sincronizzazione batch fazioni in corso...');
                const count = await syncAllDirtyFactions(campaignId);

                if (count > 0) {
                    await loadingMsg.edit(`✅ Sincronizzate **${count} fazioni** con RAG.`);
                } else {
                    await loadingMsg.edit('✨ Tutte le fazioni sono già sincronizzate!');
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
                    await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
                    return;
                }

                const loadingMsg = await ctx.message.reply(`⚙️ Sincronizzazione RAG per **${factionName}**...`);
                await syncFactionEntryIfNeeded(campaignId, factionName, true);
                await loadingMsg.edit(`✅ **${factionName}** sincronizzata con RAG.`);
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
                    await ctx.message.reply('📊 Nessuna fazione registrata (oltre al party).\nUsa `$faction create <Nome> | <Tipo>` per crearne una.');
                    return;
                }

                let msg = '**📊 Reputazione con le Fazioni:**\n\n';
                msg += factions.map(f => {
                    const icon = REPUTATION_ICONS[f.reputation];
                    const typeIcon = FACTION_TYPE_ICONS[f.type] || '⚔️';
                    return `${typeIcon} **${f.name}**: ${icon} ${f.reputation}`;
                }).join('\n');

                msg += '\n\n💡 Usa `$faction rep <Nome> | +/-/<Livello>` per modificare.';
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
                await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
                return;
            }

            if (faction.is_party) {
                await ctx.message.reply('❌ Non puoi modificare la reputazione con il tuo stesso party!');
                return;
            }

            if (!action) {
                // Show current reputation
                const rep = factionRepository.getFactionReputation(campaignId, faction.id);
                const icon = REPUTATION_ICONS[rep];
                await ctx.message.reply(`📊 Reputazione con **${faction.name}**: ${icon} ${rep}`);
                return;
            }

            let newRep: ReputationLevel;
            if (action === '+') {
                newRep = factionRepository.adjustReputation(campaignId, faction.id, 'UP');
                factionRepository.addFactionEvent(campaignId, faction.name, null, `Reputazione aumentata a ${newRep}`, 'REPUTATION_CHANGE', true);
            } else if (action === '-') {
                newRep = factionRepository.adjustReputation(campaignId, faction.id, 'DOWN');
                factionRepository.addFactionEvent(campaignId, faction.name, null, `Reputazione diminuita a ${newRep}`, 'REPUTATION_CHANGE', true);
            } else {
                // Try to set specific level
                const upperAction = action.toUpperCase() as ReputationLevel;
                if (!REPUTATION_SPECTRUM.includes(upperAction)) {
                    await ctx.message.reply(`❌ Livello non valido. Usa: ${REPUTATION_SPECTRUM.join(', ')}`);
                    return;
                }
                factionRepository.setFactionReputation(campaignId, faction.id, upperAction);
                factionRepository.addFactionEvent(campaignId, faction.name, null, `Reputazione impostata a ${upperAction}`, 'REPUTATION_CHANGE', true);
                newRep = upperAction;
            }

            const icon = REPUTATION_ICONS[newRep];
            await ctx.message.reply(`✅ Reputazione con **${faction.name}** aggiornata: ${icon} ${newRep}`);
            return;
        }

        // =============================================
        // SUBCOMMAND: events
        // =============================================
        const eventsMatch = argsStr.match(/^(.+?)\s+events(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            let factionIdentifier = eventsMatch[1].trim();
            const page = eventsMatch[2] ? parseInt(eventsMatch[2]) : 1;

            // Resolve short ID
            const sidMatch = factionIdentifier.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
                if (faction) factionIdentifier = faction.name;
                else {
                    await ctx.message.reply(`❌ Fazione con ID \`#${sidMatch[1]}\` non trovata.`);
                    return;
                }
            }

            // Verify faction exists
            const faction = factionRepository.getFaction(campaignId, factionIdentifier);
            if (!faction) {
                await ctx.message.reply(`❌ Fazione **${factionIdentifier}** non trovata.`);
                return;
            }

            await showEntityEvents(ctx, {
                tableName: 'faction_history',
                entityKeyColumn: 'faction_name',
                entityKeyValue: faction.name,
                campaignId: campaignId,
                entityDisplayName: faction.name,
                entityEmoji: '⚔️'
            }, page);
            return;
        }

        // =============================================
        // DEFAULT: $faction (list) or $faction <name>
        // =============================================
        // =============================================
        // DEFAULT: $faction (list) or $faction <name>
        // =============================================
        if (!firstArg || firstArg === 'list' || firstArg === 'lista') {
            // List all factions (limit 25 for select menu for now)
            const allFactions = factionRepository.listFactions(campaignId);
            const factions = allFactions.slice(0, 25);

            if (allFactions.length === 0) {
                await ctx.message.reply('📂 Nessuna fazione registrata.\nUsa `$faction create <Nome> | <Tipo>` per crearne una.');
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`⚔️ Fazioni (${ctx.activeCampaign?.name})`)
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
                description += `\n*...e altre ${allFactions.length - 25} fazioni.*`;
            }

            embed.setDescription(description);
            embed.setFooter({ text: `Totale: ${allFactions.length} fazioni • Usa il menu per i dettagli` });

            // Create Select Menu
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_faction')
                .setPlaceholder('🔍 Seleziona una fazione per i dettagli...')
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
                    await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
                    return;
                }

                if (interaction.customId === 'select_faction') {
                    const selectedShortId = interaction.values[0];
                    const faction = factionRepository.getFactionByShortId(campaignId, selectedShortId);

                    if (faction) {
                        const detailEmbed = generateFactionEmbed(faction);
                        await interaction.reply({ embeds: [detailEmbed], ephemeral: true });
                    } else {
                        await interaction.reply({ content: "Fazione non trovata.", ephemeral: true });
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
            await ctx.message.reply(`❌ Fazione **${searchName}** non trovata.`);
            return;
        }

        const embed = generateFactionEmbed(faction);
        await ctx.message.reply({ embeds: [embed] });
    }
};
