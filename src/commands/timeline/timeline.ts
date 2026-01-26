/**
 * $timeline / $cronologia command - World timeline management
 */

import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { addWorldEvent, deleteWorldEvent, getWorldTimeline } from '../../db';
import { safeSend } from '../../utils/discordHelper';

export const timelineCommand: Command = {
    name: 'timeline',
    aliases: ['cronologia'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

        // Subcommand: $timeline add <Year> | <Type> | <Description>
        if (arg.toLowerCase().startsWith('add ')) {
            const parts = arg.substring(4).split('|').map(s => s.trim());
            if (parts.length < 3) {
                await ctx.message.reply("Uso: `$timeline add <Anno> | <Tipo> | <Descrizione>`\nEs: `$timeline add -500 | WAR | Guerra Antica`");
                return;
            }

            const year = parseInt(parts[0]);
            const type = parts[1].toUpperCase();
            const desc = parts[2];

            if (isNaN(year)) {
                await ctx.message.reply("L'anno deve essere un numero.");
                return;
            }

            addWorldEvent(ctx.activeCampaign!.id, null, desc, type, year, true);
            await ctx.message.reply(`📜 Evento storico aggiunto nell'anno **${year}**.`);
            return;
        }

        // Subcommand: $timeline delete <ID>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('remove ')) {
            const idStr = arg.split(' ')[1];
            const eventId = parseInt(idStr);

            if (isNaN(eventId)) {
                await ctx.message.reply("Uso: `$timeline delete <ID>` (L'ID deve essere un numero)");
                return;
            }

            const success = deleteWorldEvent(eventId);
            if (success) {
                await ctx.message.reply(`🗑️ Evento #${eventId} eliminato dalla cronologia.`);
            } else {
                await ctx.message.reply(`❌ Evento #${eventId} non trovato.`);
            }
            return;
        }

        // View timeline
        const events = getWorldTimeline(ctx.activeCampaign!.id);

        if (events.length === 0) {
            await ctx.message.reply("📜 La cronologia mondiale è ancora bianca. Nessun grande evento registrato.");
            return;
        }

        let msg = `🌍 **Cronologia del Mondo: ${ctx.activeCampaign!.name}**\n\n`;

        const icons: Record<string, string> = {
            'WAR': '⚔️',
            'POLITICS': '👑',
            'DISCOVERY': '💎',
            'CALAMITY': '🌋',
            'SUPERNATURAL': '🔮',
            'GENERIC': '🔹'
        };

        events.forEach((e: any) => {
            const icon = icons[e.event_type] || '🔹';
            const yearLabel = e.year === 0 ? "**[Anno 0]**" : (e.year > 0 ? `**[${e.year} D.E.]**` : `**[${Math.abs(e.year)} P.E.]**`);
            msg += `\`#${e.id}\` ${yearLabel} ${icon} ${e.description}\n`;
        });

        msg += `\n💡 Usa \`$timeline delete <ID>\` per eliminare un evento.`;

        // Handle message length (split if necessary)
        await safeSend(ctx.message.channel as TextChannel, msg);
    }
};
