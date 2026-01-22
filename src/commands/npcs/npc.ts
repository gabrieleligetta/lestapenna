/**
 * $npc / $dossier command - NPC management with many subcommands
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    listNpcs,
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
    db
} from '../../db';
import {
    smartMergeBios,
    syncNpcDossierIfNeeded,
    syncAllDirtyNpcs
} from '../../bard';
import { isSessionId, extractSessionId } from '../../utils/sessionId';

export const npcCommand: Command = {
    name: 'npc',
    aliases: ['dossier'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        if (!argsStr) {
            // LIST with numeric IDs
            const npcs = listNpcs(ctx.activeCampaign!.id);
            if (npcs.length === 0) {
                await ctx.message.reply("L'archivio NPC è vuoto.");
                return;
            }

            const list = npcs.map((n: any, i: number) => `\`${i + 1}\` 👤 **${n.name}** (${n.role || '?'}) [${n.status}]`).join('\n');
            await ctx.message.reply(`**📂 Dossier NPC Recenti**\n${list}\n\n💡 Usa \`$npc <numero>\` o \`$npc <Nome>\` per dettagli.`);
            return;
        }

        // --- SELECTION BY NUMERIC ID: $npc 1, $npc #2 ---
        const numericMatch = argsStr.match(/^#?(\d+)$/);
        if (numericMatch) {
            const idx = parseInt(numericMatch[1]) - 1;
            const npcs = listNpcs(ctx.activeCampaign!.id);

            if (idx < 0 || idx >= npcs.length) {
                await ctx.message.reply(`❌ ID non valido. Usa un numero da 1 a ${npcs.length}.`);
                return;
            }

            const npc = npcs[idx];
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

            await ctx.message.reply(response);
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

            await ctx.message.reply(msg);
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

            updateNpcEntry(ctx.activeCampaign!.id, name, description, role, 'ALIVE');
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

            const sourceName = parts[0];
            const targetName = parts[1];

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
            const name = argsStr.substring(7).trim();
            const success = deleteNpcEntry(ctx.activeCampaign!.id, name);
            if (success) await ctx.message.reply(`🗑️ NPC **${name}** eliminato dal dossier.`);
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
        if (argsStr.toLowerCase().startsWith('update')) {
            const parts = argsStr.substring(7).split('|').map(s => s.trim());

            if (parts.length < 3 || parts.length > 4) {
                await ctx.message.reply('Uso: `$npc update <Nome> | <Campo> | <Valore> [| force]`\nCampi validi: `name`, `role`, `status`, `description`\n💡 Aggiungi `| force` per sovrascrittura diretta (solo description)');
                return;
            }

            const [name, field, value] = parts;
            const forceFlag = parts[3]?.toLowerCase();
            const isForceMode = forceFlag === 'force' || forceFlag === '--force' || forceFlag === '!';

            const npc = getNpcEntry(ctx.activeCampaign!.id, name);
            if (!npc) {
                await ctx.message.reply(`❌ NPC **${name}** non trovato.`);
                return;
            }

            if (field === 'description' || field === 'desc') {
                if (isForceMode) {
                    const loadingMsg = await ctx.message.reply(`🔥 **FORCE MODE** attivato per **${name}**...\n⚠️ La vecchia descrizione verrà completamente sostituita.`);

                    db.prepare('UPDATE npc_dossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(value, npc.id);

                    markNpcDirty(ctx.activeCampaign!.id, npc.name);

                    await loadingMsg.edit(`🔥 **Sovrascrittura completata!**\n📌 Sync RAG programmato.\n\n📜 **Nuova Bio:**\n${value.substring(0, 500)}${value.length > 500 ? '...' : ''}`);
                    return;
                } else {
                    const loadingMsg = await ctx.message.reply(`⚙️ Merge intelligente descrizione per **${name}**...`);

                    const mergedDesc = await smartMergeBios(npc.description || '', value);

                    db.prepare('UPDATE npc_dossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(mergedDesc, npc.id);

                    markNpcDirty(ctx.activeCampaign!.id, npc.name);

                    await loadingMsg.edit(`✅ Descrizione aggiornata!\n📌 Sync RAG programmato.\n💡 Tip: Usa \`| force\` alla fine per sovrascrittura diretta.\n\n📜 **Nuova Bio:**\n${mergedDesc.substring(0, 500)}${mergedDesc.length > 500 ? '...' : ''}`);
                    return;
                }
            }

            const updates: any = {};
            if (field === 'name') {
                updates.name = value;
            } else if (field === 'role') {
                updates.role = value;
            } else if (field === 'status') {
                updates.status = value;
            } else {
                await ctx.message.reply('❌ Campo non valido. Usa: `name`, `role`, `status`, `description`');
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
                await ctx.message.reply(`✅ NPC **${name}** aggiornato: ${field} = ${value}`);
            } else {
                await ctx.message.reply(`❌ Errore durante l'aggiornamento.`);
            }
            return;
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
                await loadingMsg.edit(`✅ Note Aggiornate e Sincronizzate con RAG!\n\n📜 **Nuova Bio:**\n${newDesc.substring(0, 800)}${newDesc.length > 800 ? '...' : ''}`);
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
            updateNpcEntry(ctx.activeCampaign!.id, name, desc);
            await ctx.message.reply(`👤 Scheda di **${name}** aggiornata.`);
            return;
        }

        // GETTER: $npc Nome
        const npc = getNpcEntry(ctx.activeCampaign!.id, argsStr);
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
