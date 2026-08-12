import type { SessionMetrics } from '../monitor';
import type { AggregatedCostByPhase } from './types';

const PHASE_ORDER = [
    'transcription',
    'metadata',
    'embeddings',
    'map',
    'analyst',
    'narrative_filter',
    'summary',
    'chat',
];

const PHASE_DISPLAY_NAMES: Record<string, string> = {
    transcription: 'Transcription (Whisper/Correction)',
    metadata: 'Metadata Validation',
    embeddings: 'RAG Embeddings',
    map: 'Map Phase (Condensation)',
    analyst: 'Data Analyst (Extraction)',
    narrative_filter: 'Narrative Filter',
    summary: 'Storyteller (Summary)',
    chat: 'Chat / RAG Query',
};

function aggregateCosts(metrics: SessionMetrics): AggregatedCostByPhase[] {
    const aggregated: Record<string, AggregatedCostByPhase> = {};
    for (const cost of metrics.costMetrics?.breakdown ?? []) {
        const existing = aggregated[cost.phase];
        if (!existing) {
            aggregated[cost.phase] = {
                phase: cost.phase,
                models: [cost.model],
                providers: new Set([cost.provider]),
                inputTokens: cost.inputTokens,
                cachedInputTokens: cost.cachedInputTokens || 0,
                outputTokens: cost.outputTokens,
                costUSD: cost.costUSD,
                costEUR: cost.costEUR ?? null,
            };
            continue;
        }
        if (!existing.models.includes(cost.model)) existing.models.push(cost.model);
        existing.providers.add(cost.provider);
        existing.inputTokens += cost.inputTokens;
        existing.cachedInputTokens += cost.cachedInputTokens || 0;
        existing.outputTokens += cost.outputTokens;
        existing.costUSD += cost.costUSD;
        existing.costEUR = existing.costEUR === null || cost.costEUR == null
            ? null
            : existing.costEUR + cost.costEUR;
    }

    return Object.values(aggregated).sort((a, b) => {
        const indexA = PHASE_ORDER.indexOf(a.phase);
        const indexB = PHASE_ORDER.indexOf(b.phase);
        if (indexA === -1 && indexB === -1) return a.phase.localeCompare(b.phase);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });
}

function renderMoney(costEUR: number | null | undefined, costUSD: number): string {
    const color = costUSD > 0.01 ? '#d35400' : '#27ae60';
    if (costEUR == null) {
        return `
            <strong style="color: ${color};">$${costUSD.toFixed(4)} USD</strong>
            <br/><small style="color: #777;">Conversione EUR non disponibile</small>
        `;
    }
    return `
        <strong style="color: ${color};">€${costEUR.toFixed(4)} EUR</strong>
        <br/><small style="color: #777;">$${costUSD.toFixed(4)} USD</small>
    `;
}

/** Pure renderer kept separate from email/network code so currency output is testable. */
export function renderCostAnalysisRows(metrics: SessionMetrics): string {
    const phases = aggregateCosts(metrics);
    const costMetrics = metrics.costMetrics;
    const rateNote = costMetrics?.usdPerEur && costMetrics.exchangeRateDate
        ? `Cambio ${costMetrics.exchangeRateSource === 'STALE_ECB' ? 'BCE in cache' : 'BCE'}: ` +
          `1 EUR = ${costMetrics.usdPerEur.toFixed(4)} USD · ${costMetrics.exchangeRateDate}`
        : 'Cambio EUR non disponibile: importi mostrati solo in USD.';

    const phaseRows = phases.length > 0
        ? phases.map((cost) => {
            const displayName = PHASE_DISPLAY_NAMES[cost.phase] ||
                (cost.phase.charAt(0).toUpperCase() + cost.phase.slice(1));
            return `
        <tr>
            <td style="padding-left: 20px;">
                <strong>${displayName}</strong>
                <br/><small style="color: #666;">
                    ${Array.from(cost.providers).join(', ')} • ${cost.models.join(', ')}
                </small>
            </td>
            <td>
                <small>
                    In: ${cost.inputTokens.toLocaleString()}
                    ${cost.cachedInputTokens > 0 ? `(Cached: ${cost.cachedInputTokens.toLocaleString()})` : ''}
                    <br/>
                    Out: ${cost.outputTokens.toLocaleString()}
                </small>
                <br/>
                ${renderMoney(cost.costEUR, cost.costUSD)}
            </td>
        </tr>
        `;
        }).join('')
        : '<tr><td colspan="2" style="padding: 8px; color: #999;">Nessun dato disponibile</td></tr>';

    return `
        <tr style="background-color: #fff3cd;">
            <td colspan="2"><strong>💰 COST ANALYSIS</strong></td>
        </tr>
        <tr>
            <td><strong>Total Cost</strong></td>
            <td style="font-weight: bold; font-size: 16px; color: #d35400;">
                ${renderMoney(costMetrics?.totalCostEUR, costMetrics?.totalCostUSD ?? 0)}
                <br/><small style="font-weight: normal; color: #777;">${rateNote}</small>
            </td>
        </tr>
        <tr style="background-color: #f9f9f9;">
            <td colspan="2"><strong>📊 Cost Breakdown by Phase</strong></td>
        </tr>
        ${phaseRows}
    `;
}
