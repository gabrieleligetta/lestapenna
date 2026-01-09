import 'dotenv/config';
import sodium from 'libsodium-wrappers';
import { Message, TextChannel } from 'discord.js';
import { client } from './discord/state';
import { handleCampaignCommands } from './discord/commands/campaign';
import { handleSessionCommands } from './discord/commands/session';
import { handleCharacterCommands } from './discord/commands/character';
import { handleLoreCommands } from './discord/commands/lore';
import { handleUtilityCommands } from './discord/commands/utility';
import { handleVoiceStateUpdate } from './discord/events/voiceStateUpdate';
import { recoverOrphanedFiles, checkUnprocessedJobs, ensureTestEnvironment } from './services/recoveryService';
import { startWorker } from './worker';
import { getGuildConfig, db, addRecording, updateRecordingStatus, createSession, getCampaignLocation, getActiveCampaign } from './db';
import { uploadToOracle } from './backupService';
import { audioQueue, removeSessionJobs } from './queue'; // Import corretto
import { monitor } from './monitor';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { pipeline } from 'stream/promises';
import { waitForCompletionAndSummarize } from './services/sessionService';
import { disconnect } from './voicerecorder';

const getCmdChannelId = (guildId: string) => getGuildConfig(guildId, 'cmd_channel_id') || process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID;

client.on('messageCreate', async (message: Message) => {
    if (!message.content.startsWith('$') || message.author.bot) return;
    if (!message.guild) return;

    const allowedChannelId = getCmdChannelId(message.guild.id);
    const isConfigCommand = message.content.startsWith('$setcmd');

    if (allowedChannelId && message.channelId !== allowedChannelId && !isConfigCommand) return;

    const args = message.content.slice(1).split(' ');
    const command = args.shift()?.toLowerCase();

    if (!command) return;

    // Routing dei comandi
    await handleCampaignCommands(message, command, args);
    await handleSessionCommands(message, command, args);
    await handleCharacterCommands(message, command, args);
    await handleLoreCommands(message, command, args);
    await handleUtilityCommands(message, command, args);

    // --- COMANDI SPECIALI (TESTSTREAM & CLEANTEST) ---
    
    if (command === 'teststream') {
        const setupCamp = await ensureTestEnvironment(message.guild.id, message.author.id, message);
        if (!setupCamp) return;

        const url = args[0];
        if (!url) return await message.reply("Uso: `$teststream <URL>` (es. YouTube o link diretto mp3)");

        const sessionId = `test-direct-${uuidv4().substring(0, 8)}`;
        const activeCampaign = getActiveCampaign(message.guild.id);

        createSession(sessionId, message.guild.id, activeCampaign!.id);
        monitor.startSession(sessionId);

        await message.reply(`🧪 **Test Stream Avviato**\nID Sessione: \`${sessionId}\`\nAnalisi del link in corso...`);

        const recordingsDir = path.join(__dirname, '..', 'recordings');
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

        const tempFileName = `${message.author.id}-${Date.now()}.mp3`;
        const tempFilePath = path.join(recordingsDir, tempFileName);

        try {
            const isYouTube = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/.+$/.test(url);

            if (isYouTube) {
                await (message.channel as TextChannel).send("🎥 Link YouTube rilevato. Avvio download con yt-dlp...");
                const cookiesPath = path.resolve(__dirname, '..', 'cookies.json');
                let cookieArg = '';

                if (fs.existsSync(cookiesPath)) {
                    const stats = fs.statSync(cookiesPath);
                    if (stats.isFile() && stats.size > 0) {
                        cookieArg = ` --cookies "${cookiesPath}"`;
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
            } else {
                await (message.channel as TextChannel).send("🔗 Link diretto rilevato. Scarico file...");
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Errore HTTP: ${response.statusText}`);
                
                const contentType = response.headers.get('content-type');
                if (contentType && !contentType.startsWith('audio/') && !contentType.includes('octet-stream')) {
                    throw new Error(`Il link non è un file audio valido (Rilevato: ${contentType}).`);
                }
                if (!response.body) throw new Error("Nessun contenuto ricevuto");
                await pipeline(response.body, fs.createWriteStream(tempFilePath));
            }

            const loc = getCampaignLocation(message.guild.id);
            const macro = loc?.macro || null;
            const micro = loc?.micro || null;
            const year = activeCampaign?.current_year ?? null;

            addRecording(sessionId, tempFileName, tempFilePath, message.author.id, Date.now(), macro, micro, year);

            try {
                const uploaded = await uploadToOracle(tempFilePath, tempFileName, sessionId);
                if (uploaded) updateRecordingStatus(tempFileName, 'SECURED');
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
            await waitForCompletionAndSummarize(sessionId, message.channel as TextChannel);

        } catch (error: any) {
            console.error(`[TestStream] Errore: ${error.message}`);
            await message.reply(`❌ Errore durante il processo: ${error.message}`);
            if (fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch(e) {}
            }
        }
    }

    if (command === 'cleantest') {
        if (!message.member?.permissions.has('Administrator')) return;

        await message.reply("🧹 Pulizia sessioni di test (ID che iniziano con `test-`)...");
        const testSessions = db.prepare("SELECT session_id FROM sessions WHERE session_id LIKE 'test-%'").all() as { session_id: string }[];

        if (testSessions.length === 0) {
            return await message.reply("✅ Nessuna sessione di test trovata.");
        }

        let deletedCount = 0;
        for (const s of testSessions) {
            await removeSessionJobs(s.session_id);
            db.prepare("DELETE FROM recordings WHERE session_id = ?").run(s.session_id);
            db.prepare("DELETE FROM knowledge_fragments WHERE session_id = ?").run(s.session_id);
            db.prepare("DELETE FROM sessions WHERE session_id = ?").run(s.session_id);
            deletedCount++;
        }

        await message.reply(`✅ Eliminate **${deletedCount}** sessioni di test dal database.`);
    }
});

client.on('voiceStateUpdate', handleVoiceStateUpdate);

client.once('ready', async () => {
    console.log(`🤖 Bot TS online: ${client.user?.tag}`);
    await recoverOrphanedFiles();
    await checkUnprocessedJobs();
    startWorker();
});

// --- GESTIONE GRACEFUL SHUTDOWN ---
const gracefulShutdown = async (signal: string) => {
    console.log(`\n🛑 Ricevuto segnale ${signal}. Chiusura controllata...`);
    
    // Itera su tutte le gilde dove il bot è presente
    const promises = client.guilds.cache.map(async (guild) => {
        // La funzione disconnect di voicerecorder chiude gli stream,
        // salva i file su disco e fa l'upload dei backup parziali.
        await disconnect(guild.id); 
    });

    try {
        await Promise.all(promises);
        console.log('✅ Tutti gli stream audio sono stati chiusi e salvati.');
    } catch (error) {
        console.error('❌ Errore durante la chiusura degli stream:', error);
    }

    client.destroy();
    process.exit(0);
};

// Intercetta CTRL+C (locale) e STOP (Docker/Kubernetes)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

(async () => {
    await sodium.ready;
    await client.login(process.env.DISCORD_BOT_TOKEN);
})();
