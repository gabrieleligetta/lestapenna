import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { exec } from 'child_process';
import { pipeline } from 'stream/promises';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
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
import { isGuildAdmin } from '../../utils/permissions';

// Helper for test environment (copied/adapted from index.ts)
// async function ensureTestEnvironment(guildId: string, authorId: string, message: Message) {
//     let campaigns = getCampaigns(guildId);
//     let testCamp = campaigns.find(c => c.name === "Campagna di Test");
// 
//     if (!testCamp) {
//         await message.reply("⚙️ Creazione campagna di test automatica...");
//         const newId = createCampaign(guildId, "Campagna di Test");
//         testCamp = { id: newId, guild_id: guildId, name: "Campagna di Test", description: "Campagna per debug e test stream", role: "game-master" } as any;
//     }
// 
//     // Set active locally for this context? 
//     // The command context activeCampaign might be null if not set global.
//     // We should return it.
//     return testCamp;
// }

export const debugCommand: Command = {
    name: 'debug',
    aliases: ['teststream', 'cleantest', 'testmail'],
    requiresCampaign: false,

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
                await message.reply("Uso: `$teststream <URL>` (es. YouTube o link diretto mp3)");
                return;
            }

            const sessionId = `test-direct-${uuidv4().substring(0, 8)}`;

            // Crea sessione di test
            createSession(sessionId, message.guild!.id, currentCampaign!.id);
            monitor.startSession(sessionId);

            // Assegna subito un numero di sessione progressivo
            const lastNumber = db.prepare(`
                SELECT MAX(CAST(session_number AS INTEGER)) as maxnum 
                FROM sessions 
                WHERE campaign_id = ? AND session_number IS NOT NULL
            `).get(currentCampaign!.id) as { maxnum: number | null } | undefined;

            const nextNumber = (lastNumber?.maxnum || 0) + 1;
            setSessionNumber(sessionId, nextNumber);

            await message.reply(`🧪 **Test Stream Avviato**\nID Sessione: \`${sessionId}\`\nAnalisi del link in corso...`);

            const recordingsDir = path.join(__dirname, '..', '..', '..', 'recordings'); // Adjust path: src/commands/admin -> ../../../recordings? No. src/../recordings = root/src/recordings?
            // index.ts was in src/. recording dir is path.join(__dirname, '..', 'recordings') -> src/../recordings = root/recordings.
            // From src/commands/admin/debug.ts: ../../../recordings = src/commands/admin/../../../recordings = src/recordings? 
            // root is listapenna/. src is listapenna/src.
            // recordings is listapenna/recordings?
            // index.ts: __dirname is src (if built? or ts-node?).
            // Usually project structure: src/index.ts. recordings/ in root.
            // index.ts path.join(__dirname, '..', 'recordings') means root/recordings.
            // debug.ts is in src/commands/admin.
            // So ../../../recordings = root/recordings.

            if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

            const tempFileName = `${message.author.id}-${Date.now()}.mp3`;
            const tempFilePath = path.join(recordingsDir, tempFileName);

            try {
                // RILEVAMENTO YOUTUBE
                const isYouTube = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/.+$/.test(url);

                if (isYouTube) {
                    await safeSend(message.channel as TextChannel, "🎥 Link YouTube rilevato. Avvio download con yt-dlp...");

                    const cookiesPath = path.resolve(__dirname, '..', '..', '..', 'cookies.json');
                    let cookieArg = '';

                    if (fs.existsSync(cookiesPath)) {
                        const stats = fs.statSync(cookiesPath);
                        if (stats.isFile() && stats.size > 0) {
                            cookieArg = ` --cookies "${cookiesPath}"`;
                            console.log("[TestStream] Cookies trovati e utilizzati per il download.");
                        }
                    }

                    const cmd = `yt-dlp -x --audio-format mp3 --output "${tempFilePath}"${cookieArg} "${url}"`;

                    await new Promise<void>((resolve, reject) => {
                        exec(cmd, (error, stdout, stderr) => {
                            if (error) {
                                console.error(`[yt-dlp error] ${stderr}`);
                                reject(error);
                            } else {
                                console.log(`[yt-dlp output] ${stdout}`);
                                resolve();
                            }
                        });
                    });

                    console.log(`[TestStream] Download YouTube completato: ${tempFilePath}`);

                } else {
                    await safeSend(message.channel as TextChannel, "🔗 Link diretto rilevato. Scarico file...");

                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`Errore HTTP: ${response.statusText}`);

                    const contentType = response.headers.get('content-type');
                    if (contentType && !contentType.startsWith('audio/') && !contentType.includes('octet-stream')) {
                        throw new Error(`Il link non è un file audio valido (Rilevato: ${contentType}). Usa un link diretto o YouTube.`);
                    }

                    if (!response.body) throw new Error("Nessun contenuto ricevuto");

                    // @ts-ignore
                    await pipeline(response.body, fs.createWriteStream(tempFilePath));
                    console.log(`[TestStream] Download diretto completato: ${tempFilePath}`);
                }

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

                await message.reply(`✅ Audio scaricato e accodato. Attendi la trascrizione e il riassunto...`);

                // Avvia monitoraggio
                // @ts-ignore
                await waitForCompletionAndSummarize(message.client, sessionId, message.channel as TextChannel);

            } catch (error: any) {
                console.error(`[TestStream] Errore: ${error.message}`);
                await message.reply(`❌ Errore durante il processo: ${error.message}`);
                if (fs.existsSync(tempFilePath)) {
                    try { fs.unlinkSync(tempFilePath); } catch (e) { }
                }
            }
        }

        // --- $cleantest ---
        if (commandName === 'cleantest') {
            await message.reply("🧹 Pulizia test non implementata in questo comando.");
        }

        // --- $testmail ---
        if (commandName === 'testmail') {
            if (!isGuildAdmin(message.author.id, message.guild!.id)) return;

            await message.reply("📧 Invio email di test in corso...");
            // Use import() to avoid circular dependency issues if reporter depends on db/config which debug might depend on?
            // Actually debug.ts imports from '../../db'. reporter imports from '../../db'. Should be fine.
            // But I need to import sendTestEmail from reporter/testing explicitly at top.
            // For now, I'll dynamic import or I'll just add the import at top in next step.
            // Wait, I can't add top import here. I should do it properly.
            // I'll skip dynamic and assume I will fix imports in next step or use require?
            // Standard import is better.
            const { sendTestEmail } = await import('../../reporter/testing');

            const success = await sendTestEmail('gabligetta@gmail.com');

            if (success) {
                await message.reply("✅ Email inviata con successo! Controlla la casella di posta.");
            } else {
                await message.reply("❌ Errore durante l'invio. Controlla i log della console.");
            }
        }
    }
};
