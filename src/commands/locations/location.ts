/**
 * $luogo / $location command - View or update location
 */

import { Command, CommandContext } from '../types';
import { getCampaignLocation, updateLocation } from '../../db';
import { getActiveSession } from '../../state/sessionState';
import { t } from '../../i18n';

export const locationCommand: Command = {
    name: 'location',
    category: 'mondo',
    descriptionKey: 'help.cmd.location',
    aliases: ['luogo'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        if (!argsStr) {
            // Getter
            const loc = getCampaignLocation(ctx.guildId);
            if (!loc || (!loc.macro && !loc.micro)) {
                await ctx.message.reply(t(ctx.locale, 'loc.unknown'));
                return;
            }
            await ctx.message.reply(t(ctx.locale, 'loc.current', { macro: loc.macro || t(ctx.locale, 'loc.unknownMacro'), micro: loc.micro || t(ctx.locale, 'loc.genericMicro') }));
            return;
        }

        // Setter
        const current = getCampaignLocation(ctx.guildId);
        const sessionId = await getActiveSession(ctx.guildId); // Get active session if any

        let newMacro = current?.macro || null;
        let newMicro = null;

        if (argsStr.includes('|')) {
            // Explicit syntax: Macro | Micro
            const parts = argsStr.split('|').map(s => s.trim());
            newMacro = parts[0];
            newMicro = parts[1];
        } else {
            // Simple syntax: assume it's a micro-location change (room/building)
            newMicro = argsStr.trim();
        }

        // During an active session we do not write to location_history:
        // the definitive chronology is built by the AI via travel_sequence at the end of the session.
        // Outside a session (sessionId = null) we record normally.
        const skipHistory = !!sessionId;
        updateLocation(ctx.activeCampaign!.id, newMacro, newMicro, sessionId, undefined, undefined, true, skipHistory);

        await ctx.message.reply(t(ctx.locale, 'loc.manualSet', { macro: newMacro || '-', micro: newMicro || '-' }));
    }
};
