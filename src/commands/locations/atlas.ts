/**
 * $atlante / $atlas command - Location atlas management
 */

import { Command, CommandContext } from '../types';
import {
    getCampaignLocation,
    getAtlasEntry,
    getAtlasEntryFull,
    listAtlasEntries,
    updateAtlasEntry,
    deleteAtlasEntry,
    renameAtlasEntry,
    mergeAtlasEntry,
    markAtlasDirty,
    getDirtyAtlasEntries,
    getSessionTravelLog
} from '../../db';
import {
    smartMergeBios,
    syncAllDirtyAtlas,
    syncAtlasEntryIfNeeded
} from '../../bard';
import { isSessionId, extractSessionId } from '../../utils/sessionId';

export const atlasCommand: Command = {
    name: 'atlas',
    aliases: ['atlante', 'memoria'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        // --- SESSION SPECIFIC: $atlante <session_id> ---
        if (argsStr && isSessionId(argsStr)) {
            const sessionId = extractSessionId(argsStr);
            const travelLog = getSessionTravelLog(sessionId);

            if (travelLog.length === 0) {
                await ctx.message.reply(`📖 Nessun luogo visitato nella sessione \`${sessionId}\`.`);
                return;
            }

            // Group unique locations
            const uniqueLocations = new Map<string, { macro: string, micro: string, count: number }>();
            travelLog.forEach((h: any) => {
                const key = `${h.macro_location}|${h.micro_location}`;
                if (uniqueLocations.has(key)) {
                    uniqueLocations.get(key)!.count++;
                } else {
                    uniqueLocations.set(key, { macro: h.macro_location, micro: h.micro_location, count: 1 });
                }
            });

            let msg = `**📖 Luoghi Visitati nella Sessione \`${sessionId}\`:**\n`;
            uniqueLocations.forEach((loc) => {
                const entry = getAtlasEntry(ctx.activeCampaign!.id, loc.macro, loc.micro);
                const hasDesc = entry ? '📝' : '❔';
                msg += `${hasDesc} 🌍 **${loc.macro}** - 🏠 ${loc.micro}`;
                if (loc.count > 1) msg += ` *(${loc.count}x)*`;
                msg += '\n';
            });
            msg += `\n💡 Usa \`$atlante <Regione> | <Luogo>\` per vedere i dettagli.`;

            await ctx.message.reply(msg);
            return;
        }

        // --- NO ARGS: Show current location ---
        if (!argsStr) {
            const loc = getCampaignLocation(ctx.guildId);
            if (!loc || !loc.macro || !loc.micro) {
                // No current position, show list
                const entries = listAtlasEntries(ctx.activeCampaign!.id);
                if (entries.length === 0) {
                    await ctx.message.reply("📖 L'Atlante è vuoto. Usa `$atlante <Regione> | <Luogo> | <Descrizione>` per aggiungere voci.");
                    return;
                }

                const list = entries.slice(0, 10).map((e: any) =>
                    `🗺️ **${e.macro_location}** - *${e.micro_location}*`
                ).join('\n');
                await ctx.message.reply(`**📖 Atlante (Luoghi Recenti)**\n${list}\n\n💡 Usa \`$atlante <Regione> | <Luogo>\` per dettagli.`);
                return;
            }

            const lore = getAtlasEntry(ctx.activeCampaign!.id, loc.macro, loc.micro);
            if (lore) {
                await ctx.message.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n_${lore}_`);
            } else {
                await ctx.message.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n*Nessuna memoria registrata per questo luogo.*\n💡 Usa \`$atlante ${loc.macro} | ${loc.micro} | <descrizione>\` per aggiungerne una.`);
            }
            return;
        }

        // --- SUBCOMMAND: list ---
        if (argsStr.toLowerCase() === 'list' || argsStr.toLowerCase() === 'lista') {
            const entries = listAtlasEntries(ctx.activeCampaign!.id);
            if (entries.length === 0) {
                await ctx.message.reply("📖 L'Atlante è vuoto.");
                return;
            }

            const list = entries.map((e: any) => {
                const descPreview = e.description ? e.description.substring(0, 50) + (e.description.length > 50 ? '...' : '') : '*nessuna descrizione*';
                return `🗺️ **${e.macro_location}** - *${e.micro_location}*\n   └ ${descPreview}`;
            }).join('\n');
            await ctx.message.reply(`**📖 Atlante Completo**\n${list}`);
            return;
        }

        // --- SUBCOMMAND: sync ---
        if (argsStr.toLowerCase().startsWith('sync')) {
            const syncArgs = argsStr.substring(4).trim();

            // $atlante sync all - Sync all dirty locations
            if (!syncArgs || syncArgs.toLowerCase() === 'all') {
                const dirtyCount = getDirtyAtlasEntries(ctx.activeCampaign!.id).length;
                if (dirtyCount === 0) {
                    await ctx.message.reply('📍 Nessun luogo in attesa di sincronizzazione RAG.');
                    return;
                }

                const loadingMsg = await ctx.message.reply(`🔄 Sincronizzazione RAG di **${dirtyCount}** luoghi in corso...`);
                const synced = await syncAllDirtyAtlas(ctx.activeCampaign!.id);
                await loadingMsg.edit(`✅ Sincronizzati **${synced}** luoghi nel RAG.`);
                return;
            }

            // $atlante sync <Macro> | <Micro> - Sync specific location
            const parts = syncArgs.split('|').map(s => s.trim());
            if (parts.length === 2) {
                const [macro, micro] = parts;
                const loadingMsg = await ctx.message.reply(`🔄 Sincronizzazione RAG per **${macro} - ${micro}**...`);
                const result = await syncAtlasEntryIfNeeded(ctx.activeCampaign!.id, macro, micro, true);
                if (result) {
                    await loadingMsg.edit(`✅ **${macro} - ${micro}** sincronizzato nel RAG.`);
                } else {
                    await loadingMsg.edit(`❌ Luogo **${macro} - ${micro}** non trovato.`);
                }
                return;
            }

            await ctx.message.reply(
                '**Uso: `$atlante sync`**\n' +
                '`$atlante sync all` - Sincronizza tutti i luoghi dirty\n' +
                '`$atlante sync <Regione> | <Luogo>` - Sincronizza un luogo specifico'
            );
            return;
        }

        // --- SUBCOMMAND: rename/move ---
        if (argsStr.toLowerCase().startsWith('rename ') || argsStr.toLowerCase().startsWith('move ') || argsStr.toLowerCase().startsWith('rinomina ')) {
            const renameArgs = argsStr.substring(argsStr.indexOf(' ') + 1);
            const parts = renameArgs.split('|').map(s => s.trim());

            if (parts.length < 4) {
                await ctx.message.reply(
                    '**Uso: `$atlante rename`**\n' +
                    '`$atlante rename <VecchiaRegione> | <VecchioLuogo> | <NuovaRegione> | <NuovoLuogo>`\n' +
                    '`$atlante rename <VR> | <VL> | <NR> | <NL> | history` - Aggiorna anche la cronologia viaggi'
                );
                return;
            }

            const [oldMacro, oldMicro, newMacro, newMicro] = parts;
            const updateHistory = parts[4]?.toLowerCase() === 'history' || parts[4]?.toLowerCase() === 'storia';

            const existingTarget = getAtlasEntryFull(ctx.activeCampaign!.id, newMacro, newMicro);
            const existingSource = getAtlasEntryFull(ctx.activeCampaign!.id, oldMacro, oldMicro);

            if (!existingSource) {
                await ctx.message.reply(`❌ Luogo di origine **${oldMacro} - ${oldMicro}** non trovato.`);
                return;
            }

            if (existingTarget) {
                // SMART MERGE
                const loadingMsg = await ctx.message.reply(`⚙️ **Smart Merge:** Il luogo di destinazione esiste già. Unisco le memorie...`);

                const mergedDesc = await smartMergeBios(existingTarget.description || "", existingSource.description || "");

                const success = mergeAtlasEntry(ctx.activeCampaign!.id, oldMacro, oldMicro, newMacro, newMicro, mergedDesc);

                if (success) {
                    markAtlasDirty(ctx.activeCampaign!.id, newMacro, newMicro);

                    await loadingMsg.edit(
                        `✅ **Luoghi Uniti!**\n` +
                        `📖 **${oldMacro} - ${oldMicro}** è stato integrato in **${newMacro} - ${newMicro}**\n` +
                        `📜 Cronologia aggiornata. Sync RAG programmato.\n\n` +
                        `**Nuova Descrizione:**\n${mergedDesc.substring(0, 500)}${mergedDesc.length > 500 ? '...' : ''}`
                    );
                    return;
                } else {
                    await ctx.message.reply(`❌ Errore durante l'unione dei luoghi.`);
                    return;
                }
            } else {
                // STANDARD RENAME
                const success = renameAtlasEntry(ctx.activeCampaign!.id, oldMacro, oldMicro, newMacro, newMicro, updateHistory);

                if (success) {
                    let response = `✅ **Luogo rinominato!**\n` +
                        `📖 **${oldMacro} - ${oldMicro}** → **${newMacro} - ${newMicro}**`;

                    if (updateHistory) {
                        response += `\n📜 Anche la cronologia viaggi è stata aggiornata.`;
                    } else {
                        response += `\n💡 Tip: Aggiungi \`| history\` per aggiornare anche la cronologia.`;
                    }

                    markAtlasDirty(ctx.activeCampaign!.id, newMacro, newMicro);
                    response += `\n📌 Sync RAG programmato.`;

                    await ctx.message.reply(response);
                    return;
                } else {
                    await ctx.message.reply(`❌ Impossibile rinominare.`);
                    return;
                }
            }
        }

        // --- SUBCOMMAND: delete ---
        if (argsStr.toLowerCase().startsWith('delete ') || argsStr.toLowerCase().startsWith('elimina ')) {
            const deleteArgs = argsStr.substring(argsStr.indexOf(' ') + 1);
            const parts = deleteArgs.split('|').map(s => s.trim());

            if (parts.length !== 2) {
                await ctx.message.reply('Uso: `$atlante delete <Regione> | <Luogo>`');
                return;
            }

            const [macro, micro] = parts;
            const success = deleteAtlasEntry(ctx.activeCampaign!.id, macro, micro);

            if (success) {
                await ctx.message.reply(`🗑️ Voce **${macro} - ${micro}** eliminata dall'Atlante.`);
            } else {
                await ctx.message.reply(`❌ Luogo **${macro} - ${micro}** non trovato nell'Atlante.`);
            }
            return;
        }

        // --- PARSE PIPE-SEPARATED ARGS ---
        const parts = argsStr.split('|').map(s => s.trim());

        // --- VIEW SPECIFIC LOCATION: $atlante <Macro> | <Micro> ---
        if (parts.length === 2) {
            const [macro, micro] = parts;
            const entry = getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);

            if (entry) {
                const lastUpdate = new Date(entry.last_updated).toLocaleDateString('it-IT');
                await ctx.message.reply(
                    `📖 **Atlante: ${entry.macro_location} - ${entry.micro_location}**\n` +
                    `*Ultimo aggiornamento: ${lastUpdate}*\n\n` +
                    `${entry.description || '*Nessuna descrizione*'}`
                );
            } else {
                await ctx.message.reply(
                    `📖 **${macro} - ${micro}** non è ancora nell'Atlante.\n` +
                    `💡 Usa \`$atlante ${macro} | ${micro} | <descrizione>\` per aggiungerlo.`
                );
            }
            return;
        }

        // --- UPDATE LOCATION: $atlante <Macro> | <Micro> | <Description> [| force] ---
        if (parts.length >= 3) {
            const [macro, micro, newDesc] = parts;
            const forceFlag = parts[3]?.toLowerCase();
            const isForceMode = forceFlag === 'force' || forceFlag === '--force' || forceFlag === '!';

            const existing = getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);

            if (isForceMode) {
                // FORCE MODE: Direct overwrite
                const loadingMsg = await ctx.message.reply(`🔥 **FORCE MODE** per **${macro} - ${micro}**...\n⚠️ La vecchia descrizione verrà completamente sostituita.`);

                updateAtlasEntry(ctx.activeCampaign!.id, macro, micro, newDesc);
                markAtlasDirty(ctx.activeCampaign!.id, macro, micro);

                await loadingMsg.edit(
                    `🔥 **Sovrascrittura completata!**\n` +
                    `📖 **${macro} - ${micro}**\n` +
                    `📌 Sync RAG programmato.\n\n` +
                    `${newDesc.substring(0, 500)}${newDesc.length > 500 ? '...' : ''}`
                );
                return;

            } else {
                // STANDARD MODE: Smart Merge
                if (existing && existing.description) {
                    const loadingMsg = await ctx.message.reply(`⚙️ Merge intelligente per **${macro} - ${micro}**...`);

                    const mergedDesc = await smartMergeBios(existing.description, newDesc);

                    updateAtlasEntry(ctx.activeCampaign!.id, macro, micro, mergedDesc);
                    markAtlasDirty(ctx.activeCampaign!.id, macro, micro);

                    await loadingMsg.edit(
                        `✅ **Atlante Aggiornato** per **${macro} - ${micro}**\n` +
                        `📌 Nuovi dettagli integrati. Sync RAG programmato.\n` +
                        `💡 Tip: Usa \`| force\` alla fine per sovrascrittura diretta.\n\n` +
                        `📖 **Descrizione Unificata:**\n${mergedDesc.substring(0, 600)}${mergedDesc.length > 600 ? '...' : ''}`
                    );
                    return;

                } else {
                    // First entry for this location - direct insert
                    updateAtlasEntry(ctx.activeCampaign!.id, macro, micro, newDesc);
                    markAtlasDirty(ctx.activeCampaign!.id, macro, micro);
                    await ctx.message.reply(
                        `📖 **Nuovo Luogo Aggiunto all'Atlante!**\n` +
                        `🗺️ **${macro} - ${micro}**\n` +
                        `📌 Sync RAG programmato.\n\n` +
                        `${newDesc.substring(0, 500)}${newDesc.length > 500 ? '...' : ''}`
                    );
                    return;
                }
            }
        }

        // --- FALLBACK: Help ---
        await ctx.message.reply(
            `**📖 Uso del comando $atlante:**\n` +
            `\`$atlante\` - Mostra luogo corrente o lista\n` +
            `\`$atlante list\` - Lista tutti i luoghi\n` +
            `\`$atlante sync [all|<R>|<L>]\` - Sincronizza RAG\n` +
            `\`$atlante rename <VR> | <VL> | <NR> | <NL> [| history]\` - Rinomina\n` +
            `\`$atlante <R> | <L>\` - Vedi descrizione\n` +
            `\`$atlante <R> | <L> | <Testo> [| force]\` - Aggiorna\n` +
            `\`$atlante delete <R> | <L>\` - Elimina voce`
        );
    }
};
