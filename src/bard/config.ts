/**
 * Bard Config - AI providers, models, clients, and constants
 */

import OpenAI from 'openai';
import { config, loadAiConfig, AIProvider, PhaseConfig } from '../config';

// ============================================
// LOAD AI JSON CONFIG
// ============================================

const cfg = loadAiConfig();

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Crea un client AI per la fase richiesta. Supporta OpenAI, Gemini (via endpoint
 * OpenAI-compatibile), e Ollama (con fallback automatico remote → local → openai).
 */

async function checkOllamaAlive(baseUrl: string): Promise<boolean> {
    try {
        // Rimuoviamo il suffisso /v1 per pingare l'API nativa di Ollama.
        const nativeUrl = baseUrl.replace(/\/v1\/?$/, '');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(`${nativeUrl}/api/tags`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        return response.ok;
    } catch (e) {
        return false;
    }
}

export async function getDynamicProvider(
    phase: PhaseConfig
): Promise<{ client: OpenAI, model: string, provider: AIProvider }> {

    // CASO OpenAI: client standard
    if (phase.provider === 'openai') {
        return {
            client: new OpenAI({
                apiKey: config.ai.openAi.apiKey,
                project: config.ai.openAi.projectId || undefined,
                timeout: 1800 * 1000,
            }),
            model: phase.model,
            provider: 'openai'
        };
    }

    // CASO Gemini: OpenAI SDK con endpoint OpenAI-compatibile di Google
    // Nessun health-check necessario (servizio cloud sempre disponibile)
    if (phase.provider === 'gemini') {
        return {
            client: new OpenAI({
                baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
                apiKey: config.ai.gemini.apiKey,
                timeout: 1800 * 1000,
            }),
            model: phase.model,
            provider: 'gemini'
        };
    }

    // CASO Ollama: tenta remote → local → fallback disperato su OpenAI

    // Tenta prima l'URL configurato (che potrebbe essere il Tailscale remoto)
    const primaryUrl = cfg.ollama.remoteUrl;
    const isPrimaryAlive = await checkOllamaAlive(primaryUrl);

    if (isPrimaryAlive) {
        return {
            client: new OpenAI({
                baseURL: primaryUrl,
                apiKey: 'ollama',
                timeout: 1800 * 1000,
            }),
            model: phase.model,
            provider: 'ollama'
        };
    }

    // Tenta il fallback locale se il primary fallisce
    const localFallbackUrl = cfg.ollama.localUrl;
    if (primaryUrl !== localFallbackUrl) {
        const isLocalAlive = await checkOllamaAlive(localFallbackUrl);
        if (isLocalAlive) {
            console.log(`[AI Fallback] ⚠️ Ollama Primary down. Using Local Fallback: ${localFallbackUrl}`);
            return {
                client: new OpenAI({
                    baseURL: localFallbackUrl,
                    apiKey: 'ollama',
                    timeout: 1800 * 1000,
                }),
                // Quando cadiamo sul locale, usa localModel se configurato, altrimenti il model della fase
                model: phase.localModel || phase.model,
                provider: 'ollama'
            };
        }
    }

    // Fallback disperato salvavita su OpenAI
    const fallbackModel = cfg.fallback.model;
    console.warn(`[AI Fallback] 🔴 All Ollama nodes DEAD! Falling back to OPENAI (${fallbackModel}).`);
    return {
        client: new OpenAI({
            apiKey: config.ai.openAi.apiKey,
            project: config.ai.openAi.projectId || undefined,
            timeout: 1800 * 1000,
        }),
        model: fallbackModel,
        provider: 'openai'
    };
}

// ============================================
// PROVIDER CONFIGURATION (from ai.config.json)
// ============================================

export const TRANSCRIPTION_PROVIDER = cfg.phases.transcription.provider;
export const METADATA_PROVIDER = cfg.phases.metadata.provider;
export const MAP_PROVIDER = cfg.phases.map.provider;
export const SUMMARY_PROVIDER = cfg.phases.summary.provider;
export const ANALYST_PROVIDER = cfg.phases.analyst.provider;
export const CHAT_PROVIDER = cfg.phases.chat.provider;
export const EMBEDDING_PROVIDER = cfg.phases.embedding.provider;
export const NARRATIVE_FILTER_PROVIDER = cfg.phases.narrativeFilter.provider;

// ============================================
// MODEL CONFIGURATION (from ai.config.json)
// ============================================

export const TRANSCRIPTION_MODEL = cfg.phases.transcription.model;
export const METADATA_MODEL = cfg.phases.metadata.model;
export const MAP_MODEL = cfg.phases.map.model;
export const SUMMARY_MODEL = cfg.phases.summary.model;
export const ANALYST_MODEL = cfg.phases.analyst.model;
export const CHAT_MODEL = cfg.phases.chat.model;
export const NARRATIVE_FILTER_MODEL = cfg.phases.narrativeFilter.model;

export const EMBEDDING_MODEL_OLLAMA = cfg.phases.embedding.model; // dal JSON config (es. nomic-embed-text)

// ============================================
// DYNAMIC CLIENT GETTERS
// ============================================

export const getTranscriptionClient = () => getDynamicProvider(cfg.phases.transcription);
export const getMetadataClient = () => getDynamicProvider(cfg.phases.metadata);
export const getMapClient = () => getDynamicProvider(cfg.phases.map);
export const getSummaryClient = () => getDynamicProvider(cfg.phases.summary);
export const getAnalystClient = () => getDynamicProvider(cfg.phases.analyst);
export const getChatClient = () => getDynamicProvider(cfg.phases.chat);
export const getNarrativeFilterClient = () => getDynamicProvider(cfg.phases.narrativeFilter);

export const ollamaEmbedClient = new OpenAI({
    baseURL: cfg.ollama.localUrl, // Usa sempre il locale — è l'istanza garantita (host.docker.internal in dev, ollama:11434 in prod)
    apiKey: 'ollama',
    timeout: 5000
});

// ============================================
// CONCURRENCY LIMITS (from ai.config.json)
// ============================================

export const TRANSCRIPTION_CONCURRENCY = cfg.concurrency[TRANSCRIPTION_PROVIDER];
export const MAP_CONCURRENCY = cfg.concurrency[MAP_PROVIDER];
export const EMBEDDING_BATCH_SIZE = cfg.concurrency[EMBEDDING_PROVIDER];
export const NARRATIVE_BATCH_SIZE = cfg.features.narrativeBatchSize;

// ============================================
// CONTEXT WINDOW LIMITS (per provider, per logging)
// ============================================

const PROVIDER_CONTEXT_LIMITS: Record<AIProvider, { input: number; output: number }> = {
    openai: { input: 128_000,   output: 16_384 },
    gemini: { input: 1_048_576, output: 65_536 }, // gemini-3.1-pro-preview / gemini-3-flash-preview
    ollama: { input: 32_768,    output: 4_096  }
};

export const ANALYST_CONTEXT_LIMIT = PROVIDER_CONTEXT_LIMITS[ANALYST_PROVIDER].input;
export const ANALYST_OUTPUT_LIMIT  = PROVIDER_CONTEXT_LIMITS[ANALYST_PROVIDER].output;
export const SUMMARY_CONTEXT_LIMIT = PROVIDER_CONTEXT_LIMITS[SUMMARY_PROVIDER].input;
export const SUMMARY_OUTPUT_LIMIT  = PROVIDER_CONTEXT_LIMITS[SUMMARY_PROVIDER].output;

// ============================================
// CHUNK SIZE (from ai.config.json, based on MAP_PROVIDER)
// Config values are in TOKENS — converted to chars here (~4 chars/token avg)
// ============================================

const CHARS_PER_TOKEN = 4;
export const MAX_CHUNK_SIZE = cfg.chunkSize[MAP_PROVIDER] * CHARS_PER_TOKEN;
export const CHUNK_OVERLAP = cfg.chunkOverlap[MAP_PROVIDER] * CHARS_PER_TOKEN;

// ============================================
// REMOTE MODEL CHECK (Startup — non blocca il boot)
// ============================================

async function checkRemoteModelAvailable(): Promise<void> {
    const ollamaPhases = Object.values(cfg.phases).filter(p => p.provider === 'ollama');
    if (ollamaPhases.length === 0) return;

    const remoteUrl = cfg.ollama.remoteUrl.replace(/\/v1\/?$/, '');
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${remoteUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) {
            console.warn(`[Ollama] ⚠️ PC remoto ha risposto con status ${resp.status}`);
            return;
        }
        const data = await resp.json() as { models?: Array<{ name: string }> };
        const models = (data.models || []).map((m) => m.name);
        const wantedModels = [...new Set(ollamaPhases.map(p => p.model))];
        for (const wanted of wantedModels) {
            const found = models.some((m: string) =>
                m === wanted || m.startsWith(wanted + ':')
            );
            if (found) {
                console.log(`[Ollama] ✅ Modello "${wanted}" disponibile sul PC remoto`);
            } else {
                console.warn(`[Ollama] ⚠️ Modello "${wanted}" NON trovato sul PC remoto!`);
                console.warn(`[Ollama]    Modelli disponibili: ${models.join(', ')}`);
            }
        }
    } catch {
        console.warn(`[Ollama] ⚠️ PC remoto non raggiungibile per check modello`);
    }
}

// ============================================
// DEBUG LOG (Startup)
// ============================================

const formatPhaseLog = (phase: PhaseConfig) => {
    if (phase.provider === 'ollama') {
        const local = phase.localModel ? ` (loc: ${phase.localModel})` : '';
        return `${phase.model}${local}`.padEnd(40);
    }
    return phase.model.padEnd(40);
};

console.log('\n🎭 BARDO AI - CONFIG GRANULARE');
console.log(`Correzione:  ${TRANSCRIPTION_PROVIDER.padEnd(8)} → ${formatPhaseLog(cfg.phases.transcription)}`);
console.log(`Metadati:    ${METADATA_PROVIDER.padEnd(8)} → ${formatPhaseLog(cfg.phases.metadata)}`);
console.log(`Map:         ${MAP_PROVIDER.padEnd(8)} → ${formatPhaseLog(cfg.phases.map)}`);
console.log(`Analyst:     ${ANALYST_PROVIDER.padEnd(8)} → ${formatPhaseLog(cfg.phases.analyst)} (estrazione dati)`);
console.log(`Summary:     ${SUMMARY_PROVIDER.padEnd(8)} → ${formatPhaseLog(cfg.phases.summary)} (narrazione)`);
console.log(`Chat/RAG:    ${CHAT_PROVIDER.padEnd(8)} → ${formatPhaseLog(cfg.phases.chat)}`);
console.log(`NarrFilter:  ${NARRATIVE_FILTER_PROVIDER.padEnd(8)} → ${formatPhaseLog(cfg.phases.narrativeFilter)} (batch: ${NARRATIVE_BATCH_SIZE})`);
console.log(`Embeddings:  ollama      → ${EMBEDDING_MODEL_OLLAMA} (locale: ${cfg.ollama.localUrl})`);
console.log(`Ollama URLs: Remoto → ${cfg.ollama.remoteUrl} | Locale → ${cfg.ollama.localUrl}`);
console.log(`ChunkSize:   ${MAP_PROVIDER} → ${cfg.chunkSize[MAP_PROVIDER].toLocaleString()} tokens (${MAX_CHUNK_SIZE.toLocaleString()} chars, overlap: ${cfg.chunkOverlap[MAP_PROVIDER].toLocaleString()} tok)`);

// Check asincrono del modello remoto (non blocca il boot)
checkRemoteModelAvailable();

// Check locale embed model (critico — è l'unico usato per RAG)
async function checkLocalEmbedModel(): Promise<void> {
    const localUrl = cfg.ollama.localUrl.replace(/\/v1\/?$/, '');
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${localUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) {
            console.warn(`[Ollama] ⚠️ Locale non ha risposto (status ${resp.status}) — embed RAG non funzionerà`);
            return;
        }
        const data = await resp.json() as { models?: Array<{ name: string }> };
        const models = (data.models || []).map((m) => m.name);
        const found = models.some(m => m === EMBEDDING_MODEL_OLLAMA || m.startsWith(EMBEDDING_MODEL_OLLAMA + ':'));
        if (found) {
            console.log(`[Ollama] ✅ Embed model "${EMBEDDING_MODEL_OLLAMA}" disponibile sul locale`);
        } else {
            console.warn(`[Ollama] 🔴 Embed model "${EMBEDDING_MODEL_OLLAMA}" NON trovato sul locale! RAG non funzionerà.`);
            console.warn(`[Ollama]    Modelli disponibili: ${models.join(', ') || '(nessuno)'}`);
        }
    } catch {
        console.warn(`[Ollama] ⚠️ Locale non raggiungibile (${localUrl}) — embed RAG non funzionerà`);
    }
}
checkLocalEmbedModel();
