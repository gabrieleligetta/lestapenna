import { TextChannel, Message, StringSelectMenuBuilder, ActionRowBuilder, StringSelectMenuOptionBuilder, ComponentType } from 'discord.js';
import { Command, CommandContext } from '../types';
import { db, getCampaigns, getSessionCampaignId } from '../../db';
import { PipelineService } from '../../publisher/services/PipelineService';
import { IngestionService } from '../../publisher/services/IngestionService';
import { monitor } from '../../monitor';
import { processSessionReport } from '../../reporter';
import * as fs from 'fs';
import * as path from 'path';
import { Locale, t } from '../../i18n';

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
    artifacts: number; // 🆕
    ragFragments: number;
    factions: number;
    factionEvents: number;
    artifactEvents: number; // 🆕
}

/**
 * Every table this command is allowed to count or empty.
 *
 * A table name cannot be a bound parameter — SQL binds values, not identifiers —
 * so it is the one thing here that has to be concatenated into the statement.
 * The values that *can* be bound are bound; the identifier goes through this
 * list. Today every caller passes a literal, so nothing reaches it from the
 * outside: the point is that a future caller cannot, either, in a function whose
 * job is `DELETE`.
 */
const REBUILDABLE_TABLES = new Set([
    'sessions',
    'npc_dossier',
    'location_atlas',
    'npc_history',
    'world_history',
    'character_history',
    'location_history',
    'quests',
    'inventory',
    'bestiary',
    'artifacts',
    'knowledge_fragments',
    'factions',
    'faction_history',
    'artifact_history',
    'atlas_history',
    'quest_history',
    'bestiary_history',
    'inventory_history',
]);

/** Returns the table name if it is allowed, otherwise throws. */
function assertRebuildableTable(table: string): string {
    if (!REBUILDABLE_TABLES.has(table)) {
        throw new Error(`[Rebuild] Table not allowed: ${table}`);
    }
    return table;
}

/**
 * Gets diagnostic statistics for all derived data
 */
function getDiagnostics(campaignId?: number): DiagnosticStats {
    const count = (table: string) => {
        // The table name cannot be a bound parameter — SQL does not allow
        // identifiers to be bound — so it goes through the allowlist instead.
        // The campaign id can be bound, and is.
        const sql = campaignId
            ? `SELECT COUNT(*) as c FROM ${assertRebuildableTable(table)} WHERE campaign_id = ?`
            : `SELECT COUNT(*) as c FROM ${assertRebuildableTable(table)}`;
        const row = (campaignId
            ? db.prepare(sql).get(campaignId)
            : db.prepare(sql).get()) as { c: number };
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
        artifacts: count('artifacts'), // 🆕
        ragFragments: count('knowledge_fragments'),
        factions: count('factions'),
        factionEvents: count('faction_history'),
        artifactEvents: count('artifact_history') // 🆕
    };
}

/**
 * Gets all completed sessions ordered by start time
 */
function getCompletedSessions(campaignId?: number): SessionInfo[] {
    let sql = `
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
    `;

    if (campaignId) {
        sql += ` AND s.campaign_id = @campaignId `;
    }

    sql += `
        GROUP BY s.session_id
        HAVING COUNT(*) > 0
        ORDER BY start_time ASC
    `;

    return db.prepare(sql).all({ campaignId }) as SessionInfo[];
}

interface ValidationResult {
    valid: boolean;
    sessions: SessionInfo[];
    issues: { session_id: string; title: string | null; reason: string }[];
}

/**
 * Pre-flight check: validates all sessions have required data before any deletion
 */
function validateRebuildReadiness(campaignId: number | undefined, locale: Locale): ValidationResult {
    const sessions = getCompletedSessions(campaignId);
    const issues: { session_id: string; title: string | null; reason: string }[] = [];

    for (const session of sessions) {
        // Check 1: campaign_id must exist
        if (!session.campaign_id) {
            issues.push({
                session_id: session.session_id,
                title: session.title,
                reason: t(locale, 'admin.validationNoCampaign')
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
                reason: t(locale, 'admin.validationNoTranscript')
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
 * Soft reset: preserves entity names, clears descriptions
 */
function softResetAnagrafiche(campaignId?: number): { npcs: number; locations: number; factions: number; artifacts: number; bestiary: number } {
    // Every clause below puts the campaign filter last, so the bound value is
    // always the final argument.
    const whereClause = campaignId
        ? `WHERE COALESCE(is_manual, 0) = 0 AND campaign_id = ?`
        : `WHERE COALESCE(is_manual, 0) = 0`;

    const whereClauseParty = campaignId
        ? `WHERE COALESCE(is_manual, 0) = 0 AND is_party = 0 AND campaign_id = ?`
        : `WHERE COALESCE(is_manual, 0) = 0 AND is_party = 0`;

    const args = campaignId ? [campaignId] : [];

    // Reset NPC descriptions but keep names, roles, status, aliases
    const npcResult = db.prepare(`
        UPDATE npc_dossier
        SET description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
        ${whereClause}
    `).run(...args);

    // Reset character bios but keep foundation_description
    db.prepare(`
        UPDATE characters
        SET description = foundation_description,
            rag_sync_needed = 1,
            last_synced_history_id = 0
        ${whereClause}
    `).run(...args);

    // Reset location descriptions but keep macro/micro names
    const locationResult = db.prepare(`
        UPDATE location_atlas
        SET description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
        ${whereClause}
    `).run(...args);

    // Reset faction descriptions + alignment (excluding the party — it has its own reset below)
    const factionResult = db.prepare(`
        UPDATE factions
        SET description = NULL,
            alignment_moral = NULL,
            alignment_ethical = NULL,
            moral_score = 0,
            ethical_score = 0,
            rag_sync_needed = 1,
            first_session_id = NULL
        ${whereClauseParty}
    `).run(...args);

    // Reset party faction: descrizione + allineamento azzerati
    const partyWhereClause = campaignId
        ? `WHERE is_party = 1 AND campaign_id = ?`
        : `WHERE is_party = 1`;
    db.prepare(`
        UPDATE factions
        SET description = NULL,
            alignment_moral = 'NEUTRAL',
            alignment_ethical = 'NEUTRAL',
            moral_score = 0,
            ethical_score = 0,
            rag_sync_needed = 1,
            first_session_id = NULL
        ${partyWhereClause}
    `).run(...args);

    // Reset the party alignment in the campaigns table too
    const campaignWhereClause = campaignId
        ? `WHERE id = ?`
        : '';
    db.prepare(`
        UPDATE campaigns
        SET party_alignment_moral = 'NEUTRAL',
            party_alignment_ethical = 'NEUTRAL'
        ${campaignWhereClause}
    `).run(...args);

    // Reset artifact descriptions but keep names
    const artifactResult = db.prepare(`
        UPDATE artifacts
        SET description = NULL,
            effects = NULL,
            curse_description = NULL,
            rag_sync_needed = 1,
            first_session_id = NULL
        ${whereClause}
    `).run(...args);

    // Reset bestiary but keep names
    const bestiaryResult = db.prepare(`
        UPDATE bestiary
        SET status = 'ALIVE',
            session_id = NULL,
            last_seen = NULL
        ${whereClause}
    `).run(...args);

    return {
        npcs: npcResult.changes,
        locations: locationResult.changes,
        factions: factionResult.changes,
        artifacts: artifactResult.changes,
        bestiary: bestiaryResult.changes
    };
}

/**
 * Hard purge: deletes all historical/derived data
 */
function purgeAllDerivedData(campaignId?: number): Record<string, number> {
    const results: Record<string, number> = {};

    const tablesWithManual = [
        'character_history',
        'npc_history',
        'world_history',
        'location_history',
        'quests',
        'inventory',
        'atlas_history',
        'quest_history',
        'bestiary_history',   // Eventi bestiary (entità resettate in softResetAnagrafiche)
        'inventory_history',
        'faction_history',
        'artifact_history'    // Artifact events (entities reset in softResetAnagrafiche)
    ];

    const whereClause = campaignId
        ? `WHERE COALESCE(is_manual, 0) = 0 AND campaign_id = ?`
        : `WHERE COALESCE(is_manual, 0) = 0`;
    const args = campaignId ? [campaignId] : [];

    for (const table of tablesWithManual) {
        // Only delete entries NOT marked as manual
        const result = db.prepare(`DELETE FROM ${assertRebuildableTable(table)} ${whereClause}`).run(...args);
        results[table] = result.changes;
    }

    // Always full wipe RAG fragments (they will be regenerated from source)
    const ragWhere = campaignId ? `WHERE campaign_id = ?` : '';
    const ragResult = db.prepare(`DELETE FROM knowledge_fragments ${ragWhere}`).run(...args);
    results['knowledge_fragments'] = ragResult.changes;

    // Also reset character sync state but preserve manual descriptions and foundation
    const charWhere = campaignId ? `AND campaign_id = ?` : '';
    db.prepare(`
        UPDATE characters
        SET description = CASE WHEN COALESCE(is_manual, 0) = 1 THEN description ELSE COALESCE(foundation_description, '') END,
            last_synced_history_id = 0,
            rag_sync_needed = 1
        WHERE 1=1 ${charWhere}
    `).run(...args);

    return results;
}

/**
 * Prune "zombie" entities: deletes NPCs/Locations that remained without description after rebuild
 */
export function pruneEmptyEntities(campaignId?: number): { npcs: number; locations: number } {
    // The filter always sits at the END of each WHERE below, so the bound value
    // is always the last argument.
    const campaignFilter = campaignId ? `AND campaign_id = ?` : '';
    const campaignArgs = campaignId ? [campaignId] : [];

    return db.transaction(() => {
        // 1. Identify NPCs to delete
        const npcsToDelete = db.prepare(`
            SELECT id, name FROM npc_dossier
            WHERE (description IS NULL 
                OR length(description) < 5
                OR description LIKE 'Nessuna descrizione%')
                AND COALESCE(is_manual, 0) = 0
                ${campaignFilter}
        `).all(...campaignArgs) as { id: number; name: string }[];

        // 2. Identify Locations to delete
        const locationsToDelete = db.prepare(`
            SELECT id, macro_location, micro_location FROM location_atlas
            WHERE (description IS NULL 
                OR length(description) < 10
                OR description LIKE 'Nessuna descrizione%')
                AND COALESCE(is_manual, 0) = 0
                ${campaignFilter}
        `).all(...campaignArgs) as { id: number; macro_location: string; micro_location: string }[];

        // 3. Delete NPC history and faction affiliations first
        for (const npc of npcsToDelete) {
            db.prepare('DELETE FROM npc_history WHERE npc_name = ?' + (campaignId ? ` AND campaign_id = ?` : '')).run(npc.name, ...campaignArgs);
            db.prepare('DELETE FROM faction_affiliations WHERE entity_type = ? AND entity_id = ?').run('npc', npc.id);
        }

        // 4. Delete Location history and faction affiliations
        for (const loc of locationsToDelete) {
            db.prepare(`
                DELETE FROM location_history 
                WHERE lower(macro_location) = lower(?) 
                AND lower(micro_location) = lower(?)
                ${campaignFilter}
            `).run(loc.macro_location, loc.micro_location, ...campaignArgs);

            db.prepare(`
                DELETE FROM atlas_history 
                WHERE lower(macro_location) = lower(?) 
                AND lower(micro_location) = lower(?)
                ${campaignFilter}
            `).run(loc.macro_location, loc.micro_location, ...campaignArgs);

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
                ${campaignFilter}
        `).run(...campaignArgs);

        const locationResult = db.prepare(`
            DELETE FROM location_atlas
            WHERE (description IS NULL 
                OR length(description) < 10
                OR description LIKE 'Nessuna descrizione%')
                AND COALESCE(is_manual, 0) = 0
                ${campaignFilter}
        `).run(...campaignArgs);

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
    category: 'dev',
    descriptionKey: 'help.cmd.rebuild',
    aliases: ['rebuild_index', 'reindex'],
    requiresCampaign: false,
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, client } = ctx;
        const channel = message.channel as TextChannel;

        // --- CAMPAIGN SELECTION ---
        // Only THIS guild's campaigns: the query used to be global, so from any
        // command channel you could see — and touch — the campaigns of other
        // servers.
        const campaigns = getCampaigns(ctx.guildId).map((c) => ({ id: c.id, name: c.name }));
        if (campaigns.length === 0) {
            await message.reply(t(ctx.locale, 'admin.noCampaignsDb'));
            return;
        }

        let selectedCampaignId: number | undefined = undefined;
        let selectedCampaignName = '';

        // Rebuild is intentionally restricted to one campaign. An instance-wide
        // option would let an operator of one Discord server purge every tenant.
        const campaignOptions = campaigns.map(c =>
            new StringSelectMenuOptionBuilder()
                .setLabel(c.name)
                .setValue(c.id.toString())
        );

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('rebuild_campaign_select')
            .setPlaceholder(t(ctx.locale, 'admin.rebuildSelectPlaceholder'))
            .addOptions(campaignOptions);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        const reply = await message.reply({
            content: t(ctx.locale, 'admin.rebuildSelectPrompt'),
            components: [row]
        });

        try {
            const selection = await reply.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                filter: i => i.user.id === message.author.id,
                time: 60000
            });

            selectedCampaignId = Number.parseInt(selection.values[0], 10);
            const selectedCampaign = campaigns.find(c => c.id === selectedCampaignId);
            if (!selectedCampaign) {
                throw new Error('Selected campaign does not belong to this guild');
            }
            selectedCampaignName = selectedCampaign.name;

            await selection.deferUpdate();
            await reply.delete();
        } catch (e) {
            await reply.edit({ content: t(ctx.locale, 'admin.timeoutCancelled'), components: [] });
            return;
        }

        if (selectedCampaignId === undefined) return;

        // --- DIAGNOSTIC REPORT ---
        const stats = getDiagnostics(selectedCampaignId);
        const sessions = getCompletedSessions(selectedCampaignId);

        const diagnosticMsg = t(ctx.locale, 'admin.rebuildDiagnostics', {
            scope: selectedCampaignName, sessions: sessions.length,
            npcs: stats.npcs, places: stats.locations, factions: stats.factions,
            npcEvents: stats.npcEvents, worldEvents: stats.worldEvents,
            characterEvents: stats.characterEvents, factionEvents: stats.factionEvents,
            quests: stats.quests, inventory: stats.inventory, bestiary: stats.bestiary,
            artifacts: stats.artifacts, rag: stats.ragFragments,
        });

        await message.reply(diagnosticMsg);

        // --- CONFIRMATION & MODE SELECTION ---
        let forceRegeneration = false;
        try {
            const collected = await channel.awaitMessages({
                filter: (m: Message) => m.author.id === message.author.id && m.content.toUpperCase().startsWith('CONFIRM'),
                max: 1,
                time: 60000,
                errors: ['time']
            });

            const content = collected.first()?.content.toUpperCase().trim();
            if (!content) return;

            if (content.includes('FORCE')) {
                forceRegeneration = true;
                await message.reply(t(ctx.locale, 'admin.forceMode'));
            } else {
                await message.reply(t(ctx.locale, 'admin.smartMode'));
            }

        } catch {
            await message.reply(t(ctx.locale, 'admin.rebuildTimeout'));
            return;
        }

        // --- FINAL CONFIRMATION ---
        await message.reply(t(ctx.locale, 'admin.rebuildFinalConfirm', { scope: selectedCampaignName }));

        try {
            const collected = await channel.awaitMessages({
                filter: (m: Message) => m.author.id === message.author.id && ['REBUILD', 'RICOSTRUISCI'].includes(m.content.trim().toUpperCase()),
                max: 1,
                time: 30000,
                errors: ['time']
            });

            if (collected.size === 0) return;
        } catch {
            await message.reply(t(ctx.locale, 'admin.rebuildTimeout'));
            return;
        }

        // --- EXECUTE REBUILD ---
        const rebuildSessionId = `rebuild-${Date.now()}`;
        monitor.startSession(rebuildSessionId);
        console.log(`[Rebuild] 📊 Monitor avviato per sessione ${rebuildSessionId}`);

        const statusMsg = await channel.send(t(ctx.locale, 'admin.rebuildStarted', { scope: selectedCampaignName }));

        try {
            // Phase 0: PRE-FLIGHT VALIDATION (before any deletion!)
            const validation = validateRebuildReadiness(selectedCampaignId, ctx.locale);

            if (!validation.valid) {
                await monitor.endSession(); // Clean up monitor

                let errorMsg = t(ctx.locale, 'admin.rebuildValidationFailed', { count: validation.issues.length });

                for (const issue of validation.issues.slice(0, 10)) {
                    const label = issue.title || issue.session_id.slice(0, 8);
                    errorMsg += `• **${label}**: ${issue.reason}\n`;
                }

                if (validation.issues.length > 10) {
                    errorMsg += `\n${t(ctx.locale, 'admin.moreProblemSessions', { count: validation.issues.length - 10 })}`;
                }

                errorMsg += `\n\n${t(ctx.locale, 'admin.rebuildNothingDeleted')}`;

                await statusMsg.edit(errorMsg);
                return;
            }

            await statusMsg.edit(t(ctx.locale, 'admin.rebuildValidationOk', {
                scope: selectedCampaignName, sessions: validation.sessions.length,
            }));

            // Phase 1: Soft reset anagrafiche (NOW safe to proceed)
            const resetStats = softResetAnagrafiche(selectedCampaignId);
            await statusMsg.edit(t(ctx.locale, 'admin.rebuildResetDone', {
                npcs: resetStats.npcs, places: resetStats.locations,
                factions: resetStats.factions, artifacts: resetStats.artifacts,
                bestiary: resetStats.bestiary,
            }));

            // Phase 2: Purge all derived data
            const purgeStats = purgeAllDerivedData(selectedCampaignId);
            const totalPurged = Object.values(purgeStats).reduce((a, b) => a + b, 0);

            await statusMsg.edit(t(ctx.locale, 'admin.rebuildPurgeDone', {
                total: totalPurged, npcEvents: purgeStats.npc_history,
                worldEvents: purgeStats.world_history, characterEvents: purgeStats.character_history,
                factionEvents: purgeStats.faction_history, rag: purgeStats.knowledge_fragments,
            }));

            // Phase 3: Regenerate all sessions
            // sessions already filtered by getCompletedSessions(selectedCampaignId)
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
                    await statusMsg.edit(t(ctx.locale, 'admin.rebuildSessionProgress', {
                        progress, session: sessionLabel, completed: successCount, errors: errorCount,
                    }));
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
                        throw new Error(t(ctx.locale, 'admin.campaignIdNotFound'));
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
            await statusMsg.edit(t(ctx.locale, 'admin.rebuildPruning', { sessions: successCount }));

            const pruneStats = pruneEmptyEntities(selectedCampaignId);
            console.log(`[Rebuild] 🧹 Pruned ${pruneStats.npcs} NPCs and ${pruneStats.locations} Locations.`);

            // Final report
            const finalStats = getDiagnostics(selectedCampaignId);
            let finalMessage = t(ctx.locale, 'admin.rebuildComplete', {
                success: successCount, total: sessions.length, errors: errorCount,
                scope: selectedCampaignName, npcs: finalStats.npcs, npcsPruned: pruneStats.npcs,
                places: finalStats.locations, placesPruned: pruneStats.locations,
                factions: finalStats.factions, npcEvents: finalStats.npcEvents,
                worldEvents: finalStats.worldEvents, characterEvents: finalStats.characterEvents,
                factionEvents: finalStats.factionEvents, artifactEvents: finalStats.artifactEvents,
                quests: finalStats.quests, inventory: finalStats.inventory,
                artifacts: finalStats.artifacts, rag: finalStats.ragFragments,
            });

            if (errors.length > 0) {
                finalMessage += `\n\n${t(ctx.locale, 'admin.errorsHeading')}\n${errors.slice(0, 5).map(e => `- ${e}`).join('\n')}`;
                if (errors.length > 5) {
                    finalMessage += `\n${t(ctx.locale, 'admin.moreErrors', { count: errors.length - 5 })}`;
                }
            }

            await statusMsg.edit(finalMessage);

            // Send technical report via email
            await sendTechnicalReport(rebuildSessionId, sessions, successCount, sessions.length, errorCount, errors);

        } catch (err: any) {
            console.error('[Rebuild] Errore critico:', err);
            await statusMsg.edit(t(ctx.locale, 'admin.criticalError', { message: err.message }));

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
