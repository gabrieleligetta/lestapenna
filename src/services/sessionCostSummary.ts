import { logger } from '../utils/logger';

const log = logger('SessionCost');

export interface SessionCostMetrics {
    totalCostUSD?: number | null;
    totalCostEUR?: number | null;
}

/**
 * Records the final cost of a session.
 *
 * It replaces the old `completeSessionBilling`/`failAndRefundSessionBilling`:
 * there is nothing left to charge or refund, but the total is still a product
 * fact — it is what the session cost the user **on their own provider
 * account**. The per-phase details are already in `ai_usage_log`, and
 * `monitor.endSession()` has already aggregated the month into `usage_tracking`: here we
 * only track the outcome, so the total appears in the logs next to the session
 * id.
 */
export function recordSessionCostSummary(
    sessionId: string,
    outcome: 'COMPLETED' | 'FAILED',
    metrics: SessionCostMetrics | null | undefined,
): void {
    const usd = metrics?.totalCostUSD ?? null;
    const eur = metrics?.totalCostEUR ?? null;
    const cost = usd === null
        ? 'costo non disponibile'
        : `$${usd.toFixed(4)}${eur === null ? '' : ` (≈ €${eur.toFixed(4)})`}`;

    if (outcome === 'COMPLETED') {
        log.info(`Sessione ${sessionId} completata — ${cost}`);
    } else {
        log.warn(`Sessione ${sessionId} interrotta — ${cost} già speso sul provider dell'utente`);
    }
}
