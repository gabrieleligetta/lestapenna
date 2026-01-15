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

// Sliding Window: overlap con batch precedente per mantenere coerenza
const NARRATIVE_OVERLAP = parseInt(process.env.NARRATIVE_OVERLAP || '20', 10);

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
 *
 * Usa sliding window con overlap per mantenere coerenza tra batch.
 */
export async function normalizeToNarrative(
    segments: ProcessedSegment[],
    campaignId?: number
): Promise<NarrativeSegment[]> {

    const results: NarrativeSegment[] = [];

    // Calcola numero batch con sliding window
    const effectiveBatchSize = NARRATIVE_BATCH_SIZE - NARRATIVE_OVERLAP;
    const totalBatches = Math.ceil(segments.length / effectiveBatchSize);

    console.log(`[NarrativeFilter] Inizio normalizzazione di ${segments.length} segmenti (batch: ${NARRATIVE_BATCH_SIZE}, overlap: ${NARRATIVE_OVERLAP})`);

    let processedUpTo = 0; // Tiene traccia di quanti segmenti abbiamo già processato

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
        // Calcola indici per sliding window
        const batchStart = batchNum * effectiveBatchSize;
        const contextStart = Math.max(0, batchStart - NARRATIVE_OVERLAP);
        const batchEnd = Math.min(segments.length, batchStart + NARRATIVE_BATCH_SIZE);

        // Segmenti di contesto (già processati, solo per riferimento)
        const contextSegments = segments.slice(contextStart, batchStart);
        // Segmenti da processare in questo batch
        const newSegments = segments.slice(batchStart, batchEnd);

        if (newSegments.length === 0) break;

        const prompt = buildNarrativePromptWithContext(contextSegments, newSegments, batchStart);

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

            // Processa SOLO i nuovi segmenti (ignora contesto)
            for (let j = 0; j < newSegments.length; j++) {
                const decision = decisions.find(d => d.index === j) || { action: 'keep' as const };
                const segment = newSegments[j];

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

            processedUpTo = batchEnd;
            console.log(`[NarrativeFilter] Batch ${batchNum + 1}/${totalBatches} completato (${latency}ms) - ctx: ${contextSegments.length}, new: ${newSegments.length}`);

        } catch (e: any) {
            console.error(`[NarrativeFilter] Errore batch ${batchNum + 1}:`, e.message);
            monitor.logAIRequestWithCost(
                'narrative_filter',
                NARRATIVE_FILTER_PROVIDER,
                NARRATIVE_FILTER_MODEL,
                0, 0, 0,
                Date.now() - startAI,
                true
            );

            // Fallback: mantieni invariato i nuovi segmenti
            results.push(...newSegments.map(s => ({
                speaker: s.character,
                text: s.text,
                timestamp: s.absoluteTime,
                isNarrative: false
            })));
            processedUpTo = batchEnd;
        }
    }

    const narrativeCount = results.filter(r => r.isNarrative).length;
    const skippedCount = segments.length - results.length;

    console.log(`[NarrativeFilter] Completato: ${results.length}/${segments.length} segmenti (tradotti: ${narrativeCount}, saltati: ${skippedCount})`);

    return results;
}

/**
 * Costruisce il prompt con contesto dalla sliding window.
 * I segmenti di contesto sono mostrati per riferimento ma NON devono essere processati.
 */
function buildNarrativePromptWithContext(
    contextSegments: ProcessedSegment[],
    newSegments: ProcessedSegment[],
    globalStartIndex: number
): string {
    // Contesto precedente (per risolvere pronomi)
    let contextText = "";
    if (contextSegments.length > 0) {
        contextText = `**CONTESTO PRECEDENTE** (già processato, usa per risolvere pronomi):
${contextSegments.map((s, idx) => `[CTX-${idx}] [${s.character}] ${s.text}`).join('\n')}

---

`;
    }

    // Segmenti da processare
    const batchText = newSegments.map((s, idx) => `${idx}. [${s.character}] ${s.text}`).join('\n');

    return `Sei un editor narrativo per trascrizioni D&D destinate a sistemi RAG.

**OBIETTIVO**: Trasforma in narrazione pulita mantenendo TUTTI i riferimenti semantici.

${contextText}**REGOLE**:

1. **ELIMINA** (action: "skip"):
   - Problemi tecnici ("audio tagliato", "non sento", "mic")
   - Riferimenti Discord/software ("aspetta che mi connetto")
   - Pause pure ("ehm", "[SILENZIO]", "...")
   - Commenti fuori personaggio sul gioco ("tiro dado", "bonus +3")

2. **TRADUCI in terza persona** (action: "translate"):
   - "Mi riprendo l'anello" -> "Viktor recupera l'Anello di Spell Storing"
   - "Chi ha la spilla?" -> "Il gruppo discute sulla custodia della Spilla della Luna"
   - "Vado a parlare con lui" -> "Kira si avvicina al mercante per interrogarlo"
   - USA IL CONTESTO PRECEDENTE per risolvere pronomi come "lui", "lei", "quello"

3. **PRESERVA semanticamente** (action: "keep" o "translate"):
   - Possesso oggetti: "la spilla e in mano a Viktor" DEVE risultare chiaro
   - Decisioni tattiche, stati del mondo, dialoghi rilevanti
   - Informazioni su PNG, luoghi, eventi

4. **NORMALIZZA referenze**:
   - "Ce l'hai tu" -> Nome esplicito se chiaro dal contesto
   - Pronomi vaghi -> Nomi propri quando possibile (USA IL CONTESTO!)

**INPUT DA PROCESSARE** (${newSegments.length} segmenti):
${batchText}

**OUTPUT JSON** (SOLO per gli indici 0-${newSegments.length - 1}, NON per CTX-*):
{
  "decisions": [
    {"index": 0, "action": "keep"},
    {"index": 1, "action": "translate", "text": "Viktor recupera l'anello magico"},
    {"index": 2, "action": "skip"}
  ]
}

Rispondi SOLO con JSON valido. Per "keep" non serve il campo "text".
IMPORTANTE: Processa SOLO i segmenti numerati (0, 1, 2...), NON quelli CTX-*.`;
}

// Legacy function (non più usata, mantenuta per compatibilità)
function buildNarrativePrompt(
    batch: ProcessedSegment[],
    startIndex: number
): string {
    return buildNarrativePromptWithContext([], batch, startIndex);
}

/**
 * Formatta i segmenti narrativi in testo leggibile per RAG
 */
export function formatNarrativeTranscript(segments: NarrativeSegment[]): string {
    return segments.map(s => `[${s.speaker}] ${s.text}`).join('\n\n');
}
