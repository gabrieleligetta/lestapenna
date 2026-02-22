/**
 * Bard Config - AI providers, models, clients, and constants
 */

import OpenAI from 'openai';
import { config } from '../config';

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Crea un client OpenAI. Se il provider è 'ollama', tenta dinamicamente
 * di collegarsi (prima al baseUrl remoto configurato, poi a quello locale fallback).
 * Se entrambi falliscono, commuta in automatico su 'openai' per garantire la resilienza.
 *
 * NOTA: Se la variabile d'ambiente imposta esplicitamente 'openai', 
 * NON farà mai fallback su Ollama (OpenAI è forzato).
 */

async function checkOllamaAlive(baseUrl: string): Promise<boolean> {
    try {
        // Il baseUrl contiene "/v1" (es. http://host.docker.internal:11434/v1)
        // ma l'endpoint di health check di Ollama è nativo su /api/tags (senza /v1).
        // Rimuoviamo il suffisso /v1 per pingare l'API nativa.
        const nativeUrl = baseUrl.replace(/\/v1\/?$/, '');

        // Usa un timeout molto aggressivo (2s) per fallire rapidamente senza bloccare il bot
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
    configuredProvider: 'ollama' | 'openai',
    configuredModel: string,
    openaiFallbackModel: string
): Promise<{ client: OpenAI, model: string, provider: 'ollama' | 'openai' }> {

    // CASO 1: L'utente ha chiesto esplicitamente OpenAI nell'.env
    // Rispetta la volontà dell'utente senza fare ping inutili.
    if (configuredProvider === 'openai') {
        return {
            client: new OpenAI({
                apiKey: config.ai.openAi.apiKey,
                project: config.ai.openAi.projectId,
                timeout: 1800 * 1000,
            }),
            model: configuredModel,
            provider: 'openai'
        };
    }

    // CASO 2: L'utente ha chiesto Ollama. Tentiamo la connessione.

    // Tenta prima l'URL configurato (che potrebbe essere il Tailscale remoto)
    const primaryUrl = config.ai.ollama.baseUrl;
    const isPrimaryAlive = await checkOllamaAlive(primaryUrl);

    if (isPrimaryAlive) {
        // console.log(`[AI Fallback] 🟢 Ollama Primary Alive: ${primaryUrl}`);
        return {
            client: new OpenAI({
                baseURL: primaryUrl,
                apiKey: 'ollama',
                timeout: 1800 * 1000,
            }),
            model: configuredModel,
            provider: 'ollama'
        };
    }

    // Tenta il fallback locale (il container nel cloud) se il primary fallisce
    const localFallbackUrl = 'http://host.docker.internal:11434/v1'; // Default locale
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
                // Quando cadiamo sul locale cloud, dovremmo usare un modello leggero standard se il primario era un 14B
                model: 'llama3.2', // Fallback model locale sicuro
                provider: 'ollama'
            };
        }
    }

    // CASO 3: Entrambi gli Ollama sono irraggiungibili (PC Casa spento e Container locale assente)
    // Fallback disperato salvavita su OpenAI (gpt-4o-mini).
    console.warn(`[AI Fallback] 🔴 All Ollama nodes DEAD! Falling back to OPENAI (${openaiFallbackModel}).`);
    return {
        client: new OpenAI({
            apiKey: config.ai.openAi.apiKey,
            project: config.ai.openAi.projectId,
            timeout: 1800 * 1000,
        }),
        model: openaiFallbackModel,
        provider: 'openai'
    };
}

// ============================================
// PROVIDER CONFIGURATION (Granular Constants from ENV)
// ============================================

export const TRANSCRIPTION_PROVIDER = config.ai.phases.transcription.provider;
export const METADATA_PROVIDER = config.ai.phases.metadata.provider;
export const MAP_PROVIDER = config.ai.phases.map.provider;
export const SUMMARY_PROVIDER = config.ai.phases.summary.provider;
export const ANALYST_PROVIDER = config.ai.phases.analyst.provider;
export const CHAT_PROVIDER = config.ai.phases.chat.provider;
export const EMBEDDING_PROVIDER = config.ai.embeddingProvider;
export const NARRATIVE_FILTER_PROVIDER = config.ai.phases.narrativeFilter.provider;

// ============================================
// MODEL CONFIGURATION (Granular Constants from ENV)
// ============================================

export const TRANSCRIPTION_MODEL = TRANSCRIPTION_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.transcription.model;
export const METADATA_MODEL = METADATA_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.metadata.model;
export const MAP_MODEL = MAP_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.map.model;
export const SUMMARY_MODEL = SUMMARY_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.summary.model;
export const ANALYST_MODEL = ANALYST_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.analyst.model;
export const CHAT_MODEL = CHAT_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.chat.model;
export const NARRATIVE_FILTER_MODEL = NARRATIVE_FILTER_PROVIDER === 'ollama' ? config.ai.ollama.model : config.ai.phases.narrativeFilter.model;

export const EMBEDDING_MODEL_OPENAI = 'text-embedding-3-small';
export const EMBEDDING_MODEL_OLLAMA = 'nomic-embed-text';

// ============================================
// DYNAMIC CLIENT GETTERS
// Invece di costanti sincrone (es. export const chatClient = ...), 
// esportiamo funzioni che risolvono dinamicamente il provider e il client sano.
// ============================================

export const getTranscriptionClient = () => getDynamicProvider(TRANSCRIPTION_PROVIDER, TRANSCRIPTION_MODEL, config.ai.openAi.fallbackModel || 'gpt-4o-mini');
export const getMetadataClient = () => getDynamicProvider(METADATA_PROVIDER, METADATA_MODEL, config.ai.openAi.fallbackModel || 'gpt-4o-mini');
export const getMapClient = () => getDynamicProvider(MAP_PROVIDER, MAP_MODEL, config.ai.openAi.fallbackModel || 'gpt-4o-mini');
export const getSummaryClient = () => getDynamicProvider(SUMMARY_PROVIDER, SUMMARY_MODEL, config.ai.openAi.fallbackModel || 'gpt-4o-mini');
export const getAnalystClient = () => getDynamicProvider(ANALYST_PROVIDER, ANALYST_MODEL, config.ai.openAi.fallbackModel || 'gpt-4o-mini');
export const getChatClient = () => getDynamicProvider(CHAT_PROVIDER, CHAT_MODEL, config.ai.openAi.fallbackModel || 'gpt-4o-mini');
export const getNarrativeFilterClient = () => getDynamicProvider(NARRATIVE_FILTER_PROVIDER, NARRATIVE_FILTER_MODEL, config.ai.openAi.fallbackModel || 'gpt-4o-mini');

// I client di embedding sono generalmente gestiti separatamente perché usano dimensioni diverse, 
// ma li dichiariamo statici per semplicità poichè il RAG ne ha bisogno.
// (In una V2 andrebbero dinamicizzati anche loro, ma l'embedding Ollama è leggero).

export const openaiEmbedClient = new OpenAI({
    apiKey: config.ai.openAi.apiKey,
    project: config.ai.openAi.projectId
});

export const ollamaEmbedClient = new OpenAI({
    baseURL: config.ai.ollama.baseUrl,
    apiKey: 'ollama'
});

// ============================================
// CONCURRENCY LIMITS
// ============================================

export const TRANSCRIPTION_CONCURRENCY = TRANSCRIPTION_PROVIDER === 'ollama' ? 1 : 5;
export const MAP_CONCURRENCY = MAP_PROVIDER === 'ollama' ? 1 : 5;
export const EMBEDDING_BATCH_SIZE = EMBEDDING_PROVIDER === 'ollama' ? 1 : 5;
export const NARRATIVE_BATCH_SIZE = config.features.narrativeBatchSize;


// ============================================
// CHUNK SIZE (Dynamic based on MAP_PROVIDER)
// ============================================

export const MAX_CHUNK_SIZE = MAP_PROVIDER === 'ollama' ? 15000 : 800000;
export const CHUNK_OVERLAP = MAP_PROVIDER === 'ollama' ? 1000 : 5000;

// ============================================
// DEBUG LOG (Startup)
// ============================================

console.log('\n🎭 BARDO AI - CONFIG GRANULARE');
console.log(`Correzione:  ${TRANSCRIPTION_PROVIDER.padEnd(8)} → ${TRANSCRIPTION_MODEL.padEnd(20)}`);
console.log(`Metadati:    ${METADATA_PROVIDER.padEnd(8)} → ${METADATA_MODEL.padEnd(20)}`);
console.log(`Map:         ${MAP_PROVIDER.padEnd(8)} → ${MAP_MODEL.padEnd(20)}`);
console.log(`Analyst:     ${ANALYST_PROVIDER.padEnd(8)} → ${ANALYST_MODEL.padEnd(20)} (estrazione dati)`);
console.log(`Summary:     ${SUMMARY_PROVIDER.padEnd(8)} → ${SUMMARY_MODEL.padEnd(20)} (narrazione)`);
console.log(`Chat/RAG:    ${CHAT_PROVIDER.padEnd(8)} → ${CHAT_MODEL.padEnd(20)}`);
console.log(`NarrFilter:  ${NARRATIVE_FILTER_PROVIDER.padEnd(8)} → ${NARRATIVE_FILTER_MODEL.padEnd(20)} (batch: ${NARRATIVE_BATCH_SIZE})`);
console.log(`Embeddings:  DOPPIO      → OpenAI (${EMBEDDING_MODEL_OPENAI}) + Ollama (${EMBEDDING_MODEL_OLLAMA})`);
