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
    deleteNpcEntry,
    updateNpcFields,
    migrateKnowledgeFragments,
    markNpcDirty,
    getSessionEncounteredNPCs,
    addNpcAlias,
    removeNpcAlias,
    db,
    addNpcEvent,
    deleteNpcRagSummary,
    deleteNpcHistory,
    getNpcByShortId,
    factionRepository
} from '../../db';
import {
    smartMergeBios,
    syncNpcDossierIfNeeded,
    syncAllDirtyNpcs
} from '../../bard';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { safeReply } from '../../utils/discordHelper';
import { formatAlignmentSpectrum } from '../../utils/alignmentUtils';
import { showEntityEvents } from '../utils/eventsViewer';
import { startInteractiveNpcAdd, startInteractiveNpcUpdate, startInteractiveNpcDelete, startInteractiveEventsAdd, startInteractiveEventsUpdate, startInteractiveEventsDelete } from './interactiveUpdate';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';

export const npcCommand: Command = {
    name: 'npc',
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

        // 🆕 Events Subcommand: $npc events [nome/ID] [pagina]
        // 🆕 Events Subcommand: $npc events [action] [nome/ID]
        if (subCommand === 'events') {
            const remainder = ctx.args.slice(1);
            const action = remainder[0]?.toLowerCase();
            const campaignId = ctx.activeCampaign!.id;

            // Handlers for Add/Update/Delete
            if (['add', 'update', 'delete', 'modifica', 'rimuovi', 'crea'].includes(action)) {
                // Determine Mode
                let mode: 'ADD' | 'UPDATE' | 'DELETE' = 'ADD';
                if (['update', 'modifica'].includes(action)) mode = 'UPDATE';
                if (['delete', 'rimuovi'].includes(action)) mode = 'DELETE';

                // Parse Target: "$npc events add <Name>" -> remainder: ["add", "Name"]
                // But wait, if user types "$npc events add Name | Desc", we need to split by | potentially?
                // handleEventAdd handles the interaction, so we just need the Entity Name to build Config.

                // We take everything after action as the identifier (rough guess)
                let targetIdentifier = remainder.slice(1).join(' ').trim();

                // If empty, we might need to ask? Or default to interactive selection of NPC?
                // Existing startInteractiveNpcUpdate selects an NPC. 
                // Let's rely on Resolving IF provided, else fail/ask.

                if (!targetIdentifier) {
                    if (mode === 'ADD') await startInteractiveEventsAdd(ctx);
                    else if (mode === 'UPDATE') await startInteractiveEventsUpdate(ctx);
                    else await startInteractiveEventsDelete(ctx);
                    return;
                }

                // Resolve NPC
                let npcEntry = getNpcEntry(campaignId, targetIdentifier);
                if (!npcEntry) {
                    const byShort = getNpcByShortId(campaignId, targetIdentifier);
                    if (byShort) npcEntry = byShort;
                }

                if (!npcEntry) {
                    await ctx.message.reply(`❌ NPC **${targetIdentifier}** non trovato.`);
                    return;
                }

                const config: any = { // Use any to bypass import check for now, matches EntityEventsConfig
                    tableName: 'npc_history',
                    entityKeyColumn: 'npc_name',
                    entityKeyValue: npcEntry.name,
                    campaignId: campaignId,
                    entityDisplayName: npcEntry.name,
                    entityEmoji: '👤'
                };

                const { handleEventAdd, handleEventUpdate, handleEventDelete } = require('../utils/eventInteractive');

                if (mode === 'ADD') {
                    await handleEventAdd(ctx, config);
                } else if (mode === 'UPDATE') {
                    // Start Update Flow (Selection list)
                    await handleEventUpdate(ctx, config);
                } else {
                    await handleEventDelete(ctx, config);
                }
                return;
            }

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
                await ctx.message.reply(`❌ NPC **${npcTarget}** non trovato.`);
            }
            return;
        }

        const generateDossierEmbed = (npc: any) => {
            const statusIcon = npc.status === 'DEAD' ? '💀' : npc.status === 'MISSING' ? '❓' : '👤';
            const statusColor = npc.status === 'DEAD' ? "#FF0000" : npc.status === 'MISSING' ? "#FFFF00" : "#00FF00";

            const embed = new EmbedBuilder()
                .setTitle(`${statusIcon} ${npc.name}`)
                .setColor(statusColor)
                .setDescription(npc.description || "*Nessuna nota.*")
                .addFields(
                    { name: "Ruolo", value: npc.role || "Sconosciuto", inline: true },
                    { name: "Stato", value: npc.status || "Vivo", inline: true },
                    { name: "ID", value: `\`#${npc.short_id}\``, inline: true }
                );

            if (npc.aliases) {
                embed.addFields({ name: "Alias", value: npc.aliases.split(',').join(', ') });
            }

            // 🆕 Alignment - Visual spectrum
            if (npc.alignment_moral || npc.alignment_ethical || npc.moral_score || npc.ethical_score) {
                const moralScore = npc.moral_score ?? 0;
                const ethicalScore = npc.ethical_score ?? 0;

                embed.addFields({
                    name: "⚖️ Allineamento",
                    value: formatAlignmentSpectrum(moralScore, ethicalScore),
                    inline: false
                });
            }

            // 🆕 Show faction affiliations
            const factionAffiliations = factionRepository.getEntityFactions('npc', npc.id);
            if (factionAffiliations.length > 0) {
                const factionText = factionAffiliations.map(a => {
                    const roleIcon = a.role === 'LEADER' ? '👑' : a.role === 'ALLY' ? '🤝' : a.role === 'ENEMY' ? '⚔️' : '👤';
                    return `${roleIcon} ${a.faction_name} (${a.role})`;
                }).join('\n');
                embed.addFields({ name: "⚔️ Fazioni", value: factionText });
            }

            const history = getNpcHistory(ctx.activeCampaign!.id, npc.name).slice(-3);
            if (history.length > 0) {
                const historyText = history.map((h: any) => {
                    const typeIcon = h.event_type === 'ALLIANCE' ? '🤝' : h.event_type === 'BETRAYAL' ? '🗡️' : h.event_type === 'DEATH' ? '💀' : '📝';
                    return `${typeIcon} ${h.description}`;
                }).join('\n');
                embed.addFields({ name: "Cronologia Recente", value: historyText });
            }

            embed.setFooter({ text: `Usa $npc update ${npc.short_id} | <Nota> per aggiornare.` });
            return embed;
        };

        // --- SESSION SPECIFIC: $npc <session_id> ---
        if (isSessionId(argsStr)) {
            const sessionId = extractSessionId(argsStr);
            const encounteredNPCs = getSessionEncounteredNPCs(sessionId);

            if (encounteredNPCs.length === 0) {
                await ctx.message.reply(`👥 Nessun NPC incontrato nella sessione \`${sessionId}\`.`);
                return;
            }

            let msg = `**👥 NPC della Sessione \`${sessionId}\`:**\n\n`;
            encounteredNPCs.forEach((npc: any) => {
                const statusIcon = npc.status === 'DEAD' ? '💀' : npc.status === 'MISSING' ? '❓' : '👤';
                msg += `${statusIcon} **${npc.name}** (${npc.role || '?'}) [${npc.status}]\n`;
                if (npc.description) {
                    const preview = npc.description.substring(0, 100) + (npc.description.length > 100 ? '...' : '');
                    msg += `   └ _${preview}_\n`;
                }
            });
            msg += `\n💡 Usa \`$npc <Nome>\` per vedere la scheda completa.`;

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
                await ctx.message.reply('Uso: `$npc add <Nome> | <Ruolo> | <Descrizione>`');
                return;
            }

            const [name, role, description] = parts;

            const existing = getNpcEntry(ctx.activeCampaign!.id, name);
            if (existing) {
                await ctx.message.reply(`⚠️ L'NPC **${name}** esiste già nel dossier. Usa \`$npc update\` per modificarlo.`);
                return;
            }

            updateNpcEntry(ctx.activeCampaign!.id, name, description, role, 'ALIVE', undefined, true);
            await ctx.message.reply(`✅ **Nuovo NPC Creato!**\n👤 **${name}**\n🎭 Ruolo: ${role}\n📜 ${description}`);
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
                    await ctx.message.reply('Uso: `$npc faction add <Nome NPC> | <Nome Fazione> | [Ruolo]`');
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
                    await ctx.message.reply(`❌ NPC **${npcName}** non trovato.`);
                    return;
                }

                // Resolve Faction
                let faction = factionRepository.getFaction(ctx.activeCampaign!.id, factionName);
                if (!faction) {
                    faction = factionRepository.createFaction(ctx.activeCampaign!.id, factionName, {
                        isManual: true,
                        description: "Creata manualmente via comando"
                    });
                }

                if (!faction) {
                    await ctx.message.reply(`❌ Errore nella creazione della fazione **${factionName}**.`);
                    return;
                }

                const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED'];
                const cleanRole = role ? role.toUpperCase() : 'MEMBER';

                if (!validRoles.includes(cleanRole)) {
                    await ctx.message.reply(`⚠️ Ruolo non valido. Usa: ${validRoles.join(', ')}. Impostato default: MEMBER`);
                }

                factionRepository.addAffiliation(faction.id, 'npc', targetNpc.id, {
                    role: (validRoles.includes(cleanRole) ? cleanRole : 'MEMBER') as any,
                    notes: "Aggiunto manualmente"
                });

                await ctx.message.reply(`✅ **${targetNpc.name}** ora è affiliato a **${faction.name}** come **${cleanRole}**.`);
                markNpcDirty(ctx.activeCampaign!.id, targetNpc.name);
                return;

            } else if (subArgs.startsWith('remove ')) {
                const parts = subArgs.substring(7).split('|').map(s => s.trim());
                if (parts.length < 2) {
                    await ctx.message.reply('Uso: `$npc faction remove <Nome NPC> | <Nome Fazione>`');
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
                    await ctx.message.reply(`❌ NPC **${npcName}** non trovato.`);
                    return;
                }

                const faction = factionRepository.getFaction(ctx.activeCampaign!.id, factionName);
                if (!faction) {
                    await ctx.message.reply(`❌ Fazione **${factionName}** non trovata.`);
                    return;
                }

                const success = factionRepository.removeAffiliation(faction.id, 'npc', targetNpc.id);
                if (success) {
                    await ctx.message.reply(`✅ Rimossa affiliazione di **${targetNpc.name}** da **${faction.name}**.`);
                    markNpcDirty(ctx.activeCampaign!.id, targetNpc.name);
                } else {
                    await ctx.message.reply(`⚠️ Nessuna affiliazione attiva trovata tra **${targetNpc.name}** e **${faction.name}**.`);
                }
                return;
            } else {
                await ctx.message.reply('Uso: `$npc faction add ...` o `$npc faction remove ...`');
                return;
            }
        }

        // SUBCOMMAND: merge
        if (argsStr.toLowerCase().startsWith('merge')) {
            const content = argsStr.substring(5).trim();

            const mergeConfig: MergeConfig = {
                entityType: 'NPC',
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
                    db.transaction(() => {
                        // 1. Move History
                        db.prepare(`UPDATE npc_history SET npc_name = ? WHERE campaign_id = ? AND lower(npc_name) = lower(?)`)
                            .run(target.name, cid, source.name);

                        // 2. Metadata (smart merge bio)
                        if (mergedDesc) {
                            updateNpcEntry(cid, target.name as string, mergedDesc, undefined, undefined, undefined, true);
                        }

                        // 3. Move Affiliations
                        const sourceAffiliations = db.prepare('SELECT id, faction_id FROM faction_affiliations WHERE entity_type = "npc" AND entity_id = (SELECT id FROM npc_dossier WHERE campaign_id = ? AND name = ?)').all(cid, source.name) as any[];
                        const targetId = (db.prepare('SELECT id FROM npc_dossier WHERE campaign_id = ? AND name = ?').get(cid, target.name) as any).id;

                        for (const aff of sourceAffiliations) {
                            const conflict = db.prepare('SELECT id FROM faction_affiliations WHERE faction_id = ? AND entity_type = "npc" AND entity_id = ?').get(aff.faction_id, targetId) as any;
                            if (conflict) {
                                db.prepare('DELETE FROM faction_affiliations WHERE id = ?').run(aff.id);
                            } else {
                                db.prepare('UPDATE faction_affiliations SET entity_id = ? WHERE id = ?').run(targetId, aff.id);
                            }
                        }

                        // 4. Migrate RAG
                        migrateKnowledgeFragments(cid, source.name as string, target.name as string);

                        // 5. Delete source
                        deleteNpcRagSummary(cid, source.name as string);
                        deleteNpcHistory(cid, source.name as string);
                        deleteNpcEntry(cid, source.name as string);
                    })();
                    return true;
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

            // Full Wipe: RAG + History + Dossier
            await ctx.message.reply(`🗑️ Eliminazione completa per **${name}** in corso...`);

            // 1. Delete RAG Dossier Summary
            deleteNpcRagSummary(ctx.activeCampaign!.id, name);

            // 2. Delete History
            deleteNpcHistory(ctx.activeCampaign!.id, name);

            // 3. Delete Dossier Entry
            const success = deleteNpcEntry(ctx.activeCampaign!.id, name);

            if (success) await ctx.message.reply(`✅ NPC **${name}** eliminato definitivamente (RAG, Storia, Dossier).`);
            else await ctx.message.reply(`❌ NPC "${name}" non trovato.`);
            return;
        }

        // SUBCOMMAND: alias
        if (argsStr.toLowerCase().startsWith('alias ')) {
            const parts = argsStr.substring(6).split('|').map(s => s.trim());

            if (parts.length < 2) {
                const npc = getNpcEntry(ctx.activeCampaign!.id, parts[0]);
                if (!npc) {
                    await ctx.message.reply(`❌ NPC **${parts[0]}** non trovato.`);
                    return;
                }

                const aliases = npc.aliases?.split(',').filter(a => a.trim()) || [];
                if (aliases.length === 0) {
                    await ctx.message.reply(
                        `📇 **Alias per ${npc.name}:** Nessuno\n\n` +
                        `**Comandi:**\n` +
                        `\`$npc alias ${npc.name} | add | <Alias>\` - Aggiungi alias\n` +
                        `\`$npc alias ${npc.name} | remove | <Alias>\` - Rimuovi alias`
                    );
                } else {
                    await ctx.message.reply(
                        `📇 **Alias per ${npc.name}:**\n` +
                        aliases.map(a => `• ${a.trim()}`).join('\n') +
                        `\n\n💡 Gli alias permettono di cercare l'NPC nel RAG con soprannomi o titoli.`
                    );
                }
                return;
            }

            const [npcName, action, alias] = parts;
            const npc = getNpcEntry(ctx.activeCampaign!.id, npcName);
            if (!npc) {
                await ctx.message.reply(`❌ NPC **${npcName}** non trovato.`);
                return;
            }

            if (action.toLowerCase() === 'add') {
                if (!alias) {
                    await ctx.message.reply('❌ Specifica l\'alias da aggiungere: `$npc alias <Nome> | add | <Alias>`');
                    return;
                }

                const success = addNpcAlias(ctx.activeCampaign!.id, npc.name, alias);
                if (success) {
                    await ctx.message.reply(`✅ Alias **"${alias}"** aggiunto a **${npc.name}**.\n💡 Ora puoi cercare "${alias}" e troverà frammenti relativi a ${npc.name}.`);
                } else {
                    await ctx.message.reply(`⚠️ Alias **"${alias}"** già presente per **${npc.name}**.`);
                }
                return;
            }

            if (action.toLowerCase() === 'remove' || action.toLowerCase() === 'del') {
                if (!alias) {
                    await ctx.message.reply('❌ Specifica l\'alias da rimuovere: `$npc alias <Nome> | remove | <Alias>`');
                    return;
                }

                const success = removeNpcAlias(ctx.activeCampaign!.id, npc.name, alias);
                if (success) {
                    await ctx.message.reply(`✅ Alias **"${alias}"** rimosso da **${npc.name}**.`);
                } else {
                    await ctx.message.reply(`❌ Alias **"${alias}"** non trovato per **${npc.name}**.`);
                }
                return;
            }

            await ctx.message.reply('❌ Azione non valida. Usa `add` o `remove`.');
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
                    await ctx.message.reply(`❌ NPC **${name}** non trovato.`);
                    return;
                }

                const loadingMsg = await ctx.message.reply(`⚙️ Aggiungo nota al dossier di **${name}**...`);

                const eventDesc = `[NOTA DM] ${note}`;
                addNpcEvent(ctx.activeCampaign!.id, npc.name, 'MANUAL', eventDesc, 'DM_NOTE', true);

                // Trigger regen
                const newDesc = await syncNpcDossierIfNeeded(ctx.activeCampaign!.id, npc.name, true);

                await loadingMsg.edit(`✅ Dossier aggiornato!\n📌 Sync RAG programmato.\n\n📜 **Nuova Bio:**\n${newDesc ? newDesc.substring(0, 500) : ''}${newDesc && newDesc.length > 500 ? '...' : ''}`);
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
                        await ctx.message.reply('❌ Valore mancante.');
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
                        await ctx.message.reply(`❌ NPC **${name}** non trovato.`);
                    } else {
                        await ctx.message.reply('Uso:\n1. `$npc update <Nome> | <Nota>` (Narrativo)\n2. `$npc update <Nome/ID> <status/role/name> <valore>` (Rapido)\n3. `$npc update <Nome> field:<campo> <valore>` (Esplicito)');
                    }
                    return;
                }

                // If found NPC but no action, show context
                if (!fieldKey || !value) {
                    await ctx.message.reply(
                        `✏️ **Aggiornamento NPC: ${npc.name}**\n` +
                        `Status attuale: **${npc.status}**\n` +
                        `Ruolo attuale: **${npc.role || 'Nessuno'}**\n\n` +
                        `**Comandi Rapidi:**\n` +
                        `\`$npc update ${npc.short_id} status DEAD\`\n` +
                        `\`$npc update ${npc.short_id} role Nuovo Ruolo\`\n` +
                        `\`$npc update ${npc.short_id} | <Nota Narrativa>\``
                    );
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
                    await ctx.message.reply(`❌ L'allineamento morale è ora calcolato automaticamente dagli eventi. Usa \`$npc events add\` per registrare azioni che influenzano l'allineamento.`);
                    return;
                } else if (fieldKey === 'ethical' || fieldKey === 'ethic' || fieldKey === 'etica') {
                    // updates.alignment_ethical = value.toUpperCase();
                    await ctx.message.reply(`❌ L'allineamento etico è ora calcolato automaticamente dagli eventi. Usa \`$npc events add\` per registrare azioni che influenzano l'allineamento.`);
                    return;
                } else if (fieldKey === 'faction' || fieldKey === 'fazione') {
                    // Special handling for faction relations
                    const [factionName, roleInput] = value.split('|').map(s => s.trim());

                    let faction = factionRepository.getFaction(ctx.activeCampaign!.id, factionName);
                    if (!faction) {
                        faction = factionRepository.createFaction(ctx.activeCampaign!.id, factionName, {
                            isManual: true,
                            description: "Creata manualmente via update rapido"
                        });
                    }

                    if (faction) {
                        const validRoles = ['LEADER', 'MEMBER', 'ALLY', 'ENEMY', 'CONTROLLED'];
                        const role = roleInput ? roleInput.toUpperCase() : 'MEMBER';
                        const finalRole = validRoles.includes(role) ? role : 'MEMBER';

                        factionRepository.addAffiliation(faction.id, 'npc', npc.id, {
                            role: finalRole as any,
                            notes: "Aggiornato via $npc update"
                        });

                        await ctx.message.reply(`✅ **${npc.name}** ora affiliato a **${faction.name}** (${finalRole}).`);
                        markNpcDirty(ctx.activeCampaign!.id, npc.name);
                        return;
                    } else {
                        await ctx.message.reply(`❌ Errore creazione fazione **${factionName}**.`);
                        return;
                    }
                } else {
                    await ctx.message.reply('❌ Campo non valido. Usa: `name`, `role`, `status`, `moral`, `ethical`, `faction`');
                    return;
                }

                const success = updateNpcFields(ctx.activeCampaign!.id, resolvedName, updates);

                if (success) {
                    if (updates.name) {
                        migrateKnowledgeFragments(ctx.activeCampaign!.id, resolvedName, updates.name);
                        markNpcDirty(ctx.activeCampaign!.id, updates.name);
                        await ctx.message.reply(`✅ NPC rinominato da **${resolvedName}** a **${updates.name}**.\n📌 RAG migrato e sync programmato.`);
                        return;
                    }
                    await ctx.message.reply(`✅ NPC **${resolvedName}** aggiornato: ${fieldKey} = ${updates.status || value}`);
                } else {
                    await ctx.message.reply(`❌ Errore durante l'aggiornamento.`);
                }
                return;
            }
        }

        // SUBCOMMAND: regen
        if (argsStr.toLowerCase().startsWith('regen')) {
            const name = argsStr.substring(6).trim();
            const npc = getNpcEntry(ctx.activeCampaign!.id, name);
            if (!npc) {
                await ctx.message.reply(`❌ NPC **${name}** non trovato.`);
                return;
            }

            const loadingMsg = await ctx.message.reply(`⚙️ Rigenerazione Note: Analisi cronologia per **${name}**...`);

            const newDesc = await syncNpcDossierIfNeeded(
                ctx.activeCampaign!.id,
                npc.name,
                true
            );

            if (newDesc) {
                await loadingMsg.delete().catch(() => { });
                await safeReply(ctx.message, `✅ Note Aggiornate e Sincronizzate con RAG!\n\n📜 **Nuova Bio:**\n${newDesc}`);
            } else {
                await loadingMsg.edit(`❌ Errore durante la rigenerazione.`);
            }
            return;
        }

        // SUBCOMMAND: sync
        if (argsStr.toLowerCase().startsWith('sync')) {
            const name = argsStr.substring(5).trim();

            if (!name || name === 'all') {
                const loadingMsg = await ctx.message.reply('⚙️ Sincronizzazione batch NPC in corso...');
                const count = await syncAllDirtyNpcs(ctx.activeCampaign!.id);

                if (count > 0) {
                    await loadingMsg.edit(`✅ Sincronizzati **${count} NPC** con RAG.`);
                } else {
                    await loadingMsg.edit('✨ Tutti gli NPC sono già sincronizzati!');
                }
            } else {
                const npc = getNpcEntry(ctx.activeCampaign!.id, name);
                if (!npc) {
                    await ctx.message.reply(`❌ NPC **${name}** non trovato.`);
                    return;
                }

                const loadingMsg = await ctx.message.reply(`⚙️ Sincronizzazione RAG per **${name}**...`);
                await syncNpcDossierIfNeeded(ctx.activeCampaign!.id, name, true);
                await loadingMsg.edit(`✅ **${name}** sincronizzato con RAG.`);
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
            await ctx.message.reply(`👤 Scheda di **${name}** aggiornata.`);
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
                    return { embed: new EmbedBuilder().setDescription("❌ Pagina inesistente."), totalPages: Math.ceil(total / ITEMS_PER_PAGE) };
                }

                if (total === 0) {
                    return { embed: new EmbedBuilder().setDescription("L'archivio NPC è vuoto."), totalPages: 0 };
                }

                const list = npcs.map((n: any) => {
                    const statusIcon = n.status === 'DEAD' ? '💀' : n.status === 'MISSING' ? '❓' : '👤';
                    const descPreview = (n.description && n.description.trim().length > 0)
                        ? `\n> *${n.description.substring(0, 80)}${n.description.length > 80 ? '...' : ''}*`
                        : '';
                    return `\`#${n.short_id}\` ${statusIcon} **${n.name}** (${n.role || '?'}) [${n.status}]${descPreview}`;
                }).join('\n\n');

                const embed = new EmbedBuilder()
                    .setTitle(`📂 Dossier NPC (${ctx.activeCampaign?.name})`)
                    .setColor("#E67E22")
                    .setDescription(list)
                    .setFooter({ text: `Pagina ${page + 1} di ${totalPages} • Totale: ${total}` });

                return { embed, totalPages };
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

            const generateSelectMenu = (npcs: any[]) => {
                if (npcs.length === 0) return null;

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_npc')
                    .setPlaceholder('🔍 Seleziona un NPC per i dettagli...')
                    .addOptions(
                        npcs.map((n: any) =>
                            new StringSelectMenuOptionBuilder()
                                .setLabel(n.name)
                                .setDescription(n.role || 'Senza ruolo')
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
                                await interaction.reply({ content: "NPC non trovato.", ephemeral: true });
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
            await ctx.message.reply("NPC non trovato.");
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

    // Resolve short ID
    const sidMatch = npcIdentifier.match(/^#([a-z0-9]{5})$/i);
    if (sidMatch) {
        const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatch[1]);
        if (npc) npcIdentifier = npc.name;
        else {
            await ctx.message.reply(`❌ NPC con ID \`#${sidMatch[1]}\` non trovato.`);
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
        entityEmoji: '👤'
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
        await ctx.message.reply("L'archivio NPC è vuoto.");
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle("👤 Selezione NPC per Cronologia")
        .setColor("#9B59B6")
        .setDescription("Seleziona un NPC dal menu a tendina per vederne la cronologia degli eventi.");

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_npc_events')
        .setPlaceholder('🔍 Seleziona un NPC...')
        .addOptions(
            npcs.map((n: any) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(n.name)
                    .setDescription(n.role || 'Senza ruolo')
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
            await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'select_npc_events') {
            const selectedName = interaction.values[0];
            const npc = getNpcEntry(ctx.activeCampaign!.id, selectedName);
            if (npc) {
                await interaction.update({ content: `✅ Mostro eventi per **${npc.name}**...`, embeds: [], components: [] });
                await showNpcEventsByIdentifier(ctx, npc.name, 1);
            }
        }
    });
}
