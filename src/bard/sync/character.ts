/**
 * Bard Sync - Character synchronization functions
 */

import {
    db, // Assuming db is exported from somewhere, otherwise access via queries
    getCharacterHistory,
    getCampaignById,
    getDirtyCharacters,
    getNewCharacterHistory
} from '../../db';
import {
    summaryClient,
    SUMMARY_MODEL,
    SUMMARY_PROVIDER
} from '../config';
import { monitor } from '../../monitor';
import { ingestGenericEvent } from '../rag';

/**
 * Rigenera la descrizione di un personaggio giocante basandosi su NUOVI eventi.
 */
export async function regenerateCharacterDescription(
    charName: string,
    currentDesc: string,
    newEvents: Array<{ description: string, event_type: string }>
): Promise<string> {
    if (newEvents.length === 0) {
        console.log(`[Character] Nessun nuovo evento per ${charName}, mantengo descrizione attuale.`);
        return currentDesc;
    }

    const historyText = newEvents
        .slice(-10)
        .map(h => `[${h.event_type}] ${h.description}`)
        .join('\n');

    const prompt = `Sei il Biografo Personale del personaggio giocante **${charName}**.

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

    const startAI = Date.now();
    try {
        const response = await summaryClient.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [
                { role: "system", content: "Sei un biografo esperto. Integra SOLO i nuovi eventi senza duplicare quelli già presenti. Max 800 caratteri." },
                { role: "user", content: prompt }
            ],
            max_completion_tokens: 300
        });

        const latency = Date.now() - startAI;
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, inputTokens, outputTokens, 0, latency, false);

        const newDesc = response.choices[0].message.content?.trim() || currentDesc;
        console.log(`[Character] Biografia aggiornata per ${charName} (+${newEvents.length} eventi, ${latency}ms)`);

        return newDesc;

    } catch (e) {
        console.error(`[Character] Errore rigenerazione ${charName}:`, e);
        monitor.logAIRequestWithCost('summary', SUMMARY_PROVIDER, SUMMARY_MODEL, 0, 0, 0, Date.now() - startAI, true);
        return currentDesc;
    }
}

/**
 * Sincronizza un personaggio giocante nel RAG (LAZY - solo se necessario)
 */
export async function syncCharacterIfNeeded(
    campaignId: number,
    userId: string,
    force: boolean = false
): Promise<string | null> {
    const char = db.prepare(`
        SELECT character_name, description, rag_sync_needed, last_synced_history_id
        FROM characters
        WHERE user_id = ? AND campaign_id = ?
    `).get(userId, campaignId) as {
        character_name: string,
        description: string | null,
        rag_sync_needed: number,
        last_synced_history_id: number
    } | undefined;

    if (!char || !char.character_name) return null;

    const campaign = getCampaignById(campaignId);
    if (!force && !campaign?.allow_auto_character_update) {
        console.log(`[Sync Character] Auto-update PG disabilitato per campagna ${campaignId}.`);
        return char.description;
    }

    const needsSync = char.rag_sync_needed === 1;
    if (!force && !needsSync) {
        console.log(`[Sync Character] ${char.character_name} già sincronizzato, skip.`);
        return char.description;
    }

    const lastSyncedId = char.last_synced_history_id || 0;
    const { events: newEvents, maxId } = getNewCharacterHistory(campaignId, char.character_name, lastSyncedId);

    if (newEvents.length === 0) {
        console.log(`[Sync Character] ${char.character_name}: nessun nuovo evento da integrare (lastSync: ${lastSyncedId}).`);
        db.prepare(`UPDATE characters SET rag_sync_needed = 0 WHERE user_id = ? AND campaign_id = ?`).run(userId, campaignId);
        return char.description;
    }

    console.log(`[Sync Character] Avvio sync per ${char.character_name} (+${newEvents.length} nuovi eventi, lastSync: ${lastSyncedId} → ${maxId})...`);

    const newDesc = await regenerateCharacterDescription(
        char.character_name,
        char.description || '',
        newEvents
    );

    db.prepare(`
        UPDATE characters
        SET description = ?, rag_sync_needed = 0, last_synced_history_id = ?
        WHERE user_id = ? AND campaign_id = ?
    `).run(newDesc, maxId, userId, campaignId);

    db.prepare(`
        DELETE FROM knowledge_fragments
        WHERE session_id = 'CHARACTER_UPDATE'
          AND associated_npcs LIKE ?
    `).run(`%${char.character_name}%`);

    if (newDesc.length > 100) {
        const ragContent = `[[SCHEDA PERSONAGGIO GIOCANTE: ${char.character_name}]]
DESCRIZIONE AGGIORNATA: ${newDesc}

(Questa scheda ufficiale del PG ha priorità su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'CHARACTER_UPDATE',
            ragContent,
            [char.character_name],
            'PARTY'
        );
    }

    console.log(`[Sync Character] ${char.character_name} sincronizzato (lastSyncedHistoryId: ${maxId}).`);
    return newDesc;
}

/**
 * RESET e rigenera la biografia di un PG da zero.
 */
export async function resetAndRegenerateCharacterBio(
    campaignId: number,
    userId: string
): Promise<string | null> {
    const char = db.prepare(`
        SELECT character_name, description
        FROM characters
        WHERE user_id = ? AND campaign_id = ?
    `).get(userId, campaignId) as { character_name: string, description: string | null } | undefined;

    if (!char || !char.character_name) return null;

    const allEvents = getCharacterHistory(campaignId, char.character_name);

    if (allEvents.length === 0) {
        console.log(`[Character Reset] ${char.character_name}: nessun evento in history, reset a vuoto.`);
        db.prepare(`
            UPDATE characters
            SET description = '', last_synced_history_id = 0, rag_sync_needed = 0
            WHERE user_id = ? AND campaign_id = ?
        `).run(userId, campaignId);
        return '';
    }

    const maxIdResult = db.prepare(`
        SELECT MAX(id) as maxId FROM character_history
        WHERE campaign_id = ? AND lower(character_name) = lower(?)
    `).get(campaignId, char.character_name) as { maxId: number } | undefined;
    const maxId = maxIdResult?.maxId || 0;

    console.log(`[Character Reset] Rigenerazione completa per ${char.character_name} (${allEvents.length} eventi totali)...`);

    const newDesc = await regenerateCharacterDescription(
        char.character_name,
        '',
        allEvents
    );

    db.prepare(`
        UPDATE characters
        SET description = ?, last_synced_history_id = ?, rag_sync_needed = 0
        WHERE user_id = ? AND campaign_id = ?
    `).run(newDesc, maxId, userId, campaignId);

    db.prepare(`
        DELETE FROM knowledge_fragments
        WHERE session_id = 'CHARACTER_UPDATE'
          AND associated_npcs LIKE ?
    `).run(`%${char.character_name}%`);

    if (newDesc.length > 100) {
        const ragContent = `[[SCHEDA PERSONAGGIO GIOCANTE: ${char.character_name}]]
DESCRIZIONE AGGIORNATA: ${newDesc}

(Questa scheda ufficiale del PG ha priorità su informazioni frammentarie precedenti)`;

        await ingestGenericEvent(
            campaignId,
            'CHARACTER_UPDATE',
            ragContent,
            [char.character_name],
            'PARTY'
        );
    }

    console.log(`[Character Reset] ${char.character_name} rigenerato da zero (${allEvents.length} eventi → ${newDesc.length} chars).`);
    return newDesc;
}

/**
 * RESET e rigenera le biografie di TUTTI i PG della campagna.
 */
export async function resetAllCharacterBios(campaignId: number): Promise<{ reset: number, names: string[] }> {
    const allChars = db.prepare(`
        SELECT user_id, character_name
        FROM characters
        WHERE campaign_id = ? AND character_name IS NOT NULL
    `).all(campaignId) as { user_id: string, character_name: string }[];

    if (allChars.length === 0) {
        return { reset: 0, names: [] };
    }

    console.log(`[Character Reset] Reset batch di ${allChars.length} PG...`);
    const resetNames: string[] = [];

    for (const char of allChars) {
        try {
            const newDesc = await resetAndRegenerateCharacterBio(campaignId, char.user_id);
            if (newDesc !== null) {
                resetNames.push(char.character_name);
            }
        } catch (e) {
            console.error(`[Character Reset] Errore per ${char.character_name}:`, e);
        }
    }

    return { reset: resetNames.length, names: resetNames };
}

/**
 * Batch sync di tutti i personaggi dirty
 */
export async function syncAllDirtyCharacters(campaignId: number): Promise<{ synced: number, names: string[] }> {
    const campaign = getCampaignById(campaignId);
    if (!campaign?.allow_auto_character_update) {
        console.log('[Sync Character] Auto-update PG disabilitato per questa campagna.');
        return { synced: 0, names: [] };
    }

    const dirtyChars = getDirtyCharacters(campaignId);

    if (dirtyChars.length === 0) {
        console.log('[Sync Character] Nessun PG da sincronizzare.');
        return { synced: 0, names: [] };
    }

    console.log(`[Sync Character] Sincronizzazione batch di ${dirtyChars.length} PG...`);

    const syncedNames: string[] = [];

    for (const char of dirtyChars) {
        try {
            const newDesc = await syncCharacterIfNeeded(campaignId, char.user_id, true);
            if (newDesc) {
                syncedNames.push(char.character_name);
            }
        } catch (e) {
            console.error(`[Sync Character] Errore sync ${char.character_name}:`, e);
        }
    }

    return { synced: syncedNames.length, names: syncedNames };
}
