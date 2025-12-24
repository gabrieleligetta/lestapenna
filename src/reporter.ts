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
    - Errori: ${metrics.errors.length}

    Analizza brevemente la stabilità del sistema e segnala eventuali anomalie.
    `;

    let emailBody = "";
    try {
        const modelToUse = process.env.AI_PROVIDER === 'ollama' 
            ? (process.env.OLLAMA_MODEL || "llama3.2") 
            : (process.env.OPEN_AI_MODEL || "gpt-4o-mini");

        const response = await openai.chat.completions.create({
            model: modelToUse,
            messages: [{ role: "user", content: prompt }]
        });
        emailBody = response.choices[0].message.content || "Report generico.";
    } catch (e: any) {
        emailBody = `Impossibile generare analisi AI: ${e.message}`;
    }

    // 3. Salvataggio locale temporaneo del log
    const logFileName = `report-${metrics.sessionId}.json`;
    const logPath = path.join(__dirname, '..', 'recordings', logFileName);
    fs.writeFileSync(logPath, statsJson);

    // 4. Upload su Oracle
    try {
        await uploadToOracle(logPath, logFileName, undefined, `logs/${logFileName}`);
        console.log("[Reporter] ☁️ Metriche caricate su Oracle Cloud.");
    } catch (e) {
        console.error("[Reporter] ❌ Errore upload metriche:", e);
    }

    // 5. Invio Email via Porkbun
    const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
        to: process.env.REPORT_RECIPIENT || 'gabligetta@gmail.com',
        subject: `[Lestapenna] Report Sessione ${metrics.sessionId} - ${metrics.errors.length > 0 ? '⚠️ ALERT' : '✅ OK'}`,
        text: emailBody + `\n\nDATI RAW:\n${statsJson}`,
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
        text: `Test OK.`
    };
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (e) {
        return false;
    }
}
