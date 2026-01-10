import * as nodemailer from 'nodemailer';
import { SessionMetrics } from './monitor';
import { uploadToOracle } from './backupService';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionTravelLog, getSessionEncounteredNPCs, getCampaignById, getSessionStartTime, getSessionTranscript, getExplicitSessionNumber, db } from './db';

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

    // 🆕 STATISTICHE FIXATE
    const whisperRatio = metrics.whisperMetrics?.avgProcessingRatio || 0;
    // FIX: Ratio > 1.0 = LENTO (ci mette più del realtime)
    const whisperEfficiency = whisperRatio > 3.0
        ? '🔴 Critical'
        : whisperRatio > 1.8
            ? '🟡 Slow (check thermal)'
            : whisperRatio > 1.0
                ? '⚠️ Normal (ARM64)'
                : '✅ Fast';

    // FIX: Calcola SUCCESS RATE, non failure rate
    const queueSuccessRate = metrics.queueMetrics && metrics.queueMetrics.totalJobsProcessed > 0
        ? (((metrics.queueMetrics.totalJobsProcessed - metrics.queueMetrics.totalJobsFailed) / metrics.queueMetrics.totalJobsProcessed) * 100).toFixed(1)
        : '100';

    const queueHealth = metrics.queueMetrics
        ? `${metrics.queueMetrics.totalJobsProcessed} processed, ${metrics.queueMetrics.totalJobsFailed} failed (Success: ${queueSuccessRate}%)`
        : 'N/A';

    const aiPerformance = metrics.aiMetrics
        ? `${metrics.aiMetrics.provider.toUpperCase()} - ${metrics.aiMetrics.tokensPerSecond.toFixed(1)} tok/s (avg: ${(metrics.aiMetrics.avgLatencyMs / 1000).toFixed(1)}s)`
        : 'N/A';

    const storageEfficiency = metrics.storageMetrics
        ? `${metrics.storageMetrics.totalUploadedMB.toFixed(1)} MB uploaded (${metrics.storageMetrics.uploadSuccessRate.toFixed(0)}% success, ${metrics.storageMetrics.avgCompressionRatio.toFixed(1)}x compression)`
        : 'N/A';

    const thermalWarning = metrics.performanceTrend?.thermalThrottlingDetected
        ? '🔥 THERMAL THROTTLING DETECTED! CPU performance degraded by ' + metrics.performanceTrend.cpuDegradation + '%'
        : '';

    const statsJson = JSON.stringify(metrics, null, 2);

    // 2. 🆕 PROMPT AI FIXATO
    const prompt = `
Sei un ingegnere DevOps che analizza i log di un bot Discord ("Lestapenna") su Oracle Cloud Free Tier ARM64.

Ecco le metriche della sessione:

**SYSTEM RESOURCES**
- Durata: ${durationMin.toFixed(2)} min
- CPU Media: ${avgCpu.toFixed(1)}%
- RAM Max: ${maxRam} MB
- DB Growth: ${dbGrowthMB.toFixed(3)} MB
- Disk Used: ${diskUsedPct.toFixed(1)}% (${diskFree.toFixed(2)}GB free)
${thermalWarning}

**WHISPER PERFORMANCE**
- File Audio: ${metrics.totalFiles}
- Processing Ratio: ${whisperRatio.toFixed(2)}x (${whisperEfficiency})
  [NOTA: Ratio = transcriptionTime/audioDuration. >1.0 = lento, <1.0 = veloce]
- Throughput: ${metrics.whisperMetrics?.filesPerHour.toFixed(1) || 'N/A'} file/h
- Fastest: ${metrics.whisperMetrics?.minProcessingTime.toFixed(1) || 'N/A'}s
- Slowest: ${metrics.whisperMetrics?.maxProcessingTime.toFixed(1) || 'N/A'}s

**QUEUE HEALTH**
- ${queueHealth}
- Avg Wait Time: ${metrics.queueMetrics?.avgWaitTimeMs ? (metrics.queueMetrics.avgWaitTimeMs / 1000).toFixed(1) + 's' : 'N/A'}
- Retried Jobs: ${metrics.queueMetrics?.retriedJobs || 0}

**AI PERFORMANCE**
- ${aiPerformance}
- Failed Requests: ${metrics.aiMetrics?.failedRequests || 0}

**STORAGE**
- ${storageEfficiency}

**ERRORS**: ${metrics.errors.length}

Analizza brevemente la stabilità del sistema e segnala eventuali anomalie REALI (non falsi positivi).

⚠️ REGOLE DI INTERPRETAZIONE (CRITICHE):
1. **Whisper Ratio**:
   - < 1.0 = Veloce ✅ (processa più veloce del realtime)
   - 1.0-1.8 = Normale per ARM64 ✅ (llama.cpp su ARM è più lento di x86)
   - 1.8-3.0 = Lento 🟡 (controllare concurrency/thermal)
   - > 3.0 = Critico 🔴 (problema serio)
   
2. **Disk Usage**:
   - < 75% = OK ✅
   - 75-85% = Warning 🟡 (pianifica cleanup)
   - > 85% = Critico 🔴 (cleanup urgente!)
   
3. **AI Latency (Ollama su ARM64)**:
   - < 15s = Veloce ✅
   - 15-25s = Normale ✅ (llama3.2 su ARM64)
   - 25-40s = Lento 🟡 (considerare OpenAI per task complessi)
   - > 40s = Critico 🔴 (passare a OpenAI o ridurre context)
   
4. **Queue Success Rate**:
   - > 95% = OK ✅
   - 90-95% = Warning 🟡 (indagare log)
   - < 90% = Critico 🔴 (problema serio)

Rispondi in italiano, in modo conciso (max 10 righe), segnalando SOLO problemi REALI.
Se tutti i parametri sono nella norma, dillo chiaramente senza inventare problemi.
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

    // 3. 🆕 HTML TABLE FIXATO
    const htmlTable = `
    <h2>📊 Session Metrics Report</h2>
    ${thermalWarning ? `<p style="color: red; font-weight: bold;">${thermalWarning}</p>` : ''}
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
            <td>${metrics.totalAudioDurationSec.toFixed(2)} sec</td>
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
        <tr style="background-color: ${diskUsedPct > 85 ? '#ffcccc' : diskUsedPct > 75 ? '#fff3cd' : '#e6ffe6'};">
            <td><strong>Disk Usage</strong></td>
            <td><strong>${diskUsedPct.toFixed(1)}%</strong> (${diskFree.toFixed(2)} GB free / ${diskTotal.toFixed(2)} GB total)</td>
        </tr>
        <tr>
            <td>Errors</td>
            <td style="color: ${metrics.errors.length > 0 ? 'red' : 'green'};">${metrics.errors.length}</td>
        </tr>

        <!-- 🆕 WHISPER PERFORMANCE (FIXATO) -->
        <tr style="background-color: #e3f2fd;">
            <td colspan="2"><strong>🎙️ WHISPER PERFORMANCE</strong></td>
        </tr>
        <tr>
            <td>Processing Ratio</td>
            <td style="color: ${whisperRatio > 3.0 ? 'red' : whisperRatio > 1.8 ? 'orange' : 'green'};">
                <strong>${whisperRatio.toFixed(2)}x</strong> (${whisperEfficiency})
            </td>
        </tr>
        <tr>
            <td>Throughput</td>
            <td>${metrics.whisperMetrics?.filesPerHour.toFixed(1) || 'N/A'} file/hour</td>
        </tr>
        <tr>
            <td>Fastest File</td>
            <td>${metrics.whisperMetrics?.minProcessingTime.toFixed(1) || 'N/A'}s</td>
        </tr>
        <tr>
            <td>Slowest File</td>
            <td>${metrics.whisperMetrics?.maxProcessingTime.toFixed(1) || 'N/A'}s</td>
        </tr>
        
        <!-- 🆕 QUEUE HEALTH (FIXATO) -->
        <tr style="background-color: #e3f2fd;">
            <td colspan="2"><strong>📦 QUEUE HEALTH</strong></td>
        </tr>
        <tr>
            <td>Jobs Processed</td>
            <td>${metrics.queueMetrics?.totalJobsProcessed || 0}</td>
        </tr>
        <tr>
            <td>Jobs Failed</td>
            <td style="color: ${(metrics.queueMetrics?.totalJobsFailed || 0) > 0 ? 'red' : 'green'};">
                ${metrics.queueMetrics?.totalJobsFailed || 0}
            </td>
        </tr>
        <tr>
            <td>Success Rate</td>
            <td style="color: ${parseFloat(queueSuccessRate) < 95 ? 'orange' : 'green'}; font-weight: bold;">
                ${queueSuccessRate}%
            </td>
        </tr>
        <tr>
            <td>Avg Wait Time</td>
            <td>${metrics.queueMetrics?.avgWaitTimeMs ? (metrics.queueMetrics.avgWaitTimeMs / 1000).toFixed(1) + 's' : 'N/A'}</td>
        </tr>
        <tr>
            <td>Retried Jobs</td>
            <td>${metrics.queueMetrics?.retriedJobs || 0}</td>
        </tr>
        
        <!-- AI PERFORMANCE -->
        <tr style="background-color: #e3f2fd;">
            <td colspan="2"><strong>🤖 AI PERFORMANCE</strong></td>
        </tr>
        <tr>
            <td>Provider</td>
            <td><strong>${metrics.aiMetrics?.provider.toUpperCase() || 'N/A'}</strong></td>
        </tr>
        <tr>
            <td>Avg Latency</td>
            <td style="color: ${(metrics.aiMetrics?.avgLatencyMs || 0) > 40000 ? 'red' : (metrics.aiMetrics?.avgLatencyMs || 0) > 25000 ? 'orange' : 'green'};">
                ${metrics.aiMetrics?.avgLatencyMs ? (metrics.aiMetrics.avgLatencyMs / 1000).toFixed(1) + 's' : 'N/A'}
            </td>
        </tr>
        <tr>
            <td>Tokens/Second</td>
            <td>${metrics.aiMetrics?.tokensPerSecond.toFixed(1) || 'N/A'}</td>
        </tr>
        <tr>
            <td>Failed Requests</td>
            <td style="color: ${(metrics.aiMetrics?.failedRequests || 0) > 0 ? 'red' : 'green'};">
                ${metrics.aiMetrics?.failedRequests || 0}
            </td>
        </tr>
        
        <!-- STORAGE -->
        <tr style="background-color: #e3f2fd;">
            <td colspan="2"><strong>💾 STORAGE</strong></td>
        </tr>
        <tr>
            <td>Files Uploaded</td>
            <td>${metrics.storageMetrics?.totalUploadedMB.toFixed(1) || 0} MB</td>
        </tr>
        <tr>
            <td>Upload Success Rate</td>
            <td style="color: ${(metrics.storageMetrics?.uploadSuccessRate || 100) > 95 ? 'green' : 'orange'};">
                ${metrics.storageMetrics?.uploadSuccessRate.toFixed(0) || 100}%
            </td>
        </tr>
        <tr>
            <td>Compression Ratio</td>
            <td>${metrics.storageMetrics?.avgCompressionRatio.toFixed(1) || 'N/A'}x</td>
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

export async function sendSessionRecap(
    sessionId: string,
    campaignId: number,
    summary: string,
    loot?: string[],
    lootRemoved?: string[],
    narrative?: string
): Promise<boolean> {

    if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
        console.log(`[Reporter] ✉️ Email disabilitata`);
        return false;
    }

    try {
        // 🔄 DATI SESSIONE
        const campaign = getCampaignById(campaignId);
        const sessionNum = getExplicitSessionNumber(sessionId) || "?";
        const startTime = getSessionStartTime(sessionId);
        const travels = getSessionTravelLog(sessionId);
        const npcs = getSessionEncounteredNPCs(sessionId);
        const transcripts = getSessionTranscript(sessionId);

        if (!transcripts || transcripts.length === 0) {
            console.warn(`[Reporter] ⚠️ Nessuna trascrizione per ${sessionId}`);
            return false;
        }

        // 📅 Data formattata
        const sessionDate = startTime
            ? new Date(startTime).toLocaleDateString('it-IT', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            })
            : new Date().toLocaleDateString('it-IT', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            });

        // 🆕 HELPER PER TIMESTAMP (VERSIONE SICURA)
        const formatSegment = (seg: any, fileTimestamp: number) => {
            if (!startTime) return seg.text; // Fallback se manca startTime

            const absTime = fileTimestamp + (seg.start * 1000);
            const mins = Math.floor((absTime - startTime) / 60000);
            const secs = Math.floor(((absTime - startTime) % 60000) / 1000);
            return `[${mins}:${secs.toString().padStart(2, '0')}] ${seg.text}`;
        };

        // 🆕 GENERA ALLEGATI TXT
        const correctedText = transcripts.map(t => {
            let text = "";
            try {
                const segments = JSON.parse(t.transcription_text);
                if (Array.isArray(segments)) {
                    text = segments.map(s => formatSegment(s, t.timestamp)).join('\n');
                } else {
                    text = t.transcription_text;
                }
            } catch (e) {
                text = t.transcription_text;
            }
            return `--- ${t.character_name || 'Sconosciuto'} (File: ${new Date(t.timestamp).toLocaleTimeString()}) ---\n${text}`;
        }).join('\n\n');

        const rawTextParts: string[] = [];
        for (const t of transcripts) {
            const recording = db.prepare(`
        SELECT raw_transcription_text, filename 
        FROM recordings 
        WHERE session_id = ? AND user_id = ? AND timestamp = ?
      `).get(sessionId, t.user_id, t.timestamp) as { raw_transcription_text: string | null, filename: string } | undefined;

            if (!recording || !recording.raw_transcription_text) {
                rawTextParts.push(`--- ${t.character_name || 'Sconosciuto'} (${recording?.filename || '?'}) ---\n[Trascrizione grezza non disponibile]\n`);
                continue;
            }

            let text = "";
            try {
                const segments = JSON.parse(recording.raw_transcription_text);
                if (Array.isArray(segments)) {
                    text = segments.map(s => formatSegment(s, t.timestamp)).join('\n');
                } else {
                    text = recording.raw_transcription_text;
                }
            } catch (e) {
                text = recording.raw_transcription_text;
            }
            rawTextParts.push(`--- ${t.character_name || 'Sconosciuto'} (File: ${new Date(t.timestamp).toLocaleTimeString()}) ---\n${text}`);
        }
        const rawText = rawTextParts.join('\n\n');

        // 📁 SALVA FILE TEMPORANEI
        const tempDir = path.join(__dirname, '..', 'temp_emails');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const correctedPath = path.join(tempDir, `${sessionId}_corrected.txt`);
        const rawPath = path.join(tempDir, `${sessionId}_raw_whisper.txt`);

        fs.writeFileSync(correctedPath, correctedText, 'utf-8');
        fs.writeFileSync(rawPath, rawText, 'utf-8');

        // ✉️ HTML EMAIL (VERSIONE COMPLETA)
        const htmlContent = `
<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
    <h1 style="color: #d35400;">📜 Report Sessione: ${campaign?.name || 'Campagna'}</h1>
    <p style="font-style: italic; margin-bottom: 5px;">ID Sessione: ${sessionId}</p>
    <p style="font-weight: bold; margin-top: 0;">📅 Data: ${sessionDate}</p>
    <p><strong>Sessione #${sessionNum}</strong></p>
    <hr style="border: 1px solid #d35400;">
    
    ${narrative && narrative.length > 10 ? `
    <h2>📖 Racconto</h2>
    <div style="background-color: #fff8e1; padding: 15px; border-radius: 5px; white-space: pre-line; border-left: 4px solid #d35400;">
        ${narrative}
    </div>
    ` : ''}

    <h2>📝 Riassunto Eventi (Log)</h2>
    <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; white-space: pre-line;">
        ${summary}
    </div>

    <div style="margin-top: 20px;">
        <div style="margin-bottom: 20px;">
            <h3 style="color: #2980b9;">🗺️ Cronologia Luoghi</h3>
            <ul>
                ${travels.map(t => {
            const time = new Date(t.timestamp).toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'});
            return `<li><b>${time}</b>: ${t.macro_location || '-'} (${t.micro_location || 'Esterno'})</li>`;
        }).join('') || '<li>Nessuno spostamento rilevato.</li>'}
            </ul>
        </div>
        
        <div>
            <h3 style="color: #27ae60;">💰 Bilancio Oggetti</h3>
            ${loot && loot.length > 0 ? `<p style="margin: 5px 0;"><b>Ottenuti:</b></p><ul style="margin-top: 5px;">${loot.map(i => `<li>+ ${i}</li>`).join('')}</ul>` : ''}
            ${lootRemoved && lootRemoved.length > 0 ? `<p style="margin: 5px 0;"><b>Persi/Usati:</b></p><ul style="margin-top: 5px;">${lootRemoved.map(i => `<li>- ${i}</li>`).join('')}</ul>` : ''}
            ${(!loot || loot.length === 0) && (!lootRemoved || lootRemoved.length === 0) ? '<p>Nessun cambio inventario.</p>' : ''}
        </div>
    </div>

    <h3 style="margin-top: 20px;">👥 NPC Incontrati</h3>
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
                    ${n.status === 'DEAD' ? '💀 MORTO' : ''} 
                    ${n.description ? `<i>${n.description}</i>` : ''}
                </td>
            </tr>
        `).join('') || '<tr><td colspan="3" style="padding: 8px;">Nessun NPC rilevato nel Dossier.</td></tr>'}
    </table>

    <hr>
    <h3>🎙️ Allegati</h3>
    <ul>
      <li><strong>Trascrizioni Corrette:</strong> Testo rivisto dall'AI con ortografia e punteggiatura corrette</li>
      <li><strong>Trascrizioni Grezze:</strong> Output originale di Whisper senza modifiche</li>
    </ul>
    
    <p style="font-size: 12px; color: #999; margin-top: 30px;">Generato automaticamente dal Bardo AI Lestapenna.</p>
</div>
`;

        const mailOptions = {
            from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
            to: process.env.REPORT_RECIPIENT || 'dm@example.com',
            subject: `[D&D Report] ${campaign?.name || 'Campagna'} - Sessione #${sessionNum} - ${sessionDate}`,
            html: htmlContent,
            attachments: [
                {
                    filename: `Sessione_${sessionNum}_Corretta.txt`,
                    path: correctedPath
                },
                {
                    filename: `Sessione_${sessionNum}_Raw_Whisper.txt`,
                    path: rawPath
                }
            ]
        };

        await transporter.sendMail(mailOptions);
        console.log(`[Reporter] ✅ Email inviata con HTML completo + 2 allegati`);

        // 🧹 PULIZIA
        try {
            fs.unlinkSync(correctedPath);
            fs.unlinkSync(rawPath);
        } catch (e) {
            console.warn(`[Reporter] ⚠️ Errore pulizia temp:`, e);
        }

        return true;

    } catch (err: any) {
        console.error(`[Reporter] ❌ Errore:`, err.message);
        return false;
    }
}

