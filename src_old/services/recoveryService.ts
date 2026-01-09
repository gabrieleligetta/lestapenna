import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Message } from 'discord.js';
import { getRecording, findSessionByTimestamp, createSession, addRecording, updateRecordingStatus, getUnprocessedRecordings, resetUnfinishedRecordings, getActiveCampaign, getCampaigns, createCampaign, setActiveCampaign, setCampaignYear, getCampaignLocation, updateLocation, getUserProfile, updateUserCharacter } from '../db';
import { uploadToOracle } from '../backupService';
import { audioQueue, removeSessionJobs } from '../queue'; // Import corretto

export async function recoverOrphanedFiles() {
    const recordingsDir = path.join(__dirname, '..', '..', 'recordings'); // Adjusted path
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
            // Nota: Le sessioni recuperate non avranno campagna associata, andranno gestite manualmente o assegnate a una campagna di default
            // Per ora creiamo una sessione "orfana" nel DB se non esiste
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
            jobId: `${file}-orphan-${Date.now()}`,
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

export async function checkUnprocessedJobs() {
    console.log("🔍 Controllo lavori interrotti nel database...");
    const orphanJobs = getUnprocessedRecordings();

    if (orphanJobs.length > 0) {
        const sessionIds = [...new Set(orphanJobs.map(job => job.session_id))];
        console.log(`📦 Trovati ${orphanJobs.length} file orfani appartenenti a ${sessionIds.length} sessioni.`);

        for (const sessionId of sessionIds) {
            console.log(`🔄 Ripristino automatico sessione ${sessionId}...`);
            await removeSessionJobs(sessionId);
            const filesToProcess = resetUnfinishedRecordings(sessionId);

            for (const job of filesToProcess) {
                await audioQueue.add('transcribe-job', {
                    sessionId: job.session_id,
                    fileName: job.filename,
                    filePath: job.filepath,
                    userId: job.user_id
                }, {
                    jobId: `${job.filename}-recovery-${Date.now()}`,
                    attempts: 5,
                    backoff: { type: 'exponential', delay: 2000 },
                    removeOnComplete: true,
                    removeOnFail: false
                });
            }
            console.log(`✅ Sessione ${sessionId}: ${filesToProcess.length} file riaccodati.`);
        }
        await audioQueue.resume();
    } else {
        console.log("✨ Nessun lavoro in sospeso trovato.");
    }
}

export async function ensureTestEnvironment(guildId: string, userId: string, message: Message) {
    let campaign = getActiveCampaign(guildId);

    if (!campaign) {
        const campaigns = getCampaigns(guildId);
        const testCampaignName = "Campagna di Test";
        let testCampaign = campaigns.find(c => c.name === testCampaignName);

        if (!testCampaign) {
            createCampaign(guildId, testCampaignName);
            testCampaign = getCampaigns(guildId).find(c => c.name === testCampaignName);
            await message.reply(`🧪 Creata campagna automatica: **${testCampaignName}**`);
        }

        if (testCampaign) {
            setActiveCampaign(guildId, testCampaign.id);
            campaign = getActiveCampaign(guildId);
            await message.reply(`🧪 Campagna attiva impostata su: **${testCampaignName}**`);
        }
    }

    if (!campaign) {
        await message.reply("❌ Errore critico: Impossibile creare o recuperare la campagna di test.");
        return null;
    }

    // Check Year
    if (campaign.current_year === undefined || campaign.current_year === null) {
        setCampaignYear(campaign.id, 1000);
        campaign.current_year = 1000;
        await message.reply(`🧪 Anno impostato a **1000**.`);
    }

    // Check Location
    const loc = getCampaignLocation(guildId);
    if (!loc || (!loc.macro && !loc.micro)) {
        updateLocation(campaign.id, "Laboratorio", "Stanza dei Test", "SETUP");
        await message.reply(`🧪 Luogo impostato: **Laboratorio | Stanza dei Test**`);
    }

    // Check Character
    const profile = getUserProfile(userId, campaign.id);
    if (!profile.character_name) {
        updateUserCharacter(userId, campaign.id, 'character_name', 'Test Subject');
        updateUserCharacter(userId, campaign.id, 'class', 'Tester');
        updateUserCharacter(userId, campaign.id, 'race', 'Construct');
        await message.reply(`🧪 Personaggio creato: **Test Subject** (Tester/Construct)`);
    }

    return campaign;
}
