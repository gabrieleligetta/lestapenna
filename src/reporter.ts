import * as nodemailer from 'nodemailer';
import { SessionMetrics } from './monitor';
import { uploadToOracle } from './backupService';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

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
    Se il disco è pieno oltre l'80%, lancia un allarme critico.
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
