/**
 * $sono / $iam command - Set character name
 */

import { Command, CommandContext } from '../types';
import { updateUserCharacter, db, factionRepository } from '../../db';

export const iamCommand: Command = {
    name: 'iam',
    aliases: ['sono'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const val = ctx.args.join(' ');
        if (!val) {
            await ctx.message.reply("Uso: `$sono Nome`");
            return;
        }

        const campaignId = ctx.activeCampaign!.id;
        const userId = ctx.message.author.id;

        if (val.toUpperCase() === 'DM' || val.toUpperCase() === 'DUNGEON MASTER') {
            updateUserCharacter(userId, campaignId, 'character_name', 'DM');
            updateUserCharacter(userId, campaignId, 'class', 'Dungeon Master');
            updateUserCharacter(userId, campaignId, 'race', 'Narratore');
            await ctx.message.reply(`🎲 **Saluti, Dungeon Master.** Il Bardo è ai tuoi ordini per la campagna **${ctx.activeCampaign!.name}**.`);
        } else {
            updateUserCharacter(userId, campaignId, 'character_name', val);

            // Auto-affiliate to party faction if exists
            const party = factionRepository.getPartyFaction(campaignId);
            if (party) {
                const charRow = db.prepare(`
                    SELECT rowid FROM characters WHERE user_id = ? AND campaign_id = ?
                `).get(userId, campaignId) as { rowid: number } | undefined;

                if (charRow) {
                    factionRepository.addAffiliation(party.id, 'pc', charRow.rowid, { role: 'MEMBER' });
                }
            }

            await ctx.message.reply(`⚔️ Nome aggiornato: **${val}** (Campagna: ${ctx.activeCampaign!.name})`);
        }
    }
};
