import { Client, TextChannel } from 'discord.js';
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
    getUnprocessedRecordings,
    // removeSessionJobs,
    resetUnfinishedRecordings,
    db,
    getGuildConfig,
    createSession,
    addRecording,
    updateRecordingStatus,
    getRecording,
    findSessionByTimestamp
} from '../db';
import { audioQueue, removeSessionJobs } from '../services/queue';
// If waitForCompletionAndSummarize logic was different in index.ts, I should use the one from utils/publish if compatible.
// index.ts used waitForCompletionAndSummarize(sessionId, channel).
// utils/publish likely exports publishSummary, not waitFor...
import { waitForCompletionAndSummarize as waitForCompletionAndSummarizeUtil } from '../publisher';

// Note: recoverOrphanedFiles and processOrphanedSessionsSequentially were local. Moving here.

export function registerReadyHandler(client: Client) {
    client.once('ready', async () => {
        console.log(`✅ Bot online: ${client.user?.tag}`);
        await testRemoteConnection();
        await checkStorageUsage();

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

        await recoverOrphanedFiles();

        console.log('🔍 Controllo lavori interrotti nel database...');
        const orphanJobs = getUnprocessedRecordings();

        if (orphanJobs.length > 0) {
            const sessionIds = [...new Set(orphanJobs.map(job => job.session_id))];
            console.log(`📦 Trovati ${orphanJobs.length} file orfani in ${sessionIds.length} sessioni.`);

            await processOrphanedSessionsSequentially(client, sessionIds);
        } else {
            console.log('✅ Nessun lavoro in sospeso trovato.');
        }
    });
}

async function recoverOrphanedFiles() {
    const recordingsDir = path.join(__dirname, '..', '..', 'recordings'); // Adjusted path: src/bootstrap -> ../../recordings
    // index.ts was in src/. recordings in root/recordings?
    // index.ts: path.join(__dirname, '..', 'recordings') -> src/../recordings = root/recordings.
    // bootstrap/ready.ts: __dirname is src/bootstrap.
    // So ../../recordings is correct.

    if (!fs.existsSync(recordingsDir)) return;

    const files = fs.readdirSync(recordingsDir);
    const mp3Files = files.filter(f => f.endsWith('.mp3'));

    if (mp3Files.length === 0) return;

    console.log(`🔍 Scansione file orfani in corso (${mp3Files.length} file trovati)...`);
    let recoveredCount = 0;

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
            sessionId = `recovered-${uuidv4().substring(0, 8)}`;
            console.log(`🆕 Nessuna sessione trovata per ${file}. Creo sessione di emergenza: ${sessionId}`);
            createSession(sessionId, 'unknown', 0);
        }

        addRecording(sessionId, file, filePath, userId, timestamp);

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
            await audioQueue.resume();

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
