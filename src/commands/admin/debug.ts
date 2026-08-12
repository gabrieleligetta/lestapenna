import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID as uuidv4 } from 'crypto';
import {
    createSession,
    db,
    setSessionNumber,
    getCampaignLocation,
    addRecording,
    updateRecordingStatus,
    getCampaigns,
    createCampaign,
    setActiveCampaign
} from '../../db';
import { monitor } from '../../monitor';
import { audioQueue } from '../../services/queue';
import { uploadToOracle } from '../../services/backup';
import { waitForCompletionAndSummarize } from '../../publisher';
import { safeSend } from '../../utils/discordHelper';

import { ensureTestEnvironment } from '../sessions/testEnv';
import { config } from '../../config';
import { t } from '../../i18n';
import { safeDownloadToFile } from '../../utils/safeFetch';

/**
 * Cap for the test audio. A real four-hour session in FLAC sits comfortably
 * below it: this is here to stop a hostile link from filling the disk, not to
 * limit legitimate use.
 */
const MAX_TEST_AUDIO_BYTES = 200 * 1024 * 1024;

export const debugCommand: Command = {
    name: 'debug',
    category: 'dev',
    descriptionKey: 'help.cmd.debug',
    aliases: ['teststream', 'testmail'],
    requiresCampaign: false,
    operatorOnly: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        // --- $teststream <URL> ---
        if (commandName === 'teststream') {
            let currentCampaign = activeCampaign;
            if (!currentCampaign) {
                const setupCamp = await ensureTestEnvironment(message.guild!.id, message.author.id, message);
                if (setupCamp) currentCampaign = setupCamp;
                else return; // ensureTestEnvironment handles errors/replies
            }

            const url = args[0];
            if (!url) {
                await message.reply(t(ctx.locale, 'admin.testStreamUsage'));
                return;
            }

            const sessionId = `test-direct-${uuidv4().substring(0, 8)}`;

            // Create a test session
            createSession(sessionId, message.guild!.id, currentCampaign!.id);
            monitor.startSession(sessionId);

            // Assign a progressive session number straight away
            const lastNumber = db.prepare(`
                SELECT MAX(CAST(session_number AS INTEGER)) as maxnum 
                FROM sessions 
                WHERE campaign_id = ? AND session_number IS NOT NULL
            `).get(currentCampaign!.id) as { maxnum: number | null } | undefined;

            const nextNumber = (lastNumber?.maxnum || 0) + 1;
            setSessionNumber(sessionId, nextNumber);

            await message.reply(t(ctx.locale, 'admin.testStreamStarted', { id: sessionId }));

            // The same directory the recorder uses, taken from the config
            // instead of rebuilt with a chain of '..' from this file.
            const recordingsDir = config.paths.recordingsDir;
            if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

            const tempFileName = `${message.author.id}-${Date.now()}.mp3`;
            const tempFilePath = path.join(recordingsDir, tempFileName);

            try {
                await safeSend(message.channel as TextChannel, t(ctx.locale, 'admin.directLinkDetected'));

                // A direct audio link, fetched through safeDownloadToFile:
                // scheme limited to http/https, destination re-checked on every
                // redirect, size cap applied to the stream.
                //
                // There used to be a YouTube branch here that invoked yt-dlp via
                // `exec`, interpolating the URL into the command string — that
                // is arbitrary command execution on the host starting from a
                // Discord message — and handed it a cookies.json if it found one
                // in the project root. Beyond the hole, it was a tool for
                // downloading from YouTube with an authenticated session: in a
                // public repository, shipping it means distributing it.
                await safeDownloadToFile(url, tempFilePath, {
                    maxBytes: MAX_TEST_AUDIO_BYTES,
                    allowedContentTypes: ['audio/', 'application/octet-stream'],
                });
                console.log(`[TestStream] Download diretto completato: ${tempFilePath}`);

                // PROCEDURA STANDARD
                const loc = getCampaignLocation(message.guild!.id);
                const macro = loc?.macro || null;
                const micro = loc?.micro || null;
                const year = currentCampaign?.current_year ?? null;

                addRecording(sessionId, tempFileName, tempFilePath, message.author.id, Date.now(), macro, micro, year);

                try {
                    const uploaded = await uploadToOracle(tempFilePath, tempFileName, sessionId);
                    if (uploaded) {
                        updateRecordingStatus(tempFileName, 'SECURED');
                    }
                } catch (e) {
                    console.error("[TestStream] Errore upload:", e);
                }

                await audioQueue.add('transcribe-job', {
                    sessionId: sessionId,
                    fileName: tempFileName,
                    filePath: tempFilePath,
                    userId: message.author.id
                }, {
                    jobId: tempFileName,
                    attempts: 3,
                    removeOnComplete: true
                });

                await message.reply(t(ctx.locale, 'admin.audioQueued'));

                // Avvia monitoraggio
                // @ts-ignore
                await waitForCompletionAndSummarize(message.client, sessionId, message.channel as TextChannel);

            } catch (error: any) {
                console.error(`[TestStream] Errore: ${error.message}`);
                await message.reply(t(ctx.locale, 'admin.testStreamError', { message: error.message }));
                if (fs.existsSync(tempFilePath)) {
                    try { fs.unlinkSync(tempFilePath); } catch (e) { }
                }
            }
        }

        // --- $testmail ---
        if (commandName === 'testmail') {
            // To the recipient configured by the instance. It used to be an address
            // written in here: the test command of anyone who had installed
            // Lestapenna mailed one single person, always the same one, who had
            // nothing to do with that server.
            const recipient = config.smtp.defaultRecipient;
            if (!recipient) {
                await message.reply(t(ctx.locale, 'admin.testEmailNoRecipient'));
                return;
            }

            await message.reply(t(ctx.locale, 'admin.testEmailSending'));
            const { sendTestEmail } = await import('../../reporter/testing');
            const success = await sendTestEmail(recipient);

            if (success) {
                await message.reply(t(ctx.locale, 'admin.testEmailSent'));
            } else {
                await message.reply(t(ctx.locale, 'admin.testEmailError'));
            }
        }

        // --- $debug ---
        // The primary name had no branch of its own: without this, invoking it
        // bare answered nothing and looked like a dead bot.
        if (commandName === 'debug') {
            await message.reply(t(ctx.locale, 'admin.debugUsage'));
        }
    }
};
