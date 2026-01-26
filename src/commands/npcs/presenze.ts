/**
 * $presenze command - Show NPCs encountered in session
 */

import { Command, CommandContext } from '../types';
import { getSessionEncounteredNPCs } from '../../db';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';

export const presenzeCommand: Command = {
    name: 'presenze',
    aliases: [],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ').trim();

        // Determine target session
        let targetSessionId: string | undefined;
        let sessionLabel: string;

        if (argsStr && isSessionId(argsStr)) {
            targetSessionId = extractSessionId(argsStr);
            sessionLabel = `sessione \`${targetSessionId}\``;
        } else {
            targetSessionId = guildSessions.get(ctx.guildId);
            sessionLabel = 'questa sessione';
            if (!targetSessionId) {
                await ctx.message.reply("⚠️ Nessuna sessione attiva. Specifica un ID: `$presenze session_xxxxx`");
                return;
            }
        }

        // Get NPCs with details from dossier
        const encounteredNPCs = getSessionEncounteredNPCs(targetSessionId);

        if (encounteredNPCs.length === 0) {
            await ctx.message.reply(`👥 **NPC Incontrati in ${sessionLabel}:** Nessuno rilevato.`);
            return;
        }

        let msg = `👥 **NPC Incontrati in ${sessionLabel}:**\n`;
        encounteredNPCs.forEach((npc: any) => {
            const statusIcon = npc.status === 'DEAD' ? '💀' : npc.status === 'MISSING' ? '❓' : '👤';
            const sid = npc.short_id ? `\`#${npc.short_id}\` ` : '';
            msg += `${statusIcon} ${sid}**${npc.name}** (${npc.role || '?'}) [${npc.status}]\n`;
        });

        await ctx.message.reply(msg);
    }
};
