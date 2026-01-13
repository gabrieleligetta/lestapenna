/**
 * Narrative Filter - Normalizza trascrizioni per RAG
 *
 * Elimina metagaming, preserva semantica, risolve referenze.
 * Trasforma dialoghi in narrazione pulita per query semantiche.
 */

import {
    narrativeFilterClient,
    NARRATIVE_FILTER_MODEL,
    NARRATIVE_FILTER_PROVIDER,
    NARRATIVE_BATCH_SIZE
} from './bard';
import { monitor } from './monitor';
import { ProcessedSegment } from './transcriptUtils';

export interface NarrativeSegment {
    speaker: string;
    text: string;
    timestamp: number;
    isNarrative: boolean;
}

interface FilterDecision {
    index: number;
    action: 'keep' | 'translate' | 'skip';
    text?: string;
    reason?: string;
}

/**
 * Normalizza trascrizioni corrette in forma narrativa per RAG.
 * Elimina metagaming, preserva semantica, risolve referenze.
 */
export async function normalizeToNarrative(
    segments: ProcessedSegment[],
    campaignId?: number
): Promise<NarrativeSegment[]> {

    const results: NarrativeSegment[] = [];
    const totalBatches = Math.ceil(segments.length / NARRATIVE_BATCH_SIZE);

    console.log(`[NarrativeFilter] Inizio normalizzazione di ${segments.length} segmenti (batch: ${NARRATIVE_BATCH_SIZE})`);

    for (let i = 0; i < segments.length; i += NARRATIVE_BATCH_SIZE) {
        const batch = segments.slice(i, i + NARRATIVE_BATCH_SIZE);
        const batchNum = Math.floor(i / NARRATIVE_BATCH_SIZE) + 1;

        const prompt = buildNarrativePrompt(batch, i);

        const startAI = Date.now();
        try {
            const response = await narrativeFilterClient.chat.completions.create({
                model: NARRATIVE_FILTER_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "Sei un editor narrativo per trascrizioni D&D destinate a sistemi RAG. Rispondi SOLO con JSON valido."
                    },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" },
            });

            const latency = Date.now() - startAI;
            const inputTokens = response.usage?.prompt_tokens || 0;
            const outputTokens = response.usage?.completion_tokens || 0;
            const cachedTokens = (response.usage as any)?.prompt_tokens_details?.cached_tokens || 0;

            monitor.logAIRequestWithCost(
                'narrative_filter',
                NARRATIVE_FILTER_PROVIDER,
                NARRATIVE_FILTER_MODEL,
                inputTokens,
                outputTokens,
                cachedTokens,
                latency,
                false
            );

            const parsed = JSON.parse(response.choices[0].message.content || "{}");
            const decisions: FilterDecision[] = parsed.decisions || [];

            for (let j = 0; j < batch.length; j++) {
                const decision = decisions.find(d => d.index === j) || { action: 'keep' as const };
                const segment = batch[j];

                if (decision.action === 'skip') {
                    continue;
                } else if (decision.action === 'translate') {
                    results.push({
                        speaker: segment.character,
                        text: decision.text || segment.text,
                        timestamp: segment.absoluteTime,
                        isNarrative: true
                    });
                } else {
                    results.push({
                        speaker: segment.character,
                        text: segment.text,
                        timestamp: segment.absoluteTime,
                        isNarrative: false
                    });
                }
            }

            console.log(`[NarrativeFilter] Batch ${batchNum}/${totalBatches} completato (${latency}ms)`);

        } catch (e: any) {
            console.error(`[NarrativeFilter] Errore batch ${batchNum}:`, e.message);
            monitor.logAIRequestWithCost(
                'narrative_filter',
                NARRATIVE_FILTER_PROVIDER,
                NARRATIVE_FILTER_MODEL,
                0, 0, 0,
                Date.now() - startAI,
                true
            );

            // Fallback: mantieni invariato
            results.push(...batch.map(s => ({
                speaker: s.character,
                text: s.text,
                timestamp: s.absoluteTime,
                isNarrative: false
            })));
        }
    }

    const narrativeCount = results.filter(r => r.isNarrative).length;
    const skippedCount = segments.length - results.length;

    console.log(`[NarrativeFilter] Completato: ${results.length}/${segments.length} segmenti (tradotti: ${narrativeCount}, saltati: ${skippedCount})`);

    return results;
}

function buildNarrativePrompt(
    batch: ProcessedSegment[],
    startIndex: number
): string {
    const batchText = batch.map((s, idx) => `${idx}. [${s.character}] ${s.text}`).join('\n');

    return `Sei un editor narrativo per trascrizioni D&D destinate a sistemi RAG.

**OBIETTIVO**: Trasforma in narrazione pulita mantenendo TUTTI i riferimenti semantici.

**REGOLE**:

1. **ELIMINA** (action: "skip"):
   - Problemi tecnici ("audio tagliato", "non sento", "mic")
   - Riferimenti Discord/software ("aspetta che mi connetto")
   - Pause pure ("ehm", "[SILENZIO]", "...")
   - Commenti fuori personaggio sul gioco ("tiro dado", "bonus +3")

2. **TRADUCI in terza persona** (action: "translate"):
   - "Mi riprendo l'anello" -> "Viktor recupera l'Anello di Spell Storing"
   - "Chi ha la spilla?" -> "Il gruppo discute sulla custodia della Spilla della Luna"
   - "Vado a parlare con lui" -> "Kira si avvicina al mercante per interrogarlo"

3. **PRESERVA semanticamente** (action: "keep" o "translate"):
   - Possesso oggetti: "la spilla e in mano a Viktor" DEVE risultare chiaro
   - Decisioni tattiche, stati del mondo, dialoghi rilevanti
   - Informazioni su PNG, luoghi, eventi

4. **NORMALIZZA referenze**:
   - "Ce l'hai tu" -> Nome esplicito se chiaro dal contesto
   - Pronomi vaghi -> Nomi propri quando possibile

**INPUT** (${batch.length} segmenti):
${batchText}

**OUTPUT JSON**:
{
  "decisions": [
    {"index": 0, "action": "keep"},
    {"index": 1, "action": "translate", "text": "Viktor recupera l'anello magico"},
    {"index": 2, "action": "skip"}
  ]
}

Rispondi SOLO con JSON valido. Per "keep" non serve il campo "text".`;
}

/**
 * Formatta i segmenti narrativi in testo leggibile per RAG
 */
export function formatNarrativeTranscript(segments: NarrativeSegment[]): string {
    return segments.map(s => `[${s.speaker}] ${s.text}`).join('\n\n');
}
