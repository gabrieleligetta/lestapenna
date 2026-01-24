import { Message, TextChannel } from 'discord.js';
import { Command } from '../../types';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { resetUnfinishedRecordings } from '../../db';
import { audioQueue, removeSessionJobs } from '../../services/queue';
import { waitForCompletionAndSummarize as waitForCompletionAndSummarizeUtil } from '../../publisher';
import { monitor } from '../../monitor';
import { processSessionReport } from '../../reporter';

export const recoverCommand: Command = {
    name: 'recover',
    description: 'Ripristina manualmente una sessione interrotta',
    aliases: ['resume', 'ripristina'],
    adminOnly: true,
    async execute(message: Message, args: string[]) {
        const sessionId = args[0];
        if (!sessionId) {
            await message.reply('❌ Specifica un ID sessione.');
            return;
        }

        const phaseInfo = sessionPhaseManager.getPhase(sessionId);
        if (!phaseInfo) {
            await message.reply(`❌ Sessione ${sessionId} non trovata.`);
            return;
        }

        if (phaseInfo.phase === 'DONE' || phaseInfo.phase === 'IDLE') {
            await message.reply(`⚠️ La sessione ${sessionId} è già nello stato: ${phaseInfo.phase}. Usa $reprocess se vuoi rigenerarla.`);
            return;
        }

        const recoveryPhase = sessionPhaseManager.getRecoveryStartPhase(phaseInfo.phase);
        if (!recoveryPhase) {
            // If phase is ERROR, allows retry
            if (phaseInfo.phase === 'ERROR') {
                // Try from start of phase or default to summarizing if transcripts exist?
                // For now, treat ERROR as needing manual check or assume standard logic
            } else {
                await message.reply(`❌ Fase ${phaseInfo.phase} non recuperabile automaticamente.`);
                return;
            }
        }

        await message.reply(`🔄 Avvio recupero sessione ${sessionId} (Fase: ${phaseInfo.phase})...`);

        try {
            // Logic adapted from startup recovery
            if (recoveryPhase === 'TRANSCRIBING' || (!recoveryPhase && phaseInfo.phase === 'ERROR')) { // Default logic for ERROR/Transcribing
                await removeSessionJobs(sessionId);
                const filesToProcess = resetUnfinishedRecordings(sessionId);

                if (filesToProcess.length === 0) {
                    // Try summarizing
                    monitor.startSession(sessionId);
                    await waitForCompletionAndSummarizeUtil(message.client, sessionId, message.channel as TextChannel);
                    await monitor.endSession();
                } else {
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
                    await message.channel.send(`📁 Ri-accodati ${filesToProcess.length} file audio.`);

                    monitor.startSession(sessionId);
                    await waitForCompletionAndSummarizeUtil(message.client, sessionId, message.channel as TextChannel);
                    const metrics = await monitor.endSession();
                    if (metrics) await processSessionReport(metrics);
                }

            } else {
                // Summarizing / Late phases
                monitor.startSession(sessionId);
                await waitForCompletionAndSummarizeUtil(message.client, sessionId, message.channel as TextChannel);
                const metrics = await monitor.endSession();
                if (metrics) await processSessionReport(metrics);
            }

            // Success handled by waitForCompletionAndSummarizeUtil notification logic?
            // Usually yes, but we can confirm here.
            // Wait, waitFor... sends messages to channel if passed.

        } catch (err: any) {
            console.error(`[Recover] Error:`, err);
            await message.reply(`❌ Errore durante il recupero: ${err.message}`);
        }
    }
};
