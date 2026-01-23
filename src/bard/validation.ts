/**
 * Bard Validation - Batch validation system
 */

import { ValidationBatchInput, ValidationBatchOutput } from './types';
import { metadataClient, METADATA_PROVIDER, METADATA_MODEL } from './config';
import { monitor } from '../monitor';
import { getNpcHistory, getCharacterHistory, getOpenQuests } from '../db';

/**
 * Costruisce il prompt per la validazione batch
 */
function buildValidationPrompt(context: any, input: ValidationBatchInput): string {
    let prompt = `Valida questi dati di una sessione D&D in BATCH.

**CONTESTO:**
`;

    if (context.npcHistories && Object.keys(context.npcHistories).length > 0) {
        prompt += "\n**Storia Recente NPC:**\n";
        for (const [name, history] of Object.entries(context.npcHistories)) {
            prompt += `- ${name}: ${history}\n`;
        }
    }

    if (context.charHistories && Object.keys(context.charHistories).length > 0) {
        prompt += "\n**Storia Recente PG:**\n";
        for (const [name, history] of Object.entries(context.charHistories)) {
            prompt += `- ${name}: ${history}\n`;
        }
    }

    if (context.existingQuests && context.existingQuests.length > 0) {
        prompt += `\n**Quest Attive (DA NON DUPLICARE):**\n${context.existingQuests.map((q: string) => `- ${q}`).join('\n')}\n`;
    }

    prompt += "\n**DATI DA VALIDARE:**\n\n";

    if (input.npc_events && input.npc_events.length > 0) {
        prompt += `**Eventi NPC (${input.npc_events.length}):**\n`;
        input.npc_events.forEach((e, i) => {
            prompt += `${i + 1}. ${e.name}: [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    if (input.character_events && input.character_events.length > 0) {
        prompt += `**Eventi PG (${input.character_events.length}):**\n`;
        input.character_events.forEach((e, i) => {
            prompt += `${i + 1}. ${e.name}: [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    if (input.world_events && input.world_events.length > 0) {
        prompt += `**Eventi Mondo (${input.world_events.length}):**\n`;
        input.world_events.forEach((e, i) => {
            prompt += `${i + 1}. [${e.type}] ${e.event}\n`;
        });
        prompt += "\n";
    }

    if (input.loot && input.loot.length > 0) {
        prompt += `**Loot (${input.loot.length}):**\n`;
        input.loot.forEach((item, i) => prompt += `${i + 1}. ${item}\n`);
        prompt += "\n";
    }

    if (input.quests && input.quests.length > 0) {
        prompt += `**Quest (${input.quests.length}):**\n`;
        input.quests.forEach((q, i) => prompt += `${i + 1}. ${q}\n`);
        prompt += "\n";
    }

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

Rispondi SOLO con il JSON, niente altro.`;

    return prompt;
}

/**
 * VALIDATORE BATCH UNIFICATO - Ottimizzato per costi
 */
export async function validateBatch(
    campaignId: number,
    input: ValidationBatchInput
): Promise<ValidationBatchOutput> {

    const context: any = {};

    if (input.npc_events && input.npc_events.length > 0) {
        const npcNames = [...new Set(input.npc_events.map(e => e.name))];
        context.npcHistories = {};

        for (const name of npcNames) {
            const history = getNpcHistory(campaignId, name).slice(-10);
            if (history.length > 0) {
                context.npcHistories[name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    if (input.character_events && input.character_events.length > 0) {
        const charNames = [...new Set(input.character_events.map(e => e.name))];
        context.charHistories = {};

        for (const name of charNames) {
            const history = getCharacterHistory(campaignId, name).slice(-3);
            if (history.length > 0) {
                context.charHistories[name] = history.map((h: any) =>
                    `[${h.event_type}] ${h.description}`
                ).join('; ');
            }
        }
    }

    if (input.quests && input.quests.length > 0) {
        context.existingQuests = getOpenQuests(campaignId).map((q: any) => q.title);
    }

    const prompt = buildValidationPrompt(context, input);

    const startAI = Date.now();
    try {
        const response = await metadataClient.chat.completions.create({
            model: METADATA_MODEL,
            messages: [
                { role: "system", content: "Sei il Custode degli Archivi di una campagna D&D. Valida dati in batch. Rispondi SOLO con JSON valido in italiano." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;

        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, inputTokens, outputTokens, cachedTokens, latency, false);

        console.log(`[Validator] Validazione completata in ${latency}ms (${inputTokens}+${outputTokens} tokens)`);

        const result = JSON.parse(response.choices[0].message.content || "{}");

        return {
            npc_events: result.npc_events || { keep: input.npc_events || [], skip: [] },
            character_events: result.character_events || { keep: input.character_events || [], skip: [] },
            world_events: result.world_events || { keep: input.world_events || [], skip: [] },
            loot: result.loot || { keep: input.loot || [], skip: [] },
            quests: result.quests || { keep: input.quests || [], skip: [] },
            atlas: result.atlas || { action: 'keep' }
        };

    } catch (e: any) {
        console.error('[Validator] Errore batch validation:', e);
        monitor.logAIRequestWithCost('metadata', METADATA_PROVIDER, METADATA_MODEL, 0, 0, 0, Date.now() - startAI, true);

        return {
            npc_events: { keep: input.npc_events || [], skip: [] },
            character_events: { keep: input.character_events || [], skip: [] },
            world_events: { keep: input.world_events || [], skip: [] },
            loot: { keep: input.loot || [], skip: [] },
            quests: { keep: input.quests || [], skip: [] },
            atlas: { action: 'keep' }
        };
    }
}
