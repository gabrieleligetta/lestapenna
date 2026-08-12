import { Message, TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { resetUnfinishedRecordings } from '../../db';
import { audioQueue, removeSessionJobs } from '../../services/queue';
import { waitForCompletionAndSummarize as waitForCompletionAndSummarizeUtil } from '../../publisher';
import { monitor } from '../../monitor';
import { processSessionReport } from '../../reporter';
import { mixSessionAudio } from '../../services/sessionMixer';
import { t } from '../../i18n';
import { assertSessionInGuild } from '../utils/sessionScope';

export const recoverCommand: Command = {
    name: 'recover',
    category: 'dev',
    descriptionKey: 'help.cmd.recover',
    // `resume` is gone: pauseCommand registers it too and, being registered
    // later, won. So `$resume` has always meant «resume the recording», never
    // «recover a session» — and since recover is operatorOnly while pause is
    // not, the collision also quietly downgraded the permission on that name.
    aliases: ['ripristina'],
    requiresCampaign: false,
    operatorOnly: true,
    async execute(ctx: CommandContext) {
        const { message, args } = ctx;

        const subCommand = args[0];

        // --- SUBCOMMAND: REGENERATE ALL (TIME TRAVEL) ---
        if (subCommand === 'regenerate-all') {
            const campaignId = ctx.activeCampaign?.id;
            if (!campaignId) {
                await message.reply(t(ctx.locale, 'admin.recoverNoCampaign'));
                return;
            }

            const confirmMsg = await message.reply(t(ctx.locale, 'admin.timeTravelStarted'));

            // 1. Characters (Full Reset & Rewrite from History)
            const { resetAllCharacterBios } = await import('../../bard/sync/character');
            const charResult = await resetAllCharacterBios(campaignId);
            await confirmMsg.edit(t(ctx.locale, 'admin.timeTravelCharacters', { characters: charResult.reset }));

            // 2. NPCs (Sync Force = Merge History)
            const { syncAllDirtyNpcs, syncNpcDossierIfNeeded } = await import('../../bard/sync/npc'); // syncAllDirty checks dirty only. We want ALL.
            const { listNpcs } = await import('../../db');

            const allNpcs = listNpcs(campaignId);
            let npcsCount = 0;

            // Chunk processing to avoid rate limits? process in batches?
            // For now simple loop with slight delay if needed, but bio gen is separate calls.
            await confirmMsg.edit(t(ctx.locale, 'admin.timeTravelNpcs', { characters: charResult.reset, npcs: 0, total: allNpcs.length }));

            for (const npc of allNpcs) {
                await syncNpcDossierIfNeeded(campaignId, npc.name, true);
                npcsCount++;
                if (npcsCount % 5 === 0) {
                    await confirmMsg.edit(t(ctx.locale, 'admin.timeTravelNpcs', { characters: charResult.reset, npcs: npcsCount, total: allNpcs.length }));
                }
            }

            // 3. Atlas (Sync Force = Merge History)
            const { listAllAtlasEntries } = await import('../../db');
            const { syncAtlasEntryIfNeeded } = await import('../../bard/sync/atlas');

            const allAtlas = listAllAtlasEntries(campaignId);
            let atlasCount = 0;

            await confirmMsg.edit(t(ctx.locale, 'admin.timeTravelAtlas', { characters: charResult.reset, npcs: npcsCount, places: 0, total: allAtlas.length }));

            for (const loc of allAtlas) {
                await syncAtlasEntryIfNeeded(campaignId, loc.macro_location, loc.micro_location, true);
                atlasCount++;
                if (atlasCount % 5 === 0) {
                    await confirmMsg.edit(t(ctx.locale, 'admin.timeTravelAtlas', { characters: charResult.reset, npcs: npcsCount, places: atlasCount, total: allAtlas.length }));
                }
            }

            await confirmMsg.edit(t(ctx.locale, 'admin.timeTravelComplete', {
                characters: charResult.reset, npcs: npcsCount, places: atlasCount,
            }));
            return;
        }

        // --- OLD RECOVER LOGIC (Session ID) ---
        const sessionId = args[0];
        if (!sessionId) {
            await message.reply(t(ctx.locale, 'admin.recoverSpecifySession'));
            return;
        }

        if (!await assertSessionInGuild(ctx, sessionId)) return;

        const phaseInfo = sessionPhaseManager.getPhase(sessionId);
        if (!phaseInfo) {
            await message.reply(t(ctx.locale, 'admin.sessionNotFound', { id: sessionId }));
            return;
        }

        if (phaseInfo.phase === 'DONE' || phaseInfo.phase === 'IDLE') {
            await message.reply(t(ctx.locale, 'admin.recoverAlreadyState', { id: sessionId, phase: phaseInfo.phase }));
            return;
        }

        const recoveryPhase = sessionPhaseManager.getRecoveryStartPhase(sessionId, phaseInfo.phase);
        if (!recoveryPhase) {
            await message.reply(t(ctx.locale, 'admin.recoverPhaseUnsupported', { phase: phaseInfo.phase }));
            return;
        }

        await message.reply(t(ctx.locale, 'admin.recoverStarted', { id: sessionId, phase: phaseInfo.phase, recovery: recoveryPhase }));

        try {
            // Logic adapted from startup recovery
            if (recoveryPhase === 'TRANSCRIBING') {
                // Session mix (as in the normal disconnect flow)
                try {
                    await (message.channel as TextChannel).send(t(ctx.locale, 'admin.recoverMixing'));
                    await mixSessionAudio(sessionId, true);
                } catch (mixErr: any) {
                    console.warn(`[Recover] ⚠️ Mix audio fallito (non bloccante): ${mixErr.message}`);
                    await (message.channel as TextChannel).send(t(ctx.locale, 'admin.recoverMixFailed', { message: mixErr.message }));
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
                    await (message.channel as TextChannel).send(t(ctx.locale, 'admin.recoverRequeued', { count: filesToProcess.length }));

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
            await message.reply(t(ctx.locale, 'admin.recoverError', { message: err.message }));
        }
    }
};
