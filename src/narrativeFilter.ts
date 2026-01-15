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
    action: 'keep' | 'narrate' | 'translate' | 'skip'; // narrate = prosa ricca, translate = legacy
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
                } else if (decision.action === 'narrate' || decision.action === 'translate') {
                    // "narrate" = nuova azione per prosa ricca
                    // "translate" = legacy, trattato come narrate
                    results.push({
                        speaker: segment.character,
                        text: decision.text || segment.text,
                        timestamp: segment.absoluteTime,
                        isNarrative: true
                    });
                } else {
                    // "keep" = mantieni originale
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
 *
 * OBIETTIVO: Produrre una TRASPOSIZIONE ROMANZESCA RICCA, non un riassunto!
 */
function buildNarrativePromptWithContext(
    contextSegments: ProcessedSegment[],
    newSegments: ProcessedSegment[],
    globalStartIndex: number
): string {
    // Contesto precedente (per risolvere pronomi)
    let contextText = "";
    if (contextSegments.length > 0) {
        contextText = `**CONTESTO PRECEDENTE** (già processato, usa per risolvere pronomi e continuità):
${contextSegments.map((s, idx) => `[CTX-${idx}] [${s.character}] ${s.text}`).join('\n')}

---

`;
    }

    // Segmenti da processare
    const batchText = newSegments.map((s, idx) => `${idx}. [${s.character}] ${s.text}`).join('\n');

    return `Sei uno SCRITTORE FANTASY che traspone sessioni D&D in prosa romanzesca.

**OBIETTIVO FONDAMENTALE**: Crea una TRASPOSIZIONE NARRATIVA RICCA E DETTAGLIATA.
NON stai riassumendo. Stai SCRIVENDO UN ROMANZO basato su questi dialoghi.
L'output deve essere LUNGO e RICCO quanto l'input (o più!).

${contextText}**AZIONI POSSIBILI**:

1. **"skip"** - USA RARAMENTE! Solo per:
   - Problemi tecnici puri ("audio tagliato", "non sento", "mic rotto")
   - Riferimenti Discord/software ("aspetta che mi connetto", "sei mutato")
   - Pause vuote pure ("[SILENZIO]", "...", "ehm" isolati)

2. **"narrate"** - USA PER LA MAGGIOR PARTE! Trasforma in prosa ricca:

   DIALOGHI → Mantienili come dialoghi con contesto emotivo:
   Input: "Non mi fido di lui"
   Output: "«Non mi fido di lui» disse Kira, gli occhi ridotti a fessure mentre osservava il mercante."

   AZIONI → Descrizioni immersive:
   Input: "Vado a controllare la porta"
   Output: "Viktor si avvicinò alla porta con cautela, le dita che sfioravano l'elsa della spada. Ogni suo passo era misurato, silenzioso come quello di un predatore."

   MECCANICHE DI GIOCO → Trasponi in narrazione se rilevanti:
   Input: "Faccio un tiro percezione... 18!"
   Output: "I sensi affinati di Kira colsero ciò che altri avrebbero ignorato. Notò le impronte fresche sul pavimento polveroso, il lieve bagliore di una runa nascosta."

   EMOZIONI/REAZIONI → Espandi con introspezione:
   Input: "Cazzo, è morto!"
   Output: "Il colpo fu letale. Viktor fissò il corpo che si accasciava, un misto di sollievo e inquietudine nel petto. Un altro nemico abbattuto, ma a quale costo?"

3. **"keep"** - Solo se il testo è già perfetto così com'è (raro)

**REGOLE CRITICHE**:
- L'OUTPUT DEVE ESSERE RICCO! Non frasi telegrafiche.
- Mantieni TUTTI i dettagli: nomi, oggetti, luoghi, decisioni.
- I dialoghi restano dialoghi (con «» all'italiana), ma aggiungi azione/emozione.
- Risolvi pronomi vaghi usando il contesto: "lui" → nome proprio.
- Il metagaming PURO va eliminato, ma se contiene info rilevanti (es. "ho 3 HP") → trasponi ("Viktor barcollò, sentendo le forze abbandonarlo").

**INPUT DA TRASPORRE** (${newSegments.length} segmenti):
${batchText}

**OUTPUT JSON**:
{
  "decisions": [
    {"index": 0, "action": "narrate", "text": "«Non possiamo fidarci di lui» mormorò Kira, lanciando un'occhiata diffidente verso il mercante."},
    {"index": 1, "action": "narrate", "text": "Viktor si fece avanti, la mano che andava istintivamente all'elsa della spada. «Lascia parlare me» disse, la voce bassa ma ferma."},
    {"index": 2, "action": "skip"}
  ]
}

IMPORTANTE:
- Per "narrate": il campo "text" è OBBLIGATORIO e deve essere RICCO.
- Per "keep": nessun campo "text" necessario.
- Per "skip": nessun campo "text" necessario.
- Processa SOLO gli indici numerati (0, 1, 2...), NON quelli CTX-*.`;
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
