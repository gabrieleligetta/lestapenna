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
    getSessionTravelLog,
    addAtlasEvent // 🆕
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

            const list = entries.map((e: any, i: number) => {
                const descPreview = e.description ? e.description.substring(0, 50) + (e.description.length > 50 ? '...' : '') : '*nessuna descrizione*';
                return `\`${i + 1}\` 🗺️ **${e.macro_location}** - *${e.micro_location}*\n   └ ${descPreview}`;
            }).join('\n');
            await ctx.message.reply(`**📖 Atlante Completo**\n${list}\n💡 Usa \`$atlante <ID>\` o \`$atlante update <ID> | <Nota>\``);
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

            // Check ID in first part
            const idMatch = parts[0].match(/^#?(\d+)$/);
            if (idMatch) {
                // ID Mode
                if (parts.length < 2) {
                    await ctx.message.reply('Uso: `$atlante update <ID> | <Nota>`');
                    return;
                }
                const idx = parseInt(idMatch[1]) - 1;
                const entries = listAtlasEntries(ctx.activeCampaign!.id);
                if (!entries[idx]) {
                    await ctx.message.reply(`❌ ID #${idMatch[1]} non valido.`);
                    return;
                }
                macro = entries[idx].macro_location;
                micro = entries[idx].micro_location;
                note = parts.slice(1).join('|').trim();
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

            addAtlasEvent(ctx.activeCampaign!.id, macro, micro, null, note, "MANUAL_UPDATE");
            await ctx.message.reply(`📝 Nota aggiunta a **${macro} - ${micro}**. Aggiornamento atmosfera...`);

            await syncAtlasEntryIfNeeded(ctx.activeCampaign!.id, macro, micro, true);
            return;
        }

        // --- SUBCOMMAND: delete ---
        if (argsStr.toLowerCase().startsWith('delete ') || argsStr.toLowerCase().startsWith('elimina ')) {
            const deleteArgs = argsStr.substring(argsStr.indexOf(' ') + 1);
            let macro = '';
            let micro = '';

            const idMatch = deleteArgs.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const entries = listAtlasEntries(ctx.activeCampaign!.id);
                if (!entries[idx]) {
                    await ctx.message.reply(`❌ ID #${idMatch[1]} non valido.`);
                    return;
                }
                macro = entries[idx].macro_location;
                micro = entries[idx].micro_location;
            } else {
                const parts = deleteArgs.split('|').map(s => s.trim());
                if (parts.length !== 2) {
                    await ctx.message.reply('Uso: `$atlante delete <Regione> | <Luogo>` o `$atlante delete <ID>`');
                    return;
                }
                macro = parts[0];
                micro = parts[1];
            }

            const success = deleteAtlasEntry(ctx.activeCampaign!.id, macro, micro);

            if (success) {
                await ctx.message.reply(`🗑️ Voce **${macro} - ${micro}** eliminata dall'Atlante.`);
            } else {
                await ctx.message.reply(`❌ Luogo **${macro} - ${micro}** non trovato.`);
            }
            return;
        }

        // --- PARSE PIPE-SEPARATED ARGS or ID ---
        const parts = argsStr.split('|').map(s => s.trim());

        // ID View: $atlante 1
        const idMatch = parts[0].match(/^#?(\d+)$/);
        if (parts.length === 1 && idMatch) {
            const idx = parseInt(idMatch[1]) - 1;
            const entries = listAtlasEntries(ctx.activeCampaign!.id);
            if (entries[idx]) {
                const entry = entries[idx];
                const lastUpdate = new Date(entry.last_updated).toLocaleDateString('it-IT');
                await ctx.message.reply(
                    `📖 **Atlante: ${entry.macro_location} - ${entry.micro_location}**\n` +
                    `*Ultimo aggiornamento: ${lastUpdate}*\n\n` +
                    `${entry.description || '*Nessuna descrizione*'}`
                );
            } else {
                await ctx.message.reply(`❌ ID #${idMatch[1]} non valido.`);
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
                    `${entry.description || '*Nessuna descrizione*'}`
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
            `\`$atlante list\` - Lista luoghi con ID\n` +
            `\`$atlante <ID>\` o \`$atlante <R> | <L>\` - Vedi dettaglio\n` +
            `\`$atlante update <ID> | <Nota>\` - Aggiorna luogo\n` +
            `\`$atlante update <R> | <L> | <Nota>\` - Aggiorna luogo`
        );
    }
};
