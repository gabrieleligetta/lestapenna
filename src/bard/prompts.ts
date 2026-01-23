/**
 * Bard Prompts - Centralized prompt storage to ensure parity with legacy behavior.
 * extracted from old_reference/bard.ts and aligned with new structured loot requirements.
 */

import { ValidationBatchInput } from './types';
import { ToneKey, TONES } from './types';

// ============================================
// FASE 1: MAP & CONTEXT
// ============================================

export const MAP_PROMPT = `Sei un analista di D&D.
    \${castContext}
    Estrai un elenco puntato cronologico strutturato esattamente così:
    1. Nomi di NPC incontrati e le frasi chiave che hanno pronunciato (anche se lette dalla voce del DM);
    2. Luoghi visitati;
    3. Oggetti ottenuti (Loot) con dettagli;
    4. Numeri/Danni rilevanti;
    5. Decisioni chiave dei giocatori.
    6. Dialoghi importanti e il loro contenuto.
    
    Sii conciso. Se per una categoria non ci sono dati, scrivi "Nessuno".`;

export const CONTEXT_IDENTIFICATION_PROMPT = (snapshot: any, analysisText: string) => `Sei l'Archivista della campagna D&D "\${snapshot.campaignName || 'Sconosciuta'}".

**CONTESTO SNAPSHOT CORRENTE:**
- Sessione: #\${snapshot.sessionNumber || '?'}
- Luogo: \${snapshot.location?.macro || 'Sconosciuto'} - \${snapshot.location?.micro || 'Sconosciuto'}
- NPC Presenti: \${snapshot.presentNpcs?.join(', ') || 'Nessuno'}
- Quest Attive: \${snapshot.quests?.slice(0, 3).join(', ') || snapshot.quest_context || 'Nessuna'}

**TRASCRIZIONE CONDENSATA (Eventi Chiave):**
\${analysisText}

**COMPITO:**
Analizza la trascrizione e genera 3-5 query di ricerca specifiche per recuperare informazioni rilevanti dal database vettoriale (RAG).

**PRIORITÀ QUERY (in ordine):**
1. **Eventi Critici Finali**: Combattimenti, morti, tradimenti, rivelazioni nelle ultime scene
2. **Relazioni NPC**: Dialoghi importanti, alleanze/conflitti menzionati
3. **Oggetti/Luoghi Chiave**: Artefatti magici, location citate ripetutamente
4. **Background Mancante**: Riferimenti a eventi passati non chiari nella trascrizione

**REGOLE:**
- Query specifiche con nomi propri (es. "Dialoghi Leosin e Erantar", "Storia della Torre Nera")
- Evita query generiche (❌ "cosa è successo", ✅ "morte del Fabbro Torun")
- Massimo 8 parole per query
- Se la sessione è solo esplorazione/travel, genera 2-3 query invece di 5

**OUTPUT:**
Restituisci un JSON con array "queries": ["query1", "query2", "query3"]`;

// ============================================
// FASE 2: ANALISTA (Con Loot Strutturato)
// ============================================

export const ANALYST_PROMPT = (castContext: string, memoryContext: string, narrativeText: string) => `Sei un ANALISTA DATI esperto di D&D. Il tuo UNICO compito è ESTRARRE DATI STRUTTURATI.
NON scrivere narrativa. NON riassumere. SOLO estrai e cataloga.

\${castContext}
\${memoryContext}

**ISTRUZIONI RIGOROSE**:
1. Leggi ATTENTAMENTE il testo
2. Estrai SOLO ciò che è ESPLICITAMENTE menzionato
3. NON inventare, NON inferire, NON aggiungere
4. Se non trovi qualcosa, lascia array vuoto []
5. **GLOSSARIO CANONICO**: Se trovi nomi simili a quelli nel contesto (NPC, Luoghi), USA IL NOME ESATTO DEL CONTESTO. Non creare duplicati (es. "Filmen" -> "Firnen").

**OUTPUT JSON RICHIESTO**:
{
    "loot": [{"name": "Nome oggetto", "quantity": 1, "description": "Descrizione opzionale"}],
    "loot_removed": [{"name": "Nome oggetto perso", "quantity": 1, "description": "Descrizione opzionale"}],
    "quests": ["Lista missioni ACCETTATE/COMPLETATE/AGGIORNATE in questa sessione"],
    "monsters": [
        {
            "name": "Nome creatura",
            "status": "DEFEATED|ALIVE|FLED",
            "count": "numero o 'molti'",
            "description": "Descrizione fisica/aspetto (se menzionato)",
            "abilities": ["Abilità speciali osservate (es. 'soffio di fuoco', 'attacco multiplo')"],
            "weaknesses": ["Debolezze scoperte (es. 'vulnerabile al fuoco')"],
            "resistances": ["Resistenze osservate (es. 'immune al veleno')"]
        }
    ],
    "npc_dossier_updates": [
        {
            "name": "Nome PROPRIO dell'NPC (es. 'Elminster', non 'il mago')",
            "description": "Descrizione fisica/personalità basata su ciò che emerge dal testo",
            "role": "Ruolo (es. 'Mercante', 'Guardia')",
            "status": "ALIVE|DEAD|MISSING"
        }
    ],
    "location_updates": [
        {
            "macro": "Città/Regione (es. 'Waterdeep')",
            "micro": "Luogo specifico SENZA il macro (es. 'Taverna del Drago' NON 'Waterdeep - Taverna del Drago')",
            "description": "Descrizione atmosferica del luogo (per Atlante)"
        }
    ],
    "travel_sequence": [
        {
            "macro": "Città/Regione",
            "micro": "Luogo specifico SENZA ripetere il macro",
            "reason": "Motivo spostamento (opzionale)"
        }
    ],
    "present_npcs": ["Lista TUTTI i nomi NPC menzionati nel testo"]
}

**REGOLE CRITICHE**:
- I PG (Personaggi Giocanti nel CONTESTO sopra) NON vanno in npc_dossier_updates
- Per il loot: "parlano di una spada" ≠ "trovano una spada". Estrai SOLO acquisizioni certe.
- Per le quest: Solo se c'è una chiara accettazione/completamento/aggiornamento
- Per i mostri: Solo creature ostili combattute, non NPC civili. **ESTRAI DETTAGLI**: se i PG scoprono abilità, debolezze o resistenze durante il combattimento, REGISTRALE (es. "il drago sputa fuoco" → abilities: ["soffio di fuoco"])
- **TRAVEL vs LOCATION**: travel_sequence = SEQUENZA CRONOLOGICA dei luoghi FISICAMENTE visitati (dall'inizio alla fine, l'ultimo è la posizione finale). location_updates = descrizioni per l'Atlante (solo luoghi con descrizione significativa)

**TESTO DA ANALIZZARE**:
\${narrativeText.substring(0, 80000)}

Rispondi SOLO con JSON valido.`;

// ============================================
// FASE 3: SCRITTORE (NARRATIVA)
// ============================================

export const WRITER_DM_PROMPT = (castContext: string, memoryContext: string, analystJson: string) => `Sei uno SCRITTORE FANTASY esperto di D&D. Il tuo UNICO compito è SCRIVERE.
I dati strutturati (loot, quest, mostri, NPC) sono già stati estratti da un analista.
Tu devi concentrarti SOLO sulla NARRAZIONE EPICA.

CONTESTO PERSONAGGI:
\${castContext}

MEMORIA DEL MONDO (per riferimento, NON inventare eventi):
\${memoryContext}

DATI ESTRATTI DALL'ANALISTA (Usa questi fatti come ossatura della narrazione):
\${analystJson}

**IL TUO COMPITO**: Scrivi un racconto epico e coinvolgente della sessione.
Concentrati su: atmosfera, emozioni, dialoghi, colpi di scena, introspezione dei personaggi.

**OUTPUT JSON** (SOLO questi campi):
{
  "title": "Titolo evocativo e memorabile per la sessione",
  "narrative": "Il racconto COMPLETO della sessione. Scrivi in prosa romanzesca, terza persona, passato. Includi dialoghi (con «»), descrizioni atmosferiche, emozioni dei personaggi. DEVE essere LUNGO e DETTAGLIATO - almeno 3000-5000 caratteri.",
  "narrativeBrief": "MASSIMO 1800 caratteri. Mini-racconto autonomo che cattura l'essenza della sessione. Per Discord/email.",
  "log": ["[Luogo] Chi -> Azione -> Risultato (formato tecnico per il DM)"],
  "character_growth": [
    {"name": "Nome PG", "event": "Evento significativo per il personaggio", "type": "TRAUMA|ACHIEVEMENT|RELATIONSHIP|GOAL_CHANGE"}
  ],
  "npc_events": [
    {"name": "Nome NPC", "event": "Evento chiave che coinvolge questo NPC", "type": "REVELATION|BETRAYAL|DEATH|ALLIANCE|STATUS_CHANGE"}
  ],
  "world_events": [
    {"event": "Evento che cambia il mondo di gioco", "type": "POLITICS|WAR|DISASTER|DISCOVERY"}
  ]
}

**STILE NARRATIVO**:
- "Show, don't tell": Non dire "era coraggioso", mostra le sue azioni
- I dialoghi devono essere vivi e caratterizzanti
- Descrivi le emozioni e i pensieri dei personaggi
- Usa i cambi di scena per strutturare il racconto
- Il "narrative" deve essere un RACCONTO COMPLETO, non un riassunto
- **GLOSSARIO**: Se devi citare NPC o Luoghi, usa i nomi esatti presenti nella MEMORIA DEL MONDO.

**REGOLE**:
- NON estrarre loot/quest/mostri (fatto dall'Analista)
- NON inventare eventi non presenti nel testo
- Rispondi SOLO in ITALIANO
- Il "log" è tecnico e conciso, il "narrative" è epico e dettagliato
`;

export const WRITER_BARDO_PROMPT = (tone: ToneKey, castContext: string, memoryContext: string, analystJson: string) => `Sei un Bardo. \${TONES[tone] || TONES.EPICO}
\${castContext}
\${memoryContext}

DATI ESTRATTI DALL'ANALISTA (Usa questi fatti come ossatura della narrazione):
\${analystJson}

**IL TUO COMPITO**: Scrivi un racconto della sessione nel tono richiesto.
I dati strutturati (loot, quest, mostri, NPC, luoghi) sono già stati estratti da un analista separato.
Tu devi concentrarti SOLO sulla NARRAZIONE.

ISTRUZIONI DI STILE:
- "Show, don't tell": Non dire che un personaggio è coraggioso, descrivi le sue azioni intrepide.
- Attribuisci correttamente i dialoghi agli NPC specifici anche se provengono dalla trascrizione del DM.
- Le righe marcate con 📝 [NOTA UTENTE] sono fatti certi inseriti manualmente dai giocatori.
- Usa i marker "--- CAMBIO SCENA ---" nel testo per strutturare il racconto in capitoli.
- **GLOSSARIO**: Se devi citare NPC o Luoghi, usa i nomi esatti presenti nella MEMORIA DEL MONDO.

**OUTPUT JSON** (SOLO questi campi narrativi):
{
  "title": "Titolo evocativo per la sessione",
  "narrative": "Il testo narrativo COMPLETO della sessione. Scrivi in prosa avvincente, terza persona, tempo passato. Includi dialoghi (con «»), atmosfera, emozioni. NESSUN LIMITE di lunghezza - sii dettagliato!",
  "narrativeBrief": "Mini-racconto autonomo per Discord/email. MASSIMO 1800 caratteri.",
  "log": ["[Luogo] Chi -> Azione -> Risultato (formato tecnico per il DM)"],
  "character_growth": [
    {"name": "Nome PG", "event": "Evento significativo", "type": "TRAUMA|ACHIEVEMENT|RELATIONSHIP|GOAL_CHANGE"}
  ],
  "npc_events": [
    {"name": "Nome NPC", "event": "Evento chiave", "type": "REVELATION|BETRAYAL|DEATH|ALLIANCE|STATUS_CHANGE"}
  ],
  "world_events": [
    {"event": "Evento che cambia il mondo", "type": "POLITICS|WAR|DISASTER|DISCOVERY"}
  ]
}

**REGOLE**:
- NON estrarre loot/quest/mostri/NPC/luoghi (fatto dall'Analista)
- NON inventare eventi non presenti nel testo
- Rispondi SOLO con JSON valido in ITALIANO`;

// ============================================
// VALIDAZIONE BATCH
// ============================================

export const VALIDATION_PROMPT = (context: any, input: ValidationBatchInput) => {
    let prompt = \`Valida questi dati di una sessione D&D in BATCH.

**CONTESTO:**
\`;

    // Aggiungi contesto NPC
    if (context.npcHistories && Object.keys(context.npcHistories).length > 0) {
        prompt += "\\n**Storia Recente NPC:**\\n";
        for (const [name, history] of Object.entries(context.npcHistories)) {
            prompt += \`- \${name}: \${history}\\n\`;
        }
    }

    // Aggiungi contesto PG
    if (context.charHistories && Object.keys(context.charHistories).length > 0) {
        prompt += "\\n**Storia Recente PG:**\\n";
        for (const [name, history] of Object.entries(context.charHistories)) {
            prompt += \`- \${name}: \${history}\\n\`;
        }
    }

    // Aggiungi quest attive
    if (context.existingQuests && context.existingQuests.length > 0) {
        prompt += \`\\n**Quest Attive (DA NON DUPLICARE):**\\n\${context.existingQuests.map((q: string) => \`- \${q}\`).join('\\n')}\\n\`;
    }

    prompt += "\\n**DATI DA VALIDARE:**\\n\\n";

    // Eventi NPC
    if (input.npc_events && input.npc_events.length > 0) {
        prompt += \`**Eventi NPC (\${input.npc_events.length}):**\\n\`;
        input.npc_events.forEach((e: any, i: number) => {
            prompt += \`\${i + 1}. \${e.name}: [\${e.type}] \${e.event}\\n\`;
        });
        prompt += "\\n";
    }

    // Eventi PG
    if (input.character_events && input.character_events.length > 0) {
        prompt += \`**Eventi PG (\${input.character_events.length}):**\\n\`;
        input.character_events.forEach((e: any, i: number) => {
            prompt += \`\${i + 1}. \${e.name}: [\${e.type}] \${e.event}\\n\`;
        });
        prompt += "\\n";
    }

    // Eventi Mondo
    if (input.world_events && input.world_events.length > 0) {
        prompt += \`**Eventi Mondo (\${input.world_events.length}):**\\n\`;
        input.world_events.forEach((e: any, i: number) => {
            prompt += \`\${i + 1}. [\${e.type}] \${e.event}\\n\`;
        });
        prompt += "\\n";
    }

    // Loot
    if (input.loot && input.loot.length > 0) {
        prompt += \`**Loot (\${input.loot.length}):**\\n\`;
        input.loot.forEach((item: any, i: number) => prompt += \`\${i + 1}. \${item}\\n\`);
        prompt += "\\n";
    }

    // Quest
    if (input.quests && input.quests.length > 0) {
        prompt += \`**Quest (\${input.quests.length}):**\\n\`;
        input.quests.forEach((q: any, i: number) => prompt += \`\${i + 1}. \${q}\\n\`);
        prompt += "\\n";
    }

    // Atlante
    if (input.atlas_update) {
        const a = input.atlas_update;
        prompt += \`**Aggiornamento Atlante:**\\n\`;
        prompt += \`- Luogo: \${a.macro} - \${a.micro}\\n\`;
        if (a.existingDesc) {
            const truncDesc = a.existingDesc.length > 200 ? a.existingDesc.substring(0, 200) + '...' : a.existingDesc;
            prompt += \`- Descrizione Esistente: \${truncDesc}\\n\`;
        }
        prompt += \`- Nuova Descrizione: \${a.description}\\n\\n\`;
    }

    prompt += \`
**REGOLE DI VALIDAZIONE:**

**Eventi (NPC/PG/World):**
- SKIP se: duplicato semantico della storia recente, evento banale (es. "ha parlato", "ha mangiato"), contraddittorio con eventi recenti
- KEEP se: cambio di status significativo, rivelazione importante, impatto sulla trama
- Per eventi KEEP: riscrivi in modo conciso (max 1 frase chiara)

**Loot:**
- SKIP: spazzatura (<10 monete di valore stimato), oggetti di scena non utilizzabili (es. "sacco vuoto"), duplicati semantici
- KEEP: oggetti magici o unici (anche se sembrano deboli), valuta >=10 monete, oggetti chiave per la trama
- Normalizza nomi: "Spada +1" invece di "lama affilata magica"
- Aggrega valuta: "150 mo" invece di liste multiple

**Quest:**
- **CRITICO**: Confronta OGNI quest di input con la lista "Quest Attive" nel contesto.
- Se esiste già una quest con significato simile (es. "Uccidere Drago" vs "Sconfiggere il Drago"), **SKIP**.
- Se l'input include stati come "(Completata)", "(In corso)", ignorali per il confronto semantico.
- Mantieni SOLO le quest che sono *veramente* nuove (mai viste prima).
- Normalizza: rimuovi prefissi come "Quest:", "TODO:", capitalizza correttamente

**Atlante:**
- SKIP se: e' solo una riformulazione generica dello stesso contenuto, e' piu' generica e perde dettagli
- MERGE se: contiene nuovi dettagli osservabili E preserva informazioni storiche esistenti
- KEEP se: e' la prima descrizione del luogo (non c'e' descrizione esistente)
- Per MERGE: restituisci descrizione unificata che preserva vecchi dettagli + aggiunge novita'

**OUTPUT JSON RICHIESTO:**
{
  "npc_events": {
    "keep": [{"name": "NomeNPC", "event": "evento riscritto conciso", "type": "TIPO"}],
    "skip": ["motivo scarto 1", "motivo scarto 2"]
  },
  "character_events": {
    "keep": [{"name": "NomePG", "event": "evento riscritto", "type": "TIPO"}],
    "skip": ["motivo"]
  },
  "world_events": {
    "keep": [{"event": "evento riscritto", "type": "TIPO"}],
    "skip": ["motivo"]
  },
  "loot": {
    "keep": ["Spada +1", "150 mo"],
    "skip": ["frecce rotte - valore <10mo"]
  },
  "quests": {
    "keep": ["Recuperare la Spada del Destino"],
    "skip": ["parlare con oste - micro-task", "duplicato di quest attiva"]
  },
  "atlas": {
    "action": "keep" | "skip" | "merge",
    "text": "descrizione unificata se action=merge, altrimenti ometti"
  }
}

Rispondi SOLO con il JSON, niente altro.\`;

    return prompt;
}

// ============================================
// CLEAN & CORRECTION
// ============================================

export const TRANSCRIPTION_CORRECTION_PROMPT = (batch: any[]) => {
    const cleanText = (text: string) => text; // Helper placeholder, logic is in main file usually but prompt text is here
     return \`Correggi ortografia e punteggiatura in italiano.
- Rimuovi riempitivi (ehm, uhm).
- SE UNA RIGA CONTIENE SOLO "A tutti", "Autore dei", O FRASI SENZA SENSO: Scrivi "..." (tre puntini).
- NON aggiungere commenti.
- IMPORTANTE: Restituisci ESATTAMENTE \${batch.length} righe, una per riga.
- NON unire né dividere frasi.

TESTO DA CORREGGERE (\${batch.length} righe):
\${batch.map((s, i) => \`\${i + 1}. \${s.text}\`).join('\\n')}\`;
};

// ============================================
// CHAT / RAG SYSTEM
// ============================================

export const RAG_QUERY_GENERATION_PROMPT = (recentHistory: string, userQuestion: string) => `Sei un esperto di ricerca per un database D & D.
    
    CONTESTO CHAT RECENTE:
\${ recentHistory }
    
    ULTIMA DOMANDA UTENTE:
"\${userQuestion}"
    
    Il tuo compito è generare 1 - 3 query di ricerca specifiche per trovare la risposta nel database vettoriale(RAG).

    REGOLE:
1. Risolvi i riferimenti(es. "Lui" -> "Leosin", "Quel posto" -> "Locanda del Drago").
    2. Usa parole chiave specifiche(Nomi, Luoghi, Oggetti).
    3. Se la domanda è generica("Riassumi tutto"), crea query sui fatti recenti.

    Output: JSON array di stringhe.Es: ["Dialoghi Leosin Erantar", "Storia della Torre"]`;

export const BARD_ATMOSPHERE_PROMPT = (baseAtmosphere: string, socialContext: string, contextText: string) => `\${ baseAtmosphere }
    Il tuo compito è rispondere SOLO all'ULTIMA domanda posta dal giocatore, usando le trascrizioni.

\${ socialContext }
\${ contextText }
    
    REGOLAMENTO RIGIDO:
1. La cronologia serve SOLO per il contesto.
    2. NON ripetere mai le risposte già date.
    3. Rispondi in modo diretto.
    4. Se la risposta non è nelle trascrizioni, ammetti di non ricordare.`;

// ============================================
// BIOGRAFIE & DOSSIER
// ============================================

export const CHARACTER_BIO_PROMPT = (charName: string, charRace: string, charClass: string, eventsText: string) => `Sei un biografo fantasy epico.
    Scrivi la "Storia finora" del personaggio \${ charName } (\${ charRace } \${ charClass }).
    
    Usa la seguente cronologia di eventi significativi raccolti durante le sessioni:
\${ eventsText }

ISTRUZIONI:
1. Unisci gli eventi in un racconto fluido e coinvolgente.
    2. Evidenzia l'evoluzione psicologica del personaggio (es. come i traumi lo hanno cambiato).
3. Non fare un elenco puntato, scrivi in prosa.
    4. Usa un tono solenne e introspettivo.
    5. Concludi con una frase sullo stato attuale del personaggio.`;

export const NPC_BIO_PROMPT = (npcName: string, role: string, staticDesc: string, historyText: string) => `Sei un biografo fantasy.
    Scrivi la storia dell'NPC: **\${npcName}**.
    
    RUOLO ATTUALE: \${ role }
    DESCRIZIONE GENERALE: \${ staticDesc }
    
    CRONOLOGIA EVENTI(Apparsi nelle sessioni):
\${ historyText }

ISTRUZIONI:
1. Unisci la descrizione generale con gli eventi cronologici per creare un profilo completo.
    2. Se ci sono eventi storici, usali per spiegare come è arrivato alla situazione attuale.
    3. Se non ci sono eventi storici, basati sulla descrizione generale espandendola leggermente.
    4. Usa un tono descrittivo, come una voce di enciclopedia o un dossier segreto.`;

export const REGENERATE_NPC_NOTES_PROMPT = (npcName: string, role: string, staticDesc: string, historyText: string, complexityLevel: string) => `Sei il Biografo Ufficiale di una campagna D & D.
    Devi aggiornare il Dossier per l'NPC: **\${npcName}**.

RUOLO: \${ role }
    DESCRIZIONE PRECEDENTE(Usa questa SOLO per aspetto fisico e personalità):
"\${staticDesc}"
    
    CRONOLOGIA COMPLETA DEGLI EVENTI(Usa questa come fonte di verità per la storia):
\${ historyText }

OBIETTIVO:
    Scrivi una biografia aggiornata che integri coerentemente i nuovi eventi.
    
    ISTRUZIONI DI SCRITTURA:
1. ** Lunghezza Adattiva:** La lunghezza del testo DEVE essere proporzionale alla quantità di eventi nella cronologia. 
       - Se ci sono pochi eventi, sii breve.
       - Se ci sono molti eventi, scrivi una storia ricca e dettagliata.NON RIASSUMERE ECCESSIVAMENTE.
    2. ** Struttura:**
    - Inizia con l'aspetto fisico e la personalità (presi dalla Descrizione Precedente).
        - Prosegui con la narrazione delle sue gesta in ordine cronologico(prese dalla Cronologia).
       - Concludi con la sua situazione attuale.
    3. ** Preservazione:** Non inventare fatti non presenti, ma collegali in modo logico.
    4. ** Stile:** \${ complexityLevel === "DETTAGLIATO" ? "Epico, narrativo e approfondito." : "Diretto e informativo." }
    
    Restituisci SOLO il testo della nuova biografia.`;

export const RESOLVE_IDENTITY_PROMPT = (newName: string, newDesc: string, candidates: string) => `Analizza se il NUOVO NPC è un duplicato di uno ESISTENTE.
    NUOVO: "\${newName}" - \${ newDesc }
ESISTENTI:
\${ candidates }
    
    Rispondi JSON: { "match": "NomeEsattoEsistente" | null, "confidence": 0.0 - 1.0 } `;

export const SMART_MERGE_PROMPT = (existingBio: string, newInfo: string) => `Sei un archivista di D & D.
    Devi aggiornare la scheda biografica di un NPC unendo le informazioni vecchie con quelle nuove appena scoperte.
    
    DESCRIZIONE ESISTENTE:
"\${existingBio}"
    
    NUOVE INFORMAZIONI(da integrare):
"\${newInfo}"

COMPITO:
    Riscrivi una SINGOLA descrizione coerente in italiano che:
1. Integri i fatti nuovi nel testo esistente.
    2. Elimini le ripetizioni(es.se entrambi dicono "è ferito", dillo una volta sola).
    3. Mantenga lo stile conciso da dossier.
    4. Aggiorni lo stato fisico se le nuove info sono più recenti.
    
    Restituisci SOLO il testo della nuova descrizione, niente altro.`;

// ============================================
// RECONCILIATION
// ============================================

export const AI_CONFIRM_SAME_PERSON_EXTENDED_PROMPT = (newName: string, newDescription: string, candidateName: string, candidateDescription: string, ragContextText: string) => `Sei un esperto di D & D.Rispondi SOLO con "SI" o "NO".

    Domanda: Il nuovo NPC "\${newName}" è in realtà l'NPC esistente "\${candidateName}" (errore di trascrizione o soprannome)?

CONFRONTO DATI:
- NUOVO(\${ newName }): "\${newDescription}"
    - ESISTENTE(\${ candidateName }): "\${candidateDescription}"
\${ ragContextText }

CRITERI DI GIUDIZIO:
1. ** Fonetica:** Se suonano simili(Siri / Ciri), è un forte indizio.
2. ** Contesto(RAG):** Se la "Memoria Storica" di \${ candidateName } descrive fatti identici a quelli del nuovo NPC, SONO la stessa persona.
3. ** Logica:** Se uno è "Ostaggio dei banditi" e l'altro è "Prigioniera dei briganti", SONO la stessa persona.

Rispondi SOLO: SI oppure NO`;

export const AI_CONFIRM_SAME_PERSON_PROMPT = (name1: string, name2: string, context: string) => `Sei un esperto di D & D.Rispondi SOLO con "SI" o "NO".

    Domanda: "\${name1}" e "\${name2}" sono la STESSA persona / NPC ?

        Considera che:
- I nomi potrebbero essere pronunce errate o parziali(es. "Leo Sin" = "Leosin")
    - Potrebbero essere soprannomi(es. "Rantar" potrebbe essere il cognome di "Leosin Erantar")
        - Le trascrizioni audio spesso dividono i nomi(es. "Leosin Erantar" → "Leo Sin" + "Rantar")

\${
    context ?\`Contesto aggiuntivo: \${context}\` : ''}

Rispondi SOLO: SI oppure NO`;
