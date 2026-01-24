/**
 * Bard Bio - Unified Biography Generation Service
 * Handles Characters (PC), NPCs, and Locations (Atlas)
 */

import { metadataClient, METADATA_MODEL, METADATA_PROVIDER } from './config';
import { monitor } from '../monitor';
import {
    UPDATE_CHARACTER_BIO_PROMPT,
    REGENERATE_NPC_NOTES_PROMPT,
} from './prompts';

export type BioEntityType = 'CHARACTER' | 'NPC' | 'LOCATION';

interface BioContext {
    name: string;
    // Context fields (optional based on type)
    role?: string;       // NPC
    class?: string;      // PC
    race?: string;       // PC
    macro?: string;      // Location
    micro?: string;      // Location
    currentDesc?: string;
}

/**
 * Genera un prompt specifico per il tipo di entità
 */
function generatePrompt(type: BioEntityType, ctx: BioContext, historyText: string): string {
    const complexity = historyText.length > 500 ? "DETTAGLIATO" : "CONCISO";

    switch (type) {
        case 'CHARACTER':
            // PC: Conservative approach (Agency first)
            return UPDATE_CHARACTER_BIO_PROMPT(ctx.name, ctx.currentDesc || '', historyText);

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

        console.log(`[BioGen] ✅ Bio aggiornata per ${ctx.name} (${newDesc.length} chars)`);
        return newDesc;

    } catch (e) {
        console.error(`[BioGen] ❌ Errore generazione bio per ${ctx.name}:`, e);
        monitor.logAIRequestWithCost('bio_gen', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return ctx.currentDesc || "";
    }
}
