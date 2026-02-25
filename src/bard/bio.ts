/**
 * Bard Bio - Unified Biography Generation Service
 * Handles Characters (PC), NPCs, and Locations (Atlas)
 */

import { getMetadataClient } from './config';
import { monitor } from '../monitor';
import {
    UPDATE_CHARACTER_BIO_PROMPT,
    REGENERATE_NPC_NOTES_PROMPT,
    CHARACTER_NARRATIVE_BIO_PROMPT
} from './prompts';

export type BioEntityType = 'CHARACTER' | 'NPC' | 'LOCATION' | 'QUEST' | 'MONSTER' | 'ITEM' | 'FACTION' | 'ARTIFACT';

interface BioContext {
    campaignId?: number; // Optional for backward compat or forced? Should be required really.
    name: string;
    // Context fields (optional based on type)
    role?: string;       // NPC
    class?: string;      // PC
    race?: string;       // PC
    macro?: string;      // Location
    micro?: string;      // Location
    currentDesc?: string;
    foundationDescription?: string; // PC Foundation Bio
    manualDescription?: string; // 🆕 Guida manuale per l'AI
}

/**
 * Genera un prompt specifico per il tipo di entità
 */
function generatePrompt(type: BioEntityType, ctx: BioContext, historyText: string): string {
    const complexity = historyText.length > 500 ? "DETTAGLIATO" : "CONCISO";

    let promptText = '';

    switch (type) {
        case 'CHARACTER':
            promptText = CHARACTER_NARRATIVE_BIO_PROMPT(ctx.name, ctx.foundationDescription || '', historyText);
            break;
        case 'NPC':
            promptText = REGENERATE_NPC_NOTES_PROMPT(ctx.name, ctx.role || 'Sconosciuto', ctx.currentDesc || '', historyText, complexity);
            break;
        case 'LOCATION':
            promptText = `Sei l'Archivista di un Atlante Fantasy.
    Devi aggiornare la descrizione del luogo: **${ctx.macro || '?'} - ${ctx.micro || '?'}**.
    
    DESCRIZIONE ESISTENTE: 
    "${ctx.currentDesc || ''}"
    
    EVENTI/OSSERVAZIONI RECENTI (Cronologia):
    ${historyText}
    
    OBIETTIVO:
    Scrivi una descrizione aggiornata che fonda l'atmosfera originale con i nuovi eventi significativi.
    
    ISTRUZIONI:
    1. **Atmosfera:** Mantieni lo stile evocativo.
    2. **Integrazione:** Se la cronologia dice "la locanda è bruciata", la descrizione DEVE riflettere lo stato di rovina.
    3. **Formato:** Testo descrittivo unico, niente elenchi puntati.
    4. **Limiti:** Massimo 3500 caratteri.
    
    Restituisci SOLO il testo della nuova descrizione.`;
            break;
        case 'QUEST':
            promptText = `Sei il Bardo, custode delle imprese. Scrivi il **Diario della Missione** per la quest: "${ctx.name}".
STATO ATTUALE: ${ctx.role || 'In Corso'}

CRONOLOGIA EVENTI:
${historyText}

OBIETTIVO:
Scrivi un riassunto narrativo della missione che integri gli eventi accaduti.
- Stile: Diario di bordo o Cronaca avventurosa.
- Includi gli obiettivi raggiunti e quelli falliti.
- Se la quest è conclusa, scrivi un epilogo.
- NO liste puntate, usa paragrafi fluidi.
- Lunghezza: Massimo 3000 caratteri.`;
            break;
        case 'MONSTER':
            promptText = `Sei uno Studioso di Mostri. Scrivi il **Dossier Ecologico** per: "${ctx.name}".
NOTE ESISTENTI: ${ctx.currentDesc || 'Nessuna'}

OSSERVAZIONI E INCONTRI:
${historyText}

OBIETTIVO:
Compila una descrizione tecnica ma narrativa della creatura basata SOLO su ciò che è stato osservato.
- Descrivi aspetto, comportamento e abilità viste.
- Evidenzia debolezze o resistenze scoperte (es. "Sembra temere il fuoco").
- Non inventare fatti non supportati dalla storia.
- Stile: Accademico ma pratico (Manuale di Sopravvivenza).
- Lunghezza: Massimo 3500 caratteri.`;
            break;
        case 'ITEM':
            promptText = `Sei un Antiquario Arcano. Scrivi la **Leggenda** dell'oggetto: "${ctx.name}".
DESCRIZIONE BASE: ${ctx.currentDesc || 'Nessuna'}

STORIA DELL'OGGETTO:
${historyText}

OBIETTIVO:
Scrivi la storia dell'oggetto basandoti sui suoi passaggi di mano e utilizzi.
- Chi lo ha trovato? Chi lo ha usato?
- Ha mostrato poteri particolari?
- Si è danneggiato o modificato nel tempo?
- Stile: Descrizione da catalogo d'asta magica o leggenda sussurrata.
- Lunghezza: Massimo 3000 caratteri.`;
            break;
        case 'FACTION':
            promptText = `Sei uno Storico Politico. Scrivi il **Rapporto di Intelligence** per la fazione: "${ctx.name}".
DESCRIZIONE ESISTENTE: ${ctx.currentDesc || 'Nessuna'}

MOVIMENTI E AZIONI RECENTI:
${historyText}

OBIETTIVO:
Aggiorna la descrizione della fazione integrando le sue mosse recenti e i cambiamenti di status/reputazione.
- Come sono cambiate le sue alleanze?
- Ha guadagnato o perso influenza?
- Stile: Analitico e Persuasivo.
- Focus: Obiettivi politici, reputazione e struttura di potere.
- Lunghezza: Massimo 3500 caratteri.`;
            break;
        case 'ARTIFACT':
            promptText = `Sei il Custode delle Reliquie. Scrivi la **Storia dell'Artefatto**: "${ctx.name}".
DESCRIZIONE ESISTENTE: ${ctx.currentDesc || 'Nessuna'}

EVENTI E UTILIZZI:
${historyText}

OBIETTIVO:
Narra la storia recente dell'artefatto, chi lo ha impugnato e quali poteri ha manifestato.
- Se ha cambiato proprietario, descrivi come.
- Se sono emersi nuovi poteri o maledizioni, integrali nella descrizione.
- Stile: Mitologico e Solenne.
- Lunghezza: Massimo 3000 caratteri.`;
            break;
        default:
            promptText = `Aggiorna la descrizione di ${ctx.name} basandoti su: ${historyText}`;
    }

    // 🆕 UNIVERSAL MANUAL DESCRIPTION PROTECTION
    if (ctx.manualDescription) {
        promptText = `⚠️ DESCRIZIONE MANUALE VINCOLANTE (FONDAZIONE):
"${ctx.manualDescription}"

${promptText}

ISTRUZIONE CRITICA:
Non contraddire la descrizione manuale. Usala come scheletro e arricchiscila con gli eventi recenti, ma mantieni inalterati i fatti chiave stabiliti dall'utente.`;
    }

    return promptText;
}


/**
 * Unified Bio Generator
 */
export async function generateBio(
    type: BioEntityType,
    ctx: BioContext,
    historyEvents: Array<{ description: string, event_type: string }>
): Promise<string> {

    // 1. Filter empty events
    const validEvents = historyEvents.filter(e => e.description && e.description.trim().length > 0);

    if (validEvents.length === 0) {
        console.log(`[BioGen] ⏩ Nessun evento per ${type} ${ctx.name}, skip regen.`);
        return ctx.currentDesc || "";
    }

    // 2. Prepare History Text
    // Limit history length to fit context window if needed, prioritizing recent events?
    // For now, take last 20 events.
    const recentEvents = validEvents.slice(-20);
    const historyText = recentEvents
        .map(h => `[${h.event_type}] ${h.description}`)
        .join('\n');

    console.log(`[BioGen] 🧬 Generazione bio per ${type} ${ctx.name} (${validEvents.length} eventi)...`);

    // 3. Select Prompt
    const prompt = generatePrompt(type, ctx, historyText);

    // 4. Call LLM
    const startAI = Date.now();
    try {
        const { client, model, provider } = await getMetadataClient();
        const response = await client.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: "Sei un esperto biografo e archivista fantasy. Rispondi in italiano. Sii conciso se necessario per non superare i limiti di spazio." },
                { role: "user", content: prompt }
            ],
            max_completion_tokens: 1000 // Ensure output is well within Discord's 4096 char limit for descriptions
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;

        monitor.logAIRequestWithCost('bio_gen', provider, model, inputTokens, outputTokens, 0, latency, false);

        const newDesc = response.choices[0].message.content?.trim() || ctx.currentDesc || "";

        // 5. Persist Changes (Phase 2 Unification)
        if (ctx.campaignId) {
            const campaignId = ctx.campaignId;
            switch (type) {
                case 'QUEST': {
                    const { questRepository } = await import('../db/repositories/QuestRepository');
                    questRepository.updateQuestDescription(campaignId, ctx.name, newDesc);
                    break;
                }
                case 'MONSTER': {
                    const { bestiaryRepository } = await import('../db/repositories/BestiaryRepository');
                    bestiaryRepository.updateBestiaryDescription(campaignId, ctx.name, newDesc);
                    break;
                }
                case 'ITEM': {
                    const { inventoryRepository } = await import('../db/repositories/InventoryRepository');
                    inventoryRepository.updateInventoryDescription(campaignId, ctx.name, newDesc);
                    break;
                }
                case 'FACTION': {
                    const { factionRepository } = await import('../db/repositories/FactionRepository');
                    factionRepository.updateFaction(campaignId, ctx.name, { description: newDesc }, false);
                    break;
                }
                case 'ARTIFACT': {
                    const { artifactRepository } = await import('../db/repositories/ArtifactRepository');
                    artifactRepository.updateArtifactDescription(campaignId, ctx.name, newDesc);
                    break;
                }
            }
        }

        console.log(`[BioGen] ✅ Bio aggiornata per ${ctx.name} (${newDesc.length} chars)`);
        return newDesc;

    } catch (e) {
        console.error(`[BioGen] ❌ Errore generazione bio per ${ctx.name}:`, e);
        // Fallback static logging on failure since we might not have dynamic provider initialized
        monitor.logAIRequestWithCost('bio_gen', 'openai', 'gpt-4o-mini', 0, 0, 0, Date.now() - startAI, true);
        return ctx.currentDesc || "";
    }
}

/**
 * Genera descrizioni per più entità in una singola chiamata (Risparmio Token ~40%)
 */
/**
 * Genera descrizioni per più entità in una singola chiamata (Risparmio Token ~40%)
 */
export async function generateBioBatch(
    type: BioEntityType,
    items: Array<{ name: string, context: BioContext, history: string }>
): Promise<Record<string, string>> {

    if (items.length === 0) return {};

    console.log(`[BioBatch] 🧬 Avvio generazione batch per ${items.length} entità di tipo ${type}...`);

    // Costruiamo un payload compatto
    const payload = items.map(i => ({
        id: i.name,
        current_desc: i.context.currentDesc?.substring(0, 500) || "Nessuna", // Tronchiamo per risparmiare input
        manual_guidance: i.context.manualDescription || null, // 🆕 Include guida manuale
        recent_events: i.history
    }));

    const systemPrompt = `Sei l'Archivista di ${type}. Aggiorna le descrizioni delle seguenti entità basandoti sui nuovi eventi.
Sii CONCISO (max 3 frasi per entità).
IMPORTANTE: Se presente "manual_guidance", usala come scheletro vincolante. Non contraddirla.
Restituisci SOLO un JSON valido formato: { "Nome Entità": "Nuova Descrizione" }.`;

    try {
        const { client, model, provider } = await getMetadataClient();
        const bioOptions: any = {
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: JSON.stringify(payload) }
            ],
        };
        if (provider === 'openai') bioOptions.response_format = { type: "json_object" };
        else if (provider === 'ollama') bioOptions.format = 'json';
        const response = await client.chat.completions.create(bioOptions);

        const content = response.choices[0].message.content;
        if (!content) return {};

        const results = JSON.parse(content);
        return results; // Mappa { "Nome": "Descrizione" }

    } catch (e) {
        console.error(`[BioBatch] Errore batch:`, e);
        return {}; // Fallback sicuro
    }
}
