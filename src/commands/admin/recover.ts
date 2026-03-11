import { Message, TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { resetUnfinishedRecordings } from '../../db';
import { audioQueue, removeSessionJobs } from '../../services/queue';
import { waitForCompletionAndSummarize as waitForCompletionAndSummarizeUtil } from '../../publisher';
import { monitor } from '../../monitor';
import { processSessionReport } from '../../reporter';
import { isGuildAdmin } from '../../utils/permissions';
import { mixSessionAudio } from '../../services/sessionMixer';

export const recoverCommand: Command = {
    name: 'recover',
    aliases: ['resume', 'ripristina'],
    requiresCampaign: false,
    async execute(ctx: CommandContext) {
        const { message, args } = ctx;

        if (!isGuildAdmin(message.author.id, message.guild!.id)) return;

        const subCommand = args[0];

        // --- SUBCOMMAND: REGENERATE ALL (TIME TRAVEL) ---
        if (subCommand === 'regenerate-all') {
            const campaignId = ctx.activeCampaign?.id;
            if (!campaignId) {
                await message.reply("❌ Nessuna campagna attiva. Impossibile rigenerare.");
                return;
            }

            const confirmMsg = await message.reply("⏳ **TIME TRAVEL: Rigenerazione Globale Avviata...**\nSto rianalizzando l'intera storia della campagna per riscrivere le biografie.");

            // 1. Characters (Full Reset & Rewrite from History)
            const { resetAllCharacterBios } = await import('../../bard/sync/character');
            const charResult = await resetAllCharacterBios(campaignId);
            await confirmMsg.edit(`⏳ **TIME TRAVEL**\n✅ Personaggi: ${charResult.reset} rigenerati.`);

            // 2. NPCs (Sync Force = Merge History)
            const { syncAllDirtyNpcs, syncNpcDossierIfNeeded } = await import('../../bard/sync/npc'); // syncAllDirty checks dirty only. We want ALL.
            const { listNpcs } = await import('../../db');

            const allNpcs = listNpcs(campaignId);
            let npcsCount = 0;

            // Chunk processing to avoid rate limits? process in batches?
            // For now simple loop with slight delay if needed, but bio gen is separate calls.
            await confirmMsg.edit(`⏳ **TIME TRAVEL**\n✅ Personaggi: ${charResult.reset} rigenerati.\n⚙️ NPC: 0/${allNpcs.length}...`);

            for (const npc of allNpcs) {
                await syncNpcDossierIfNeeded(campaignId, npc.name, true);
                npcsCount++;
                if (npcsCount % 5 === 0) {
                    await confirmMsg.edit(`⏳ **TIME TRAVEL**\n✅ Personaggi: ${charResult.reset} rigenerati.\n⚙️ NPC: ${npcsCount}/${allNpcs.length}...`);
                }
            }

            // 3. Atlas (Sync Force = Merge History)
            const { listAllAtlasEntries } = await import('../../db');
            const { syncAtlasEntryIfNeeded } = await import('../../bard/sync/atlas');

            const allAtlas = listAllAtlasEntries(campaignId);
            let atlasCount = 0;

            await confirmMsg.edit(`⏳ **TIME TRAVEL**\n✅ Personaggi: ${charResult.reset}\n✅ NPC: ${npcsCount}\n⚙️ Atlante: 0/${allAtlas.length}...`);

            for (const loc of allAtlas) {
                await syncAtlasEntryIfNeeded(campaignId, loc.macro_location, loc.micro_location, true);
                atlasCount++;
                if (atlasCount % 5 === 0) {
                    await confirmMsg.edit(`⏳ **TIME TRAVEL**\n✅ Personaggi: ${charResult.reset}\n✅ NPC: ${npcsCount}\n⚙️ Atlante: ${atlasCount}/${allAtlas.length}...`);
                }
            }

            await confirmMsg.edit(
                `✨ **RIGENERAZIONE COMPLETATA** ✨\n\n` +
                `👤 **Personaggi**: ${charResult.reset} riscritti.\n` +
                `🎭 **NPC**: ${npcsCount} aggiornati.\n` +
                `🌍 **Atlante**: ${atlasCount} luoghi riconsolidati.\n\n` +
                `La storia è stata riscritta.`
            );
            return;
        }

        // --- OLD RECOVER LOGIC (Session ID) ---
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
                // Mix sessione (come nel flusso normale di disconnect)
                try {
                    await (message.channel as TextChannel).send(`📀 Generazione mix audio sessione...`);
                    await mixSessionAudio(sessionId, true);
                } catch (mixErr: any) {
                    console.warn(`[Recover] ⚠️ Mix audio fallito (non bloccante): ${mixErr.message}`);
                    await (message.channel as TextChannel).send(`⚠️ Mix audio non riuscito: ${mixErr.message}. Proseguo con la trascrizione.`);
                }

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
                    await (message.channel as TextChannel).send(`📁 Ri-accodati ${filesToProcess.length} file audio.`);

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
