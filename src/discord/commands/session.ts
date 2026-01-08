import { Message, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { getActiveCampaign, updateLocation, getCampaignLocation, createSession, getUserProfile, addSessionNote, getLocationHistory, getAtlasEntry, updateAtlasEntry, setSessionNumber, resetSessionData, updateRecordingStatus, getSessionTranscript, getSessionStartTime, updateSessionTitle, getSessionCampaignId, addLoot, removeLoot, addQuest, addCharacterEvent, addNpcEvent, addWorldEvent, getAvailableSessions } from '../../db';
import { guildSessions, autoLeaveTimers } from '../state';
import { monitor } from '../../monitor';
import { audioQueue, removeSessionJobs } from '../../queue'; // Import corretto
import { connectToChannel, disconnect, pauseRecording, resumeRecording, isRecordingPaused } from '../../voicerecorder';
import { checkAutoLeave } from '../events/voiceStateUpdate';
import { waitForCompletionAndSummarize, publishSummary } from '../../services/sessionService';
import { downloadFromOracle, uploadToOracle, getPresignedUrl } from '../../backupService';
import { ingestSessionRaw, generateSummary, ingestBioEvent, ingestWorldEvent, TONES, ToneKey } from '../../bard';
import { mixSessionAudio } from '../../sessionMixer';
import { processSessionReport, sendSessionRecap } from '../../reporter';
import { ensureTestEnvironment } from '../../services/recoveryService';

export async function handleSessionCommands(message: Message, command: string, args: string[]) {
    let activeCampaign = getActiveCampaign(message.guild!.id);

    // --- COMANDO LISTEN (INIZIO SESSIONE) ---
    if (command === 'listen' || command === 'ascolta' || command === 'testascolta') {
        const member = message.member;
        if (!member?.voice.channel) {
            return await message.reply("Devi essere in un canale vocale per evocare il Bardo!");
        }

        if (command === 'testascolta') {
             const setupCamp = await ensureTestEnvironment(message.guild!.id, message.author.id, message);
             if (setupCamp) activeCampaign = setupCamp;
             else return;
        }

        if (!activeCampaign) return await message.reply("⚠️ **Nessuna campagna attiva!**");

        if (activeCampaign.current_year === undefined || activeCampaign.current_year === null) {
            return await message.reply(
                `🛑 **Configurazione Temporale Mancante!**\n` +
                `Prima di iniziare la prima sessione, devi stabilire l'Anno 0 e la data attuale.\n\n` +
                `1. Usa \`$anno0 <Descrizione>\` per definire l'evento cardine (es. "La Caduta dell'Impero").\n` +
                `2. Usa \`$data <Anno>\` per impostare l'anno corrente (es. 100).`
            );
        }

        const locationArg = args.join(' ');
        const sessionId = uuidv4();

        if (locationArg) {
            let newMacro = null;
            let newMicro = null;

            if (locationArg.includes('|')) {
                const parts = locationArg.split('|').map(s => s.trim());
                newMacro = parts[0];
                newMicro = parts[1];
            } else {
                newMicro = locationArg.trim();
            }

            updateLocation(activeCampaign.id, newMacro, newMicro, sessionId);
            await message.reply(`📍 Posizione tracciata: **${newMacro || '-'}** | **${newMicro || '-'}**.\nIl Bardo userà questo contesto per le trascrizioni.`);
        } else {
            const currentLoc = getCampaignLocation(message.guild!.id);
            if (currentLoc && (currentLoc.macro || currentLoc.micro)) {
                await message.reply(`📍 Luogo attuale: **${currentLoc.macro || '-'}** | **${currentLoc.micro || '-'}** (Se è cambiato, usa \`$ascolta Macro | Micro\`)`);
            } else {
                await message.reply(`⚠️ **Luogo Sconosciuto.**\nConsiglio: scrivi \`$ascolta <Città> | <Luogo>\` per aiutare il Bardo a capire meglio i nomi e l'atmosfera.`);
            }
        }

        const voiceChannel = member.voice.channel;
        const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
        const botMembers = voiceChannel.members.filter(m => m.user.bot);

        const missingNames: string[] = [];
        humanMembers.forEach(m => {
            const profile = getUserProfile(m.id, activeCampaign!.id);
            if (!profile.character_name) {
                missingNames.push(m.displayName);
            }
        });

        if (missingNames.length > 0) {
            return await message.reply(
                `🛑 **ALT!** Non posso iniziare la cronaca per **${activeCampaign.name}**.\n` +
                `I seguenti avventurieri non hanno dichiarato il loro nome in questa campagna:\n` +
                missingNames.map(n => `- **${n}** (Usa: \`$sono NomePersonaggio\`)`).join('\n')
            );
        }

        if (botMembers.size > 0) {
            const botNames = botMembers.map(b => b.displayName).join(', ');
            await (message.channel as TextChannel).send(`🤖 Noto la presenza di costrutti magici (${botNames}). Le loro voci saranno ignorate.`);
        }

        guildSessions.set(message.guild!.id, sessionId);
        createSession(sessionId, message.guild!.id, activeCampaign.id);
        monitor.startSession(sessionId);

        await audioQueue.pause();
        console.log(`[Flow] Coda in PAUSA. Inizio accumulo file per sessione ${sessionId}`);

        await connectToChannel(voiceChannel, sessionId);
        await message.reply(`🔊 **Cronaca Iniziata** per la campagna **${activeCampaign.name}**.\nID Sessione: \`${sessionId}\`.\nI bardi stanno ascoltando ${humanMembers.size} eroi.`);
        checkAutoLeave(voiceChannel);
        return;
    }

    // --- COMANDO STOPLISTENING (FINE SESSIONE) ---
    if (command === 'stoplistening' || command === 'termina') {
        const sessionId = guildSessions.get(message.guild!.id);
        if (!sessionId) {
            await disconnect(message.guild!.id);
            await message.reply("Nessuna sessione attiva tracciata, ma mi sono disconnesso.");
            return;
        }

        await disconnect(message.guild!.id);
        guildSessions.delete(message.guild!.id);

        await message.reply(`🛑 Sessione **${sessionId}** terminata. Lo Scriba sta trascrivendo...`);
        await audioQueue.resume();
        console.log(`[Flow] Coda RIPRESA. I worker stanno elaborando i file accumulati...`);

        await waitForCompletionAndSummarize(sessionId, message.channel as TextChannel);
        return;
    }

    // --- PAUSA / RIPRENDI ---
    if (command === 'pausa' || command === 'pause') {
        const sessionId = guildSessions.get(message.guild!.id);
        if (!sessionId) return await message.reply("Nessuna sessione attiva.");

        if (isRecordingPaused(message.guild!.id)) {
            return await message.reply("La registrazione è già in pausa.");
        }

        pauseRecording(message.guild!.id);
        await message.reply("⏸️ **Registrazione in Pausa**. Il Bardo si riposa.");
        return;
    }

    if (command === 'riprendi' || command === 'resume') {
        const sessionId = guildSessions.get(message.guild!.id);
        if (!sessionId) return await message.reply("Nessuna sessione attiva.");

        if (!isRecordingPaused(message.guild!.id)) {
            return await message.reply("La registrazione è già attiva.");
        }

        resumeRecording(message.guild!.id);
        await message.reply("▶️ **Registrazione Ripresa**. Il Bardo torna ad ascoltare.");
        return;
    }

    // --- NOTA ---
    if (command === 'nota' || command === 'note') {
        const sessionId = guildSessions.get(message.guild!.id);
        if (!sessionId) return await message.reply("⚠️ Nessuna sessione attiva. Avvia prima una sessione con `$ascolta`.");

        const noteContent = args.join(' ');
        if (!noteContent) return await message.reply("Uso: `$nota <Testo della nota>`");

        addSessionNote(sessionId, message.author.id, noteContent, Date.now());
        await message.reply("📝 Nota aggiunta al diario della sessione.");
        return;
    }

    // --- LUOGO ---
    if (command === 'luogo' || command === 'location') {
        if (!activeCampaign) return await message.reply("⚠️ **Nessuna campagna attiva!**");
        const argsStr = args.join(' ');

        if (!argsStr) {
            const loc = getCampaignLocation(message.guild!.id);
            if (!loc || (!loc.macro && !loc.micro)) {
                return message.reply("🗺️ Non so dove siete! Usa `$luogo <Città> | <Luogo>` per impostarlo.");
            }
            return message.reply(`📍 **Posizione Attuale**\n🌍 Regione: **${loc.macro || "Sconosciuto"}**\n🏠 Luogo: **${loc.micro || "Generico"}**`);
        } else {
            const current = getCampaignLocation(message.guild!.id);
            const sessionId = guildSessions.get(message.guild!.id);

            let newMacro = current?.macro || null;
            let newMicro = null;

            if (argsStr.includes('|')) {
                const parts = argsStr.split('|').map(s => s.trim());
                newMacro = parts[0];
                newMicro = parts[1];
            } else {
                newMicro = argsStr.trim();
            }

            updateLocation(activeCampaign.id, newMacro, newMicro, sessionId);
            return message.reply(`📍 **Aggiornamento Manuale**\nImpostato su: ${newMacro || '-'} | ${newMicro || '-'}`);
        }
    }

    // --- VIAGGI ---
    if (command === 'viaggi' || command === 'travels') {
        if (!activeCampaign) return await message.reply("⚠️ **Nessuna campagna attiva!**");
        const history = getLocationHistory(message.guild!.id);

        if (history.length === 0) return message.reply("Il diario di viaggio è vuoto.");

        let msg = "**📜 Diario di Viaggio (Ultimi spostamenti):**\n";
        history.forEach((h: any) => {
            const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            msg += `\`${h.session_date} ${time}\` 🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}\n`;
        });

        return message.reply(msg);
    }

    // --- ATLANTE ---
    if (command === 'atlante' || command === 'memoria' || command === 'atlas') {
        if (!activeCampaign) return await message.reply("⚠️ **Nessuna campagna attiva!**");
        const loc = getCampaignLocation(message.guild!.id);

        if (!loc || !loc.macro || !loc.micro) {
            return message.reply("⚠️ Non so dove siete. Imposta prima il luogo con `$luogo`.");
        }

        const newDesc = args.join(' ');

        if (newDesc) {
            updateAtlasEntry(activeCampaign.id, loc.macro, loc.micro, newDesc);
            return message.reply(`📖 **Atlante Aggiornato** per *${loc.micro}*:\n"${newDesc}"`);
        } else {
            const lore = getAtlasEntry(activeCampaign.id, loc.macro, loc.micro);
            if (lore) {
                return message.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n_${lore}_`);
            } else {
                return message.reply(`📖 **Atlante: ${loc.macro} - ${loc.micro}**\n\n*Nessuna memoria registrata per questo luogo.*`);
            }
        }
    }

    // --- SET SESSION ---
    if (command === 'setsession' || command === 'impostasessione') {
        const sessionId = guildSessions.get(message.guild!.id);
        if (!sessionId) {
            return await message.reply("⚠️ Nessuna sessione attiva. Avvia prima una sessione con `$ascolta`.");
        }

        const sessionNum = parseInt(args[0]);
        if (isNaN(sessionNum) || sessionNum <= 0) {
            return await message.reply("Uso: `$impostasessione <numero>` (es. `$impostasessione 5`)");
        }

        setSessionNumber(sessionId, sessionNum);
        await message.reply(`✅ Numero sessione impostato a **${sessionNum}**. Sarà usato per il prossimo riassunto.`);
        return;
    }

    if (command === 'setsessionid' || command === 'impostasessioneid') {
        const targetSessionId = args[0];
        const sessionNum = parseInt(args[1]);

        if (!targetSessionId || isNaN(sessionNum)) {
            return await message.reply("Uso: `$impostasessioneid <ID_SESSIONE> <NUMERO>`");
        }

        setSessionNumber(targetSessionId, sessionNum);
        await message.reply(`✅ Numero sessione per \`${targetSessionId}\` impostato a **${sessionNum}**.`);
        return;
    }

    // --- RESET ---
    if (command === 'reset') {
        const targetSessionId = args[0];
        if (!targetSessionId) {
            return await message.reply("Uso: `$reset <ID_SESSIONE>` - Forza la rielaborazione completa.");
        }

        await message.reply(`🔄 **Reset Sessione ${targetSessionId}** avviato...\n1. Pulizia coda...`);

        await removeSessionJobs(targetSessionId);
        const filesToProcess = resetSessionData(targetSessionId);

        if (filesToProcess.length === 0) {
            return await message.reply(`⚠️ Nessun file trovato per la sessione ${targetSessionId}.`);
        }

        await message.reply(`2. Database resettato (${filesToProcess.length} file trovati).\n3. Ripristino file e reinserimento in coda...`);

        let restoredCount = 0;

        for (const job of filesToProcess) {
            if (!fs.existsSync(job.filepath)) {
                const success = await downloadFromOracle(job.filename, job.filepath, targetSessionId);
                if (success) restoredCount++;
            }

            try {
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
                jobId: `${job.filename}-reset-${Date.now()}`,
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
        await waitForCompletionAndSummarize(targetSessionId, message.channel as TextChannel);
        return;
    }

    // --- SCARICA TRASCRIZIONI ---
    if (command === 'scaricatrascrizioni' || command === 'downloadtxt') {
        const targetSessionId = args[0];
        if (!targetSessionId) {
            return await message.reply("Uso: `$scaricatrascrizioni <ID>`");
        }

        const transcripts = getSessionTranscript(targetSessionId);
        if (!transcripts || transcripts.length === 0) {
            return await message.reply(`⚠️ Nessuna trascrizione trovata per la sessione \`${targetSessionId}\`.`);
        }

        const formattedText = transcripts.map(t => {
            let text = "";
            const startTime = getSessionStartTime(targetSessionId) || 0;

            try {
                const segments = JSON.parse(t.transcription_text);
                if (Array.isArray(segments)) {
                    text = segments.map(s => {
                        if (typeof s.start !== 'number' || !s.text) return "";
                        const absTime = t.timestamp + (s.start * 1000);
                        const mins = Math.floor((absTime - startTime) / 60000);
                        const secs = Math.floor(((absTime - startTime) % 60000) / 1000);
                        return `[${mins}:${secs.toString().padStart(2, '0')}] ${s.text}`;
                    }).filter(line => line !== "").join('\n');
                } else {
                    text = t.transcription_text;
                }
            } catch (e) {
                text = t.transcription_text;
            }

            return `--- ${t.character_name || 'Sconosciuto'} (File: ${new Date(t.timestamp).toLocaleTimeString()}) ---\n${text}\n`;
        }).join('\n');

        const fileName = `transcript-${targetSessionId}.txt`;
        const recordingsDir = path.join(__dirname, '..', '..', 'recordings');
        
        if (!fs.existsSync(recordingsDir)) {
            fs.mkdirSync(recordingsDir, { recursive: true });
        }
        
        const filePath = path.join(recordingsDir, fileName);

        fs.writeFileSync(filePath, formattedText);

        await message.reply({
            content: `📜 **Trascrizione Completa** per sessione \`${targetSessionId}\``,
            files: [filePath]
        });

        try { fs.unlinkSync(filePath); } catch (e) {}
        return;
    }

    // --- RACCONTA ---
    if (command === 'racconta' || command === 'narrate' || command === 'summarize') {
        const targetSessionId = args[0];
        const requestedTone = args[1]?.toUpperCase() as ToneKey;

        if (!targetSessionId) {
            const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id);
            if (sessions.length === 0) return await message.reply("Nessuna sessione trovata per questa campagna.");
            const list = sessions.map(s => `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)`).join('\n\n');
            const embed = new EmbedBuilder().setTitle(`📜 Sessioni: ${activeCampaign?.name}`).setDescription(list);
            return await message.reply({ embeds: [embed] });
        }

        if (requestedTone && !TONES[requestedTone]) {
            return await message.reply(`Tono non valido. Toni: ${Object.keys(TONES).join(', ')}`);
        }

        const channel = message.channel as TextChannel;
        await channel.send(`📜 Il Bardo sta consultando gli archivi per la sessione \`${targetSessionId}\`...`);

        const startProcessing = Date.now();

        try {
            await channel.send("🧠 Il Bardo sta studiando gli eventi per ricordarli in futuro...");
            await ingestSessionRaw(targetSessionId);
            await channel.send("✅ Memoria aggiornata.");
        } catch (ingestErr: any) {
            console.error(`⚠️ Errore ingestione ${targetSessionId}:`, ingestErr);
            await channel.send(`⚠️ Ingestione memoria fallita: ${ingestErr.message}. Puoi riprovare più tardi con \`$memorizza ${targetSessionId}\`.`);
        }

        try {
            await channel.send("✍️ Inizio stesura del racconto...");
            const result = await generateSummary(targetSessionId, requestedTone || 'DM');

            updateSessionTitle(targetSessionId, result.title);

            if (activeCampaign) {
                const activeCampaignId = activeCampaign.id;
                if (result.loot && result.loot.length > 0) result.loot.forEach((item: string) => addLoot(activeCampaignId, item));
                if (result.loot_removed && result.loot_removed.length > 0) result.loot_removed.forEach((item: string) => removeLoot(activeCampaignId, item));
                if (result.quests && result.quests.length > 0) result.quests.forEach((q: string) => addQuest(activeCampaignId, q));

                if (result.character_growth && Array.isArray(result.character_growth)) {
                    for (const growth of result.character_growth) {
                        if (growth.name && growth.event) {
                            addCharacterEvent(activeCampaignId, growth.name, targetSessionId, growth.event, growth.type || 'GENERIC');
                            ingestBioEvent(activeCampaignId, targetSessionId, growth.name, growth.event, growth.type || 'GENERIC').catch(err => console.error(`Errore ingestione bio per ${growth.name}:`, err));
                        }
                    }
                }

                if (result.npc_events && Array.isArray(result.npc_events)) {
                    for (const evt of result.npc_events) {
                        if (evt.name && evt.event) {
                            addNpcEvent(activeCampaignId, evt.name, targetSessionId, evt.event, evt.type || 'GENERIC');
                            ingestBioEvent(activeCampaignId, targetSessionId, evt.name, evt.event, evt.type || 'GENERIC').catch(err => console.error(`Errore ingestione bio NPC ${evt.name}:`, err));
                        }
                    }
                }

                if (result.world_events && Array.isArray(result.world_events)) {
                    for (const w of result.world_events) {
                        if (w.event) {
                            addWorldEvent(activeCampaignId, targetSessionId, w.event, w.type || 'GENERIC');
                            ingestWorldEvent(activeCampaignId, targetSessionId, w.event, w.type || 'GENERIC').catch(err => console.error(`Errore ingestione mondo:`, err));
                        }
                    }
                }
            }

            await publishSummary(targetSessionId, result.summary, channel, true, result.title, result.loot, result.quests, result.narrative);

            const processingTime = Date.now() - startProcessing;
            const transcripts = getSessionTranscript(targetSessionId);

            const replayMetrics = {
                sessionId: targetSessionId,
                startTime: startProcessing,
                endTime: Date.now(),
                totalFiles: transcripts.length,
                totalAudioDurationSec: 0,
                transcriptionTimeMs: 0,
                summarizationTimeMs: processingTime,
                totalTokensUsed: result.tokens,
                errors: [],
                resourceUsage: { cpuSamples: [], ramSamplesMB: [] }
            };

            processSessionReport(replayMetrics).catch(e => console.error("Err Report Replay:", e));

        } catch (err) {
            console.error(`❌ Errore racconta ${targetSessionId}:`, err);
            await channel.send(`⚠️ Errore durante la generazione del riassunto.`);
        }
        return;
    }

    // --- MODIFICA TITOLO ---
    if (command === 'modificatitolo' || command === 'edittitle') {
        const targetSessionId = args[0];
        const newTitle = args.slice(1).join(' ');

        if (!targetSessionId || !newTitle) {
            return await message.reply("Uso: `$modificatitolo <ID_SESSIONE> <Nuovo Titolo>`");
        }

        updateSessionTitle(targetSessionId, newTitle);
        await message.reply(`✅ Titolo aggiornato per la sessione \`${targetSessionId}\`: **${newTitle}**`);
        return;
    }

    // --- INGEST ---
    if (command === 'ingest' || command === 'memorizza') {
        const targetSessionId = args[0];
        if (!targetSessionId) return await message.reply("Uso: `$ingest <ID_SESSIONE>`");

        await message.reply(`🧠 **Ingestione Memoria** avviata per sessione \`${targetSessionId}\`...\nSto leggendo le trascrizioni e creando i vettori.`);

        try {
            await ingestSessionRaw(targetSessionId);
            await message.reply(`✅ Memoria aggiornata per sessione \`${targetSessionId}\`. Ora puoi farmi domande su di essa.`);
        } catch (e: any) {
            console.error(e);
            await message.reply(`❌ Errore durante l'ingestione: ${e.message}`);
        }
        return;
    }

    // --- DOWNLOAD ---
    if (command === 'download' || command === 'scarica') {
        const isActiveSession = guildSessions.has(message.guild!.id);
        const queueCounts = await audioQueue.getJobCounts();
        const isProcessing = queueCounts.active > 0 || queueCounts.waiting > 0;

        if (isActiveSession || isProcessing) {
            return await message.reply(
                `🛑 **Sistema sotto carico.**\n` +
                `Non posso generare il download mentre:\n` +
                `- Una sessione è attiva: ${isActiveSession ? 'SÌ' : 'NO'}\n` +
                `- Ci sono file in elaborazione: ${isProcessing ? 'SÌ' : 'NO'} (${queueCounts.waiting} in coda)\n\n` +
                `Attendi la fine della sessione e del riassunto.`
            );
        }

        let targetSessionId = args[0];

        if (!targetSessionId) {
            targetSessionId = guildSessions.get(message.guild!.id) || "";
        }

        if (!targetSessionId) {
            return await message.reply("⚠️ Specifica un ID sessione o avvia una sessione: `$scarica <ID>`");
        }

        await message.reply(`⏳ **Elaborazione Audio Completa** per sessione \`${targetSessionId}\`...\nPotrebbe volerci qualche minuto a seconda della durata. Ti avviserò qui.`);

        try {
            const masterFileName = `MASTER-${targetSessionId}.mp3`;
            const presignedUrl = await getPresignedUrl(masterFileName, targetSessionId, 3600 * 24);

            if (presignedUrl) {
                 await (message.channel as TextChannel).send(`✅ **Audio Sessione Trovato!**\nPuoi scaricarlo qui (link valido 24h):\n${presignedUrl}`);
                 return;
            }

            const filePath = await mixSessionAudio(targetSessionId);
            const stats = fs.statSync(filePath);
            const sizeMB = stats.size / (1024 * 1024);

            if (sizeMB < 25) {
                await (message.channel as TextChannel).send({
                    content: `✅ **Audio Sessione Pronto!** (${sizeMB.toFixed(2)} MB)`,
                    files: [filePath]
                });
            } else {
                const fileName = path.basename(filePath);
                const customKey = `recordings/${targetSessionId}/master/${fileName}`;
                await uploadToOracle(filePath, fileName, targetSessionId, customKey);
                
                const newUrl = await getPresignedUrl(fileName, targetSessionId, 3600 * 24);

                if (newUrl) {
                    await (message.channel as TextChannel).send(`✅ **Audio Generato** (${sizeMB.toFixed(2)} MB).\nEssendo troppo grande per Discord, puoi scaricarlo qui (link valido 24h):\n${newUrl}`);
                } else {
                    await (message.channel as TextChannel).send(`✅ **Audio Generato** (${sizeMB.toFixed(2)} MB), ma non sono riuscito a generare il link di download.`);
                }

                try { fs.unlinkSync(filePath); } catch(e) {}
            }

        } catch (err: any) {
            console.error(err);
            await (message.channel as TextChannel).send(`❌ Errore durante la generazione dell'audio: ${err.message}`);
        }
        return;
    }

    // --- LISTA SESSIONI ---
    if (command === 'listasessioni' || command === 'listsessions') {
        const sessions = getAvailableSessions(message.guild!.id, activeCampaign?.id, 0);
        if (sessions.length === 0) {
            await message.reply("Nessuna sessione trovata negli archivi per questa campagna.");
        } else {
            const ITEMS_PER_PAGE = 5;
            const totalPages = Math.ceil(sessions.length / ITEMS_PER_PAGE);
            let currentPage = 0;

            const generateEmbed = (page: number) => {
                const start = page * ITEMS_PER_PAGE;
                const end = start + ITEMS_PER_PAGE;
                const currentSessions = sessions.slice(start, end);

                const list = currentSessions.map(s => {
                    const title = s.title ? `📜 **${s.title}**` : "";
                    return `🆔 \`${s.session_id}\`\n📅 ${new Date(s.start_time).toLocaleString()} (${s.fragments} frammenti)\n${title}`;
                }).join('\n\n');

                return new EmbedBuilder()
                    .setTitle(`📜 Cronache: ${activeCampaign?.name}`)
                    .setColor("#7289DA")
                    .setDescription(list)
                    .setFooter({ text: `Pagina ${page + 1} di ${totalPages}` });
            };

            const generateButtons = (page: number) => {
                const row = new ActionRowBuilder<ButtonBuilder>();

                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page')
                        .setLabel('⬅️ Precedente')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel('Successivo ➡️')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1)
                );

                return row;
            };

            const reply = await message.reply({
                embeds: [generateEmbed(currentPage)],
                components: totalPages > 1 ? [generateButtons(currentPage)] : []
            });

            if (totalPages > 1) {
                const collector = reply.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    time: 60000
                });

                collector.on('collect', async (interaction: MessageComponentInteraction) => {
                    if (interaction.user.id !== message.author.id) {
                        await interaction.reply({ content: "Solo chi ha invocato il comando può sfogliare le pagine.", ephemeral: true });
                        return;
                    }

                    if (interaction.customId === 'prev_page') {
                        currentPage--;
                    } else if (interaction.customId === 'next_page') {
                        currentPage++;
                    }

                    await interaction.update({
                        embeds: [generateEmbed(currentPage)],
                        components: [generateButtons(currentPage)]
                    });
                });

                collector.on('end', () => {
                    reply.edit({ components: [] }).catch(() => {});
                });
            }
        }
        return;
    }
}
