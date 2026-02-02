import { TextChannel, StringSelectMenuBuilder, ActionRowBuilder, StringSelectMenuOptionBuilder, ComponentType } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getSessionCampaignId, db, getSessionAIOutput } from '../../db';
import { monitor } from '../../monitor';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';

interface SessionOption {
    session_id: string;
    campaign_id: number;
    title: string | null;
    session_number: number | null;
    start_time: number;
    has_cache: boolean;
}

/**
 * Get sessions with AI cache for selection
 */
function getSessionsWithCache(campaignId?: number): SessionOption[] {
    let sql = `
        SELECT
            s.session_id,
            s.campaign_id,
            s.title,
            s.session_number,
            s.analyst_data IS NOT NULL as has_cache,
            MIN(r.timestamp) as start_time
        FROM sessions s
        LEFT JOIN recordings r ON r.session_id = s.session_id
        WHERE s.analyst_data IS NOT NULL
    `;

    if (campaignId) {
        sql += ` AND s.campaign_id = @campaignId `;
    }

    sql += `
        GROUP BY s.session_id
        ORDER BY start_time DESC
        LIMIT 25
    `;

    return db.prepare(sql).all({ campaignId }) as SessionOption[];
}

/**
 * Pulisce e ri-riconcilia una sessione con la nuova logica di riconciliazione.
 * NON rigenera il summary AI (usa la cache), quindi ZERO costi API per la generazione.
 *
 * Utile quando la logica di riconciliazione è stata corretta e si vuole
 * ri-applicare sui dati di una sessione già processata.
 */
export const rereconcileCommand: Command = {
    name: 'rereconcile',
    aliases: ['rericoncilia', 'fixreconcile'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign } = ctx;
        let targetSessionId = args[0];
        const channel = message.channel as TextChannel;

        // If no session ID provided, show interactive selection
        if (!targetSessionId) {
            const sessions = getSessionsWithCache(activeCampaign?.id);

            if (sessions.length === 0) {
                await message.reply(
                    "⚠️ Nessuna sessione con cache AI trovata.\n" +
                    "Le sessioni devono essere state processate almeno una volta per avere la cache."
                );
                return;
            }

            // Build select menu
            const sessionOptions = sessions.map(s => {
                const date = s.start_time ? new Date(s.start_time).toLocaleDateString('it-IT') : '?';
                const label = s.title
                    ? `${s.title.substring(0, 50)}${s.title.length > 50 ? '...' : ''}`
                    : `Sessione ${s.session_number || s.session_id.slice(0, 8)}`;

                return new StringSelectMenuOptionBuilder()
                    .setLabel(label)
                    .setValue(s.session_id)
                    .setDescription(`${date} | ID: ${s.session_id.slice(0, 12)}...`);
            });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('rereconcile_session_select')
                .setPlaceholder('Seleziona la sessione da ri-riconciliare')
                .addOptions(sessionOptions);

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

            const reply = await message.reply({
                content:
                    '🔄 **RI-RICONCILIAZIONE**\n\n' +
                    'Seleziona la sessione da ri-riconciliare.\n' +
                    '✅ Usa la cache AI (ZERO costi)\n' +
                    '🧹 Pulisce e ri-applica la riconciliazione\n',
                components: [row]
            });

            try {
                const selection = await reply.awaitMessageComponent({
                    componentType: ComponentType.StringSelect,
                    filter: i => i.user.id === message.author.id,
                    time: 60000
                });

                targetSessionId = selection.values[0];
                await selection.deferUpdate();
                await reply.delete();
            } catch (e) {
                await reply.edit({ content: '⌛ Tempo scaduto. Comando annullato.', components: [] });
                return;
            }
        }

        const campaignId = getSessionCampaignId(targetSessionId);

        if (!campaignId) {
            await message.reply(`❌ Campagna non trovata per la sessione \`${targetSessionId}\`.`);
            return;
        }

        // Check if we have cached data
        const cached = getSessionAIOutput(targetSessionId);
        if (!cached) {
            await message.reply(
                `⚠️ Nessun dato AI in cache per la sessione \`${targetSessionId}\`.\n` +
                `Usa \`$riprocessa ${targetSessionId} FORCE\` per rigenerare tutto (costi AI).`
            );
            return;
        }

        await channel.send(
            `🔄 **Ri-Riconciliazione** avviata per sessione \`${targetSessionId}\`...\n` +
            `📦 Usando cache AI del ${new Date(cached.lastGeneratedAt).toLocaleString()}\n` +
            `1. Analisi dati da pulire...`
        );

        // Show what will be affected
        const stats = getSessionStats(targetSessionId, campaignId);
        await channel.send(
            `📊 **Dati da ri-processare:**\n` +
            `• NPC creati in questa sessione: ${stats.npcsCreated}\n` +
            `• NPC aggiornati in questa sessione: ${stats.npcsUpdated}\n` +
            `• Luoghi creati in questa sessione: ${stats.locationsCreated}\n` +
            `• Luoghi aggiornati in questa sessione: ${stats.locationsUpdated}\n` +
            `• Eventi storia: ${stats.historyEvents}\n` +
            `• Frammenti RAG: ${stats.ragFragments}`
        );

        // Start monitoring
        let monitorStartedByUs = false;
        if (!monitor.isSessionActive()) {
            monitor.startSession(targetSessionId);
            monitorStartedByUs = true;
        }

        const pipelineService = new PipelineService();
        const ingestionService = new IngestionService();

        try {
            await channel.send(`2. 🧹 Pulizia dati derivati...`);

            // Custom cleanup that preserves more context
            cleanupSessionDataForRereconcile(targetSessionId, campaignId);

            await channel.send(`3. 🔄 Ri-generazione con nuova logica di riconciliazione...`);

            // Use cached summary - this will NOT call AI, just load from DB
            const result = await pipelineService.generateSessionSummary(
                targetSessionId,
                campaignId,
                'DM',
                { forceRegeneration: false } // USE CACHE!
            );

            // Re-ingest
            await ingestionService.ingestSummary(targetSessionId, result);
            ingestionService.updateSessionTitle(targetSessionId, result.title);

            await channel.send(`4. 💾 Salvataggio dati riconciliati...`);

            // Process batch events with NEW reconciliation logic
            await ingestionService.processBatchEvents(campaignId, targetSessionId, result, channel, true); // Silent

            // End monitoring
            if (monitorStartedByUs) {
                await monitor.endSession();
            }

            // Show new stats
            const newStats = getSessionStats(targetSessionId, campaignId);
            await channel.send(
                `✅ **Ri-Riconciliazione Completata!**\n\n` +
                `📊 **Nuovi dati:**\n` +
                `• NPC: ${newStats.npcsCreated + newStats.npcsUpdated} (${newStats.npcsCreated} nuovi, ${newStats.npcsUpdated} aggiornati)\n` +
                `• Luoghi: ${newStats.locationsCreated + newStats.locationsUpdated}\n` +
                `• Eventi storia: ${newStats.historyEvents}\n` +
                `• Frammenti RAG: ${newStats.ragFragments}\n\n` +
                `💡 Controlla i log per vedere i dettagli della riconciliazione.`
            );

        } catch (e: any) {
            console.error(`[Rericoncilia] ❌ Errore:`, e);
            await channel.send(`❌ Errore ri-riconciliazione: ${e.message}`);

            if (monitorStartedByUs) {
                await monitor.endSession();
            }
        }
    }
};

/**
 * Get statistics about what data exists for a session
 */
function getSessionStats(sessionId: string, campaignId: number): {
    npcsCreated: number;
    npcsUpdated: number;
    locationsCreated: number;
    locationsUpdated: number;
    historyEvents: number;
    ragFragments: number;
} {
    const npcsCreated = (db.prepare(
        'SELECT COUNT(*) as count FROM npc_dossier WHERE first_session_id = ?'
    ).get(sessionId) as { count: number })?.count || 0;

    const npcsUpdated = (db.prepare(
        'SELECT COUNT(*) as count FROM npc_dossier WHERE last_updated_session_id = ? AND first_session_id != ?'
    ).get(sessionId, sessionId) as { count: number })?.count || 0;

    const locationsCreated = (db.prepare(
        'SELECT COUNT(*) as count FROM location_atlas WHERE first_session_id = ?'
    ).get(sessionId) as { count: number })?.count || 0;

    const locationsUpdated = (db.prepare(
        'SELECT COUNT(*) as count FROM location_atlas WHERE last_updated_session_id = ? AND first_session_id != ?'
    ).get(sessionId, sessionId) as { count: number })?.count || 0;

    const historyEvents = (db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM npc_history WHERE session_id = ?) +
            (SELECT COUNT(*) FROM character_history WHERE session_id = ?) +
            (SELECT COUNT(*) FROM world_history WHERE session_id = ?) +
            (SELECT COUNT(*) FROM location_history WHERE session_id = ?)
        as count
    `).get(sessionId, sessionId, sessionId, sessionId) as { count: number })?.count || 0;

    const ragFragments = (db.prepare(
        'SELECT COUNT(*) as count FROM knowledge_fragments WHERE session_id = ?'
    ).get(sessionId) as { count: number })?.count || 0;

    return { npcsCreated, npcsUpdated, locationsCreated, locationsUpdated, historyEvents, ragFragments };
}

/**
 * Cleanup session data specifically for re-reconciliation.
 * More targeted than purgeSessionData.
 */
function cleanupSessionDataForRereconcile(sessionId: string, campaignId: number) {
    console.log(`[Rericoncilia] 🧹 Pulizia dati per sessione ${sessionId}...`);

    // 1. Delete history events from this session
    const historyTables = ['npc_history', 'character_history', 'world_history', 'location_history', 'atlas_history'];
    for (const table of historyTables) {
        const result = db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
        if (result.changes > 0) {
            console.log(`[Rericoncilia] 🧹 Cancellati ${result.changes} eventi da ${table}`);
        }
    }

    // 2. Delete derived data (quests, inventory, bestiary) from this session
    db.prepare('DELETE FROM quests WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM inventory WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM bestiary WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_logs WHERE session_id = ?').run(sessionId);

    // 3. Delete NPC/locations CREATED in this session (they will be re-created)
    const npcsDeleted = db.prepare('DELETE FROM npc_dossier WHERE first_session_id = ?').run(sessionId);
    if (npcsDeleted.changes > 0) {
        console.log(`[Rericoncilia] 🧹 Cancellati ${npcsDeleted.changes} NPC creati in questa sessione`);
    }

    const locsDeleted = db.prepare('DELETE FROM location_atlas WHERE first_session_id = ?').run(sessionId);
    if (locsDeleted.changes > 0) {
        console.log(`[Rericoncilia] 🧹 Cancellati ${locsDeleted.changes} luoghi creati in questa sessione`);
    }

    // 4. Reset descriptions for NPC/locations UPDATED in this session
    // They will get new descriptions from the re-reconciliation
    const npcsReset = db.prepare(`
        UPDATE npc_dossier
        SET description = NULL, rag_sync_needed = 1, last_updated_session_id = NULL
        WHERE last_updated_session_id = ? AND first_session_id != ?
    `).run(sessionId, sessionId);
    if (npcsReset.changes > 0) {
        console.log(`[Rericoncilia] 🧹 Reset descrizioni per ${npcsReset.changes} NPC aggiornati`);
    }

    const locsReset = db.prepare(`
        UPDATE location_atlas
        SET description = NULL, rag_sync_needed = 1, last_updated_session_id = NULL
        WHERE last_updated_session_id = ? AND first_session_id != ?
    `).run(sessionId, sessionId);
    if (locsReset.changes > 0) {
        console.log(`[Rericoncilia] 🧹 Reset descrizioni per ${locsReset.changes} luoghi aggiornati`);
    }

    // 5. Reset character sync state for affected characters
    const affectedChars = db.prepare(
        'SELECT DISTINCT character_name FROM character_history WHERE session_id = ?'
    ).all(sessionId) as { character_name: string }[];

    for (const char of affectedChars) {
        db.prepare(`
            UPDATE characters
            SET last_synced_history_id = 0, rag_sync_needed = 1
            WHERE campaign_id = ? AND character_name = ?
        `).run(campaignId, char.character_name);
    }

    // 6. Delete RAG fragments from this session
    const ragDeleted = db.prepare('DELETE FROM knowledge_fragments WHERE session_id = ?').run(sessionId);
    console.log(`[Rericoncilia] 🧹 Cancellati ${ragDeleted.changes} frammenti RAG`);

    console.log(`[Rericoncilia] ✅ Pulizia completata.`);
}
