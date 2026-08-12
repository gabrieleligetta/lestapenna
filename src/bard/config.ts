/**
 * Bard Config — access to the AI layer, per phase.
 *
 * The real resolution lives in `bard/ai/`: what stays here are the per-phase
 * getters, which now return a route **complete with credentials** instead of the
 * old client/model/provider trio.
 *
 * The argument-less getters read the ambient scope (`ai/ambientScope.ts`). It is
 * a bridge: as call sites start receiving an explicit `AiContext`, they will
 * disappear. As long as they exist, whoever starts a pipeline has to enter
 * `runWithAiScope()` — otherwise the instance's default guild is resolved,
 * which on a shared instance is the wrong guild.
 */

import { loadAiConfig, AIProvider, PhaseConfig } from '../config';
import { requireAiScope } from './ai/ambientScope';
import { getAiContext, contextLimitsFor, isOllamaAlive, listOllamaModels, stripV1Suffix } from './ai/resolver';
import type { AiPhase, AiScope } from './ai/types';
import type { ProviderRoute } from './llm/generate';

const cfg = loadAiConfig();

const CHARS_PER_TOKEN = 4;

export { stripV1Suffix };

/** Compatibility: the historical name of the Ollama health check. */
export const checkOllamaAlive = isOllamaAlive;

/** The route for a phase, in the given scope (or in the ambient one). */
export function routeFor(phase: AiPhase, scope?: AiScope): Promise<ProviderRoute> {
    return getAiContext(scope ?? requireAiScope()).route(phase);
}

// ============================================
// DYNAMIC CLIENT GETTERS
// ============================================

export const getTranscriptionClient = (scope?: AiScope) => routeFor('transcription', scope);
export const getMetadataClient = (scope?: AiScope) => routeFor('metadata', scope);
export const getMapClient = (scope?: AiScope) => routeFor('map', scope);
export const getSummaryClient = (scope?: AiScope) => routeFor('summary', scope);
export const getAnalystClient = (scope?: AiScope) => routeFor('analyst', scope);
export const getChatClient = (scope?: AiScope) => routeFor('chat', scope);
export const getNarrativeFilterClient = (scope?: AiScope) => routeFor('narrativeFilter', scope);
/** Entity reconciliation: falls back to metadata when the phase is not configured. */
export const getReconcileClient = (scope?: AiScope) => routeFor('reconcile', scope);
/** Portrait generation. Asked for one entity at a time, never by the session pipeline. */
export const getImageClient = (scope?: AiScope) => routeFor('image', scope);

// ============================================
// PIPELINE PARAMETERS, PER TABLE
// ============================================
//
// These used to be constants frozen at import time. They all depend on the
// chosen provider, which is now the table's choice: a guild on Ollama and one on
// Gemini have context windows two orders of magnitude apart, and chunking the
// first one's transcript with the second one's size means sending the model an
// input that does not fit.

/** Size of the transcript chunks, in characters. It depends on the map phase. */
export const chunkingFor = (scope?: AiScope) =>
    getAiContext(scope ?? requireAiScope()).chunking();

/** How many parallel requests that phase's provider tolerates. */
export const concurrencyFor = (phase: AiPhase, scope?: AiScope) =>
    getAiContext(scope ?? requireAiScope()).concurrency(phase);

/** Context and output window of that phase's provider. */
export const limitsFor = (phase: AiPhase, scope?: AiScope) =>
    getAiContext(scope ?? requireAiScope()).limits(phase);

/**
 * A phase's provider and model, without building clients or credentials.
 *
 * It serves whoever only has to *say* what would be used — the cost estimate
 * shown before confirming an action — without spending anything.
 */
export const phaseConfigFor = (phase: AiPhase, scope?: AiScope) =>
    getAiContext(scope ?? requireAiScope()).phaseConfig(phase);

/**
 * The default embedding model in the instance configuration.
 *
 * It is no longer *the* model: every campaign pins its own at the first
 * indexing (`ai/embeddings.ts`). It stays for the startup banner and as a
 * fallback for anyone self-hosting with Ollama who configures nothing else.
 */
const DEFAULT_EMBEDDING_MODEL = cfg.phases.embedding.model;

/**
 * **Instance** configuration, for the startup banner only.
 *
 * It is not the truth for a table: `getAiContext(scope)` gives that. It stays
 * here because the banner describes what the process starts with, before any
 * guild exists at all.
 */
const NARRATIVE_BATCH_SIZE = cfg.features.narrativeBatchSize;

// ============================================
// BANNER D'AVVIO
// ============================================

const formatPhaseLog = (phase: PhaseConfig) => {
    if (phase.provider === 'ollama') {
        const local = phase.localModel ? ` (loc: ${phase.localModel})` : '';
        return `${phase.model}${local}`.padEnd(40);
    }
    return phase.model.padEnd(40);
};

/**
 * Prints the **instance** configuration.
 *
 * It has to be called explicitly from `src/index.ts`, not at import time: it
 * used to be a module side effect, which meant opening sockets and printing
 * just by importing a type — including in the test suite, where it produced
 * logs after the cases had closed.
 */
export function printAiBanner(): void {
    const line = (label: string, phase: PhaseConfig, note = '') =>
        console.log(`${label.padEnd(13)}${phase.provider.padEnd(8)} → ${formatPhaseLog(phase)}${note}`);

    const mapProvider = cfg.phases.map.provider;
    const chunkChars = cfg.chunkSize[mapProvider] * CHARS_PER_TOKEN;

    console.log('\n🎭 BARDO AI — configurazione di istanza (i tavoli possono sovrascriverla)');
    line('Correzione:', cfg.phases.transcription);
    line('Metadati:', cfg.phases.metadata);
    line('Map:', cfg.phases.map);
    line('Analyst:', cfg.phases.analyst, ' (estrazione dati)');
    line('Summary:', cfg.phases.summary, ' (narrazione)');
    line('Chat/RAG:', cfg.phases.chat);
    line('NarrFilter:', cfg.phases.narrativeFilter, ` (batch: ${NARRATIVE_BATCH_SIZE})`);
    if (cfg.phases.image) line('Immagini:', cfg.phases.image, ' (ritratti, a richiesta)');
    console.log(`Embeddings:  default     → ${DEFAULT_EMBEDDING_MODEL} (ogni campagna fissa il proprio)`);
    console.log(`Ollama URLs: Remoto → ${cfg.ollama.remoteUrl} | Locale → ${cfg.ollama.localUrl}`);
    console.log(`ChunkSize:   ${mapProvider} → ${cfg.chunkSize[mapProvider].toLocaleString()} tokens (${chunkChars.toLocaleString()} chars, overlap: ${cfg.chunkOverlap[mapProvider].toLocaleString()} tok)`);
}

/**
 * Verifies that the configured models exist on the Ollama nodes.
 *
 * This too used to be an import-time effect. It is now explicit and does not block the boot.
 */
export async function checkOllamaModelsAvailable(): Promise<void> {
    const ollamaPhases = Object.values(cfg.phases).filter(p => p.provider === 'ollama');
    const wanted = new Set(ollamaPhases.map(p => p.model));
    wanted.add(DEFAULT_EMBEDDING_MODEL);

    for (const [label, url] of [['remoto', cfg.ollama.remoteUrl], ['locale', cfg.ollama.localUrl]] as const) {
        if (label === 'remoto' && ollamaPhases.length === 0) continue;

        const available = await listOllamaModels(url);
        if (available === null) {
            console.warn(`[Ollama] ⚠️ Nodo ${label} non raggiungibile (${url})`);
            continue;
        }
        for (const model of wanted) {
            const found = available.some(m => m === model || m.startsWith(`${model}:`));
            if (!found) {
                console.warn(`[Ollama] ⚠️ Modello "${model}" non trovato sul nodo ${label}`);
            }
        }
    }
}

export type { AIProvider, PhaseConfig };
