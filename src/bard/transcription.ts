/**
 * Bard Transcription - Text correction and cleaning
 */

import { AIResponse } from './types';
import {
    getTranscriptionClient,
    concurrencyFor
} from './config';
import { withRetry, processInBatches } from './helpers';
import { monitor } from '../monitor';
import { generateText } from './llm/generate';
import { filterWhisperHallucinations } from '../utils/filters/whisper';
import { Locale, aiLanguageName } from '../i18n';

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
 * AI correction of raw text. `locale` is the transcript's language:
 * the correction has to happen in the same language as the speech.
 */
export async function correctTextOnly(segments: any[], locale: Locale = 'it'): Promise<any[]> {
    const BATCH_SIZE = 20;
    const allBatches: any[][] = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        allBatches.push(segments.slice(i, i + BATCH_SIZE));
    }

    const results = await processInBatches(
        allBatches,
        concurrencyFor('transcription'),
        async (batch, idx) => {
            const prompt = `Fix spelling and punctuation. The text is in ${aiLanguageName(locale)}: correct it and answer in that same language.
- Remove filler words (uh, um).
- IF A LINE CONTAINS ONLY meaningless boilerplate or nonsense phrases (common speech-to-text hallucinations): write "..." (three dots).
- Do NOT add comments.
- IMPORTANT: Return EXACTLY ${batch.length} lines, one per line.
- Do NOT merge or split sentences.

TEXT TO FIX (${batch.length} lines):
${batch.map((s, i) => `${i + 1}. ${cleanText(s.text)}`).join('\n')}`;

            const startAI = Date.now();
            try {
                const route = await getTranscriptionClient();
                const ai = await withRetry(() => generateText({
                    route,
                    label: 'transcription',
                    system: "Concise spelling corrector.",
                    prompt
                }));

                const rawOutput = ai.content;
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
