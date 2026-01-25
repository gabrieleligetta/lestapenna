import { Command, CommandContext } from '../types';
import { resetSessionData, updateRecordingStatus } from '../../db';
import { audioQueue, removeSessionJobs } from '../../services/queue';
import { monitor } from '../../monitor';
import { downloadFromOracle, uploadToOracle } from '../../services/backup';
import { purgeSessionData } from '../../services/janitor';
import * as fs from 'fs';

export const resetCommand: Command = {
    name: 'reset',
    aliases: ['resetsession'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;
        const targetSessionId = args[0];

        if (!targetSessionId) {
            await message.reply("Uso: `$reset <ID_SESSIONE>` - Forza la rielaborazione completa.");
            return;
        }

        await message.reply(`🔄 **Reset Sessione ${targetSessionId}** avviato...\n1. Pulizia coda...`);

        const removed = await removeSessionJobs(targetSessionId);

        // 1.5 Purge Derived Data (DB + RAG + Clean Bio State + AI Cache)
        purgeSessionData(targetSessionId, true); // 🆕 Clear cache on full reset

        const filesToProcess = resetSessionData(targetSessionId);

        if (filesToProcess.length === 0) {
            await message.reply(`⚠️ Nessun file trovato per la sessione ${targetSessionId}.`);
            return;
        }

        await message.reply(`2. Database resettato (${filesToProcess.length} file trovati).\n3. Ripristino file e reinserimento in coda...`);

        console.log(`[Monitor] 🔄 Avvio monitoring per sessione reset: ${targetSessionId}`);
        monitor.startSession(targetSessionId);

        let restoredCount = 0;

        for (const job of filesToProcess) {
            if (!fs.existsSync(job.filepath)) {
                // Assuming downloadFromOracle signature: (filename, filepath, sessionId) ? check index.ts line 2099
                // index.ts: downloadFromOracle(job.filename, job.filepath, targetSessionId)
                const success = await downloadFromOracle(job.filename, job.filepath, targetSessionId);
                if (success) restoredCount++;
            }

            try {
                // index.ts: uploadToOracle(job.filepath, job.filename, targetSessionId)
                const uploaded = await uploadToOracle(job.filepath, job.filename, targetSessionId);
                if (uploaded) {
                    updateRecordingStatus(job.filename, 'SECURED');
                }
            } catch (err) {
                console.error(`[Custode] Fallimento upload durante reset per ${job.filename}:`, err);
            }

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

        await audioQueue.resume();

        let statusMsg = `✅ **Reset Completato**. ${filesToProcess.length} file sono stati rimessi in coda.`;
        if (restoredCount > 0) {
            statusMsg += `\n📦 ${restoredCount} file mancanti sono stati ripristinati dal Cloud.`;
        }
        await message.reply(statusMsg);
    }
};
