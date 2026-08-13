import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { sessionPhaseManager } from '../../services/SessionPhaseManager';
import { getSessionGuildId, resetUnfinishedRecordings } from '../../db';
import { removeSessionJobs } from '../../services/queue';
import { enqueueSessionFinalization, enqueueSessionProcessing } from '../../services/sessionProcessing';
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

        const recoveryPhase = sessionPhaseManager.getRecoveryStartPhase(sessionId, phaseInfo.phase);
        if (!recoveryPhase) {
            if (phaseInfo.phase === 'DONE' || phaseInfo.phase === 'IDLE') {
                await message.reply(t(ctx.locale, 'admin.recoverAlreadyState', { id: sessionId, phase: phaseInfo.phase }));
                return;
            }
            await message.reply(t(ctx.locale, 'admin.recoverPhaseUnsupported', { phase: phaseInfo.phase }));
            return;
        }

        await message.reply(t(ctx.locale, 'admin.recoverStarted', { id: sessionId, phase: phaseInfo.phase, recovery: recoveryPhase }));

        try {
            await removeSessionJobs(sessionId);
            const guildId = getSessionGuildId(sessionId)!;

            if (recoveryPhase === 'TRANSCRIBING') {
                const filesToProcess = resetUnfinishedRecordings(sessionId);
                sessionPhaseManager.setPhase(sessionId, 'TRANSCRIBING');
                await enqueueSessionProcessing(sessionId, guildId, message.channel.id);
                await (message.channel as TextChannel).send(t(ctx.locale, 'admin.recoverRequeued', { count: filesToProcess.length }));
            } else {
                sessionPhaseManager.setPhase(sessionId, 'SUMMARIZING');
                await enqueueSessionFinalization(sessionId, guildId, message.channel.id);
            }

        } catch (err: any) {
            console.error(`[Recover] Error:`, err);
            await message.reply(t(ctx.locale, 'admin.recoverError', { message: err.message }));
        }
    }
};
