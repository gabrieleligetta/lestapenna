/**
 * $luogo / $location command - View or update location
 */

import { Command, CommandContext } from '../types';
import { getCampaignLocation, updateLocation } from '../../db';
import { guildSessions } from '../../state/sessionState';

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
        const sessionId = guildSessions.get(ctx.guildId); // Get active session if any

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

        updateLocation(ctx.activeCampaign!.id, newMacro, newMicro, sessionId, undefined, undefined, true);

        await ctx.message.reply(`📍 **Aggiornamento Manuale**\nImpostato su: ${newMacro || '-'} | ${newMicro || '-'}`);
    }
};
