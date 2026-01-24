import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { db, getSessionCampaignId } from '../../db';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { monitor } from '../../monitor';
import { processSessionReport } from '../../reporter';

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
        ragFragments: count('knowledge_fragments')
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
function softResetAnagrafiche(): { npcs: number; locations: number } {
    // Reset NPC descriptions but keep names, roles, status, aliases
    const npcResult = db.prepare(`
        UPDATE npc_dossier
        SET description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
    `).run();

    // Reset location descriptions but keep macro/micro names
    const locationResult = db.prepare(`
        UPDATE location_atlas
        SET description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
    `).run();

    return {
        npcs: npcResult.changes,
        locations: locationResult.changes
    };
}

/**
 * Hard purge: deletes all historical/derived data
 */
function purgeAllDerivedData(): Record<string, number> {
    const results: Record<string, number> = {};

    const tables = [
        'character_history',
        'npc_history',
        'world_history',
        'location_history',
        'quests',
        'inventory',
        'bestiary',
        'knowledge_fragments'
    ];

    for (const table of tables) {
        const result = db.prepare(`DELETE FROM ${table}`).run();
        results[table] = result.changes;
    }

    // Also reset character sync state
    db.prepare(`
        UPDATE characters
        SET description = '',
            last_synced_history_id = 0,
            rag_sync_needed = 1
    `).run();

    return results;
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

**Dati Storici (verranno CANCELLATI e rigenerati):**
- Eventi NPC: **${stats.npcEvents}**
- Eventi Mondo: **${stats.worldEvents}**
- Eventi PG: **${stats.characterEvents}**
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
            await message.reply("Uso: `$rebuild` (diagnostica) o `$rebuild CONFIRM` (esegui)");
            return;
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
                `   - ${resetStats.locations} luoghi (nomi preservati)\n\n` +
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

                    // Generate summary
                    const campaignId = session.campaign_id || getSessionCampaignId(session.session_id);
                    if (!campaignId) {
                        throw new Error('Campaign ID non trovato');
                    }

                    const result = await pipelineService.generateSessionSummary(
                        session.session_id,
                        campaignId,
                        'DM'
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

            // Final report
            const finalStats = getDiagnostics();
            let finalMessage = `✅ **REBUILD COMPLETATO**\n\n` +
                `**Risultato:**\n` +
                `- Sessioni processate: ${successCount}/${sessions.length}\n` +
                `- Errori: ${errorCount}\n\n` +
                `**Nuovo stato database:**\n` +
                `- Eventi NPC: ${finalStats.npcEvents}\n` +
                `- Eventi Mondo: ${finalStats.worldEvents}\n` +
                `- Eventi PG: ${finalStats.characterEvents}\n` +
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
            await sendTechnicalReport(rebuildSessionId, successCount, sessions.length, errorCount, errors);

        } catch (err: any) {
            console.error('[Rebuild] Errore critico:', err);
            await statusMsg.edit(`❌ **ERRORE CRITICO**\n\n${err.message}`);

            // Send report even on critical error
            monitor.logError('Rebuild', err.message);
            await sendTechnicalReport(rebuildSessionId, 0, 0, 1, [err.message]);
        }
    }
};

/**
 * Sends technical report email with rebuild costs
 */
async function sendTechnicalReport(
    rebuildSessionId: string,
    successCount: number,
    totalSessions: number,
    errorCount: number,
    errors: string[]
): Promise<void> {
    try {
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
