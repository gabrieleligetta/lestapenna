/**
 * $bio / $biografia command - Character biography management
 */

import { Command, CommandContext } from '../types';
import { db, updateUserCharacter } from '../../db';
import { resetAndRegenerateCharacterBio, resetAllCharacterBios } from '../../bard';
import { t } from '../../i18n';
import type { BioGenerationCost } from '../../bard/bio';
import { assertCampaignWrite } from '../utils/campaignWrite';

export const bioCommand: Command = {
    name: 'bio',
    category: 'personaggi',
    descriptionKey: 'help.cmd.bio',
    aliases: ['biografia'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        if (!await assertCampaignWrite(ctx)) return;
        const campaignId = ctx.activeCampaign!.id;
        const firstArg = ctx.args[0]?.toLowerCase();

        if (firstArg === 'reset') {
            let actualCostUsd: number | null = 0;
            let actualCostEur: number | null = 0;
            const collectActualCost = (cost: BioGenerationCost): void => {
                actualCostUsd = actualCostUsd === null || cost.costUsd === null
                    ? null
                    : actualCostUsd + cost.costUsd;
                actualCostEur = actualCostEur === null || cost.costEur === null
                    ? null
                    : actualCostEur + cost.costEur;
            };
            const targetName = ctx.args.slice(1).join(' ');

            if (!targetName) {
                const counts = db.prepare(`
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN EXISTS (
                            SELECT 1 FROM character_history h
                            WHERE h.campaign_id = c.campaign_id
                              AND lower(h.character_name) = lower(c.character_name)
                              AND trim(COALESCE(h.description, '')) <> ''
                        ) THEN 1 ELSE 0 END) AS billable
                    FROM characters c
                    WHERE c.campaign_id = ? AND c.character_name IS NOT NULL
                `).get(campaignId) as { total: number; billable: number | null };
                // Reset ALL characters
                const loadingMsg = await ctx.message.reply(t(ctx.locale, 'char.bioResetAllStart'));
                try {
                    const result = await resetAllCharacterBios(campaignId, collectActualCost);
                    if (result.reset !== counts.total) throw new Error('one or more biographies failed to regenerate');
                    if (result.reset === 0) {
                        await loadingMsg.edit(t(ctx.locale, 'char.bioNoneToReset'));
                    } else {
                        await loadingMsg.edit(t(ctx.locale, 'char.bioRegenerated', {
                            count: result.reset,
                            list: result.names.map(n => `• ${n}`).join('\n')
                        }));
                    }
                } catch (e: any) {
                    await loadingMsg.edit(t(ctx.locale, 'char.bioResetError', { error: e.message }));
                }
                return;
            }

            // Reset specific character
            const targetPG = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;
            if (!targetPG) {
                await ctx.message.reply(t(ctx.locale, 'char.pgNotFound', { name: targetName }));
                return;
            }

            const loadingMsg = await ctx.message.reply(t(ctx.locale, 'char.bioResetOneStart', { name: targetPG.character_name }));
            try {
                const result = await resetAndRegenerateCharacterBio(campaignId, targetPG.user_id, collectActualCost);
                if (result !== null) {
                    const preview = result.length > 1500 ? result.substring(0, 1500) + '...' : result;
                    await loadingMsg.edit(t(ctx.locale, 'char.bioRegeneratedOne', { name: targetPG.character_name, preview }));
                } else {
                    await loadingMsg.edit(t(ctx.locale, 'char.errorPgNotFound'));
                }
            } catch (e: any) {
                await loadingMsg.edit(t(ctx.locale, 'char.genericError', { error: e.message }));
            }
            return;
        }

        if (firstArg === 'clear' || firstArg === 'svuota' || firstArg === 'empty') {
            const targetName = ctx.args.slice(1).join(' ');

            if (!targetName) {
                // Clear ALL characters
                const characters = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ?').all(campaignId) as any[];
                if (characters.length === 0) {
                    await ctx.message.reply(t(ctx.locale, 'char.bioNoneToClear'));
                    return;
                }

                for (const char of characters) {
                    updateUserCharacter(char.user_id, campaignId, 'description', '');
                }

                await ctx.message.reply(t(ctx.locale, 'char.bioClearedAll', { count: characters.length }));
                return;
            }

            // Clear specific character
            const targetPG = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;
            if (!targetPG) {
                await ctx.message.reply(t(ctx.locale, 'char.pgNotFound', { name: targetName }));
                return;
            }

            updateUserCharacter(targetPG.user_id, campaignId, 'description', '');
            await ctx.message.reply(t(ctx.locale, 'char.bioClearedOne', { name: targetPG.character_name }));
            return;
        }

        // Help
        await ctx.message.reply(t(ctx.locale, 'char.bioHelp'));
    }
};
