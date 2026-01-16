/**
 * @deprecated Questo modulo non è più utilizzato nella pipeline principale.
 * La logica di filtro narrativo è stata sostituita da una pulizia regex leggera in `bard.ts` (correctTranscription)
 * e dall'estrazione contestuale in `generateSummary`.
 *
 * Mantenuto solo per riferimento storico o eventuale ripristino futuro.
 */

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
 * Pre-processa i segmenti per consolidare frasi frammentate dello stesso speaker
 * (elimina rumore da interruzioni audio/latenza Discord)
 */
function consolidateFragments(segments: ProcessedSegment[]): ProcessedSegment[] {
    const consolidated: ProcessedSegment[] = [];

    for (let i = 0; i < segments.length; i++) {
        let current = segments[i];
        
        // Loop per unire frammenti multipli consecutivi
        while (i + 1 < segments.length) {
            const next = segments[i + 1];
            
            // Consolida se: stesso speaker, timestamp <3 secondi, testo breve (<50 char)
            if (current.character === next.character &&
                (next.absoluteTime - current.absoluteTime) < 3000 &&
                current.text.length < 50) {
                
                current = {
                    ...current,
                    text: `${current.text} ${next.text}`.trim()
                };
                i++; // Salta il prossimo segmento perché è stato unito
            } else {
                break; // Interrompi se non soddisfa i criteri
            }
        }
        
        consolidated.push(current);
    }
    
    return consolidated;
}

/**
 * @deprecated Funzione non più utilizzata. Vedi `correctTranscription` in `bard.ts`.
 *
 * Normalizza trascrizioni corrette in forma narrativa per RAG.
 * Elimina metagaming, preserva semantica, risolve referenze.
 *
 * Usa sliding window con overlap per mantenere coerenza tra batch.
 */
export async function normalizeToNarrative(
    segments: ProcessedSegment[],
    campaignId?: number
): Promise<NarrativeSegment[]> {

    // Pre-processing: consolida frammenti
    const consolidatedSegments = consolidateFragments(segments);
    
    const results: NarrativeSegment[] = [];

    // Calcola numero batch con sliding window
    const effectiveBatchSize = NARRATIVE_BATCH_SIZE - NARRATIVE_OVERLAP;
    const totalBatches = Math.ceil(consolidatedSegments.length / effectiveBatchSize);

    console.log(`[NarrativeFilter] Inizio normalizzazione: ${segments.length} → ${consolidatedSegments.length} segmenti (consolidati: ${segments.length - consolidatedSegments.length})`);

    let processedUpTo = 0; // Tiene traccia di quanti segmenti abbiamo già processato

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
        // Calcola indici per sliding window
        const batchStart = batchNum * effectiveBatchSize;
        const contextStart = Math.max(0, batchStart - NARRATIVE_OVERLAP);
        const batchEnd = Math.min(consolidatedSegments.length, batchStart + NARRATIVE_BATCH_SIZE);

        // Segmenti di contesto (già processati, solo per riferimento)
        const contextSegments = consolidatedSegments.slice(contextStart, batchStart);
        // Segmenti da processare in questo batch
        const newSegments = consolidatedSegments.slice(batchStart, batchEnd);

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

            // VALIDAZIONE JSON AGGIUNTIVA
            if (!parsed.decisions || !Array.isArray(parsed.decisions)) {
                console.warn(`[NarrativeFilter] Batch ${batchNum + 1}: JSON malformato o chiave 'decisions' mancante.`);
                throw new Error('Invalid JSON structure: decisions array missing');
            }

            const decisions: FilterDecision[] = parsed.decisions;

            // Valida contenuto decisioni
            for (const decision of decisions) {
                // Check indice fuori range
                if (typeof decision.index !== 'number' || decision.index < 0 || decision.index >= newSegments.length) {
                    console.warn(`[NarrativeFilter] Batch ${batchNum + 1}: Indice ${decision.index} fuori range (max: ${newSegments.length - 1})`);
                    continue;
                }

                // Check presenza testo per narrate
                if ((decision.action === 'narrate' || decision.action === 'translate') && (!decision.text || decision.text.trim() === '')) {
                    console.warn(`[NarrativeFilter] Batch ${batchNum + 1}: Decisione ${decision.index} manca "text" field, uso fallback 'keep'`);
                    decision.action = 'keep';
                }
            }

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
    const skippedCount = consolidatedSegments.length - results.length;

    console.log(`[NarrativeFilter] Completato: ${results.length}/${consolidatedSegments.length} segmenti (tradotti: ${narrativeCount}, saltati: ${skippedCount})`);

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

**VINCOLI ASSOLUTI - NON VIOLARE MAI:**
1. **ZERO INVENZIONI**: Non aggiungere dettagli non presenti nell'input (esiti azioni, oggetti, motivazioni non dichiarate)
2. **PRESERVA AMBIGUITÀ**: Se l'input non specifica l'esito ("cerco trappole"), scrivi solo il tentativo, non il risultato
3. **METAGAMING = SKIP**: Tiri dadi, riferimenti meccaniche pure, calcoli HP → sempre skip (salvo se contengono narrazione)
4. **COERENZA CON CONTESTO**: Usa i segmenti CTX- per risolvere pronomi e mantenere continuità stilistica

**LISTA NERA - FRASI VIETATE** (causano "AI slop"):
❌ "un brivido corse lungo la schiena"
❌ "un sorriso che non raggiungeva gli occhi"
❌ "il cuore batteva nel petto"
❌ "la tensione era palpabile nell'aria"
❌ "aggrottò la fronte"
❌ "sospirò pesantemente"
❌ "con occhi socchiusi"

Invece: Descrivi azioni fisiche specifiche e osservabili.
✅ "Le dita gli si strinsero sull'elsa della spada"
✅ "La mascella si contrasse. Una vena pulsava sulla tempia"

**OBIETTIVO FONDAMENTALE**: Crea una TRASPOSIZIONE NARRATIVA RICCA E DETTAGLIATA.
NON stai riassumendo. Stai SCRIVENDO UN ROMANZO basato su questi dialoghi.
L'output deve essere LUNGO e RICCO quanto l'input (o più!).

**GESTIONE SPEAKER**:

**DM**: Descrizioni ambientali e NPC → Mantieni prosa in terza persona
  Input: "[DM] Vedete una stanza con pilastri di marmo"
  Output: "La stanza si apriva davanti a loro, sostenuta da pilastri di marmo bianco."

**NPC attraverso DM**: Dialoghi diretti NPC → Usa virgolette con attribuzione
  Input: "[DM] La mano di Ogma dice: 'Dovete fermare la corruzione'"
  Output: "La Mano di Ogma parlò, la voce solenne: «Dovete fermare la corruzione»."
  Input: "[DM] Un cittadino si avvicina scortato da un pari"
  Output: "Un cittadino si avvicinò, scortato da uno degli angeli pari."
  **REGOLA**: Se DM riporta dialogo NPC, mantieni virgolette + attribuzione al PNG.

**Giocatori**: Azioni e dialoghi → Trasforma in narrazione con nome PG
  Input: "[Viktor] Mi avvicino cauto alla porta"
  Output: "Viktor si avvicinò alla porta con cautela."

**Distinzione**: Se speaker != "DM", è un personaggio giocante (usa sempre il nome).

**TEMPO VERBALE**:
- Usa SEMPRE passato remoto per azioni concluse ("Viktor colpì", "Kira disse")
- Usa imperfetto per stati/descrizioni ("La stanza era buia", "L'arcimago tremava")
- NON mescolare presente storico con passato (incoerente)
- Se CTX- usa passato remoto, continua con passato remoto

${contextText}**AZIONI POSSIBILI**:

1. **"skip"** - USA RARAMENTE! Solo per:
   - Problemi tecnici puri ("audio tagliato", "non sento", "mic rotto")
   - Riferimenti Discord/software ("aspetta che mi connetto", "sei mutato")
   - Pause vuote pure ("[SILENZIO]", "...", "ehm" isolati)
   - Metagaming puro (numeri, calcoli) senza narrazione associata.

2. **"narrate"** - USA PER LA MAGGIOR PARTE! Trasforma in prosa ricca:

   DIALOGHI → Mantienili integrali + contesto osservabile:
     Input: "Non mi fido di lui"
     ✅ CORRETTO: "«Non mi fido di lui» disse Kira, incrociando le braccia."
     ❌ SBAGLIATO: "«Non mi fido di lui» disse Kira, ricordando il tradimento subito." [INVENTA MOTIVAZIONE]

   AZIONI CON ESITO → Trascrivi solo ciò che viene dichiarato:
     Input: "Apro la porta e vedo una stanza vuota"
     ✅ CORRETTO: "Viktor aprì la porta. La stanza al di là era vuota, spoglia."
     ❌ SBAGLIATO: "Viktor aprì la porta, sollevato di non trovare nemici." [INVENTA EMOZIONE]

   **ESPANSIONE DEL RITMO** (Una linea di gioco → Paragrafo ricco):
     Input breve DM: "Entrate. C'è un tavolo rotto e tracce di sangue"
     ❌ TELEGRAFICO: "Entrarono. C'era un tavolo rotto e tracce di sangue."
     ✅ ESPANSO: "Varcarono la soglia. L'aria stagnante sapeva di muffa e ferro. Al centro della stanza, un tavolo giaceva rovesciato, le gambe spezzate. Strisce scure di sangue rappreso serpeggiavano sul pavimento di pietra, tracciando una scia verso l'ombra oltre la porta sul fondo."
     **REGOLA**: Se l'input è descrittivo (non solo dialogo), ESPANDI con dettagli sensoriali. Non inventare fatti, ma arricchisci atmosfera con elementi coerenti alla scena.

   **COMBATTIMENTI** - Caso speciale (molto frequente):
     Input: "[Viktor] 29, 10 danni necrotici; poi 24, altri 15 danni"
     ✅ SKIP (solo numeri)
     Input: "[DM] Il mago crolla a terra. L'angelo scompare in una luce divina"
     ✅ NARRATE: "Il mago si accasciò al suolo, esanime. L'angelo celeste svanì in un'esplosione di luce divina che illuminò la stanza."
     Input: "[Viktor] Faccio cinque passi e attacco con il pugno"
     ✅ NARRATE: "Viktor avanzò di qualche metro e scagliò un pugno contro il nemico."
     **REGOLA COMBATTIMENTI**: Tiri e danni → skip. Dichiarazioni d'azione e esiti visibili → narrate espanso.

   MECCANICHE → Skip se puro metagame, traduci se contiene narrazione:
     Input: "Tiro percezione... 18!"
     ✅ SKIP (solo meccanica)
     Input: "Tiro percezione... 18! Noto delle impronte"
     ✅ NARRATE: "I sensi di Kira colsero dettagli che altri avrebbero ignorato: impronte fresche sul pavimento."

3. **"keep"** - Solo se il testo è già perfetto così com'è (raro)

**USO DEL CONTESTO PRECEDENTE:**
- Risolvi pronomi vaghi ("lui" → usa ultimo nome citato in CTX-)
- Mantieni tono narrativo coerente (se CTX- usa passato remoto, continua così)
- NON contraddire eventi già narrati in CTX-
- Se CTX- menziona un PNG, usa lo stesso nome (non sinonimi)

**INPUT DA TRASPORRE** (${newSegments.length} segmenti):
${batchText}

**AUTO-VERIFICA PRIMA DI RISPONDERE:**
Per ogni "narrate", chiediti:
- Ho aggiunto dettagli non presenti nell'input? → ERRORE
- Ho specificato un esito non dichiarato? → ERRORE
- Ho inventato pensieri/motivazioni dei PG? → ERRORE
- Ho usato frasi della LISTA NERA? → ERRORE
- Ho solo riscritto ciò che è stato detto/mostrato? → OK

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
