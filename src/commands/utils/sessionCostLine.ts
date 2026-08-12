import { CommandContext } from '../types';
import { estimateSessionCost } from '../../services/sessionCostEstimator';
import { t } from '../../i18n';

/** Typical duration the estimate is given for, in minutes. */
const TYPICAL_SESSION_MINUTES = 240;

/**
 * The cost line that accompanies the start of a session.
 *
 * It is the moment when the question «how much is tonight going to cost me?»
 * has a useful answer: four hours later it only explains a bill that has
 * already arrived.
 *
 * It never fails the command: when the estimate cannot be made, we record
 * anyway. Blocking a session because we cannot quote it would mean charging a
 * fault of ours to the people about to play.
 */
export async function sessionCostLine(ctx: CommandContext): Promise<string> {
    try {
        const estimate = await estimateSessionCost(
            { guildId: ctx.guildId, campaignId: ctx.activeCampaign?.id },
            TYPICAL_SESSION_MINUTES,
        );

        // No price for at least one phase: say so, rather than showing a partial
        // total that looks complete.
        if (!estimate.pricingComplete || estimate.totalUsd === null) {
            return '\n' + t(ctx.locale, 'session.costUnknown');
        }

        // Everything on the table's own hardware: zero is the truth, and it should
        // be said that it still costs time and electricity.
        if (estimate.totalUsd === 0) {
            return '\n' + t(ctx.locale, 'session.costFree');
        }

        return '\n' + t(ctx.locale, 'session.costEstimate', {
            usd: estimate.totalUsd.toFixed(2),
            hours: String(TYPICAL_SESSION_MINUTES / 60),
        });
    } catch {
        return '';
    }
}
