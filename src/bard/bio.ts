/**
 * Bard Bio - Unified Biography Generation Service
 * Handles Characters (PC), NPCs, and Locations (Atlas)
 */

import { metadataClient, METADATA_MODEL, METADATA_PROVIDER } from './config';
import { monitor } from '../monitor';
import {
    UPDATE_CHARACTER_BIO_PROMPT,
    REGENERATE_NPC_NOTES_PROMPT,
    CHARACTER_NARRATIVE_BIO_PROMPT
} from './prompts';

export type BioEntityType = 'CHARACTER' | 'NPC' | 'LOCATION' | 'QUEST' | 'MONSTER' | 'ITEM';

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
}

/**
 * Genera un prompt specifico per il tipo di entità
 */
function generatePrompt(type: BioEntityType, ctx: BioContext, historyText: string): string {
    const complexity = historyText.length > 500 ? "DETTAGLIATO" : "CONCISO";

    switch (type) {
        case 'CHARACTER':
            // PC: Narrative focus (Foundation + History)
            return CHARACTER_NARRATIVE_BIO_PROMPT(ctx.name, ctx.foundationDescription || '', historyText);

        case 'NPC':
            // NPC: Narrative approach
            return REGENERATE_NPC_NOTES_PROMPT(
                ctx.name,
                ctx.role || 'Sconosciuto',
                ctx.currentDesc || '',
                historyText,
                complexity
            );

        case 'LOCATION':
            // LOCATION: Atmospheric approach
            // TODO: Move this prompt to prompts.ts if it grows complex
            return `Sei l'Archivista di un Atlante Fantasy.
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
    
    Restituisci SOLO il testo della nuova descrizione.`;

        case 'QUEST':
            return `Sei il Bardo, custode delle imprese. Scrivi il **Diario della Missione** per la quest: "${ctx.name}".
STATO ATTUALE: ${ctx.role || 'In Corso'}

CRONOLOGIA EVENTI:
${historyText}

OBIETTIVO:
Scrivi un riassunto narrativo della missione che integri gli eventi accaduti.
- Stile: Diario di bordo o Cronaca avventurosa.
- Includi gli obiettivi raggiunti e quelli falliti.
- Se la quest è conclusa, scrivi un epilogo.
- NO liste puntate, usa paragrafi fluidi.
- Lunghezza: Massimo 200 parole.`;

        case 'MONSTER':
            return `Sei uno Studioso di Mostri. Scrivi il **Dossier Ecologico** per: "${ctx.name}".
NOTE ESISTENTI: ${ctx.currentDesc || 'Nessuna'}

OSSERVAZIONI E INCONTRI:
${historyText}

OBIETTIVO:
Compila una descrizione tecnica ma narrativa della creatura basata SOLO su ciò che è stato osservato.
- Descrivi aspetto, comportamento e abilità viste.
- Evidenzia debolezze o resistenze scoperte (es. "Sembra temere il fuoco").
- Non inventare fatti non supportati dalla storia.
- Stile: Accademico ma pratico (Manuale di Sopravvivenza).`;

        case 'ITEM':
            return `Sei un Antiquario Arcano. Scrivi la **Leggenda** dell'oggetto: "${ctx.name}".
DESCRIZIONE BASE: ${ctx.currentDesc || 'Nessuna'}

STORIA DELL'OGGETTO:
${historyText}

OBIETTIVO:
Scrivi la storia dell'oggetto basandoti sui suoi passaggi di mano e utilizzi.
- Chi lo ha trovato? Chi lo ha usato?
- Ha mostrato poteri particolari?
- Si è danneggiato o modificato nel tempo?
- Stile: Descrizione da catalogo d'asta magica o leggenda sussurrata.`;

        default:
            return `Aggiorna la descrizione di ${ctx.name} basandoti su: ${historyText}`;
    }
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
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [
                { role: "system", content: "Sei un esperto biografo e archivista fantasy." },
                { role: "user", content: prompt }
            ],
            // max_completion_tokens: type === 'CHARACTER' ? 400 : 800 // PC bios are kept shorter
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;

        monitor.logAIRequestWithCost('bio_gen', METADATA_PROVIDER, METADATA_MODEL, inputTokens, outputTokens, 0, latency, false);

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
            }
        }

        console.log(`[BioGen] ✅ Bio aggiornata per ${ctx.name} (${newDesc.length} chars)`);
        return newDesc;

    } catch (e) {
        console.error(`[BioGen] ❌ Errore generazione bio per ${ctx.name}:`, e);
        monitor.logAIRequestWithCost('bio_gen', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return ctx.currentDesc || "";
    }
}
