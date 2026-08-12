import { db } from '../db/client';
import { getAiContext } from '../bard/ai/resolver';
import { resolveTranscription } from '../bard/ai/transcription';
import { resolveEmbedding } from '../bard/ai/embeddings';
import { transcriptionPricePerMinute } from '../bard/ai/modelCatalog';
import { costUsdFor, hasKnownPrice, resolvePricingFor, type PricingSource } from './pricingSource';
import { getUsdEurRate, usdToEur } from './aiCostTransparency';
import type { AIProvider } from '../config';
import type { AiPhase, AiScope } from '../bard/ai/types';

/**
 * Roughly what recording a session will cost.
 *
 * It is not a price: it is an estimate, and it should be read as one. It exists to answer
 * the question a person asks before pressing «listen» — «how much is tonight
 * going to cost me?» — instead of finding out four hours later.
 *
 * **The calibration comes from the table's own history.** `ai_usage_log` records
 * the tokens per phase with `guild_id`: the median of the past minutes says how much
 * that table really consumes per minute of session, which is far more accurate
 * than a table of constants — a group of six people talking over each other
 * produces three times the text of a duo. Without history a global default is
 * used, and declared as such.
 */

/**
 * Tokens per minute of session, per phase, when there is no history.
 *
 * For `analyst` and `summary` this is the **input** side only: their output is
 * a narrative recap with a size of its own, not a function of how long the
 * table talked — see `FLAT_OUTPUT_PHASES` below. Treating it as a rate once
 * priced a 3-hour session's write-up as if it were three times a 1-hour one's,
 * which it is not.
 */
const DEFAULT_TOKENS_PER_MINUTE: Record<string, { input: number; output: number }> = {
    metadata: { input: 214, output: 8 },
    analyst: { input: 1550, output: 0 },
    summary: { input: 670, output: 0 },
    reconcile: { input: 17, output: 0.5 },
    embedding: { input: 300, output: 0 },
};

/**
 * Tokens that belong to the session, not to its minutes.
 *
 * `analyst`/`summary` output: a recap's length. `manifesto`/`bio_batch`/
 * `moral_reassessment`: maintenance calls that run about once per session
 * regardless of how long it ran — dividing them by minutes would call a
 * near-constant a rate.
 *
 * Calibrated on the one real "semi-agentic" session logged so far (~130
 * minutes) — declared, not measured: `calibrated` stays false until a table
 * has three of its own for `observedTokensPerSession` to average.
 */
const FLAT_TOKENS_PER_SESSION: Record<string, { input: number; output: number }> = {
    analyst: { input: 0, output: 2000 },
    summary: { input: 0, output: 2500 },
    manifesto: { input: 7900, output: 1800 },
    bio_batch: { input: 1150, output: 425 },
    moral_reassessment: { input: 570, output: 110 },
};

/** Sides that come from `FLAT_TOKENS_PER_SESSION` instead of a per-minute rate. */
const FLAT_INPUT_PHASES = new Set(['manifesto', 'bio_batch', 'moral_reassessment']);
const FLAT_OUTPUT_PHASES = new Set(['analyst', 'summary', 'manifesto', 'bio_batch', 'moral_reassessment']);

/**
 * A phase borrows another's model when it has no select of its own in the
 * settings UI — `manifesto`/`bio_batch` run on the metadata client,
 * `moral_reassessment` on the analyst client (see `src/bard/manifesto.ts`,
 * `src/bard/bio.ts`, `src/bard/moralReassessment.ts`). The estimate has to
 * price them on the same client that will actually run them.
 */
const PHASE_CONFIG_ALIAS: Partial<Record<string, AiPhase>> = {
    manifesto: 'metadata',
    bio_batch: 'metadata',
    moral_reassessment: 'analyst',
};

/**
 * Every id in `SESSION_PHASES` other than `embedding` is either a real
 * `AiPhase` already, or aliased to one above — the cast is by construction,
 * not an escape hatch.
 */
function configPhaseFor(phase: string): AiPhase {
    return (PHASE_CONFIG_ALIAS[phase] ?? phase) as AiPhase;
}

/**
 * Turning audio into text — **not** an `AiPhase`.
 *
 * It is an engine, not a configurable phase: it has no entry in
 * `ai.config.json`, it is billed per minute of audio rather than per token, and
 * on the table's own PC it is not billed at all.
 *
 * It needs a name of its own because `transcription` was already taken, by the
 * phase that *corrects* the transcript. The two used to share one id, in the
 * estimate and in `ai_usage_log` alike, and the collision cost the correction
 * its line: the estimate priced the audio step under that name and the
 * correction's tokens were counted nowhere at all.
 */
export const SPEECH_TO_TEXT_PHASE = 'speechToText';

/**
 * The phases a session actually runs, in pipeline order.
 *
 * `chat` is absent on purpose: the RAG answers questions asked afterwards, not
 * during the recording, so it belongs to no session's bill. `transcription`
 * (AI correction of the transcript), `map` and `narrativeFilter` are absent
 * too, but for a different reason: none of the three has a live call site
 * left in the codebase — `correctTranscription()` does only regex-based
 * hallucination cleanup, and `map`/`narrativeFilter` were never called at all
 * — so pricing them would charge for work that structurally cannot happen.
 * `manifesto`, `bio_batch` and `moral_reassessment` are here instead: they run
 * every session's post-summary maintenance step but were simply never added.
 */
const SESSION_PHASES = ['metadata', 'analyst', 'manifesto', 'summary', 'moral_reassessment', 'bio_batch', 'reconcile', 'embedding'] as const;

export interface PhaseCostEstimate {
    phase: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** $/1M tokens for each side, so the UI can show the rate behind the total, not just the total. */
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    costUsd: number | null;
    pricingSource: PricingSource;
    /**
     * True when the phase costs time and hardware rather than money.
     *
     * It has to be said, not omitted: «€0» on a phase that keeps a home PC busy
     * for twenty minutes is a half-truth.
     */
    resourceIntensive: boolean;
}

export interface SessionCostEstimate {
    audioMinutes: number;
    perPhase: PhaseCostEstimate[];
    totalUsd: number | null;
    totalEur: number | null;
    /** False when even one phase has an unknown price: the total is partial. */
    pricingComplete: boolean;
    /** Phases that run on the table's hardware. */
    resourceIntensivePhases: string[];
    /** True when the estimate is based on this table's own history. */
    calibrated: boolean;
}

/**
 * Tokens per minute observed on this table.
 *
 * The **median** is used rather than the mean: a session that went wrong, or a
 * manual regeneration, would move the mean considerably and make the
 * estimate worse than a default.
 *
 * ⚠️ The duration is **approximated by the time span of the recordings** —
 * from the first to the last — because no table keeps the minutes of audio
 * per session (`usage_tracking` aggregates by guild and month). It is an
 * over-estimate: it includes the pauses when nobody speaks. For an estimate that is
 * fine, and it errs on the right side.
 */
function observedTokensPerMinute(guildId: string): Map<string, { input: number; output: number }> {
    const rows = db.prepare(`
        WITH spans AS (
            SELECT session_id,
                   (MAX(timestamp) - MIN(timestamp)) / 60000.0 AS minutes
            FROM recordings
            WHERE timestamp IS NOT NULL
            GROUP BY session_id
            HAVING minutes > 0
        )
        SELECT u.phase,
               SUM(u.input_tokens)  AS input_tokens,
               SUM(u.output_tokens) AS output_tokens,
               s.minutes AS audio_minutes_used
        FROM ai_usage_log u
        JOIN spans s ON s.session_id = u.session_id
        WHERE u.guild_id = ?
        GROUP BY u.session_id, u.phase
    `).all(guildId) as Array<{ phase: string; input_tokens: number; output_tokens: number; audio_minutes_used: number }>;

    const byPhase = new Map<string, Array<{ input: number; output: number }>>();
    for (const row of rows) {
        const list = byPhase.get(row.phase) ?? [];
        list.push({
            input: row.input_tokens / row.audio_minutes_used,
            output: row.output_tokens / row.audio_minutes_used,
        });
        byPhase.set(row.phase, list);
    }

    const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };

    const result = new Map<string, { input: number; output: number }>();
    for (const [phase, samples] of byPhase) {
        // Fewer than three sessions do not make a median: better the default,
        // declared, than a calibration on a single case.
        if (samples.length < 3) continue;
        result.set(phase, {
            input: median(samples.map(s => s.input)),
            output: median(samples.map(s => s.output)),
        });
    }
    return result;
}

/**
 * Raw per-session totals, for phases whose usage does not scale with the
 * session's length (see `FLAT_TOKENS_PER_SESSION`). No join against
 * `recordings` here — unlike `observedTokensPerMinute`, a flat phase does not
 * need to know how long the session ran to be averaged.
 */
function observedTokensPerSession(guildId: string): Map<string, { input: number; output: number }> {
    const rows = db.prepare(`
        SELECT phase,
               SUM(input_tokens)  AS input_tokens,
               SUM(output_tokens) AS output_tokens
        FROM ai_usage_log
        WHERE guild_id = ?
        GROUP BY session_id, phase
    `).all(guildId) as Array<{ phase: string; input_tokens: number; output_tokens: number }>;

    const byPhase = new Map<string, Array<{ input: number; output: number }>>();
    for (const row of rows) {
        const list = byPhase.get(row.phase) ?? [];
        list.push({ input: row.input_tokens, output: row.output_tokens });
        byPhase.set(row.phase, list);
    }

    const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };

    const result = new Map<string, { input: number; output: number }>();
    for (const [phase, samples] of byPhase) {
        if (samples.length < 3) continue;
        result.set(phase, {
            input: median(samples.map(s => s.input)),
            output: median(samples.map(s => s.output)),
        });
    }
    return result;
}

/** The rate to use for one side of one phase — this table's own history once there is enough of it, the declared defaults otherwise. */
function rateFor(
    phase: string,
    side: 'input' | 'output',
    audioMinutes: number,
    byMinute: Map<string, { input: number; output: number }>,
    bySession: Map<string, { input: number; output: number }>,
): number {
    const flat = (side === 'input' ? FLAT_INPUT_PHASES : FLAT_OUTPUT_PHASES).has(phase);
    const fallback = (flat ? FLAT_TOKENS_PER_SESSION[phase] : DEFAULT_TOKENS_PER_MINUTE[phase]) ?? { input: 0, output: 0 };
    if (flat) return bySession.get(phase)?.[side] ?? fallback[side];
    return (byMinute.get(phase)?.[side] ?? fallback[side]) * audioMinutes;
}

export async function estimateSessionCost(
    scope: AiScope,
    audioMinutes: number,
): Promise<SessionCostEstimate> {
    const ctx = getAiContext(scope);
    const byMinute = observedTokensPerMinute(scope.guildId);
    const bySession = observedTokensPerSession(scope.guildId);
    const perPhase: PhaseCostEstimate[] = [];

    // Audio→text first: it is what the whole pipeline reads from, and on a long
    // session it is often the largest single line.
    const speechToText = await estimateSpeechToText(scope, audioMinutes);
    if (speechToText) perPhase.push(speechToText);

    for (const phase of SESSION_PHASES) {
        const estimate = phase === 'embedding'
            ? await estimateEmbedding(scope, audioMinutes, byMinute)
            : estimateTokenPhase(ctx, scope, phase, configPhaseFor(phase), audioMinutes, byMinute, bySession);

        if (estimate) perPhase.push(estimate);
    }

    const pricingComplete = perPhase.every(p => hasKnownPrice(p.pricingSource));
    const totalUsd = perPhase.reduce<number | null>(
        (total, phase) => total === null || phase.costUsd === null ? null : total + phase.costUsd,
        0,
    );
    const rate = await getUsdEurRate();

    return {
        audioMinutes,
        perPhase,
        totalUsd,
        totalEur: totalUsd === null ? null : usdToEur(totalUsd, rate),
        pricingComplete,
        resourceIntensivePhases: perPhase.filter(p => p.resourceIntensive).map(p => p.phase),
        calibrated: byMinute.size > 0 || bySession.size > 0,
    };
}

/**
 * What one phase would cost with a **candidate** model.
 *
 * It answers the question asked while a select is open — «and if I picked this
 * one?» — which the whole-session estimate cannot: that one prices what is
 * already configured, and by the time it changes the choice has been made.
 *
 * Same calibration as the session estimate: the table's own history when there
 * is enough of it, the declared defaults otherwise. `calibrated` says which,
 * because a figure derived from three of your own sessions and one derived from
 * our constants deserve different amounts of trust.
 */
export function estimatePhaseCost(
    scope: AiScope,
    phase: AiPhase,
    provider: AIProvider,
    model: string,
    audioMinutes: number,
): PhaseCostEstimate & { calibrated: boolean } {
    const byMinute = observedTokensPerMinute(scope.guildId);
    const bySession = observedTokensPerSession(scope.guildId);
    const inputTokens = Math.round(rateFor(phase, 'input', audioMinutes, byMinute, bySession));
    const outputTokens = Math.round(rateFor(phase, 'output', audioMinutes, byMinute, bySession));

    const pricing = resolvePricingFor(provider, model, scope);
    return {
        phase,
        provider,
        model,
        inputTokens,
        outputTokens,
        inputPerMillion: pricing.pricing?.input ?? null,
        outputPerMillion: pricing.pricing?.output ?? null,
        costUsd: costUsdFor(pricing, { input: inputTokens, output: outputTokens }),
        pricingSource: pricing.source,
        resourceIntensive: provider === 'ollama',
        calibrated: byMinute.has(phase) || bySession.has(phase),
    };
}

/**
 * Transcription is quoted **per minute of audio**, not per token.
 *
 * It is often the largest line item of a long session, and using the per-token
 * rate would give a figure wrong by orders of magnitude.
 */
async function estimateSpeechToText(scope: AiScope, audioMinutes: number): Promise<PhaseCostEstimate | null> {
    const transcription = resolveTranscription(scope);

    if (transcription.engine === 'remote') {
        return {
            phase: SPEECH_TO_TEXT_PHASE,
            provider: 'own-machine',
            model: 'lesta-penna-ai-server',
            inputTokens: 0,
            outputTokens: 0,
            inputPerMillion: null,
            outputPerMillion: null,
            costUsd: 0,
            pricingSource: 'free',
            resourceIntensive: true,
        };
    }
    if (transcription.engine !== 'cloud') return null;

    const perMinute = transcriptionPricePerMinute(transcription.cloud.model);
    return {
        phase: SPEECH_TO_TEXT_PHASE,
        provider: transcription.cloud.provider,
        model: transcription.cloud.model,
        inputTokens: 0,
        outputTokens: 0,
        // Billed per minute of audio, not per token: a $/1M rate would not describe it.
        inputPerMillion: null,
        outputPerMillion: null,
        costUsd: perMinute === null ? null : perMinute * audioMinutes,
        pricingSource: perMinute === null ? 'unknown' : 'builtin',
        resourceIntensive: false,
    };
}

async function estimateEmbedding(
    scope: AiScope,
    audioMinutes: number,
    observed: Map<string, { input: number; output: number }>,
): Promise<PhaseCostEstimate | null> {
    const resolved = await resolveEmbedding(scope, { probeOllama: false }).catch(() => null);
    if (!resolved) return null;

    const rate = observed.get('embeddings') ?? DEFAULT_TOKENS_PER_MINUTE.embedding;
    const inputTokens = Math.round(rate.input * audioMinutes);
    const pricing = resolvePricingFor(resolved.provider, resolved.model, scope);

    return {
        phase: 'embedding',
        provider: resolved.provider,
        model: resolved.model,
        inputTokens,
        outputTokens: 0,
        inputPerMillion: pricing.pricing?.input ?? null,
        outputPerMillion: pricing.pricing?.output ?? null,
        costUsd: costUsdFor(pricing, { input: inputTokens, output: 0 }),
        pricingSource: pricing.source,
        resourceIntensive: resolved.provider === 'ollama',
    };
}

function estimateTokenPhase(
    ctx: ReturnType<typeof getAiContext>,
    scope: AiScope,
    phase: string,
    configPhase: AiPhase,
    audioMinutes: number,
    byMinute: Map<string, { input: number; output: number }>,
    bySession: Map<string, { input: number; output: number }>,
): PhaseCostEstimate {
    const config = ctx.phaseConfig(configPhase);
    const inputTokens = Math.round(rateFor(phase, 'input', audioMinutes, byMinute, bySession));
    const outputTokens = Math.round(rateFor(phase, 'output', audioMinutes, byMinute, bySession));

    const pricing = resolvePricingFor(config.provider, config.model, scope);
    return {
        phase,
        provider: config.provider,
        model: config.model,
        inputTokens,
        outputTokens,
        inputPerMillion: pricing.pricing?.input ?? null,
        outputPerMillion: pricing.pricing?.output ?? null,
        costUsd: costUsdFor(pricing, { input: inputTokens, output: outputTokens }),
        pricingSource: pricing.source,
        resourceIntensive: config.provider === 'ollama',
    };
}
