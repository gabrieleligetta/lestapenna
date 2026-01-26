/**
 * $atlante / $atlas command - Location atlas management
 */

import { Command, CommandContext } from '../types';
import {
    getCampaignLocation,
    getAtlasEntry,
    getAtlasEntryFull,
    listAtlasEntries,
    countAtlasEntries,
    updateAtlasEntry,
    deleteAtlasEntry,
    renameAtlasEntry,
    mergeAtlasEntry,
    markAtlasDirty,
    getDirtyAtlasEntries,
    getSessionTravelLog,
    addAtlasEvent, // 🆕
    deleteAtlasHistory,
    deleteAtlasRagSummary,
    getAtlasEntryByShortId
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
                // No current position, show list (Page 1)
                const pageSize = 10;
                const entries = listAtlasEntries(ctx.activeCampaign!.id, pageSize, 0);
                const total = countAtlasEntries(ctx.activeCampaign!.id);
                const totalPages = Math.ceil(total / pageSize);

                if (entries.length === 0) {
                    await ctx.message.reply("📖 L'Atlante è vuoto. Usa `$atlante <Regione> | <Luogo> | <Descrizione>` per aggiungere voci.");
                    return;
                }

                const list = entries.map((e: any) =>
                    `\`#${e.short_id}\` 🗺️ **${e.macro_location}** - *${e.micro_location}*`
                ).join('\n');

                let footer = `\n\n💡 Usa \`$atlante <ID>\` o \`$atlante <Regione> | <Luogo>\` per dettagli.`;
                if (totalPages > 1) footer = `\n\n📄 **Pagina 1/${totalPages}** (Usa \`$atlante list 2\` per la prossima)` + footer;

                await ctx.message.reply(`**📖 Atlante (Luoghi Recenti)**\n${list}${footer}`);
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

        // --- SUBCOMMAND: list [page] ---
        if (argsStr.toLowerCase().startsWith('list') || argsStr.toLowerCase().startsWith('lista')) {
            let page = 1;
            const parts = argsStr.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                page = parseInt(parts[1]);
            }

            const pageSize = 15;
            const offset = (page - 1) * pageSize;
            const total = countAtlasEntries(ctx.activeCampaign!.id);
            const totalPages = Math.ceil(total / pageSize);

            if (page < 1 || (totalPages > 0 && page > totalPages)) {
                await ctx.message.reply(`❌ Pagina ${page} non valida. Totale pagine: ${totalPages || 1}.`);
                return;
            }

            const entries = listAtlasEntries(ctx.activeCampaign!.id, pageSize, offset);
            if (entries.length === 0) {
                await ctx.message.reply("📖 L'Atlante è vuoto.");
                return;
            }

            const list = entries.map((e: any) => {
                const descPreview = (e.description && e.description.trim().length > 0)
                    ? e.description.substring(0, 50) + (e.description.length > 50 ? '...' : '')
                    : '*nessuna descrizione*';
                return `\`#${e.short_id}\` 🗺️ **${e.macro_location}** - *${e.micro_location}*\n   └ ${descPreview}`;
            }).join('\n');

            let footer = `\n💡 Usa \`$atlante <ID>\` o \`$atlante update <ID> | <Nota>\``;
            if (totalPages > 1) footer = `\n\n📄 **Pagina ${page}/${totalPages}** (Usa \`$atlante list ${page + 1}\` per la prossima)` + footer;

            await ctx.message.reply(`**📖 Atlante Completo**\n${list}${footer}`);
            return;
        }

        // --- SUBCOMMAND: update ---
        if (argsStr.toLowerCase().startsWith('update')) {
            const content = argsStr.substring(7).trim();
            // ID or Macro|Micro
            // $atlante update 1 | Note
            // $atlante update Region | Place | Note

            const parts = content.split('|').map(s => s.trim());

            let macro = '';
            let micro = '';
            let note = '';

            // ID Resolution
            const sidMatch = parts[0].match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const entry = getAtlasEntryByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (entry) {
                    macro = entry.macro_location;
                    micro = entry.micro_location;
                    note = parts.slice(1).join('|').trim();
                } else {
                    await ctx.message.reply(`❌ ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            } else {
                // Name Mode: Region | Place | Note
                if (parts.length < 3) {
                    await ctx.message.reply('Uso: `$atlante update <Regione> | <Luogo> | <Nota>`');
                    return;
                }
                macro = parts[0];
                micro = parts[1];
                note = parts.slice(2).join('|').trim();
            }

            // Check existence?
            // Since we use ID or explicit names from list, it should exist. 
            // Logic in existing code registers event even if not exists?
            // "addAtlasEvent" takes macro/micro.

            addAtlasEvent(ctx.activeCampaign!.id, macro, micro, null, note, "MANUAL_UPDATE", true);
            await ctx.message.reply(`📝 Nota aggiunta a **${macro} - ${micro}**. Aggiornamento atmosfera...`);

            await syncAtlasEntryIfNeeded(ctx.activeCampaign!.id, macro, micro, true);
            return;
        }

        // --- SUBCOMMAND: delete ---
        if (argsStr.toLowerCase().startsWith('delete ') || argsStr.toLowerCase().startsWith('elimina ')) {
            const deleteArgs = argsStr.substring(argsStr.indexOf(' ') + 1);
            let macro = '';
            let micro = '';

            const sidMatch = deleteArgs.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const entry = getAtlasEntryByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (entry) {
                    macro = entry.macro_location;
                    micro = entry.micro_location;
                } else {
                    await ctx.message.reply(`❌ ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            } else {
                const parts = deleteArgs.split('|').map(s => s.trim());
                if (parts.length !== 2) {
                    await ctx.message.reply('Uso: `$atlante delete <Regione> | <Luogo>` o `$atlante delete <ID>`');
                    return;
                }
                macro = parts[0];
                micro = parts[1];
            }

            // Full Wipe: RAG + History + Entry
            await ctx.message.reply(`🗑️ Eliminazione completa per **${macro} - ${micro}** in corso...`);

            // 1. Delete RAG Summary
            deleteAtlasRagSummary(ctx.activeCampaign!.id, macro, micro);

            // 2. Delete History
            deleteAtlasHistory(ctx.activeCampaign!.id, macro, micro);

            // 3. Delete Entry
            const success = deleteAtlasEntry(ctx.activeCampaign!.id, macro, micro);

            if (success) {
                await ctx.message.reply(`✅ Voce **${macro} - ${micro}** eliminata definitivamente (RAG, Storia, Atlante).`);
            } else {
                await ctx.message.reply(`❌ Luogo **${macro} - ${micro}** non trovato.`);
            }
            return;
        }

        // --- PARSE PIPE-SEPARATED ARGS or ID ---
        const parts = argsStr.split('|').map(s => s.trim());
        const sidMatchDetail = parts[0].match(/^#([a-z0-9]{5})$/i);

        // ID View: $atlante 1 or $atlante #abcde
        if (parts.length === 1 && sidMatchDetail) {
            let entry: any = null;

            if (sidMatchDetail) {
                entry = getAtlasEntryByShortId(ctx.activeCampaign!.id, sidMatchDetail[1]);
            }

            if (entry) {
                const lastUpdate = new Date(entry.last_updated).toLocaleDateString('it-IT');
                await ctx.message.reply(
                    `📖 **Atlante: ${entry.macro_location} - ${entry.micro_location}**\n` +
                    `*Ultimo aggiornamento: ${lastUpdate}*\n\n` +
                    `${(entry.description && entry.description.trim().length > 0) ? entry.description : '*Nessuna descrizione*'}`
                );
            } else {
                if (sidMatchDetail) {
                    await ctx.message.reply(`❌ ID \`#${sidMatchDetail[1]}\` non trovato.`);
                }
            }
            return;
        }

        // --- VIEW SPECIFIC LOCATION: $atlante <Macro> | <Micro> ---
        if (parts.length === 2) {
            const [macro, micro] = parts;
            const entry = getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);

            if (entry) {
                const lastUpdate = new Date(entry.last_updated).toLocaleDateString('it-IT');
                await ctx.message.reply(
                    `📖 **Atlante: ${entry.macro_location} - ${entry.micro_location}**\n` +
                    `*Ultimo aggiornamento: ${lastUpdate}*\n\n` +
                    `${(entry.description && entry.description.trim().length > 0) ? entry.description : '*Nessuna descrizione*'}`
                );
            } else {
                await ctx.message.reply(
                    `📖 **${macro} - ${micro}** non è ancora nell'Atlante.\n` +
                    `💡 Usa \`$atlante update ${macro} | ${micro} | <descrizione>\` per aggiungerlo.`
                );
            }
            return;
        }

        // --- LEGACY/FALLBACK ---
        if (parts.length >= 3) {
            await ctx.message.reply("⚠️ Sintassi aggiornata. Usa: `$atlante update <Regione> | <Luogo> | <Nota>`");
            return;
        }

        // --- FALLBACK: Help ---
        await ctx.message.reply(
            `**📖 Uso del comando $atlante:**\n` +
            `\`$atlante\` - Mostra luogo corrente o lista\n` +
            `\`$atlante list [pag]\` - Lista luoghi con ID\n` +
            `\`$atlante <ID>\` o \`$atlante <R> | <L>\` - Vedi dettaglio\n` +
            `\`$atlante update <ID> | <Nota>\` - Aggiorna luogo\n` +
            `\`$atlante update <R> | <L> | <Nota>\` - Aggiorna luogo`
        );
    }
};
