/**
 * $timeline / $cronologia command - World timeline management
 */

import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { addWorldEvent, deleteWorldEvent, getWorldTimeline, db, getWorldEventByShortId } from '../../db';
import { safeSend } from '../../utils/discordHelper';
import { startInteractiveTimelineAdd, startInteractiveTimelineUpdate, startInteractiveTimelineDelete } from './interactiveUpdate';

export const timelineCommand: Command = {
    name: 'timeline',
    aliases: ['cronologia'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

        // Subcommand: $timeline add <Year> | <Type> | <Description>
        if (arg.toLowerCase() === 'add' || arg.toLowerCase().startsWith('add ')) {
            const content = arg.substring(4).trim();
            if (!content) {
                await startInteractiveTimelineAdd(ctx);
                return;
            }

            const parts = content.split('|').map(s => s.trim());
            if (parts.length < 3) {
                await ctx.message.reply("Uso: `$timeline add <Anno> | <Tipo> | <Descrizione>`\nEs: `$timeline add -500 | WAR | Guerra Antica`\nOppure scrivi solo `$timeline add` per l'inserimento interattivo.");
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

        // Subcommand: $timeline update [#ID]
        if (arg.toLowerCase() === 'update' || arg.toLowerCase().startsWith('update ')) {
            await startInteractiveTimelineUpdate(ctx);
            return;
        }

        // Subcommand: $timeline delete <#ID>
        if (arg.toLowerCase() === 'delete' || arg.toLowerCase().startsWith('delete ') || arg.toLowerCase() === 'remove' || arg.toLowerCase().startsWith('remove ')) {
            const remainder = arg.split(' ').slice(1).join(' ').trim();
            if (!remainder) {
                await startInteractiveTimelineDelete(ctx);
                return;
            }

            const shortId = remainder.replace('#', '').trim();
            const event = getWorldEventByShortId(ctx.activeCampaign!.id, shortId);

            if (!event) {
                await ctx.message.reply(`❌ Evento \`#${shortId}\` non trovato.`);
                return;
            }

            const success = deleteWorldEvent(event.id);
            if (success) {
                await ctx.message.reply(`🗑️ Evento \`#${shortId}\` eliminato dalla cronologia.`);
            } else {
                await ctx.message.reply(`❌ Errore durante l'eliminazione dell'evento \`#${shortId}\`.`);
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
            'MYTH': '🏺',
            'RELIGION': '⚜️',
            'BIRTH': '👶',
            'DEATH': '💀',
            'CONSTRUCTION': '🏛️',
            'GENERIC': '🔹'
        };

        events.forEach((e: any) => {
            const icon = icons[e.event_type] || '🔹';
            const yearLabel = e.year === 0 ? "**[Anno 0]**" : (e.year > 0 ? `**[${e.year} D.E.]**` : `**[${Math.abs(e.year)} P.E.]**`);
            msg += `\`#${e.short_id}\` ${yearLabel} ${icon} ${e.description}\n`;
        });

        msg += `\n💡 Usa \`$timeline delete <#ID>\` per eliminare un evento.`;

        // Handle message length (split if necessary)
        await safeSend(ctx.message.channel as TextChannel, msg);
    }
};
