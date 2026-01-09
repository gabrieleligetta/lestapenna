import * as nodemailer from 'nodemailer';
import { SessionMetrics } from './monitor';
import { uploadToOracle, getPresignedUrl } from './backupService';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionTravelLog, getSessionEncounteredNPCs, getCampaignById, getSessionStartTime, getSessionTranscript } from './db';

// Configurazione SMTP per Porkbun
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.porkbun.com",
    port: parseInt(process.env.SMTP_PORT || "465"),
    secure: true, 
    auth: {
        user: process.env.SMTP_USER, 
        pass: process.env.SMTP_PASS  
    }
});

const openai = new OpenAI({
    baseURL: process.env.AI_PROVIDER === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1') : undefined,
    project: process.env.AI_PROVIDER === 'ollama' ? undefined : process.env.OPENAI_PROJECT_ID,
    apiKey: process.env.AI_PROVIDER === 'ollama' ? 'ollama' : process.env.OPENAI_API_KEY,
});

export async function processSessionReport(metrics: SessionMetrics) {
    console.log(`[Reporter] 📝 Generazione report post-mortem per sessione ${metrics.sessionId}...`);

    // 1. Calcolo Statistiche
    const durationMin = metrics.startTime && metrics.endTime ? (metrics.endTime - metrics.startTime) / 60000 : 0;
    const avgCpu = metrics.resourceUsage.cpuSamples.length > 0 
        ? metrics.resourceUsage.cpuSamples.reduce((a, b) => a + b, 0) / metrics.resourceUsage.cpuSamples.length 
        : 0;
    const maxRam = metrics.resourceUsage.ramSamplesMB.length > 0 
        ? Math.max(...metrics.resourceUsage.ramSamplesMB) 
        : 0;

    // Calcolo DB Growth
    const dbStartMB = (metrics.dbStartSizeBytes || 0) / (1024 * 1024);
    const dbEndMB = (metrics.dbEndSizeBytes || 0) / (1024 * 1024);
    const dbGrowthMB = dbEndMB - dbStartMB;

    // Disk Info
    const diskTotal = metrics.diskUsage?.totalGB || 0;
    const diskFree = metrics.diskUsage?.freeGB || 0;
    const diskUsedPct = metrics.diskUsage?.usedPercent || 0;

    const statsJson = JSON.stringify(metrics, null, 2);
    
    // 2. Generazione testo email con AI
    const prompt = `
    Sei un ingegnere DevOps che analizza i log di un bot Discord ("Lestapenna").
    Ecco le metriche della sessione:
    - ID Sessione: ${metrics.sessionId}
    - Durata: ${durationMin.toFixed(2)} min
    - File Audio: ${metrics.totalFiles}
    - Durata Audio Totale: ${metrics.totalAudioDurationSec} sec
    - Tempo Trascrizione Totale: ${(metrics.transcriptionTimeMs / 1000).toFixed(2)} sec
    - Token AI Utilizzati (Summ): ${metrics.totalTokensUsed}
    - CPU Media: ${avgCpu.toFixed(1)}%
    - RAM Max: ${maxRam} MB
    - DB Start: ${dbStartMB.toFixed(2)} MB
    - DB End: ${dbEndMB.toFixed(2)} MB
    - DB Growth: ${dbGrowthMB.toFixed(3)} MB
    - Disk Total: ${diskTotal} GB
    - Disk Free: ${diskFree} GB
    - Disk Used: ${diskUsedPct}%
    - Errori: ${metrics.errors.length}

    Analizza brevemente la stabilità del sistema e segnala eventuali anomalie.
    
    ISTRUZIONI SPECIFICHE:
    1. Se il disco è pieno oltre l'80%, lancia un allarme critico e suggerisci azioni specifiche (es. "Cancellare log vecchi in /var/log", "Spostare registrazioni su Oracle").
    2. Se la RAM supera i 500MB, suggerisci di controllare memory leak.
    3. Se ci sono errori, riassumili brevemente.
    `;

    let emailBody = "";
    try {
        const modelToUse = process.env.AI_PROVIDER === 'ollama' 
            ? (process.env.OLLAMA_MODEL || "llama3.2") 
            : (process.env.OPEN_AI_MODEL || "gpt-5-mini");

        const response = await openai.chat.completions.create({
            model: modelToUse,
            messages: [{ role: "user", content: prompt }]
        });
        emailBody = response.choices[0].message.content || "Report generico.";
    } catch (e: any) {
        emailBody = `Impossibile generare analisi AI: ${e.message}`;
    }

    // 3. Generazione HTML Table
    const htmlTable = `
    <h2>📊 Session Metrics Report</h2>
    <p><strong>Session ID:</strong> ${metrics.sessionId}</p>
    <p><strong>Analysis:</strong><br/>${emailBody.replace(/\n/g, '<br/>')}</p>
    
    <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif;">
        <tr style="background-color: #f2f2f2;">
            <th>Metric</th>
            <th>Value</th>
        </tr>
        <tr>
            <td>Duration</td>
            <td>${durationMin.toFixed(2)} min</td>
        </tr>
        <tr>
            <td>Files Processed</td>
            <td>${metrics.totalFiles}</td>
        </tr>
        <tr>
            <td>Total Audio</td>
            <td>${metrics.totalAudioDurationSec} sec</td>
        </tr>
        <tr>
            <td>Transcription Time</td>
            <td>${(metrics.transcriptionTimeMs / 1000).toFixed(2)} sec</td>
        </tr>
        <tr>
            <td>AI Tokens</td>
            <td>${metrics.totalTokensUsed}</td>
        </tr>
        <tr>
            <td>Avg CPU</td>
            <td>${avgCpu.toFixed(1)}%</td>
        </tr>
        <tr>
            <td>Max RAM</td>
            <td>${maxRam} MB</td>
        </tr>
        <tr>
            <td>DB Start Size</td>
            <td>${dbStartMB.toFixed(2)} MB</td>
        </tr>
        <tr>
            <td>DB End Size</td>
            <td>${dbEndMB.toFixed(2)} MB</td>
        </tr>
        <tr style="background-color: ${dbGrowthMB > 5 ? '#ffcccc' : '#e6ffe6'};">
            <td><strong>DB Growth</strong></td>
            <td><strong>+${dbGrowthMB.toFixed(3)} MB</strong></td>
        </tr>
        <tr style="background-color: ${diskUsedPct > 80 ? '#ffcccc' : '#e6ffe6'};">
            <td><strong>Disk Usage</strong></td>
            <td><strong>${diskUsedPct}%</strong> (${diskFree} GB free / ${diskTotal} GB total)</td>
        </tr>
        <tr>
            <td>Errors</td>
            <td style="color: ${metrics.errors.length > 0 ? 'red' : 'green'};">${metrics.errors.length}</td>
        </tr>
    </table>
    
    ${metrics.errors.length > 0 ? `<h3>⚠️ Errors</h3><pre>${metrics.errors.join('\n')}</pre>` : ''}
    `;

    // 4. Salvataggio locale temporaneo del log
    const logFileName = `report-${metrics.sessionId}.json`;
    const logPath = path.join(__dirname, '..', 'recordings', logFileName);
    fs.writeFileSync(logPath, statsJson);

    // 5. Upload su Oracle
    try {
        await uploadToOracle(logPath, logFileName, undefined, `logs/${logFileName}`);
        console.log("[Reporter] ☁️ Metriche caricate su Oracle Cloud.");
    } catch (e) {
        console.error("[Reporter] ❌ Errore upload metriche:", e);
    }

    // 6. Invio Email via Porkbun
    const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
        to: process.env.REPORT_RECIPIENT || 'gabligetta@gmail.com',
        subject: `[Lestapenna] Report Sessione ${metrics.sessionId} - ${metrics.errors.length > 0 ? '⚠️ ALERT' : '✅ OK'}`,
        text: emailBody + `\n\nDATI RAW:\n${statsJson}`,
        html: htmlTable,
        attachments: [
            {
                filename: logFileName,
                content: statsJson
            }
        ]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Reporter] 📧 Email inviata a ${mailOptions.to}`);
    } catch (e) {
        console.error("[Reporter] ❌ Errore invio email:", e);
    }
    
    if (fs.existsSync(logPath)) {
        try { fs.unlinkSync(logPath); } catch (e) {}
    }
}

export async function sendTestEmail(recipient: string): Promise<boolean> {
    const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
        to: recipient,
        subject: `[Lestapenna] Test Configurazione SMTP`,
        text: `Test OK.`,
        html: `<h2>Test OK</h2><p>Il sistema di notifica funziona correttamente.</p>`
    };
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (e) {
        return false;
    }
}

async function generateAndUploadTranscript(sessionId: string): Promise<string | null> {
    try {
        const transcripts = getSessionTranscript(sessionId);
        if (!transcripts || transcripts.length === 0) return null;

        const startTime = getSessionStartTime(sessionId) || 0;

        const formattedText = transcripts.map(t => {
            let text = "";
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

        const fileName = `transcript-${sessionId}.txt`;
        const recordingsDir = path.join(__dirname, '..', 'recordings');
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
        
        const filePath = path.join(recordingsDir, fileName);
        fs.writeFileSync(filePath, formattedText);

        const customKey = `recordings/${sessionId}/transcript/${fileName}`;
        await uploadToOracle(filePath, fileName, sessionId, customKey);
        
        try { fs.unlinkSync(filePath); } catch (e) {}

        // URL valido per 7 giorni
        return await getPresignedUrl(fileName, sessionId, 604800);
    } catch (e) {
        console.error(`[Reporter] ❌ Errore generazione transcript per email:`, e);
        return null;
    }
}

export async function sendSessionRecap(
    sessionId: string, 
    campaignId: number, 
    summaryText: string,
    lootGained: string[] = [],
    lootLost: string[] = [],
    narrative?: string
) {
    const campaign = getCampaignById(campaignId);
    const campaignName = campaign ? campaign.name : "Sconosciuta";
    
    // 1. Recupera Dati DB
    const travels = getSessionTravelLog(sessionId);
    const npcs = getSessionEncounteredNPCs(sessionId);
    const startTime = getSessionStartTime(sessionId);
    
    // Formatta la data
    const sessionDate = startTime 
        ? new Date(startTime).toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : new Date().toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // 2. Genera Link Download Audio (Master)
    let downloadLinksHtml = "";
    
    // Audio Link
    let audioUrl = "";
    try {
        const masterFileName = `MASTER-${sessionId}.mp3`;
        audioUrl = await getPresignedUrl(masterFileName, sessionId, 604800) || "";
    } catch (e) {
        console.warn("[Reporter] Impossibile generare link audio per email:", e);
    }

    // Transcript Link
    let transcriptUrl = await generateAndUploadTranscript(sessionId);

    if (audioUrl || transcriptUrl) {
        downloadLinksHtml = `
        <div style="margin: 20px 0; padding: 15px; background-color: #e8f6f3; border: 1px solid #1abc9c; border-radius: 5px; text-align: center;">
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #16a085;">📥 Download Materiali Sessione</p>
            <div style="display: flex; justify-content: center; gap: 10px; flex-wrap: wrap;">
                ${audioUrl ? `<a href="${audioUrl}" style="background-color: #1abc9c; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">🎧 Scarica Audio (MP3)</a>` : ''}
                ${transcriptUrl ? `<a href="${transcriptUrl}" style="background-color: #3498db; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">📜 Scarica Trascrizione (TXT)</a>` : ''}
            </div>
            <p style="margin: 10px 0 0 0; font-size: 12px; color: #7f8c8d;">Link validi per 7 giorni</p>
        </div>
        `;
    }

    // 3. Costruisci HTML
    let htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
        <h1 style="color: #d35400;">📜 Report Sessione: ${campaignName}</h1>
        <p style="font-style: italic; margin-bottom: 5px;">ID Sessione: ${sessionId}</p>
        <p style="font-weight: bold; margin-top: 0;">📅 Data: ${sessionDate}</p>
        <hr style="border: 1px solid #d35400;">
        
        ${downloadLinksHtml}
    `;

    // --- SEZIONE RACCONTO ---
    if (narrative && narrative.length > 10) {
        htmlContent += `
        <h2>📖 Racconto</h2>
        <div style="background-color: #fff8e1; padding: 15px; border-radius: 5px; white-space: pre-line; border-left: 4px solid #d35400;">
            ${narrative}
        </div>
        `;
    }
    // ------------------------

    htmlContent += `
        <h2>📝 Riassunto Eventi (Log)</h2>
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; white-space: pre-line;">
            ${summaryText}
        </div>

        <div style="display: flex; gap: 20px; margin-top: 20px;">
            <div style="flex: 1;">
                <h3 style="color: #2980b9;">🗺️ Cronologia Luoghi</h3>
                <ul>
                    ${travels.map(t => {
                        const time = new Date(t.timestamp).toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'});
                        return `<li><b>${time}</b>: ${t.macro_location || '-'} (${t.micro_location || 'Esterno'})</li>`;
                    }).join('') || '<li>Nessuno spostamento rilevato.</li>'}
                </ul>
            </div>
            
            <div style="flex: 1;">
                <h3 style="color: #27ae60;">💰 Bilancio Oggetti</h3>
                ${lootGained.length > 0 ? `<b>Ottenuti:</b><ul>${lootGained.map(i => `<li>+ ${i}</li>`).join('')}</ul>` : ''}
                ${lootLost.length > 0 ? `<b>Persi/Usati:</b><ul>${lootLost.map(i => `<li>- ${i}</li>`).join('')}</ul>` : ''}
                ${lootGained.length === 0 && lootLost.length === 0 ? '<p>Nessun cambio inventario.</p>' : ''}
            </div>
        </div>

        <h3>👥 NPC Incontrati</h3>
        <table style="width: 100%; border-collapse: collapse;">
            <tr style="background-color: #eee;">
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #ddd;">Nome</th>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #ddd;">Ruolo</th>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #ddd;">Note / Status</th>
            </tr>
            ${npcs.map(n => `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #ddd;"><b>${n.name}</b></td>
                    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${n.role || '-'}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #ddd;">
                        ${n.status === 'DEAD' ? '💀 MORT' : ''} 
                        ${n.description ? `<i>${n.description.substring(0, 100)}${n.description.length > 100 ? '...' : ''}</i>` : ''}
                    </td>
                </tr>
            `).join('') || '<tr><td colspan="3" style="padding: 8px;">Nessun NPC rilevato nel Dossier.</td></tr>'}
        </table>

        <br>
        <p style="font-size: 12px; color: #999;">Generato automaticamente dal Bardo AI Lestapenna.</p>
    </div>
    `;

    // 3. Invia
    const recipient = process.env.REPORT_RECIPIENT;
    if (!recipient) {
        console.warn("[Reporter] REPORT_RECIPIENT non configurato. Salto invio email.");
        return;
    }

    try {
        await transporter.sendMail({
            from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
            to: recipient,
            subject: `[D&D Report] ${campaignName} - ${sessionDate}`,
            html: htmlContent
        });
        console.log(`[Reporter] 📧 Email di report inviata a ${recipient}`);
    } catch (e) {
        console.error("[Reporter] ❌ Errore invio email:", e);
    }
}
