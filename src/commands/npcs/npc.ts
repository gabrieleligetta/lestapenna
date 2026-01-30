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
import { showEntityEvents } from '../utils/eventsViewer';

export const npcCommand: Command = {
    name: 'npc',
    aliases: ['dossier'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const firstArg = ctx.args[0];
        const argsStr = ctx.args.join(' ');

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

            // 🆕 Aglignment
            if (npc.alignment_moral || npc.alignment_ethical) {
                embed.addFields({
                    name: "⚖️ Allineamento",
                    value: `${npc.alignment_ethical || 'NEUTRALE'} ${npc.alignment_moral || 'NEUTRALE'}`,
                    inline: true
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
        if (argsStr.toLowerCase().startsWith('add ') || argsStr.toLowerCase().startsWith('create ') || argsStr.toLowerCase().startsWith('crea ')) {
            const content = argsStr.substring(argsStr.indexOf(' ') + 1);
            const parts = content.split('|').map(s => s.trim());

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
        if (argsStr.toLowerCase().startsWith('merge ')) {
            const parts = argsStr.substring(6).split('|').map(s => s.trim());
            if (parts.length !== 2) {
                await ctx.message.reply("Uso: `$npc merge <Vecchio Nome> | <Nuovo Nome>`");
                return;
            }

            let sourceName = parts[0];
            let targetName = parts[1];

            // Resolve Source ID
            const sourceSidMatch = sourceName.match(/^#([a-z0-9]{5})$/i);

            if (sourceSidMatch) {
                const npc = getNpcByShortId(ctx.activeCampaign!.id, sourceSidMatch[1]);
                if (npc) sourceName = npc.name;
            }

            // Resolve Target ID
            const targetSidMatch = targetName.match(/^#([a-z0-9]{5})$/i);

            if (targetSidMatch) {
                const npc = getNpcByShortId(ctx.activeCampaign!.id, targetSidMatch[1]);
                if (npc) targetName = npc.name;
            }

            const sourceNpc = getNpcEntry(ctx.activeCampaign!.id, sourceName);
            const targetNpc = getNpcEntry(ctx.activeCampaign!.id, targetName);

            if (!sourceNpc) {
                await ctx.message.reply(`❌ Impossibile unire: NPC "${sourceName}" non trovato.`);
                return;
            }

            if (targetNpc) {
                await ctx.message.reply(`⏳ **Smart Merge:** Unione intelligente di "${sourceName}" in "${targetName}"...`);

                const mergedDesc = await smartMergeBios(targetName, targetNpc.description || "", sourceNpc.description || "");

                db.prepare(`UPDATE npc_dossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(mergedDesc, targetNpc.id);

                db.prepare(`UPDATE npc_history SET npc_name = ? WHERE campaign_id = ? AND lower(npc_name) = lower(?)`)
                    .run(targetName, ctx.activeCampaign!.id, sourceName);

                db.prepare(`DELETE FROM npc_dossier WHERE id = ?`).run(sourceNpc.id);

                await ctx.message.reply(`✅ **Unito!**\n📜 **Nuova Bio:**\n> *${mergedDesc}*`);
            } else {
                const success = renameNpcEntry(ctx.activeCampaign!.id, sourceName, targetName);
                if (success) await ctx.message.reply(`✅ NPC rinominato: **${sourceName}** è ora **${targetName}**.`);
                else await ctx.message.reply(`❌ Errore durante la rinomina.`);
            }
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

            if (content.includes('|')) {
                // Type 1: Narrative Update
                const parts = content.split('|').map(s => s.trim());
                if (parts.length < 2) {
                    await ctx.message.reply('Uso: `$npc update <Nome> | <Nota/Fatto>`');
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
                    updates.alignment_moral = value.toUpperCase();
                } else if (fieldKey === 'ethical' || fieldKey === 'ethic' || fieldKey === 'etica') {
                    updates.alignment_ethical = value.toUpperCase();
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
        // Pattern: last arg is 'events' or second-to-last is 'events' followed by page number
        const eventsMatch = argsStr.match(/^(.+?)\s+events(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            let npcIdentifier = eventsMatch[1].trim();
            const page = eventsMatch[2] ? parseInt(eventsMatch[2]) : 1;

            // Resolve short ID
            const sidMatch = npcIdentifier.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (npc) npcIdentifier = npc.name;
                else {
                    await ctx.message.reply(`❌ NPC con ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            }

            // Verify NPC exists
            const npc = getNpcEntry(ctx.activeCampaign!.id, npcIdentifier);
            if (!npc) {
                await ctx.message.reply(`❌ NPC **${npcIdentifier}** non trovato.`);
                return;
            }

            await showEntityEvents(ctx, {
                tableName: 'npc_history',
                entityKeyColumn: 'npc_name',
                entityKeyValue: npc.name,
                campaignId: ctx.activeCampaign!.id,
                entityDisplayName: npc.name,
                entityEmoji: '👤'
            }, page);
            return;
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
