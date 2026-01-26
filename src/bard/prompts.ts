/**
 * Bard Prompts - Centralized Prompt Definitions
 * Estatti e consolidati da old_reference/bard.ts
 */

export const TONES = {
    EPICO: "Sei un cantastorie epico. Usa un linguaggio epico, solenne, enfatizza l'eroismo e il destino.",
    DIVERTENTE: "Sei un bardo ubriaco e sarcastico. Prendi in giro i fallimenti dei personaggi.",
    OSCURO: "Sei un cronista di un mondo Lovecraftiano. Tono cupo e disperato.",
    CONCISO: "Sei un segretario efficiente. solo fatti narrazione in terza persona.",
    DM: "Sei un assistente per il Dungeon Master. Punti salienti, loot e NPC."
};

export type ToneKey = keyof typeof TONES;

// --- MAP PHASE ---

export const MAP_PROMPT = `Sei un analista di D&D.
    \${castContext}
    Estrai un elenco puntato cronologico strutturato esattamente così:
    1. Nomi di NPC incontrati (SOLO se agiscono o parlano nel testo, IGNORA il contesto se non presenti);
    2. Luoghi visitati;
    3. Oggetti ottenuti (Loot) con dettagli;
    4. Numeri/Danni rilevanti;
    5. Decisioni chiave dei giocatori.
    6. Dialoghi importanti e il loro contenuto.
    
    Sii conciso. Se per una categoria non ci sono dati, scrivi "Nessuno".`;

// --- RAG QUERY GENERATION ---

export const CONTEXT_IDENTIFICATION_PROMPT = (snapshot: any, analysisText: string) => `Sei l'Archivista della campagna D&D "${snapshot.campaignName || 'Sconosciuta'}".

**CONTESTO SNAPSHOT CORRENTE:**
- Sessione: #${snapshot.sessionNumber || '?'}
- Luogo: ${snapshot.location?.macro || 'Sconosciuto'} - ${snapshot.location?.micro || 'Sconosciuto'}
- NPC Presenti: ${snapshot.presentNpcs?.join(', ') || 'Nessuno'}
- Quest Attive: ${snapshot.quests?.slice(0, 3).join(', ') || snapshot.quest_context || 'Nessuna'}

**TRASCRIZIONE CONDENSATA (Eventi Chiave):**
${analysisText}

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

// --- SCOUT (NER) ---

export const SCOUT_PROMPT = (text: string) => `
Sei uno SCOUT di lettura veloce.
Scansiona questa trascrizione di D&D e identifica le ENTITÀ SPECIFICHE citate che richiedono contesto.
Analizza il testo e estrai i nomi propri.

TESTO (Primi 40k caratteri):
${text.substring(0, 40000)}...

COMPITO:
Restituisci un JSON con array di stringhe.
- "npcs": Nomi propri di persone/creature che PARLANO o AGISCONO. (Ignora "il goblin", "la guardia" se generici).
- "locations": Nomi di luoghi specifici visitati o menzionati.
- "quests": Parole chiave o titoli di missioni citate.

Rispondi SOLO con JSON valido: {"npcs": [], "locations": [], "quests": []}
`;

// --- ANALYZER ---

export const ANALYST_PROMPT = (castContext: string, memoryContext: string, narrativeText: string) => `Sei un ANALISTA DATI esperto di D&D. Il tuo UNICO compito è ESTRARRE DATI STRUTTURATI da un testo di sessione.
NON scrivere narrativa. NON riassumere. SOLO estrai e cataloga.

=========================================
## 1. CONTESTO DI RIFERIMENTO (DA IGNORARE PER L'EXTRAZIONE)
Queste informazioni servono SOLO per riconoscere i nomi propri corretti. 
NON ESTRARRE loot, quest o mostri da questa sezione. 
Se un oggetto è elencato qui ma non viene acquisito NUOVAMENTE nel "Testo da Analizzare", NON aggiungerlo.

${castContext}
${memoryContext}
=========================================

## 2. ISTRUZIONI RIGOROSE
1. Analizza SOLO il "TESTO DA ANALIZZARE" in fondo.
2. Estrai SOLO ciò che è ESPLICITAMENTE acquisito o accaduto in QUESTA parte di testo.
3. **LOOT**: Se il testo dice "Usa la pozione che aveva", NON è loot. Se dice "Trova una pozione", È loot.
4. **MONSTERS**: Se il testo cita "Ricordarono il drago ucciso ieri", NON estrarre il drago. Estrai solo mostri combattuti ORA.
5. **QUEST**: Estrai solo se c'è un progresso attivo.
6. **GLOSSARIO**: Usa i nomi esatti del Contesto di Riferimento se corrispondesi.

## 3. OUTPUT JSON RICHIESTO
{
    "loot": [
        {
            "name": "Nome oggetto (ESATTO, senza descrizioni tra parentesi)",
            "quantity": 1,
            "description": "Descrizione fisica/magica. Inserisci QUI i dettagli che metteresti tra parentesi."
        }
    ],
    "loot_removed": [
        {
            "name": "Nome oggetto",
            "quantity": 1,
            "description": "Motivo rimozione o utilizzo (es. 'Bevuta pozione', 'Persa spada')"
        }
    ],
    "quests": [
        {
            "title": "Titolo breve della missione (es. 'Salvare il Fabbro')",
            "description": "Descrizione del progresso o aggiornamento (es. 'Il gruppo ha trovato la chiave della cella')",
            "title": "Titolo breve della missione (es. 'Salvare il Fabbro')",
            "description": "Descrizione del progresso o aggiornamento (es. 'Il gruppo ha trovato la chiave della cella')",
            "status": "OPEN|IN_PROGRESS|COMPLETED|FAILED",
            "type": "MAJOR|MINOR"
        }
    ],
    "monsters": [
        {
            "name": "Nome creatura (es. 'Scheletro', NON 'Scheletro (con spada)'). NON usare parentesi.",
            "status": "DEFEATED|ALIVE|FLED",
            "count": "numero o 'molti'",
            "description": "Descrizione fisica/aspetto. Inserisci QUI i dettagli descrittivi.",
            "abilities": ["Abilità speciali osservate (es. 'soffio di fuoco', 'attacco multiplo')"],
            "weaknesses": ["Debolezze scoperte (es. 'vulnerabile al fuoco')"],
            "resistances": ["Resistenze osservate (es. 'immune al veleno')"]
        }
        // AVVISO AI: NON INCLUDERE creature menzionate solo nel "Contesto".
        // ESEMPIO NEGATIVO: Se il testo dice "Ti ricordi il Troll di ieri?", ARRAY VUOTO [].
        // ESEMPIO POSITIVO: Se il testo dice "Un Troll esce dalla grotta!", AGGIUNGI Troll.
    ],
    "npc_dossier_updates": [
        {
            "name": "Nome PROPRIO dell'NPC (es. 'Elminster', NON 'Elminster (mago)'). NON inserire descrizioni tra parentesi nel nome.",
            "description": "Descrizione fisica/personalità basata su ciò che emerge dal testo. Inserisci QUI eventuali dettagli descrittivi che metteresti tra parentesi.",
            "role": "Ruolo (es. 'Mercante', 'Guardia')",
            "status": "ALIVE|DEAD|MISSING"
        }
    ],

    "location_updates": [
        {
            "macro": "Città/Regione (es. 'Waterdeep')",
            "micro": "Luogo PRINCIPALE (es. 'Castello di Waterdeep'). NON creare sub-luoghi per singole stanze (es. 'Cucine', 'Sala trono') ma AGGREGA nel luogo principale.",
            "description": "Descrizione atmosferica del luogo. Se vengono visitate più stanze, descrivile qui in un unico blocco. IGNORA SE VUOTO (Non creare l'entry)."
        }
    ],
    "travel_sequence": [
        {
            "macro": "Città/Regione",
            "micro": "Luogo specifico SENZA ripetere il macro",
            "reason": "Motivo spostamento (opzionale)"
        }
    ],
    "present_npcs": ["Lista TUTTI i nomi NPC che AGISCONO o PARLANO esplicitamente nel testo. Usa i nomi dal CONTESTO PERSONAGGI o NPC PRESENTI (Scout) se disponibili."],
    "log": ["[Luogo] Chi -> Azione -> Risultato (formato tecnico per il DM, log azioni principali)"],
    "character_growth": [
        {
            "name": "Nome PG", 
            "event": "Evento significativo per il personaggio", 
            "type": "TRAUMA|ACHIEVEMENT|RELATIONSHIP|GOAL_CHANGE"
        }
    ],
    "npc_events": [
        {
            "name": "Nome NPC", 
            "event": "Evento chiave che coinvolge questo NPC (es. cambiato fazione, morto, rivelato segreto)", 
            "type": "REVELATION|BETRAYAL|DEATH|ALLIANCE|STATUS_CHANGE"
        }
    ],
    "world_events": [
        {
            "event": "Evento che cambia il mondo di gioco (es. scoppiata guerra, cataclisma)", 
            "type": "POLITICS|WAR|DISASTER|DISCOVERY"
        }
    ]
}

**REGOLE CRITICHE**:
- I PG (Personaggi Giocanti nel CONTESTO sopra) NON vanno in npc_dossier_updates
- Per il loot: "parlano di una spada" ≠ "trovano una spada". Estrai SOLO acquisizioni certe.
- Per le quest: Solo se c'è una chiara accettazione/completamento/aggiornamento. Usa oggetti strutturati {title, description, status, type}.
- **QUEST TYPE**: "MAJOR" = Archi narrativi principali o quest lunghe. "MINOR" = Commissioni, favori veloci, fetch quest semplici.
- Per i mostri: Solo creature ostili combattute, non NPC civili. **ESTRAI DETTAGLI**: se i PG scoprono abilità, debolezze o resistenze durante il combattimento, REGISTRALE (es. "il drago sputa fuoco" → abilities: ["soffio di fuoco"])
- **TRAVEL vs LOCATION**: travel_sequence = SEQUENZA CRONOLOGICA dove sono stati fisicamente. location_updates = SOLO per l'Atlante. **CRITICO ATLANTE**: EVITA GRANULARITÀ ECCESSIVA. Se i PG visitano "Castello - Ingresso", "Castello - Cucine", "Castello - Prigioni", crea UN SOLO location_update: "Castello" e metti i dettagli nella descrizione. Solo se un luogo è davvero distinto e distante (es. "Città" vs "Foresta fuori città") crea entry separate.
- **LOG**: Deve essere una sequenza di fatti oggettivi.
- **CHARACTER GROWTH**: Includi solo cambiamenti significativi nella psiche o stato dei PG.
- **NPC EVENTS**: Includi eventi che cambiano lo status quo degli NPC.

**TESTO DA ANALIZZARE**:
${narrativeText.substring(0, 320000)}

Rispondi SOLO con JSON valido.`;

// --- WRITER ---

export const WRITER_DM_PROMPT = (castContext: string, memoryContext: string, analystJson: string) => `Sei uno SCRITTORE FANTASY esperto di D&D. Il tuo UNICO compito è SCRIVERE.
I dati strutturati (loot, quest, mostri, NPC) sono già stati estratti da un analista.
Tu devi concentrarti SOLO sulla NARRAZIONE EPICA.

=========================================
## 1. CONTESTO DI RIFERIMENTO
${castContext}

## 2. MEMORIA DEL MONDO
(Fatti passati per coerenza, NON inventare questi eventi come se accadessero ora)
${memoryContext}
=========================================

## 3. DATI DI SESSIONE (Vera ossatura della narrazione)
Questi sono i fatti ESPLICITI accaduti in QUESTO episodio:
${analystJson}

**IL TUO COMPITO**: Scrivi un racconto epico e coinvolgente della sessione.
Concentrati su: atmosfera, emozioni, dialoghi, colpi di scena, introspezione dei personaggi.

**OUTPUT JSON** (SOLO questi campi):
    "title": "Titolo evocativo e memorabile per la sessione",
    "narrative": "Il racconto COMPLETO della sessione. Scrivi in prosa romanzesca, terza persona, passato. Includi dialoghi (con «»), descrizioni atmosferiche, emozioni dei personaggi. DEVE essere LUNGO e DETTAGLIATO - almeno 3000-5000 caratteri.",
    "narrativeBrief": "MASSIMO 1800 caratteri. Mini-racconto autonomo che cattura l'essenza della sessione. Per Discord/email."
}

**STILE NARRATIVO**:
- "Show, don't tell": Non dire "era coraggioso", mostra le sue azioni
- I dialoghi devono essere vivi e caratterizzanti
- Descrivi le emozioni e i pensieri dei personaggi
- Usa i cambi di scena per strutturare il racconto
- Il "narrative" deve essere un RACCONTO COMPLETO, non un riassunto
- **GLOSSARIO**: Il contesto fornito è già filtrato e contiene solo le entità rilevanti. USA I NOMI ESATTI forniti nel contesto.

**REGOLE**:
- NON estrarre loot/quest/mostri (fatto dall'Analista)
- NON inventare eventi non presenti nel testo
- Rispondi SOLO in ITALIANO
- Il "narrative" è epico e dettagliato`;

export const WRITER_BARDO_PROMPT = (tone: ToneKey, castContext: string, memoryContext: string, analystJson: string) => `Sei un Bardo. ${TONES[tone] || TONES.EPICO}

=========================================
## CONTESTO (MEMORY)
${castContext}
${memoryContext}
=========================================

## FATTI DELLA SESSIONE CORRENTE
(Questi sono gli eventi che devi narrare come accaduti ORA):
${analystJson}

**IL TUO COMPITO**: Scrivi un racconto della sessione nel tono richiesto.
I dati strutturati (loot, quest, mostri, NPC, luoghi) sono già stati estratti da un analista separato.
Tu devi concentrarti SOLO sulla NARRAZIONE.

ISTRUZIONI DI STILE:
- "Show, don't tell": Non dire che un personaggio è coraggioso, descrivi le sue azioni intrepide.
- Attribuisci correttamente i dialoghi agli NPC specifici anche se provengono dalla trascrizione del DM.
- Le righe marcate con 📝 [NOTA UTENTE] sono fatti certi inseriti manualmente dai giocatori.
- Usa i marker "--- CAMBIO SCENA ---" nel testo per strutturare il racconto in capitoli.
- **GLOSSARIO**: Il contesto fornito è già filtrato. Usa i nomi esatti presenti nella memoria.

**OUTPUT JSON** (SOLO questi campi narrativi):
    "title": "Titolo evocativo per la sessione",
    "narrative": "Il testo narrativo COMPLETO della sessione. Scrivi in prosa avvincente, terza persona, tempo passato. Includi dialoghi (con «»), atmosfera, emozioni. NESSUN LIMITE di lunghezza - sii dettagliato!",
    "narrativeBrief": "Mini-racconto autonomo per Discord/email. MASSIMO 1800 caratteri."
}

**REGOLE**:
- NON estrarre loot/quest/mostri/NPC/luoghi (fatto dall'Analista)
- NON inventare eventi non presenti nel testo
- Rispondi SOLO con JSON valido in ITALIANO`;

// --- BIOGRAPHIES ---

export const CHARACTER_BIO_PROMPT = (charName: string, charRace: string, charClass: string, eventsText: string) => `Sei un biografo fantasy epico.
    Scrivi la "Storia finora" del personaggio ${charName} (${charRace} ${charClass}).
    
    Usa la seguente cronologia di eventi significativi raccolti durante le sessioni:
    ${eventsText}
    
    ISTRUZIONI:
    1. Unisci gli eventi in un racconto fluido e coinvolgente.
    2. Evidenzia l'evoluzione psicologica del personaggio (es. come i traumi lo hanno cambiato).
    3. Non fare un elenco puntato, scrivi in prosa.
    4. Usa un tono solenne e introspettivo.
    5. Concludi con una frase sullo stato attuale del personaggio.`;

export const UPDATE_CHARACTER_BIO_PROMPT = (charName: string, currentDesc: string, historyText: string) => `Sei il Biografo Personale del personaggio giocante **${charName}**.

**BIOGRAFIA ATTUALE (Contiene già eventi precedenti integrati):**
${currentDesc || 'Nessuna descrizione iniziale.'}

**NUOVI EVENTI DA INTEGRARE (Non ancora nella biografia sopra):**
${historyText}

**REGOLE CRITICHE:**
1. **NON DUPLICARE**: Gli eventi nella "Biografia Attuale" sono GIÀ integrati. Aggiungi SOLO i "Nuovi Eventi".
2. **Rispetta l'Agency del Giocatore**: NON cambiare tratti di personalità.
3. **Aggiungi Solo Conseguenze Osservabili**: Cicatrici, oggetti iconici, titoli, relazioni chiave.
4. **Preserva il Testo Esistente**: Modifica minimamente, aggiungi max 1-2 frasi per i nuovi eventi.
5. **Formato**: Terza persona, stile enciclopedia fantasy, max 800 caratteri totali.

Restituisci SOLO il testo aggiornato della biografia (senza introduzioni o spiegazioni).`;

export const NPC_BIO_PROMPT = (npcName: string, role: string, staticDesc: string, historyText: string) => `Sei un biografo fantasy.
    Scrivi la storia dell'NPC: **${npcName}**.
    
    RUOLO ATTUALE: ${role}
    DESCRIZIONE GENERALE: ${staticDesc}
    
    CRONOLOGIA EVENTI (Apparsi nelle sessioni):
    ${historyText}
    
    ISTRUZIONI:
    1. Unisci la descrizione generale con gli eventi cronologici per creare un profilo completo.
    2. Se ci sono eventi storici, usali per spiegare come è arrivato alla situazione attuale.
    3. Se non ci sono eventi storici, basati sulla descrizione generale espandendola leggermente.
    4. Usa un tono descrittivo, come una voce di enciclopedia o un dossier segreto.`;

export const REGENERATE_NPC_NOTES_PROMPT = (npcName: string, role: string, staticDesc: string, historyText: string, complexityLevel: string) => `Sei il Biografo Ufficiale di una campagna D&D.
    Devi aggiornare il Dossier per l'NPC: **${npcName}**.
    
    RUOLO: ${role}
    DESCRIZIONE PRECEDENTE (Usa questa SOLO per aspetto fisico e personalità): 
    "${staticDesc}"
    
    CRONOLOGIA COMPLETA DEGLI EVENTI (Usa questa come fonte di verità per la storia):
    ${historyText}
    
    OBIETTIVO:
    Scrivi una biografia aggiornata che integri coerentemente i nuovi eventi.
    
    ISTRUZIONI DI SCRITTURA:
    1. **Lunghezza Adattiva:** La lunghezza del testo DEVE essere proporzionale alla quantità di eventi nella cronologia. 
       - Se ci sono pochi eventi, sii breve.
       - Se ci sono molti eventi, scrivi una storia ricca e dettagliata. NON RIASSUMERE ECCESSIVAMENTE.
    2. **Struttura:**
       - Inizia con l'aspetto fisico e la personalità (presi dalla Descrizione Precedente).
       - Prosegui con la narrazione delle sue gesta in ordine cronologico (prese dalla Cronologia).
       - Concludi con la sua situazione attuale.
    3. **Preservazione:** Non inventare fatti non presenti, ma collegali in modo logico.
    4. **Stile:** ${complexityLevel === "DETTAGLIATO" ? "Epico, narrativo e approfondito." : "Diretto e informativo."}
    
    Restituisci SOLO il testo della nuova biografia.`;

// --- RECONCILIATION ---

export const SMART_MERGE_PROMPT = (bio1: string, bio2: string) => `Sei un archivista di D&D.
    Devi aggiornare la scheda biografica di un NPC unendo le informazioni vecchie con quelle nuove appena scoperte.
    
    DESCRIZIONE ESISTENTE:
    "${bio1}"
    
    NUOVE INFORMAZIONI (da integrare):
    "${bio2}"
    
    COMPITO:
    Riscrivi una SINGOLA descrizione coerente in italiano che:
    1. Integri i fatti nuovi nel testo esistente.
    2. Elimini le ripetizioni (es. se entrambi dicono "è ferito", dillo una volta sola).
    3. Mantenga lo stile conciso da dossier.
    4. Aggiorni lo stato fisico se le nuove info sono più recenti.
    
    Restituisci SOLO il testo della nuova descrizione, niente altro.`;

export const AI_CONFIRM_SAME_PERSON_EXTENDED_PROMPT = (newName: string, newDescription: string, candidateName: string, candidateDescription: string, ragContextText: string) => `Sei un esperto di D&D. Rispondi SOLO con "SI" o "NO".

Domanda: Il nuovo NPC "${newName}" è in realtà l'NPC esistente "${candidateName}" (errore di trascrizione o soprannome)?

CONFRONTO DATI:
- NUOVO (${newName}): "${newDescription}"
- ESISTENTE (${candidateName}): "${candidateDescription}"
${ragContextText}

CRITERI DI GIUDIZIO:
1. **Fonetica:** Se suonano simili (Siri/Ciri), è un forte indizio.
2. **Contesto (RAG):** Se la "Memoria Storica" di ${candidateName} descrive fatti identici a quelli del nuovo NPC, SONO la stessa persona.
3. **Logica:** Se uno è "Ostaggio dei banditi" e l'altro è "Prigioniera dei briganti", SONO la stessa persona.
4. **Link Semantico:** Se il Contesto RAG menziona che "${newName}" è un titolo/soprannome di "${candidateName}", RISPONDI SI.

Se c'è anche solo un vago ma plausibile collegamento nel contesto, **FAVORISCI IL SI** per evitare duplicati.

Rispondi SOLO: SI oppure NO`;

export const AI_CONFIRM_SAME_PERSON_PROMPT = (name1: string, name2: string, context: string) => `Sei un esperto di D&D. Rispondi SOLO con "SI" o "NO".

Domanda: "${name1}" e "${name2}" sono la STESSA persona/NPC?

Considera che:
- I nomi potrebbero essere pronunce errate o parziali (es. "Leo Sin" = "Leosin")
- Potrebbero essere soprannomi (es. "Rantar" potrebbe essere il cognome di "Leosin Erantar")
- Le trascrizioni audio spesso dividono i nomi (es. "Leosin Erantar" → "Leo Sin" + "Rantar")

${context ? `Contesto aggiuntivo: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

export const AI_CONFIRM_SAME_LOCATION_EXTENDED_PROMPT = (newMacro: string, newMicro: string, newDescription: string, candidateMacro: string, candidateMicro: string, candidateDescription: string, ragContextText: string) => `Sei un esperto di D&D e ambientazioni fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: Il nuovo luogo "${newMacro} - ${newMicro}" è in realtà il luogo esistente "${candidateMacro} - ${candidateMicro}"?

CONFRONTO DATI:
- NUOVO: "${newDescription}"
- ESISTENTE: "${candidateDescription}"
${ragContextText}

CRITERI DI GIUDIZIO:
1. **Fonetica:** Se i nomi suonano simili o sono traduzioni/sinonimi (es. "Torre Nera" vs "Torre Oscura").
2. **Contesto (RAG):** Se la "Memoria Storica" descrive eventi accaduti nel luogo candidato che coincidono con la descrizione del nuovo luogo.
3. **Gerarchia:** Se uno è chiaramente un sotto-luogo dell'altro ma usato come nome principale.
4. **Link Semantico:** Se il Contesto RAG o la descrizione suggeriscono che sono lo stesso posto (es. "Torre Nera" che è descritta come "Oscura"), RISPONDI SI.

Se c'è anche solo un vago ma plausibile collegamento nel contesto, **FAVORISCI IL SI** per evitare duplicati.

Rispondi SOLO: SI oppure NO`;

export const AI_CONFIRM_SAME_LOCATION_PROMPT = (loc1Macro: string, loc1Micro: string, loc2Macro: string, loc2Micro: string, context: string) => `Sei un esperto di D&D e ambientazioni fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${loc1Macro} - ${loc1Micro}" e "${loc2Macro} - ${loc2Micro}" sono lo STESSO luogo?

Considera che:
- I nomi potrebbero essere trascrizioni errate o parziali (es. "Palazzo centrale" = "Palazzo Centrale")
- Potrebbero essere descrizioni diverse dello stesso posto (es. "Sala del trono" = "Sala Trono")
- I luoghi macro potrebbero avere varianti (es. "Dominio di Ogma" = "Regno di Ogma")
- I micro-luoghi potrebbero essere sottoinsiemi (es. "Cancelli d'Ingresso" ≈ "Cancelli del dominio")

${context ? `Contesto aggiuntivo: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

export const AI_CONFIRM_SAME_MONSTER_PROMPT = (name1: string, name2: string, context: string) => `Sei un esperto di D&D e creature fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${name1}" e "${name2}" sono lo STESSO tipo di mostro/creatura?

Considera che:
- I nomi potrebbero essere singolari/plurali (es. "Goblin" = "Goblins")
- Potrebbero essere varianti ortografiche (es. "Orco" = "Orchi")
- Potrebbero essere nomi parziali (es. "Scheletro" ≈ "Scheletro Guerriero")
- NON unire creature diverse (es. "Goblin" ≠ "Hobgoblin")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

export const AI_CONFIRM_SAME_ITEM_PROMPT = (item1: string, item2: string, context: string) => `Sei un esperto di D&D e oggetti fantasy. Rispondi SOLO con "SI" o "NO".

Domanda: "${item1}" e "${item2}" sono lo STESSO oggetto?

Considera che:
- Potrebbero essere abbreviazioni (es. "Pozione di cura" = "Pozione Cura")
- Potrebbero essere varianti (es. "100 monete d'oro" ≈ "100 mo")
- NON unire oggetti diversi (es. "Spada +1" ≠ "Spada +2")
- NON unire categorie diverse (es. "Pozione di cura" ≠ "Pozione di forza")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

export const AI_CONFIRM_SAME_QUEST_PROMPT = (title1: string, title2: string, context: string) => `Sei un esperto di D&D e missioni. Rispondi SOLO con "SI" o "NO".

Domanda: "${title1}" e "${title2}" sono la STESSA missione/quest?

Considera che:
- I titoli potrebbero essere varianti (es. "Salvare il villaggio" = "Salvare il Villaggio")
- Potrebbero essere abbreviati (es. "Trova l'artefatto" ≈ "Trovare l'artefatto antico")
- NON unire missioni diverse (es. "Salvare Alice" ≠ "Salvare Bob")

${context ? `Contesto: ${context}` : ''}

Rispondi SOLO: SI oppure NO`;

// --- RAG SEARCH ---

export const RAG_QUERY_GENERATION_PROMPT = (recentHistory: string, userQuestion: string) => `Sei un esperto di ricerca per un database D&D.
    
    CONTESTO CHAT RECENTE:
    ${recentHistory}
    
    ULTIMA DOMANDA UTENTE:
    "${userQuestion}"
    
    Il tuo compito è generare 1-3 query di ricerca specifiche per trovare la risposta nel database vettoriale (RAG).
    
    REGOLE:
    1. Risolvi i riferimenti (es. "Lui" -> "Leosin", "Quel posto" -> "Locanda del Drago").
    2. Usa parole chiave specifiche (Nomi, Luoghi, Oggetti).
    3. Se la domanda è generica ("Riassumi tutto"), crea query sui fatti recenti.
    
    Output: JSON array di stringhe. Es: ["Dialoghi Leosin Erantar", "Storia della Torre"]`;

export const BARD_ATMOSPHERE_PROMPT = (atmosphere: string, socialContext: string, contextText: string) => `${atmosphere}
    Il tuo compito è rispondere SOLO all'ULTIMA domanda posta dal giocatore, usando le trascrizioni.
    
    ${socialContext}
    ${contextText}
    
    REGOLAMENTO RIGIDO:
    1. La cronologia serve SOLO per il contesto.
    2. NON ripetere mai le risposte già date.
    3. Rispondi in modo diretto.
    4. Se la risposta non è nelle trascrizioni, ammetti di non ricordare.`;

// --- VALIDATION ---

export const VALIDATION_PROMPT = (context: any, input: any) => {
    let prompt = `Valida questi dati di una sessione D&D in BATCH.

**CONTESTO:**
`;

    // Aggiungi contesto NPC
    if (context.npcHistories && Object.keys(context.npcHistories).length > 0) {
        prompt += "\n**Storia Recente NPC:**\n";
        for (const [name, history] of Object.entries(context.npcHistories)) {
            prompt += `- ${name}: ${history}\n`;
        }
    }

    // Aggiungi contesto PG
    if (context.charHistories && Object.keys(context.charHistories).length > 0) {
        prompt += "\n**Storia Recente PG:**\n";
        for (const [name, history] of Object.entries(context.charHistories)) {
            prompt += `- ${name}: ${history}\n`;
        }
    }

    // Aggiungi quest attive
    if (context.existingQuests && context.existingQuests.length > 0) {
        prompt += `\n**Quest Attive (DA NON DUPLICARE):**\n${context.existingQuests.map((q: string) => `- ${q}`).join('\n')}\n`;
    }

    prompt += "\n**DATI DA VALIDARE:**\n\n";

    // Eventi NPC
    if (input.npc_events && input.npc_events.length > 0) {
        prompt += `**Eventi NPC (${input.npc_events.length}):**\n`;
        input.npc_events.forEach((e: any, i: number) => {
            prompt += `${i + 1}. ${e.name}: [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    // Eventi PG
    if (input.character_events && input.character_events.length > 0) {
        prompt += `**Eventi PG (${input.character_events.length}):**\n`;
        input.character_events.forEach((e: any, i: number) => {
            prompt += `${i + 1}. ${e.name}: [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    // Eventi Mondo
    if (input.world_events && input.world_events.length > 0) {
        prompt += `**Eventi Mondo (${input.world_events.length}):**\n`;
        input.world_events.forEach((e: any, i: number) => {
            prompt += `${i + 1}. [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    // Loot
    if (input.loot && input.loot.length > 0) {
        prompt += `**Loot (${input.loot.length}):**\n`;
        input.loot.forEach((item: any, i: number) => {
            const desc = typeof item === 'string' ? item : `${item.name} (x${item.quantity}) - ${item.description || ''}`;
            prompt += `${i + 1}. ${desc}\n`
        });
        prompt += "\n";
    }

    // Quest
    if (input.quests && input.quests.length > 0) {
        prompt += `**Quest (${input.quests.length}):**\n`;
        input.quests.forEach((q: any, i: number) => {
            const title = typeof q === 'string' ? q : q.title;
            const desc = typeof q === 'string' ? '' : ` - ${q.description || ''}`;
            prompt += `${i + 1}. ${title}${desc}\n`;
        });
        prompt += "\n";
    }

    // Atlante
    if (input.atlas_update) {
        const a = input.atlas_update;
        prompt += `**Aggiornamento Atlante:**\n`;
        prompt += `- Luogo: ${a.macro} - ${a.micro}\n`;
        if (a.existingDesc) {
            const truncDesc = a.existingDesc.length > 200 ? a.existingDesc.substring(0, 200) + '...' : a.existingDesc;
            prompt += `- Descrizione Esistente: ${truncDesc}\n`;
        }
        prompt += `- Nuova Descrizione: ${a.description}\n\n`;
    }

    prompt += `
**REGOLE DI VALIDAZIONE:**

**Eventi (NPC/PG/World):**
- SKIP se: duplicato semantico della storia recente, evento banale (es. "ha parlato", "ha mangiato", "ha camminato"), dialoghi senza conseguenze, spostamenti minori.
- KEEP se: cambio di status significativo, rivelazione importante, impatto sulla trama, ferite gravi, acquisizione abilità/oggetti unici.
- CRITERIO: "Se questo evento non fosse scritto, la storia cambierebbe?" Se NO -> SKIP.
- Per eventi KEEP: riscrivi in modo conciso (max 1 frase chiara)

**Loot:**
- SKIP: spazzatura (<10 monete di valore stimato), oggetti di scena non utilizzabili (es. "sacco vuoto"), duplicati semantici
- KEEP: oggetti magici o unici (anche se sembrano deboli), valuta >=10 monete, oggetti chiave per la trama
- MANTIENI STRUTTURA: Restituisci oggetti JSON { name, quantity, description }
- Normalizza nomi: "Spada +1" invece di "lama affilata magica"
- Aggrega valuta: "150 mo" invece di liste multiple

**Quest:**
- **CRITICO**: Confronta OGNI quest di input con la lista "Quest Attive" nel contesto.
- Se esiste già una quest con significato simile (es. "Uccidere Drago" vs "Sconfiggere il Drago"), **SKIP** a meno che non ci sia un aggiornamento di stato o descrizione.
- **QUEST STATUS**: "OPEN" = Nuova quest o non ancora iniziata. "IN_PROGRESS" = Obiettivi parziali raggiunti, attivita' in corso. "COMPLETED" = Finita con successo. "FAILED" = Fallita.
- MANTIENI STRUTTURA: Restituisci oggetti JSON { title, description, status, type }
- CLASSIFICAZIONE: Se la quest è "Comprare pane" -> SKIP o MINOR. Se è "Salvare il Regno" -> MAJOR.

**Atlante:**
- SKIP se: e' solo una riformulazione generica dello stesso contenuto, e' piu' generica e perde dettagli.
- **AGGREGA**: Se l'input è una stanza specifica (es. "Palazzo - Sala Trono") e l'Atlante ha già il luogo genitore (es. "Palazzo"), **MERGE** nel genitore aggiornando la descrizione con i dettagli della stanza.
- MERGE se: contiene nuovi dettagli osservabili E preserva informazioni storiche esistenti.
- KEEP se: e' la prima descrizione di un luogo macroscopico RILEVANTE.
- Per MERGE: restituisci descrizione unificata che preserva vecchi dettagli + aggiunge novita'.

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
    "keep": [{"name": "Spada +1", "quantity": 1, "description": "Lama elfica"}, {"name": "150 mo", "quantity": 150, "description": "Valuta"}],
    "skip": ["frecce rotte - valore <10mo"]
  },
  "quests": {
    "keep": [{"title": "Recuperare la Spada", "description": "Trovata nella grotta", "status": "IN_PROGRESS", "type": "MAJOR"}],
    "skip": ["parlare con oste - micro-task", "duplicato di quest attiva"]
  },
  "atlas": {
    "action": "keep" | "skip" | "merge",
    "text": "descrizione unificata se action=merge, altrimenti ometti"
  }
}

Rispondi SOLO con il JSON, niente altro.`;

    return prompt;
};
