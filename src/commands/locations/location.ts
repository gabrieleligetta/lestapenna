/**
 * $luogo / $location command - View or update location
 */

import { Command, CommandContext } from '../types';
import { getCampaignLocation, updateLocation } from '../../db';
import { getActiveSession } from '../../state/sessionState';

export const locationCommand: Command = {
    name: 'location',
    aliases: ['luogo'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        if (!argsStr) {
            // Getter
            const loc = getCampaignLocation(ctx.guildId);
            if (!loc || (!loc.macro && !loc.micro)) {
                await ctx.message.reply("🗺️ Non so dove siete! Usa `$luogo <Città> | <Luogo>` per impostarlo.");
                return;
            }
            await ctx.message.reply(`📍 **Posizione Attuale**\n🌍 Regione: **${loc.macro || "Sconosciuto"}**\n🏠 Luogo: **${loc.micro || "Generico"}**`);
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

        // Durante una sessione attiva, non scriviamo in location_history:
        // la cronologia definitiva viene costruita dall'AI via travel_sequence a fine sessione.
        // Fuori sessione (sessionId = null) registriamo normalmente.
        const skipHistory = !!sessionId;
        updateLocation(ctx.activeCampaign!.id, newMacro, newMicro, sessionId, undefined, undefined, true, skipHistory);

        await ctx.message.reply(`📍 **Aggiornamento Manuale**\nImpostato su: ${newMacro || '-'} | ${newMicro || '-'}`);
    }
};
