/**
 * $affiliate command - Manage entity affiliations to factions
 */

import { Command, CommandContext } from '../types';
import {
    factionRepository,
    npcRepository,
    locationRepository,
    db
} from '../../db';
import { AffiliationRole } from '../../db/types';
import { safeReply } from '../../utils/discordHelper';
import {
    startInteractiveAffiliate,
    startInteractiveAffiliateAdd,
    startInteractiveAffiliateRemove,
    getRoleLabel
} from './affiliateInteractive';
import { EmbedBuilder } from 'discord.js';

const ROLE_ICONS: Record<AffiliationRole, string> = {
    'LEADER': '👑',
    'MEMBER': '👤',
    'ALLY': '🤝',
    'ENEMY': '⚔️',
    'CONTROLLED': '🏛️',
    'HQ': '🏰',
    'PRESENCE': '📍',
    'HOSTILE': '💢',
    'PRISONER': '⛓️'
};

// Helper: Get NPC by ID (for internal use)
function getNpcById(npcId: number): { id: number; name: string; role?: string } | null {
    return db.prepare(`SELECT id, name, role FROM npc_dossier WHERE id = ?`).get(npcId) as any;
}

// Helper: Get Atlas entry by ID
function getAtlasEntryById(entryId: number): { id: number; macro_location: string; micro_location: string } | null {
    return db.prepare(`SELECT id, macro_location, micro_location FROM atlas WHERE id = ?`).get(entryId) as any;
}

// Helper: Find Atlas entry by micro location name
function findAtlasByMicro(campaignId: number, microName: string): { id: number; macro_location: string; micro_location: string } | null {
    return db.prepare(`
        SELECT id, macro_location, micro_location 
        FROM atlas 
        WHERE campaign_id = ? AND LOWER(micro_location) = LOWER(?)
    `).get(campaignId, microName) as any;
}

export const affiliateCommand: Command = {
    name: 'affiliate',
    aliases: ['affilia', 'affiliazione'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const campaignId = ctx.activeCampaign!.id;
        const argsStr = ctx.args.join(' ');

        // Interactive Mode Entry Points
        if (!argsStr.trim()) {
            await startInteractiveAffiliate(ctx);
            return;
        }

        if (argsStr.toLowerCase() === 'add') {
            await startInteractiveAffiliateAdd(ctx);
            return;
        }

        if (argsStr.toLowerCase() === 'remove') {
            await startInteractiveAffiliateRemove(ctx);
            return;
        }

        // =============================================
        // SUBCOMMAND: remove
        // =============================================
        if (/^remove\s/i.test(argsStr)) {
            const content = argsStr.substring(7).trim();
            const entityMatch = content.match(/^(npc|location|loc|pc)\s+(.+)/i);

            if (!entityMatch) {
                await ctx.message.reply('Uso: `$affiliate remove <npc|location|pc> <Nome> | <Fazione>`');
                return;
            }

            let entityType = entityMatch[1].toLowerCase();
            if (entityType === 'loc') entityType = 'location';

            const parts = entityMatch[2].split('|').map(s => s.trim());
            if (parts.length < 2) {
                await ctx.message.reply('Uso: `$affiliate remove <tipo> <Nome Entità> | <Nome Fazione>`');
                return;
            }

            const entityName = parts[0];
            const factionName = parts[1];

            // Find faction
            const faction = factionRepository.getFaction(campaignId, factionName) ||
                factionRepository.getFactionByShortId(campaignId, factionName.replace('#', ''));

            if (!faction) {
                await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
                return;
            }

            // Find entity
            let entityId: number | null = null;
            if (entityType === 'npc') {
                const npc = npcRepository.getNpcEntry(campaignId, entityName) ||
                    npcRepository.getNpcByShortId(campaignId, entityName.replace('#', ''));
                entityId = npc?.id ?? null;
            } else if (entityType === 'location') {
                const loc = findAtlasByMicro(campaignId, entityName);
                entityId = loc?.id ?? null;
            } else if (entityType === 'pc') {
                await ctx.message.reply('❌ Rimozione affiliazione PC non ancora implementata.');
                return;
            }

            if (!entityId) {
                await ctx.message.reply(`❌ ${entityType.toUpperCase()} **${entityName}** non trovato.`);
                return;
            }

            const success = factionRepository.removeAffiliation(faction.id, entityType as any, entityId);
            if (success) {
                factionRepository.addFactionEvent(
                    campaignId,
                    faction.name,
                    null,
                    `${entityType.toUpperCase()} "${entityName}" ha lasciato la fazione`,
                    'MEMBER_LEAVE',
                    true
                );
                await ctx.message.reply(`✅ **${entityName}** non è più affiliato a **${faction.name}**.`);
            } else {
                await ctx.message.reply(`⚠️ Affiliazione non trovata o già rimossa.`);
            }
            return;
        }

        // =============================================
        // SUBCOMMAND: list <faction>
        // =============================================
        if (/^list\s/i.test(argsStr)) {
            const factionName = argsStr.substring(5).trim();

            const faction = factionRepository.getFaction(campaignId, factionName) ||
                factionRepository.getFactionByShortId(campaignId, factionName.replace('#', ''));

            if (!faction) {
                await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
                return;
            }

            const members = factionRepository.getFactionMembers(faction.id);

            if (members.length === 0) {
                await ctx.message.reply(`📋 La fazione **${faction.name}** non ha membri affiliati.`);
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`📋 Membri di "${faction.name}"`)
                .setColor("#E67E22");

            // Group by entity type
            const npcs = members.filter(m => m.entity_type === 'npc');
            const locations = members.filter(m => m.entity_type === 'location');
            const pcs = members.filter(m => m.entity_type === 'pc');

            if (npcs.length > 0) {
                const lines = npcs.map(m => {
                    const icon = ROLE_ICONS[m.role as AffiliationRole] || '👤';
                    const label = getRoleLabel(m.role);
                    return `${icon} **${m.entity_name || `ID:${m.entity_id}`}** (${label})`;
                }).join('\n');
                embed.addFields({ name: "👤 NPC", value: lines });
            }

            if (locations.length > 0) {
                const lines = locations.map(m => {
                    const icon = ROLE_ICONS[m.role as AffiliationRole] || '📍';
                    const label = getRoleLabel(m.role);
                    return `${icon} **${m.entity_name || `ID:${m.entity_id}`}** (${label})`;
                }).join('\n');
                embed.addFields({ name: "📍 Luoghi", value: lines });
            }

            if (pcs.length > 0) {
                const lines = pcs.map(m => {
                    const icon = ROLE_ICONS[m.role as AffiliationRole] || '🎭';
                    const label = getRoleLabel(m.role);
                    return `${icon} **PG ID:${m.entity_id}** (${label})`;
                }).join('\n');
                embed.addFields({ name: "🎭 Personaggi", value: lines });
            }

            await ctx.message.reply({ embeds: [embed] });
            return;
        }

        // =============================================
        // SUBCOMMAND: of <entity>
        // =============================================
        if (/^of\s/i.test(argsStr)) {
            const entityName = argsStr.substring(3).trim();

            // Try to find as NPC first
            let npc = npcRepository.getNpcEntry(campaignId, entityName) ||
                npcRepository.getNpcByShortId(campaignId, entityName.replace('#', ''));

            if (npc) {
                const affiliations = factionRepository.getEntityFactions('npc', npc.id);
                if (affiliations.length === 0) {
                    await ctx.message.reply(`👤 **${npc.name}** non appartiene a nessuna fazione.`);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle(`👤 Fazioni di "${npc.name}"`)
                    .setColor("#3498DB");

                const list = affiliations.map(a => {
                    const icon = ROLE_ICONS[a.role as AffiliationRole] || '🏴';
                    const label = getRoleLabel(a.role);
                    return `${icon} **${a.faction_name}** (${label})`;
                }).join('\n');

                embed.setDescription(list);
                await ctx.message.reply({ embeds: [embed] });
                return;
            }

            // Try as location
            const loc = findAtlasByMicro(campaignId, entityName);
            if (loc) {
                const affiliations = factionRepository.getEntityFactions('location', loc.id);
                if (affiliations.length === 0) {
                    await ctx.message.reply(`📍 **${loc.micro_location}** non appartiene a nessuna fazione.`);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setTitle(`📍 Fazioni di "${loc.micro_location}"`)
                    .setColor("#3498DB");

                const list = affiliations.map(a => {
                    const icon = ROLE_ICONS[a.role as AffiliationRole] || '🏴';
                    const label = getRoleLabel(a.role);
                    return `${icon} **${a.faction_name}** (${label})`;
                }).join('\n');

                embed.setDescription(list);
                await ctx.message.reply({ embeds: [embed] });
                return;
            }

            await ctx.message.reply(`❌ Entità **${entityName}** non trovata (come NPC o Luogo).`);
            return;
        }

        // =============================================
        // MAIN: affiliate <type> <entity> | <faction> [| <role>]
        // =============================================
        const entityMatch = argsStr.match(/^(npc|location|loc|pc)\s+(.+)/i);

        if (!entityMatch) {
            await ctx.message.reply(
                'Uso:\n' +
                '`$affiliate npc <NPC> | <Fazione> [| <Ruolo>]`\n' +
                '`$affiliate location <Luogo> | <Fazione> [| <Ruolo>]`\n' +
                '`$affiliate pc <Personaggio> | <Fazione> [| <Ruolo>]`\n\n' +
                'Ruoli: LEADER, MEMBER, ALLY, ENEMY, CONTROLLED, HQ, PRESENCE, HOSTILE, PRISONER'
            );
            return;
        }

        let entityType = entityMatch[1].toLowerCase();
        if (entityType === 'loc') entityType = 'location';

        const parts = entityMatch[2].split('|').map(s => s.trim());
        if (parts.length < 2) {
            await ctx.message.reply('Uso: `$affiliate <tipo> <Nome Entità> | <Nome Fazione> [| <Ruolo>]`');
            return;
        }

        const entityName = parts[0];
        const factionName = parts[1];
        const role = (parts[2]?.toUpperCase() || 'MEMBER') as AffiliationRole;

        const validRoles: AffiliationRole[] = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED', 'HQ', 'PRESENCE', 'HOSTILE', 'PRISONER'];
        if (!validRoles.includes(role)) {
            await ctx.message.reply(`❌ Ruolo non valido. Usa: ${validRoles.join(', ')}`);
            return;
        }

        // Find faction
        const faction = factionRepository.getFaction(campaignId, factionName) ||
            factionRepository.getFactionByShortId(campaignId, factionName.replace('#', ''));

        if (!faction) {
            await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
            return;
        }

        // Find entity
        let entityId: number | null = null;
        let resolvedName = entityName;

        if (entityType === 'npc') {
            const npc = npcRepository.getNpcEntry(campaignId, entityName) ||
                npcRepository.getNpcByShortId(campaignId, entityName.replace('#', ''));
            if (npc) {
                entityId = npc.id;
                resolvedName = npc.name;
            }
        } else if (entityType === 'location') {
            const loc = findAtlasByMicro(campaignId, entityName);
            if (loc) {
                entityId = loc.id;
                resolvedName = `${loc.macro_location} - ${loc.micro_location}`;
            }
        } else if (entityType === 'pc') {
            await ctx.message.reply('❌ Affiliazione PC non ancora implementata completamente.');
            return;
        }

        if (!entityId) {
            await ctx.message.reply(`❌ ${entityType.toUpperCase()} **${entityName}** non trovato.`);
            return;
        }

        const success = factionRepository.addAffiliation(faction.id, entityType as any, entityId, { role });

        if (success) {
            factionRepository.addFactionEvent(
                campaignId,
                faction.name,
                null,
                `${entityType.toUpperCase()} "${resolvedName}" si è unito come ${role}`,
                'MEMBER_JOIN',
                true
            );

            const roleIcon = ROLE_ICONS[role];
            const label = getRoleLabel(role);
            await ctx.message.reply(`✅ **${resolvedName}** è ora affiliato a **${faction.name}** come ${roleIcon} **${label}**.`);
        } else {
            await ctx.message.reply("❌ Errore durante l'affiliazione.");
        }
    }
};
