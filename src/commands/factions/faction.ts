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

// Helper: Get NPC by ID (for internal use)
function getNpcById(npcId: number): { id: number; name: string; role?: string } | null {
    return db.prepare(`SELECT id, name, role FROM npc_dossier WHERE id = ?`).get(npcId) as any;
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

const FACTION_TYPE_ICONS: Record<string, string> = {
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
                    value: npcList + (npcAffiliations.length > 5 ? `\n... e altri ${npcAffiliations.length - 5}` : '')
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
        if (/^(add|create|crea)\s/i.test(argsStr)) {
            const content = argsStr.substring(argsStr.indexOf(' ') + 1);
            const parts = content.split('|').map(s => s.trim());

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

        // =============================================
        // SUBCOMMAND: update
        // =============================================
        if (/^update\s/i.test(argsStr)) {
            const content = argsStr.substring(7).trim();
            const parts = content.split('|').map(s => s.trim());

            if (parts.length < 2) {
                await ctx.message.reply('Uso: `$faction update <Nome o #ID> | <Nuova Descrizione>`');
                return;
            }

            let name = parts[0];
            const description = parts.slice(1).join('|').trim();

            // Resolve short ID
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const faction = factionRepository.getFactionByShortId(campaignId, sidMatch[1]);
                if (faction) name = faction.name;
            }

            const success = factionRepository.updateFaction(campaignId, name, { description });
            if (success) {
                await ctx.message.reply(`✅ Descrizione di **${name}** aggiornata.`);
            } else {
                await ctx.message.reply(`❌ Fazione **${name}** non trovata.`);
            }
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
        if (!firstArg || firstArg === 'list' || firstArg === 'lista') {
            // List all factions
            const factions = factionRepository.listFactions(campaignId);

            if (factions.length === 0) {
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
                const memberStr = `${members.npcs}👤 ${members.locations}📍`;

                description += `\`#${f.short_id}\` ${typeIcon} **${f.name}**${f.is_party ? ' 🎭' : ''}\n`;
                description += `└ ${rep ? `${repIcon} ${rep} • ` : ''}${memberStr}\n\n`;
            }

            embed.setDescription(description);
            embed.setFooter({ text: `Totale: ${factions.length} fazioni • Usa $faction <Nome> per i dettagli` });

            await ctx.message.reply({ embeds: [embed] });
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
