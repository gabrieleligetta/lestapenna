/**
 * Bard Transcription - Text correction and cleaning
 */

import { AIResponse } from './types';
import {
    getTranscriptionClient,
    TRANSCRIPTION_CONCURRENCY
} from './config';
import { withRetry, processInBatches } from './helpers';
import { monitor } from '../monitor';
import { filterWhisperHallucinations } from '../utils/filters/whisper';

/**
 * Helper: clean text from known hallucinations
 */
function cleanText(text: string): string {
    if (!text) return "";

    const hallucinations = [
        /Autore dei.*/gi,
        /Sottotitoli.*/gi,
        /Amara\.org/gi,
        /creati dalla comunità/gi,
        /A tutti[\.,]?\s*(A tutti[\.,]?\s*)*/gi,
        /A te[\.,]?\s*(A te[\.,]?\s*)*/gi,
        /A voi[\.,]?\s*(A voi[\.,]?\s*)*/gi,
        /^Grazie\.?$/gi,
        /^Mille\.?$/gi,
        /^Ciao\.?$/gi,
        /Concentrazione di Chieti/gi,
        /Noblesse anatema/gi,
        /Salomando/gi
    ];

    let cleaned = text;
    hallucinations.forEach(regex => {
        cleaned = cleaned.replace(regex, "");
    });

    return cleaned
        .replace(/\[SILENZIO\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Correzione testo grezzo con AI
 */
export async function correctTextOnly(segments: any[]): Promise<any[]> {
    const BATCH_SIZE = 20;
    const allBatches: any[][] = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        allBatches.push(segments.slice(i, i + BATCH_SIZE));
    }

    const results = await processInBatches(
        allBatches,
        TRANSCRIPTION_CONCURRENCY,
        async (batch, idx) => {
            const prompt = `Correggi ortografia e punteggiatura in italiano.
- Rimuovi riempitivi (ehm, uhm).
- SE UNA RIGA CONTIENE SOLO "A tutti", "Autore dei", O FRASI SENZA SENSO: Scrivi "..." (tre puntini).
- NON aggiungere commenti.
- IMPORTANTE: Restituisci ESATTAMENTE ${batch.length} righe, una per riga.
- NON unire né dividere frasi.

TESTO DA CORREGGERE (${batch.length} righe):
${batch.map((s, i) => `${i + 1}. ${cleanText(s.text)}`).join('\n')}`;

            const startAI = Date.now();
            try {
                const { client, model, provider } = await getTranscriptionClient();
                const response = await withRetry(() =>
                    client.chat.completions.create({
                        model: model,
                        messages: [
                            { role: "system", content: "Correttore ortografico conciso." },
                            { role: "user", content: prompt }
                        ]
                    })
                );

                const latency = Date.now() - startAI;
                const inputTokens = response.usage?.prompt_tokens || 0;
                const outputTokens = response.usage?.completion_tokens || 0;
                const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

                monitor.logAIRequestWithCost(
                    'transcription',
                    provider,
                    model,
                    inputTokens,
                    outputTokens,
                    cachedTokens,
                    latency,
                    false
                );

                const rawOutput = response.choices[0].message.content || "";
                const lines = rawOutput.split('\n')
                    .map(l => l.replace(/^\d+\.\s*/, '').trim())
                    .filter((l: string) => l.length > 0);

                const tolerance = Math.ceil(batch.length * 0.2);
                const diff = Math.abs(lines.length - batch.length);

                if (lines.length !== batch.length) {
                    if (diff <= tolerance) {
                        console.warn(`[Correzione] ⚠️ Batch ${idx + 1}: Mismatch tollerato (${lines.length}≠${batch.length}, diff: ${diff})`);
                        return batch.map((orig, i) => ({
                            ...orig,
                            text: cleanText(lines[i] || orig.text)
                        }));
                    }

                    console.warn(`[Correzione] ⚠️ Batch ${idx + 1}: Mismatch eccessivo (${lines.length}≠${batch.length}). Uso originale.`);
                    return batch;
                }

                return batch.map((orig, i) => ({
                    ...orig,
                    text: cleanText(lines[i])
                }));

            } catch (err) {
                console.error(`[Correzione] ❌ Errore batch ${idx + 1}:`, err);
                monitor.logAIRequestWithCost('transcription', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
                return batch;
            }
        },
        `Correzione Testo`
    );

    return results.flat();
}

/**
 * Funzione principale: pulizia anti-allucinazioni
 */
export async function correctTranscription(
    segments: any[],
    campaignId?: number
): Promise<AIResponse> {
    console.log(`[Bardo] 🧹 Avvio pulizia anti-allucinazioni (${segments.length} segmenti)...`);

    const cleanedSegments = segments.map(segment => ({
        ...segment,
        text: filterWhisperHallucinations(segment.text || '')
    })).filter(segment => segment.text.length > 0);

    const removedCount = segments.length - cleanedSegments.length;
    if (removedCount > 0) {
        console.log(`[Bardo] 🗑️ Rimossi ${removedCount} segmenti vuoti/allucinazioni`);
    }
    console.log(`[Bardo] ✅ Pulizia completata: ${cleanedSegments.length} segmenti validi`);

    return {
        segments: cleanedSegments
    };
}
