import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { db, getSessionCampaignId } from '../../db';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { monitor } from '../../monitor';
import { processSessionReport } from '../../reporter';
import * as fs from 'fs';
import * as path from 'path';

interface SessionInfo {
    session_id: string;
    campaign_id: number;
    start_time: number;
    title: string | null;
    session_number: number | null;
}

interface DiagnosticStats {
    sessions: number;
    npcs: number;
    locations: number;
    npcEvents: number;
    worldEvents: number;
    characterEvents: number;
    quests: number;
    inventory: number;
    bestiary: number;
    ragFragments: number;
    factions: number;
    factionEvents: number;
}

/**
 * Gets diagnostic statistics for all derived data
 */
function getDiagnostics(): DiagnosticStats {
    const count = (table: string) => {
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
        return row.c;
    };

    return {
        sessions: count('sessions'),
        npcs: count('npc_dossier'),
        locations: count('location_atlas'),
        npcEvents: count('npc_history'),
        worldEvents: count('world_history'),
        characterEvents: count('character_history'),
        quests: count('quests'),
        inventory: count('inventory'),
        bestiary: count('bestiary'),
        ragFragments: count('knowledge_fragments'),
        factions: count('factions'),
        factionEvents: count('faction_history')
    };
}

/**
 * Gets all completed sessions ordered by start time
 */
function getCompletedSessions(): SessionInfo[] {
    return db.prepare(`
        SELECT
            s.session_id,
            s.campaign_id,
            s.title,
            s.session_number,
            MIN(r.timestamp) as start_time
        FROM sessions s
        JOIN recordings r ON r.session_id = s.session_id
        WHERE r.status = 'PROCESSED'
        AND r.transcription_text IS NOT NULL
        GROUP BY s.session_id
        HAVING COUNT(*) > 0
        ORDER BY start_time ASC
    `).all() as SessionInfo[];
}

interface ValidationResult {
    valid: boolean;
    sessions: SessionInfo[];
    issues: { session_id: string; title: string | null; reason: string }[];
}

/**
 * Pre-flight check: validates all sessions have required data before any deletion
 */
function validateRebuildReadiness(): ValidationResult {
    const sessions = getCompletedSessions();
    const issues: { session_id: string; title: string | null; reason: string }[] = [];

    for (const session of sessions) {
        // Check 1: campaign_id must exist
        if (!session.campaign_id) {
            issues.push({
                session_id: session.session_id,
                title: session.title,
                reason: 'Nessuna campagna associata'
            });
            continue;
        }

        // Check 2: must have at least one transcription with text
        const transcriptCount = db.prepare(`
            SELECT COUNT(*) as cnt FROM recordings
            WHERE session_id = ?
            AND status = 'PROCESSED'
            AND transcription_text IS NOT NULL
            AND LENGTH(transcription_text) > 10
        `).get(session.session_id) as { cnt: number };

        // Check 3: or at least one note
        const noteCount = db.prepare(`
            SELECT COUNT(*) as cnt FROM session_notes
            WHERE session_id = ?
        `).get(session.session_id) as { cnt: number };

        if (transcriptCount.cnt === 0 && noteCount.cnt === 0) {
            issues.push({
                session_id: session.session_id,
                title: session.title,
                reason: 'Nessuna trascrizione o nota disponibile'
            });
        }
    }

    return {
        valid: issues.length === 0,
        sessions,
        issues
    };
}

/**
 * Soft reset: preserves NPC and location names, clears descriptions
 */
function softResetAnagrafiche(): { npcs: number; locations: number; factions: number } {
    // Reset NPC descriptions but keep names, roles, status, aliases
    const npcResult = db.prepare(`
        UPDATE npc_dossier
        SET description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
        WHERE COALESCE(is_manual, 0) = 0
    `).run();

    // Reset character bios but keep foundation_description
    db.prepare(`
        UPDATE characters
        SET description = foundation_description,
            rag_sync_needed = 1,
            last_synced_history_id = 0
        WHERE COALESCE(is_manual, 0) = 0
    `).run();

    // Reset location descriptions but keep macro/micro names
    const locationResult = db.prepare(`
        UPDATE location_atlas
        SET description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
        WHERE COALESCE(is_manual, 0) = 0
    `).run();

    // Reset faction descriptions
    const factionResult = db.prepare(`
        UPDATE factions
        SET description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
        WHERE COALESCE(is_manual, 0) = 0 AND is_party = 0
    `).run();

    return {
        npcs: npcResult.changes,
        locations: locationResult.changes,
        factions: factionResult.changes
    };
}

/**
 * Hard purge: deletes all historical/derived data
 */
function purgeAllDerivedData(): Record<string, number> {
    const results: Record<string, number> = {};

    const tablesWithManual = [
        'character_history',
        'npc_history',
        'world_history',
        'location_history',
        'quests',
        'inventory',
        'bestiary',
        'atlas_history',
        'quest_history',
        'bestiary_history',
        'inventory_history',
        'faction_history'
    ];

    for (const table of tablesWithManual) {
        // Only delete entries NOT marked as manual
        const result = db.prepare(`DELETE FROM ${table} WHERE COALESCE(is_manual, 0) = 0`).run();
        results[table] = result.changes;
    }

    // Always full wipe RAG fragments (they will be regenerated from source)
    const ragResult = db.prepare('DELETE FROM knowledge_fragments').run();
    results['knowledge_fragments'] = ragResult.changes;

    // Also reset character sync state but preserve manual descriptions and foundation
    db.prepare(`
        UPDATE characters
        SET description = CASE WHEN COALESCE(is_manual, 0) = 1 THEN description ELSE COALESCE(foundation_description, '') END,
            last_synced_history_id = 0,
            rag_sync_needed = 1
    `).run();

    return results;
}

/**
 * Prune "zombie" entities: deletes NPCs/Locations that remained without description after rebuild
 */
export function pruneEmptyEntities(): { npcs: number; locations: number } {
    return db.transaction(() => {
        // 1. Identify NPCs to delete
        const npcsToDelete = db.prepare(`
            SELECT id, name FROM npc_dossier
            WHERE (description IS NULL 
                OR length(description) < 5
                OR description LIKE 'Nessuna descrizione%')
                AND COALESCE(is_manual, 0) = 0
        `).all() as { id: number; name: string }[];

        // 2. Identify Locations to delete
        const locationsToDelete = db.prepare(`
            SELECT id, macro_location, micro_location FROM location_atlas
            WHERE (description IS NULL 
                OR length(description) < 10
                OR description LIKE 'Nessuna descrizione%')
                AND COALESCE(is_manual, 0) = 0
        `).all() as { id: number; macro_location: string; micro_location: string }[];

        // 3. Delete NPC history and faction affiliations first
        for (const npc of npcsToDelete) {
            db.prepare('DELETE FROM npc_history WHERE npc_name = ?').run(npc.name);
            db.prepare('DELETE FROM faction_affiliations WHERE entity_type = ? AND entity_id = ?').run('npc', npc.id);
        }

        // 4. Delete Location history and faction affiliations
        for (const loc of locationsToDelete) {
            db.prepare(`
                DELETE FROM location_history 
                WHERE lower(macro_location) = lower(?) 
                AND lower(micro_location) = lower(?)
            `).run(loc.macro_location, loc.micro_location);

            db.prepare(`
                DELETE FROM atlas_history 
                WHERE lower(macro_location) = lower(?) 
                AND lower(micro_location) = lower(?)
            `).run(loc.macro_location, loc.micro_location);

            // Clean up faction affiliations for this location
            db.prepare('DELETE FROM faction_affiliations WHERE entity_type = ? AND entity_id = ?').run('location', loc.id);
        }

        // 5. Delete actual entities
        const npcResult = db.prepare(`
            DELETE FROM npc_dossier
            WHERE (description IS NULL 
                OR length(description) < 5
                OR description LIKE 'Nessuna descrizione%')
                AND COALESCE(is_manual, 0) = 0
        `).run();

        const locationResult = db.prepare(`
            DELETE FROM location_atlas
            WHERE (description IS NULL 
                OR length(description) < 10
                OR description LIKE 'Nessuna descrizione%')
                AND COALESCE(is_manual, 0) = 0
        `).run();

        // 6. Also cleanup any orphaned faction affiliations (entities deleted outside this function)
        db.prepare(`
            DELETE FROM faction_affiliations 
            WHERE entity_type = 'npc' 
            AND entity_id NOT IN (SELECT id FROM npc_dossier)
        `).run();

        db.prepare(`
            DELETE FROM faction_affiliations 
            WHERE entity_type = 'location' 
            AND entity_id NOT IN (SELECT id FROM location_atlas)
        `).run();

        return {
            npcs: npcResult.changes,
            locations: locationResult.changes
        };
    })();
}

export const rebuildCommand: Command = {
    name: 'rebuild',
    aliases: ['rebuild_index', 'reindex'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, client } = ctx;
        const channel = message.channel as TextChannel;

        // Developer check
        const DEVELOPER_ID = process.env.DISCORD_DEVELOPER_ID || '310865403066712074';
        if (message.author.id !== DEVELOPER_ID) {
            await message.reply("Solo il developer puo' eseguire questo comando.");
            return;
        }

        // --- DIAGNOSTIC MODE (no args) ---
        if (!args[0]) {
            const stats = getDiagnostics();
            const sessions = getCompletedSessions();

            const diagnosticMsg = `📊 **DIAGNOSTICA DATABASE**
            
**Anagrafiche (verranno preservati i NOMI):**
- NPC nel dossier: **${stats.npcs}**
- Luoghi nell'atlante: **${stats.locations}**
- Fazioni: **${stats.factions}**

**Dati Storici (verranno CANCELLATI e rigenerati):**
- Eventi NPC: **${stats.npcEvents}**
- Eventi Mondo: **${stats.worldEvents}**
- Eventi PG: **${stats.characterEvents}**
- Eventi Fazioni: **${stats.factionEvents}**
- Quest: **${stats.quests}**
- Oggetti inventario: **${stats.inventory}**
- Creature bestiario: **${stats.bestiary}**
- Frammenti RAG: **${stats.ragFragments}**

**Sessioni da ri-processare:** ${sessions.length}
${sessions.slice(0, 5).map((s, i) => `  ${i + 1}. \`${s.session_id.slice(0, 8)}...\` - ${s.title || 'Senza titolo'}`).join('\n')}
${sessions.length > 5 ? `  ... e altre ${sessions.length - 5}` : ''}

---
⚠️ Per procedere con il rebuild, scrivi:
\`$rebuild CONFIRM\`

Il processo:
1. Resettera' le descrizioni di NPC e luoghi (nomi preservati)
2. Cancellera' TUTTI i dati storici
3. Rigenerera' tutto dalle trascrizioni originali
`;

            await message.reply(diagnosticMsg);
            return;
        }

        // --- CONFIRM MODE ---
        if (args[0].toUpperCase() !== 'CONFIRM') {
            await message.reply("Uso: `$rebuild` (diagnostica) o `$rebuild CONFIRM [FORCE]` (esegui)");
            return;
        }

        const forceRegeneration = args[1]?.toUpperCase() === 'FORCE';
        if (forceRegeneration) {
            await message.reply("⚠️ **MODALITÀ FORCE ATTIVA**: Verrà forzata la rigenerazione AI di tutti i riassunti (Costi aggiuntivi!).");
        } else {
            await message.reply("ℹ️ **MODALITÀ SMART**: Verranno usati i dati AI salvati se disponibili (Zero costi).");
        }

        // Double confirmation
        await message.reply(
            `⚠️ **CONFERMA FINALE**\n\n` +
            `Stai per:\n` +
            `1. Resettare le descrizioni di NPC e luoghi\n` +
            `2. Cancellare TUTTI i dati storici (eventi, quest, loot, RAG)\n` +
            `3. Rigenerare tutto dalle trascrizioni\n\n` +
            `Scrivi \`RICOSTRUISCI\` entro 30 secondi per procedere.`
        );

        try {
            const collected = await channel.awaitMessages({
                filter: (m: Message) => m.author.id === message.author.id && m.content === 'RICOSTRUISCI',
                max: 1,
                time: 30000,
                errors: ['time']
            });

            if (collected.size === 0) {
                await message.reply("⌛ Tempo scaduto. Operazione annullata.");
                return;
            }
        } catch {
            await message.reply("⌛ Tempo scaduto. Operazione annullata.");
            return;
        }

        // --- EXECUTE REBUILD ---
        const rebuildSessionId = `rebuild-${Date.now()}`;
        monitor.startSession(rebuildSessionId);
        console.log(`[Rebuild] 📊 Monitor avviato per sessione ${rebuildSessionId}`);

        const statusMsg = await channel.send("🔄 **REBUILD AVVIATO**\n\n⏳ Fase 0/3: Validazione pre-flight...");

        try {
            // Phase 0: PRE-FLIGHT VALIDATION (before any deletion!)
            const validation = validateRebuildReadiness();

            if (!validation.valid) {
                await monitor.endSession(); // Clean up monitor

                let errorMsg = `❌ **REBUILD ANNULLATO - Validazione fallita**\n\n` +
                    `Trovate **${validation.issues.length}** sessioni senza dati sufficienti:\n\n`;

                for (const issue of validation.issues.slice(0, 10)) {
                    const label = issue.title || issue.session_id.slice(0, 8);
                    errorMsg += `• **${label}**: ${issue.reason}\n`;
                }

                if (validation.issues.length > 10) {
                    errorMsg += `\n... e altre ${validation.issues.length - 10} sessioni con problemi`;
                }

                errorMsg += `\n\n⚠️ **Nessun dato è stato cancellato.**\n` +
                    `Correggi i problemi sopra prima di riprovare.`;

                await statusMsg.edit(errorMsg);
                return;
            }

            await statusMsg.edit(
                `🔄 **REBUILD IN CORSO**\n\n` +
                `✅ Fase 0/3: Validazione OK (${validation.sessions.length} sessioni pronte)\n\n` +
                `⏳ Fase 1/3: Reset anagrafiche...`
            );

            // Phase 1: Soft reset anagrafiche (NOW safe to proceed)
            const resetStats = softResetAnagrafiche();
            await statusMsg.edit(
                `🔄 **REBUILD IN CORSO**\n\n` +
                `✅ Fase 0/4: Validazione OK\n` +
                `✅ Fase 1/4: Anagrafiche resettate\n` +
                `   - ${resetStats.npcs} NPC (nomi preservati)\n` +
                `   - ${resetStats.locations} luoghi (nomi preservati)\n` +
                `   - ${resetStats.factions} fazioni (nomi preservati)\n\n` +
                `⏳ Fase 2/4: Pulizia dati storici...`
            );

            // Phase 2: Purge all derived data
            const purgeStats = purgeAllDerivedData();
            const totalPurged = Object.values(purgeStats).reduce((a, b) => a + b, 0);

            await statusMsg.edit(
                `🔄 **REBUILD IN CORSO**\n\n` +
                `✅ Fase 0/4: Validazione OK\n` +
                `✅ Fase 1/4: Anagrafiche resettate\n` +
                `✅ Fase 2/4: Dati storici cancellati (${totalPurged} record)\n` +
                `   - Eventi NPC: ${purgeStats.npc_history}\n` +
                `   - Eventi Mondo: ${purgeStats.world_history}\n` +
                `   - Eventi PG: ${purgeStats.character_history}\n` +
                `   - Eventi Fazioni: ${purgeStats.faction_history}\n` +
                `   - RAG: ${purgeStats.knowledge_fragments}\n\n` +
                `⏳ Fase 3/4: Rigenerazione sessioni...`
            );

            // Phase 3: Regenerate all sessions
            const sessions = getCompletedSessions();
            const pipelineService = new PipelineService();
            const ingestionService = new IngestionService();

            let successCount = 0;
            let errorCount = 0;
            const errors: string[] = [];

            for (let i = 0; i < sessions.length; i++) {
                const session = sessions[i];
                const progress = `[${i + 1}/${sessions.length}]`;
                const sessionLabel = session.title || session.session_id.slice(0, 8);

                // Update status every 3 sessions or on first/last
                if (i === 0 || i === sessions.length - 1 || i % 3 === 0) {
                    await statusMsg.edit(
                        `🔄 **REBUILD IN CORSO**\n\n` +
                        `✅ Fase 1/3: Anagrafiche resettate\n` +
                        `✅ Fase 2/3: Dati storici cancellati\n` +
                        `⏳ Fase 3/4: ${progress} Processando **${sessionLabel}**...\n\n` +
                        `Completate: ${successCount} | Errori: ${errorCount}`
                    );
                }

                try {
                    console.log(`[Rebuild] ${progress} Inizio sessione ${session.session_id}`);

                    // CLEANUP: Rimuovi vecchi file di debug per evitare duplicati (es. writer_prompt.txt vs act1)
                    const debugDir = path.join(__dirname, '..', '..', '..', 'transcripts', session.session_id, 'debug_prompts');
                    if (fs.existsSync(debugDir)) {
                        try {
                            const files = fs.readdirSync(debugDir);
                            for (const file of files) {
                                fs.unlinkSync(path.join(debugDir, file));
                            }
                            console.log(`[Rebuild] 🧹 Pulita cartella debug per ${session.session_id}`);
                        } catch (cleanupErr) {
                            console.warn(`[Rebuild] ⚠️ Errore pulizia debug dir:`, cleanupErr);
                        }
                    }

                    // Generate summary
                    const campaignId = session.campaign_id || getSessionCampaignId(session.session_id);
                    if (!campaignId) {
                        throw new Error('Campaign ID non trovato');
                    }

                    const result = await pipelineService.generateSessionSummary(
                        session.session_id,
                        campaignId,
                        'DM',
                        { forceRegeneration } // 🆕 Pass force flag
                    );

                    // Ingest to RAG
                    await ingestionService.ingestSummary(session.session_id, result);
                    ingestionService.updateSessionTitle(session.session_id, result.title);

                    // Process events
                    await ingestionService.processBatchEvents(
                        campaignId,
                        session.session_id,
                        result,
                        undefined // No channel notifications during rebuild
                    );

                    // Mark as DONE in state machine
                    const { sessionPhaseManager } = await import('../../services/SessionPhaseManager');
                    sessionPhaseManager.setPhase(session.session_id, 'DONE');

                    successCount++;
                    console.log(`[Rebuild] ${progress} Sessione ${session.session_id} completata`);

                    // Cooldown to avoid API rate limits
                    await new Promise(r => setTimeout(r, 3000));

                } catch (err: any) {
                    errorCount++;
                    const errMsg = `${sessionLabel}: ${err.message}`;
                    errors.push(errMsg);
                    console.error(`[Rebuild] ${progress} ERRORE sessione ${session.session_id}:`, err);

                    // Continue with next session
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            // Phase 4: Final Pruning
            await statusMsg.edit(
                `🔄 **REBUILD IN CORSO**\n\n` +
                `✅ Fase 1/4: Anagrafiche resettate\n` +
                `✅ Fase 2/4: Dati storici cancellati\n` +
                `✅ Fase 3/4: Rigenerazione completata (${successCount} sessioni)\n` +
                `⏳ Fase 4/4: Pulizia entità vuote...`
            );

            const pruneStats = pruneEmptyEntities();
            console.log(`[Rebuild] 🧹 Pruned ${pruneStats.npcs} NPCs and ${pruneStats.locations} Locations.`);

            // Final report
            const finalStats = getDiagnostics();
            let finalMessage = `✅ **REBUILD COMPLETATO**\n\n` +
                `**Risultato:**\n` +
                `- Sessioni processate: ${successCount}/${sessions.length}\n` +
                `- Errori: ${errorCount}\n\n` +
                `**Nuovo stato database:**\n` +
                `- NPC Rimossi (Vuoti): ${pruneStats.npcs}\n` +
                `- Luoghi Rimossi (Vuoti): ${pruneStats.locations}\n` +
                `- Eventi NPC: ${finalStats.npcEvents}\n` +
                `- Eventi Mondo: ${finalStats.worldEvents}\n` +
                `- Eventi PG: ${finalStats.characterEvents}\n` +
                `- Eventi Fazioni: ${finalStats.factionEvents}\n` +
                `- Quest: ${finalStats.quests}\n` +
                `- Inventario: ${finalStats.inventory}\n` +
                `- Frammenti RAG: ${finalStats.ragFragments}`;

            if (errors.length > 0) {
                finalMessage += `\n\n**Errori:**\n${errors.slice(0, 5).map(e => `- ${e}`).join('\n')}`;
                if (errors.length > 5) {
                    finalMessage += `\n... e altri ${errors.length - 5} errori`;
                }
            }

            await statusMsg.edit(finalMessage);

            // Send technical report via email
            await sendTechnicalReport(rebuildSessionId, sessions, successCount, sessions.length, errorCount, errors);

        } catch (err: any) {
            console.error('[Rebuild] Errore critico:', err);
            await statusMsg.edit(`❌ **ERRORE CRITICO**\n\n${err.message}`);

            // Send report even on critical error
            monitor.logError('Rebuild', err.message);
            await sendTechnicalReport(rebuildSessionId, [], 0, 0, 1, [err.message]);
        }
    }
};

/**
 * Sends technical report email with rebuild costs
 */
export async function sendTechnicalReport(
    rebuildSessionId: string,
    sessions: SessionInfo[],
    successCount: number,
    totalSessions: number,
    errorCount: number,
    errors: string[]
): Promise<void> {
    try {
        // Aggregazione file di debug
        const rebuildDebugDir = path.join(__dirname, '..', '..', '..', 'transcripts', rebuildSessionId, 'debug_prompts');
        if (sessions.length > 0) {
            try {
                if (!fs.existsSync(rebuildDebugDir)) {
                    fs.mkdirSync(rebuildDebugDir, { recursive: true });
                }

                for (const session of sessions) {
                    const sessionDebugDir = path.join(__dirname, '..', '..', '..', 'transcripts', session.session_id, 'debug_prompts');
                    if (fs.existsSync(sessionDebugDir)) {
                        const files = fs.readdirSync(sessionDebugDir);
                        for (const file of files) {
                            if (file.endsWith('.txt') || file.endsWith('.json')) {
                                const srcPath = path.join(sessionDebugDir, file);
                                const destPath = path.join(rebuildDebugDir, `${session.session_id}_${file}`);
                                fs.copyFileSync(srcPath, destPath);
                            }
                        }
                    }
                }
                console.log(`[Rebuild] 📂 Aggregati file di debug in ${rebuildDebugDir}`);
            } catch (e) {
                console.warn(`[Rebuild] ⚠️ Errore aggregazione file debug:`, e);
            }
        }

        const metrics = await monitor.endSession();
        if (metrics) {
            // Add rebuild-specific info to errors for context
            if (successCount > 0 || totalSessions > 0) {
                metrics.errors.unshift(`[REBUILD STATS] Sessioni: ${successCount}/${totalSessions}, Errori: ${errorCount}`);
            }

            await processSessionReport(metrics);
            console.log(`[Rebuild] 📧 Report tecnico inviato per ${rebuildSessionId}`);
        }
    } catch (e: any) {
        console.error('[Rebuild] ❌ Errore invio report:', e.message);
    }
}
