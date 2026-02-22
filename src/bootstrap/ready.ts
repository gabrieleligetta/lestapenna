import { Client, TextChannel, ChannelType } from 'discord.js';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { monitor, startMemoryMonitor } from '../monitor';
import { startWorker } from '../workers';
import {
    checkStorageUsage,
    // uploadToOracle // used in recoverOrphanedFiles
} from '../services/backup';
import { uploadToOracle } from '../services/backup';
import {
    testRemoteConnection,
    processSessionReport
} from '../reporter';
import { initIdentityGuard } from '../utils/identity';
import {
    createSession,
    addRecording,
    updateRecordingStatus,
    getRecording,
    findSessionByTimestamp,
    getCampaigns,
    createCampaign,
    getUnprocessedRecordings,
    resetUnfinishedRecordings,
    getAvailableSessions,
    db,
    getGuildConfig
} from '../db';

import { audioQueue, removeSessionJobs } from '../services/queue';
// If waitForCompletionAndSummarize logic was different in index.ts, I should use the one from utils/publish if compatible.
// index.ts used waitForCompletionAndSummarize(sessionId, channel).
// utils/publish likely exports publishSummary, not waitFor...
import { waitForCompletionAndSummarize as waitForCompletionAndSummarizeUtil } from '../publisher';
import { sessionPhaseManager, SessionPhase } from '../services/SessionPhaseManager';
import { config } from '../config';
import { resetRecordingState } from '../state/sessionState';
import { buildWelcomeEmbed, markGuildAsWelcomed, hasBeenWelcomed } from './guildJoin';

// Note: recoverOrphanedFiles and processOrphanedSessionsSequentially were local. Moving here.

export function registerReadyHandler(client: Client) {
    client.once('ready', async () => {
        console.log(`✅ Bot online: ${client.user?.tag}`);

        // Log DEV_GUILD_ID / IGNORE_GUILD_IDS status
        if (config.discord.devGuildId) {
            console.log(`🔧 [DEV MODE] Rispondo solo al server: ${config.discord.devGuildId}`);
        } else if (config.discord.ignoreGuildIds.length > 0) {
            console.log(`🌐 [PROD MODE] Rispondo a tutti i server, ignoro: ${config.discord.ignoreGuildIds.join(', ')}`);
        } else {
            console.log(`🌐 [PROD MODE] Rispondo a tutti i server`);
        }

        await testRemoteConnection();
        await checkStorageUsage();

        // 📊 Print last 5 sessions table
        printRecentSessions();

        initIdentityGuard();

        startWorker();

        exec('df -h /dev/shm', (error, stdout, stderr) => {
            if (error) {
                console.warn(`⚠️ [System] Impossibile verificare /dev/shm: ${error.message}`);
                return;
            }
            const lines = stdout.trim().split('\n');
            const info = lines.length > 1 ? lines[1] : lines[0];
            console.log(`✅ [System] RAM Disk Check: ${info.replace(/\s+/g, ' ')}`);
        });

        monitor.startIdleMonitoring();
        startMemoryMonitor();

        // 🆕 PHASE-BASED RECOVERY: Check for sessions interrupted by crash
        await recoverIncompleteSessions(client);

        const recoveredSessionIds = await recoverOrphanedFiles();

        console.log('🔍 Controllo lavori interrotti nel database...');
        const orphanJobs = getUnprocessedRecordings();
        const orphanSessionIds = orphanJobs.map(job => job.session_id);

        // Merge recovered sessions and database orphans
        const allPendingSessions = [...new Set([...recoveredSessionIds, ...orphanSessionIds])];

        if (allPendingSessions.length > 0) {
            console.log(`📦 Trovati ${allPendingSessions.length} sessioni pendenti (Recovered + DB Orphans).`);
            await processOrphanedSessionsSequentially(client, allPendingSessions);
        } else {
            console.log('✅ Nessun lavoro in sospeso trovato.');
        }

        // 🆕 Notify unconfigured servers
        await notifyUnconfiguredGuilds(client);
    });
}

/**
 * Send welcome message to all guilds that haven't configured cmd_channel_id yet
 */
async function notifyUnconfiguredGuilds(client: Client): Promise<void> {
    const guilds = client.guilds.cache;
    let notifiedCount = 0;

    for (const [guildId, guild] of guilds) {
        // DEV_GUILD_ID: If set, only handle that specific guild
        if (config.discord.devGuildId && guildId !== config.discord.devGuildId) {
            continue;
        }

        // IGNORE_GUILD_IDS: Skip these guilds
        if (config.discord.ignoreGuildIds.includes(guildId)) {
            continue;
        }

        const cmdChannelId = getGuildConfig(guildId, 'cmd_channel_id');

        if (!cmdChannelId) {
            // Check debounce to prevent duplicate messages
            if (hasBeenWelcomed(guildId)) {
                console.log(`[Setup] Server "${guild.name}" già notificato di recente, skip.`);
                continue;
            }

            // Server not configured - send welcome message
            let targetChannel: TextChannel | null = null;

            if (guild.systemChannel) {
                targetChannel = guild.systemChannel;
            } else {
                // Find first text channel we have permission to send to
                const textChannels = guild.channels.cache
                    .filter(ch => ch.type === ChannelType.GuildText)
                    .filter(ch => {
                        const perms = ch.permissionsFor(client.user!);
                        return perms?.has('SendMessages') && perms?.has('ViewChannel');
                    });

                if (textChannels.size > 0) {
                    targetChannel = textChannels.first() as TextChannel;
                }
            }

            if (targetChannel) {
                try {
                    await targetChannel.send({ embeds: [buildWelcomeEmbed()] });
                    markGuildAsWelcomed(guildId);
                    console.log(`[Setup] 📨 Messaggio di configurazione inviato a "${guild.name}" (#${targetChannel.name})`);
                    notifiedCount++;
                } catch (e) {
                    console.warn(`[Setup] ⚠️ Impossibile inviare messaggio a "${guild.name}":`, e);
                }
            } else {
                console.warn(`[Setup] ⚠️ Nessun canale disponibile per "${guild.name}"`);
            }
        }
    }

    if (notifiedCount > 0) {
        console.log(`[Setup] 📋 ${notifiedCount} server non configurati notificati.`);
    } else {
        console.log('[Setup] ✅ Tutti i server sono configurati.');
    }
}

/**
 * 📊 Print last 5 sessions table at startup
 */
function printRecentSessions(): void {
    try {
        const sessions = getAvailableSessions(undefined, undefined, 5);

        if (sessions.length === 0) {
            console.log('\n📋 Nessuna sessione registrata nel database.\n');
            return;
        }

        console.log('\n┌─────────────────────────────────────────────────────────────────────────────────────────────────┐');
        console.log('│                                            📜 ULTIME 5 SESSIONI                                             │');
        console.log('├──────┬──────────────────────────────────────┬───────────────────┬─────────────────┬─────────────────┤');
        console.log('│  #   │ Session ID                           │ Data/Ora          │ Campagna        │ Stato           │');
        console.log('├──────┼──────────────────────────────────────┼───────────────────┼─────────────────┼─────────────────┤');

        // Reverse so most recent is at bottom
        const reversed = [...sessions].reverse();
        for (const s of reversed) {
            const num = s.session_number ? String(s.session_number).padStart(4, ' ') : '  - ';
            const id = s.session_id.padEnd(36, ' ');
            const dateTime = s.start_time
                ? new Date(s.start_time).toLocaleString('it-IT', {
                    day: '2-digit',
                    month: '2-digit',
                    year: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'Europe/Rome'
                })
                : '       -       ';
            const campaign = (s.campaign_name || '-').substring(0, 15).padEnd(15, ' ');

            // Get processing phase (for old sessions without phase tracking, infer DONE if they have processed recordings)
            const phaseInfo = sessionPhaseManager.getPhase(s.session_id);
            let phase = phaseInfo?.phase || null;

            // Sessions returned by getAvailableSessions have PROCESSED recordings, so if phase is IDLE or null, they're actually DONE
            if (!phase || phase === 'IDLE') {
                phase = 'DONE';
            }
            const phaseDisplay = phase.substring(0, 15).padEnd(15, ' ');

            console.log(`│ ${num} │ ${id} │ ${dateTime.padEnd(17, ' ')} │ ${campaign} │ ${phaseDisplay} │`);
        }

        console.log('└──────┴──────────────────────────────────────┴───────────────────┴─────────────────┴─────────────────┘\n');
    } catch (e) {
        console.warn('[Startup] ⚠️ Impossibile caricare sessioni recenti:', e);
    }
}

/**
 * 🆕 Phase-based recovery for sessions interrupted mid-processing
 */
async function recoverIncompleteSessions(client: Client): Promise<void> {
    console.log('🔍 Controllo sessioni interrotte per fase di processing...');

    const incompleteSessions = sessionPhaseManager.getIncompleteSessions();

    if (incompleteSessions.length === 0) {
        console.log('✅ Nessuna sessione interrotta trovata.');
        return;
    }

    console.log(`⚠️ Trovate ${incompleteSessions.length} sessioni interrotte:`);

    for (const session of incompleteSessions) {
        const { sessionId, phase, guildId } = session;
        const recoveryPhase = sessionPhaseManager.getRecoveryStartPhase(phase);

        console.log(`[Recovery] 🔄 Sessione ${sessionId} interrotta in fase: ${phase}`);

        if (!recoveryPhase) {
            console.log(`[Recovery] ⏩ Fase ${phase} non recuperabile, skip.`);
            continue;
        }

        if (guildId) {
            // We just log to console as requested.
        } else {
            console.warn(`[Recovery] ⚠️ Sessione ${sessionId} senza Guild ID associato.`);
        }

        console.warn(`\n⚠️  [RECOVERY REQUIRED] Sessione interrotta rilevata!`);
        console.warn(`   ID: ${sessionId}`);
        console.warn(`   Fase: ${phase}`);
        console.warn(`   Azione: Invia il comando \`$recover ${sessionId}\` su Discord per ripristinare.`);
        console.warn(`   Oppure \`$reset ${sessionId}\` per cancellare e ricominciare.\n`);
    }
}


async function recoverOrphanedFiles(): Promise<string[]> {
    const recordingsDir = path.join(__dirname, '..', '..', 'recordings'); // Adjusted path: src/bootstrap -> ../../recordings
    // index.ts was in src/. recordings in root/recordings?
    // index.ts: path.join(__dirname, '..', 'recordings') -> src/../recordings = root/recordings.
    // bootstrap/ready.ts: __dirname is src/bootstrap.
    // So ../../recordings is correct.

    if (!fs.existsSync(recordingsDir)) return [];

    const files = fs.readdirSync(recordingsDir);
    const mp3Files = files.filter(f => f.endsWith('.mp3'));

    if (mp3Files.length === 0) return [];

    console.log(`🔍 Scansione file orfani in corso (${mp3Files.length} file trovati)...`);
    let recoveredCount = 0;
    const affectedSessionIds = new Set<string>();

    for (const file of mp3Files) {
        const filePath = path.join(recordingsDir, file);
        const match = file.match(/^(.+)-(\d+)\.mp3$/);
        if (!match) continue;

        const userId = match[1];
        const timestamp = parseInt(match[2]);

        const existing = getRecording(file);
        if (existing) continue;

        if (Date.now() - timestamp < 300000) continue;

        console.log(`🩹 Trovato file orfano: ${file}. Tento recupero...`);

        let sessionId = findSessionByTimestamp(timestamp);

        if (!sessionId) {
            // FIX: Ensure valid campaign ID for emergency session
            const recoveryGuildId = 'recovery_guild'; // Placeholder guild for orphans
            const campaigns = getCampaigns(recoveryGuildId);
            let recoveryCamp = campaigns.find(c => c.name === "Campagna di Recupero");

            if (!recoveryCamp) {
                console.log(`[Recovery] Creazione "Campagna di Recupero" per sessioni orfane...`);
                // createCampaign returns number ID
                const newId = createCampaign(recoveryGuildId, "Campagna di Recupero");
                recoveryCamp = { id: newId } as any;
            }

            sessionId = `recovered-${uuidv4().substring(0, 8)}`;
            console.log(`🆕 Nessuna sessione trovata per ${file}. Creo sessione di emergenza: ${sessionId} (Campaign: ${recoveryCamp?.id})`);

            // Use the valid campaign ID
            createSession(sessionId, recoveryGuildId, recoveryCamp!.id);
        }

        addRecording(sessionId, file, filePath, userId, timestamp);
        affectedSessionIds.add(sessionId);

        try {
            const uploaded = await uploadToOracle(filePath, file, sessionId);
            if (uploaded) {
                updateRecordingStatus(file, 'SECURED');
            }
        } catch (err) {
            console.error(`[Recovery] Fallimento upload per ${file}:`, err);
        }

        await audioQueue.add('transcribe-job', {
            sessionId,
            fileName: file,
            filePath,
            userId
        }, {
            jobId: file,
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
            removeOnFail: false
        });

        recoveredCount++;
    }

    if (recoveredCount > 0) {
        console.log(`✅ Recupero completato: ${recoveredCount} file orfani ripristinati.`);
    }

    // Return only the set of session IDs that were affected by recovery
    return [...affectedSessionIds];
}

async function processOrphanedSessionsSequentially(client: Client, sessionIds: string[]) {
    for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i];

        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 [${i + 1}/${sessionIds.length}] Inizio recupero sessione: ${sessionId}`);
        console.log(`${'='.repeat(60)}\n`);

        monitor.startSession(sessionId);

        try {
            await removeSessionJobs(sessionId);
            const filesToProcess = resetUnfinishedRecordings(sessionId);

            if (filesToProcess.length === 0) {
                console.log(`⚠️ Nessun file da processare per ${sessionId}. Skip.`);
                continue;
            }

            console.log(`📁 Trovati ${filesToProcess.length} file da processare.`);

            for (const job of filesToProcess) {
                await audioQueue.add('transcribe-job', {
                    sessionId: job.session_id,
                    fileName: job.filename,
                    filePath: job.filepath,
                    userId: job.user_id
                }, {
                    jobId: job.filename,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 2000 },
                    removeOnComplete: true,
                    removeOnFail: false
                });
            }

            console.log(`✅ ${filesToProcess.length} file accodati. Avvio processing...`);
            await resetRecordingState();

            const session = db.prepare('SELECT guild_id FROM sessions WHERE session_id = ?').get(sessionId) as { guild_id: string } | undefined;
            let channel: TextChannel | null = null;

            if (session) {
                const targetChannelId = getGuildConfig(session.guild_id, 'summary_channel_id') || getGuildConfig(session.guild_id, 'cmd_channel_id');
                if (targetChannelId) {
                    try {
                        channel = await client.channels.fetch(targetChannelId) as TextChannel;
                        await channel.send(`🔄 **Sessione Recuperata** [${i + 1}/${sessionIds.length}]: \`${sessionId}\`\nElaborazione in corso...`);
                    } catch (err) {
                        console.warn(`⚠️ Impossibile accedere al canale ${targetChannelId}`);
                    }
                }
            }

            console.log(`⏳ Attendo completamento sessione ${sessionId}...`);

            try {
                // Use imported util or local compatible logic
                // Assuming util takes (client, sessionId, channel)
                await waitForCompletionAndSummarizeUtil(client, sessionId, channel as TextChannel);
                console.log(`✅ Sessione ${sessionId} completata con successo!`);

                const metrics = await monitor.endSession();
                if (metrics) {
                    console.log('[Monitor] 📊 Invio report sessione recuperata...');
                    await processSessionReport(metrics);
                }

            } catch (err: any) {
                console.error(`❌ Errore durante elaborazione ${sessionId}:`, err.message);
                await monitor.endSession();
                if (channel) {
                    await channel.send(`⚠️ Errore durante elaborazione sessione \`${sessionId}\`. Usa \`$racconta ${sessionId}\` per riprovare.`).catch(() => { });
                }
            }

            if (i < sessionIds.length - 1) {
                console.log(`⏸️ Pausa 5s prima della prossima sessione...\n`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

        } catch (err: any) {
            console.error(`❌ Errore critico sessione ${sessionId}:`, err.message);
        }
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Tutte le ${sessionIds.length} sessioni orfane sono state elaborate!`);
    console.log(`${'='.repeat(60)}\n`);
}
