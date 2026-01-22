/**
 * $viaggi / $travels command - Travel history management
 */

import { Command, CommandContext } from '../types';
import {
    getLocationHistory,
    getLocationHistoryWithIds,
    getSessionTravelLog,
    fixLocationHistoryEntry,
    deleteLocationHistoryEntry,
    fixCurrentLocation
} from '../../db';
import { isSessionId, extractSessionId } from '../../utils/sessionId';

export const travelsCommand: Command = {
    name: 'travels',
    aliases: ['viaggi'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        // --- SESSION SPECIFIC: $viaggi <session_id> ---
        if (argsStr && isSessionId(argsStr)) {
            const sessionId = extractSessionId(argsStr);
            const travelLog = getSessionTravelLog(sessionId);

            if (travelLog.length === 0) {
                await ctx.message.reply(`📜 Nessun viaggio registrato per la sessione \`${sessionId}\`.`);
                return;
            }

            let msg = `**📜 Viaggi della Sessione \`${sessionId}\`:**\n`;
            travelLog.forEach((h: any) => {
                const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                msg += `\`${time}\` 🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}\n`;
            });

            await ctx.message.reply(msg);
            return;
        }

        // --- SUBCOMMAND: list (with ID for edit) ---
        if (argsStr.toLowerCase() === 'list' || argsStr.toLowerCase() === 'lista') {
            const history = getLocationHistoryWithIds(ctx.activeCampaign!.id);
            if (history.length === 0) {
                await ctx.message.reply("Il diario di viaggio è vuoto.");
                return;
            }

            let msg = "**📜 Diario di Viaggio (con ID per correzione):**\n";
            history.forEach((h: any) => {
                const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                msg += `\`#${h.id}\` \`${h.session_date} ${time}\` 🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}\n`;
            });
            msg += `\n💡 Usa \`$viaggi fix #ID | NuovaRegione | NuovoLuogo\` per correggere.\n💡 Usa \`$viaggi delete #ID\` per eliminare.`;

            await ctx.message.reply(msg);
            return;
        }

        // --- SUBCOMMAND: fix (correct entry) ---
        if (argsStr.toLowerCase().startsWith('fix ') && !argsStr.toLowerCase().startsWith('fixcurrent')) {
            const fixArgs = argsStr.substring(4).trim();
            const parts = fixArgs.split('|').map(s => s.trim());

            if (parts.length !== 3) {
                await ctx.message.reply(
                    '**Uso: `$viaggi fix`**\n' +
                    '`$viaggi fix #ID | <NuovaRegione> | <NuovoLuogo>`\n' +
                    '💡 Usa `$viaggi list` per vedere gli ID delle voci.'
                );
                return;
            }

            const idStr = parts[0].replace('#', '').trim();
            const entryId = parseInt(idStr);
            const [, newMacro, newMicro] = parts;

            if (isNaN(entryId)) {
                await ctx.message.reply('❌ ID non valido. Usa `$viaggi list` per vedere gli ID.');
                return;
            }

            const success = fixLocationHistoryEntry(entryId, newMacro, newMicro);
            if (success) {
                await ctx.message.reply(`✅ **Voce #${entryId} corretta!**\n📍 ${newMacro} - ${newMicro}`);
            } else {
                await ctx.message.reply(`❌ Voce #${entryId} non trovata.`);
            }
            return;
        }

        // --- SUBCOMMAND: delete (delete entry) ---
        if (argsStr.toLowerCase().startsWith('delete ') || argsStr.toLowerCase().startsWith('del ') || argsStr.toLowerCase().startsWith('remove ')) {
            const idStr = argsStr.split(' ')[1].replace('#', '').trim();
            const entryId = parseInt(idStr);

            if (isNaN(entryId)) {
                await ctx.message.reply('❌ ID non valido. Usa `$viaggi list` per vedere gli ID.');
                return;
            }

            const success = deleteLocationHistoryEntry(entryId);
            if (success) {
                await ctx.message.reply(`🗑️ Voce #${entryId} eliminata dalla cronologia viaggi.`);
            } else {
                await ctx.message.reply(`❌ Voce #${entryId} non trovata.`);
            }
            return;
        }

        // --- SUBCOMMAND: fixcurrent (fix current position) ---
        if (argsStr.toLowerCase().startsWith('fixcurrent ') || argsStr.toLowerCase().startsWith('correggi ')) {
            const fixArgs = argsStr.substring(argsStr.indexOf(' ') + 1).trim();
            const parts = fixArgs.split('|').map(s => s.trim());

            if (parts.length !== 2) {
                await ctx.message.reply(
                    '**Uso: `$viaggi fixcurrent`**\n' +
                    '`$viaggi fixcurrent <NuovaRegione> | <NuovoLuogo>`\n' +
                    'Corregge la posizione corrente della campagna.'
                );
                return;
            }

            const [newMacro, newMicro] = parts;
            fixCurrentLocation(ctx.activeCampaign!.id, newMacro, newMicro);
            await ctx.message.reply(`✅ **Posizione corrente aggiornata!**\n📍 ${newMacro} - ${newMicro}`);
            return;
        }

        // --- DEFAULT: Show simple history ---
        const history = getLocationHistory(ctx.guildId);
        if (history.length === 0) {
            await ctx.message.reply("Il diario di viaggio è vuoto.");
            return;
        }

        let msg = "**📜 Diario di Viaggio (Ultimi spostamenti):**\n";
        history.forEach((h: any) => {
            const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            msg += `\`${h.session_date} ${time}\` 🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}\n`;
        });
        msg += `\n💡 Usa \`$viaggi list\` per vedere gli ID e correggere voci.`;

        await ctx.message.reply(msg);
    }
};
