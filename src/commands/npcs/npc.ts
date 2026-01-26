/**
 * $npc / $dossier command - NPC management with many subcommands
 */

import { EmbedBuilder } from 'discord.js';
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
    addNpcEvent, // 🆕
    deleteNpcRagSummary,
    deleteNpcHistory,
    getNpcByShortId
} from '../../db';
import {
    smartMergeBios,
    syncNpcDossierIfNeeded,
    syncAllDirtyNpcs
} from '../../bard';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { safeReply } from '../../utils/discordHelper';

export const npcCommand: Command = {
    name: 'npc',
    aliases: ['dossier'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        // --- LIST / PAGINATION: $npc list [page] or $npc [page] ---
        // Check if argsStr is empty, "list", "list <n>", or just "<n>" (where n is page if > 10 items?)
        // Actually, "$npc <n>" is currently used for SELECTION.
        // We need to distinguish between "Select NPC #2" and "Show Page 2".
        // Convention: "$npc list <n>" for page. "$npc <n>" for selection.
        // If "$npc" alone -> Page 1.

        if (!argsStr || argsStr.toLowerCase().startsWith('list')) {
            let page = 1;
            const parts = argsStr.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                page = parseInt(parts[1]);
            }

            const pageSize = 10;
            const offset = (page - 1) * pageSize;
            const totalNpcs = countNpcs(ctx.activeCampaign!.id);
            const totalPages = Math.ceil(totalNpcs / pageSize);

            if (page < 1 || (totalPages > 0 && page > totalPages)) {
                await ctx.message.reply(`❌ Pagina ${page} non valida. Totale pagine: ${totalPages || 1}.`);
                return;
            }

            const npcs = listNpcs(ctx.activeCampaign!.id, pageSize, offset);
            if (npcs.length === 0) {
                await ctx.message.reply("L'archivio NPC è vuoto.");
                return;
            }

            const list = npcs.map((n: any, i: number) => {
                const absoluteIndex = offset + i + 1;
                return `\`${absoluteIndex}\` \`#${n.short_id}\` 👤 **${n.name}** (${n.role || '?'}) [${n.status}]`;
            }).join('\n');

            let footer = `\n\n💡 Usa \`$npc <numero>\` o \`$npc <Nome>\` per dettagli.`;
            if (totalPages > 1) {
                footer = `\n\n📄 **Pagina ${page}/${totalPages}** (Usa \`$npc list ${page + 1}\` per la prossima)` + footer;
            }

            await safeReply(ctx.message, `**📂 Dossier NPC Recenti**\n${list}${footer}`);
            return;
        }

        // --- SELECTION BY ID: $npc #abcde, $npc 1 ---
        const sidMatch = argsStr.match(/^#([a-z0-9]{5})$/i);
        const numericMatch = argsStr.match(/^#?(\d+)$/);

        if (sidMatch || numericMatch) {
            let npc: any = null;

            if (sidMatch) {
                npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatch[1]);
            } else if (numericMatch) {
                const absoluteIdx = parseInt(numericMatch[1]);
                const npcs = listNpcs(ctx.activeCampaign!.id, 1, absoluteIdx - 1);
                if (npcs.length > 0) npc = npcs[0];
            }

            if (!npc) {
                if (numericMatch) {
                    const total = countNpcs(ctx.activeCampaign!.id);
                    await ctx.message.reply(`❌ ID non valido. Usa un numero da 1 a ${total}.`);
                } else {
                    await ctx.message.reply(`❌ ID \`#${sidMatch![1]}\` non trovato.`);
                }
                return;
            }
            const statusIcon = npc.status === 'DEAD' ? '💀' : npc.status === 'MISSING' ? '❓' : '👤';
            let response = `${statusIcon} **${npc.name}**\n`;
            response += `🎭 **Ruolo:** ${npc.role || 'Sconosciuto'}\n`;
            response += `📊 **Stato:** ${npc.status}\n`;
            response += `📜 **Note:**\n> ${npc.description || '_Nessuna nota_'}`;

            const history = getNpcHistory(ctx.activeCampaign!.id, npc.name).slice(-5);
            if (history.length > 0) {
                response += `\n\n📖 **Cronologia Recente:**\n`;
                history.forEach((h: any) => {
                    const typeIcon = h.event_type === 'ALLIANCE' ? '🤝' : h.event_type === 'BETRAYAL' ? '🗡️' : h.event_type === 'DEATH' ? '💀' : '📝';
                    response += `${typeIcon} ${h.description}\n`;
                });
            }

            await safeReply(ctx.message, response);
            return;
        }

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
            const sourceIdMatch = sourceName.match(/^#?(\d+)$/);

            if (sourceSidMatch) {
                const npc = getNpcByShortId(ctx.activeCampaign!.id, sourceSidMatch[1]);
                if (npc) sourceName = npc.name;
            } else if (sourceIdMatch) {
                const idx = parseInt(sourceIdMatch[1]) - 1;
                const npcs = listNpcs(ctx.activeCampaign!.id, 1, idx);
                if (npcs.length > 0) sourceName = npcs[0].name;
            }

            // Resolve Target ID
            const targetSidMatch = targetName.match(/^#([a-z0-9]{5})$/i);
            const targetIdMatch = targetName.match(/^#?(\d+)$/);

            if (targetSidMatch) {
                const npc = getNpcByShortId(ctx.activeCampaign!.id, targetSidMatch[1]);
                if (npc) targetName = npc.name;
            } else if (targetIdMatch) {
                const idx = parseInt(targetIdMatch[1]) - 1;
                const npcs = listNpcs(ctx.activeCampaign!.id, 1, idx);
                if (npcs.length > 0) targetName = npcs[0].name;
            }

            const sourceNpc = getNpcEntry(ctx.activeCampaign!.id, sourceName);
            const targetNpc = getNpcEntry(ctx.activeCampaign!.id, targetName);

            if (!sourceNpc) {
                await ctx.message.reply(`❌ Impossibile unire: NPC "${sourceName}" non trovato.`);
                return;
            }

            if (targetNpc) {
                await ctx.message.reply(`⏳ **Smart Merge:** Unione intelligente di "${sourceName}" in "${targetName}"...`);

                const mergedDesc = await smartMergeBios(targetNpc.description || "", sourceNpc.description || "");

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
            const idMatch = name.match(/^#?(\d+)$/);

            if (sidMatch) {
                const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (npc) name = npc.name;
            } else if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const npcs = listNpcs(ctx.activeCampaign!.id, 1, idx);
                if (npcs.length > 0) name = npcs[0].name;
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
        // Unified Syntax:
        // 1. Narrative: $npc update <Name> | <Note>
        // 2. Metadata:  $npc update <Name> field:<Field> <Value>
        if (argsStr.toLowerCase().startsWith('update')) {
            const content = argsStr.substring(7).trim(); // Remove 'update '

            // Pattern 2: Metadata Update (field:...)
            // check if second token is field:something
            // We need to parse strict tokens for this, or split by pipe?
            // If it contains pipe, it's likely Type 1 (unless name has pipe... unlikely).

            // Let's rely on pipe separation for Narrative, and non-pipe for Metadata?
            // "Garlon field:status DEAD"

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
                const sidMatchArea = name.match(/^#([a-z0-9]{5})$/i);
                const idMatchArea = name.match(/^#?(\d+)$/);

                if (sidMatchArea) {
                    const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatchArea[1]);
                    if (npc) name = npc.name;
                } else if (idMatchArea) {
                    const idx = parseInt(idMatchArea[1]) - 1;
                    const npcs = listNpcs(ctx.activeCampaign!.id, 1, idx);
                    if (npcs.length > 0) name = npcs[0].name;
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
                // Expect: Name field:status Value
                // This is tricky if Name has spaces.
                // Alternative: $npc update Name | field:status Value ?
                // Guide says: "$npc update Garlon field:status DEAD"
                // Parse strategy: Name is everything before "field:".

                const fieldIndex = content.indexOf('field:');
                if (fieldIndex === -1) {
                    await ctx.message.reply('Uso:\n1. `$npc update <Nome> | <Nota>` (Narrativo)\n2. `$npc update <Nome> field:<campo> <valore>` (Metadati)');
                    return;
                }

                let name = content.substring(0, fieldIndex).trim();
                const remainder = content.substring(fieldIndex); // field:status DEAD

                // ID Resolution
                const sidMatchMeta = name.match(/^#([a-z0-9]{5})$/i);
                const idMatchMeta = name.match(/^#?(\d+)$/);

                if (sidMatchMeta) {
                    const npc = getNpcByShortId(ctx.activeCampaign!.id, sidMatchMeta[1]);
                    if (npc) name = npc.name;
                } else if (idMatchMeta) {
                    const idx = parseInt(idMatchMeta[1]) - 1;
                    const npcs = listNpcs(ctx.activeCampaign!.id, 1, idx);
                    if (npcs.length > 0) name = npcs[0].name;
                }

                const firstSpace = remainder.indexOf(' ');

                let fieldKey = '';
                let value = '';

                if (firstSpace === -1) {
                    // "field:status" (missing value?)
                    await ctx.message.reply('❌ Valore mancante.');
                    return;
                }

                fieldKey = remainder.substring(6, firstSpace); // remove field:
                value = remainder.substring(firstSpace + 1).trim();

                const npc = getNpcEntry(ctx.activeCampaign!.id, name);
                if (!npc) {
                    await ctx.message.reply(`❌ NPC **${name}** non trovato.`);
                    return;
                }

                const updates: any = {};
                if (fieldKey === 'name') {
                    updates.name = value;
                } else if (fieldKey === 'role') {
                    updates.role = value;
                } else if (fieldKey === 'status') {
                    updates.status = value;
                } else if (fieldKey === 'desc' || fieldKey === 'description') {
                    // Legacy fallback manual overwrite
                    updates.description = value;
                } else {
                    await ctx.message.reply('❌ Campo non valido. Usa: `name`, `role`, `status`');
                    return;
                }

                const success = updateNpcFields(ctx.activeCampaign!.id, name, updates);

                if (success) {
                    if (updates.name) {
                        migrateKnowledgeFragments(ctx.activeCampaign!.id, name, updates.name);
                        markNpcDirty(ctx.activeCampaign!.id, updates.name);
                        await ctx.message.reply(`✅ NPC rinominato da **${name}** a **${updates.name}**.\n📌 RAG migrato e sync programmato.`);
                        return;
                    }
                    await ctx.message.reply(`✅ NPC **${name}** aggiornato: ${fieldKey} = ${value}`);
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

        // SETTER: $npc Nome | Descrizione
        if (argsStr.includes('|')) {
            const [name, desc] = argsStr.split('|').map(s => s.trim());
            updateNpcEntry(ctx.activeCampaign!.id, name, desc, undefined, undefined, undefined, true);
            await ctx.message.reply(`👤 Scheda di **${name}** aggiornata.`);
            return;
        }

        // GETTER: $npc Nome / #abcde
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

        const embed = new EmbedBuilder()
            .setTitle(`👤 Dossier: ${npc.name}`)
            .setColor(npc.status === 'DEAD' ? "#FF0000" : "#00FF00")
            .addFields(
                { name: "Ruolo", value: npc.role || "Sconosciuto", inline: true },
                { name: "Stato", value: npc.status || "Vivo", inline: true },
                { name: "Note", value: npc.description || "Nessuna nota." }
            )
            .setFooter({ text: `Ultimo avvistamento: ${npc.last_updated}` });

        await ctx.message.reply({ embeds: [embed] });
    }
};
