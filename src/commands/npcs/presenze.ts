/**
 * $presenze command - Show NPCs encountered in session
 */

import { Command, CommandContext } from '../types';
import { getSessionEncounteredNPCs } from '../../db';
import { getActiveSession } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { assertSessionInActiveCampaign } from '../utils/sessionScope';
import { t, eventTypeLabel } from '../../i18n';

export const presenzeCommand: Command = {
    name: 'presenze',
    category: 'entita',
    descriptionKey: 'help.cmd.presenze',
    aliases: [],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ').trim();

        // Determine target session
        let targetSessionId: string | undefined;
        let sessionLabel: string;

        if (argsStr && isSessionId(argsStr)) {
            targetSessionId = extractSessionId(argsStr);
            // isSessionId checks the shape, not the ownership: without this you
            // could read the NPCs met in another table's session.
            if (!await assertSessionInActiveCampaign(ctx, targetSessionId)) return;
            sessionLabel = t(ctx.locale, 'npc.presSessionLabel', { id: targetSessionId });
        } else {
            targetSessionId = await getActiveSession(ctx.guildId);
            sessionLabel = t(ctx.locale, 'npc.presCurrentSession');
            if (!targetSessionId) {
                await ctx.message.reply(t(ctx.locale, 'npc.presNoActive'));
                return;
            }
        }

        // Get NPCs with details from dossier
        const encounteredNPCs = getSessionEncounteredNPCs(targetSessionId);

        if (encounteredNPCs.length === 0) {
            await ctx.message.reply(t(ctx.locale, 'npc.presNone', { session: sessionLabel }));
            return;
        }

        let msg = t(ctx.locale, 'npc.presHeader', { session: sessionLabel }) + '\n';
        encounteredNPCs.forEach((npc: any) => {
            const statusIcon = npc.status === 'DEAD' ? '💀' : npc.status === 'MISSING' ? '❓' : '👤';
            const sid = npc.short_id ? `\`#${npc.short_id}\` ` : '';
            msg += `${statusIcon} ${sid}**${npc.name}** (${npc.role || '?'}) [${eventTypeLabel(ctx.locale, npc.status)}]\n`;
        });

        await ctx.message.reply(msg);
    }
};
