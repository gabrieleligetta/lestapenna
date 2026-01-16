import * as nodemailer from 'nodemailer';
import { SessionMetrics } from './monitor';
import { uploadToOracle, getPresignedUrl } from './backupService';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionTravelLog, getSessionEncounteredNPCs, getCampaignById, getSessionStartTime, getSessionTranscript, getExplicitSessionNumber, db, getSessionNotes } from './db';
import { processChronologicalSession } from './transcriptUtils';
import { monitor } from './monitor';
// 🆕 Rimosso import narrativeFilter - ora usiamo solo regex per pulizia
import axios from "axios";

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

// Helper per ottenere la lista dei destinatari
// Accetta il nome della variabile specifica, con fallback su REPORT_RECIPIENT
function getRecipients(envVarName: string): string[] {
    // 1. Cerca la variabile specifica (es. TECHNICAL_REPORT_RECIPIENT)
    // 2. Se manca, cerca quella generica (REPORT_RECIPIENT)
    // 3. Se manca anche quella, usa il default
    const recipientEnv =  process.env[envVarName] || process.env.REPORT_RECIPIENT;

    if (!recipientEnv) return ['gabligetta@gmail.com'];

    try {
        // Prova a parsare come JSON array
        const parsed = JSON.parse(recipientEnv);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        // Se è una stringa JSON valida ma non un array, la trattiamo come stringa singola
        return [String(parsed)];
    } catch (e) {
        // Se fallisce il parsing JSON, assume che sia una stringa semplice (singola email o separata da virgola)
        if (recipientEnv.includes(',')) {
            return recipientEnv.split(',').map(s => s.trim());
        }
        return [recipientEnv];
    }
}

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

**SYSTEM HEALTH (VM)**
- Min Free RAM: ${metrics.systemHealth?.minFreeRamMB || 'N/A'} MB (Critico se < 1000MB)
- Max CPU Load: ${metrics.systemHealth?.maxCpuLoad.toFixed(2) || 'N/A'}

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
    const startAI = Date.now();
    try {
        const modelToUse = process.env.AI_PROVIDER === 'ollama'
            ? (process.env.OLLAMA_MODEL || "llama3.2")
            : (process.env.OPEN_AI_MODEL || "gpt-4o-mini");

        const response = await openai.chat.completions.create({
            model: modelToUse,
            messages: [{ role: "user", content: prompt }]
        });
        
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        const provider = process.env.AI_PROVIDER === 'ollama' ? 'ollama' : 'openai';
        
        monitor.logAIRequestWithCost('summary', provider, modelToUse, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);
        
        emailBody = response.choices[0].message.content || "Report generico.";
    } catch (e: any) {
        const provider = process.env.AI_PROVIDER === 'ollama' ? 'ollama' : 'openai';
        const modelToUse = process.env.AI_PROVIDER === 'ollama'
            ? (process.env.OLLAMA_MODEL || "llama3.2")
            : (process.env.OPEN_AI_MODEL || "gpt-4o-mini");
        monitor.logAIRequestWithCost('summary', provider, modelToUse, 0, 0, 0, Date.now() - startAI, true);
        emailBody = `Impossibile generare analisi AI: ${e.message}`;
    }

    // 🆕 AGGREGA COSTI PER FASE
    interface AggregatedCostByPhase {
        phase: string;
        models: string[];          // Tutti i modelli usati in questa fase
        providers: Set<string>;    // Provider usati
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        costUSD: number;
    }

    const aggregatedByPhase: Record<string, AggregatedCostByPhase> = {};

    if (metrics.costMetrics?.breakdown) {
        metrics.costMetrics.breakdown.forEach(cost => {
            if (!aggregatedByPhase[cost.phase]) {
                aggregatedByPhase[cost.phase] = {
                    phase: cost.phase,
                    models: [cost.model],
                    providers: new Set([cost.provider]),
                    inputTokens: cost.inputTokens,
                    cachedInputTokens: cost.cachedInputTokens || 0,
                    outputTokens: cost.outputTokens,
                    costUSD: cost.costUSD
                };
            } else {
                // Aggiungi modello se non già presente
                if (!aggregatedByPhase[cost.phase].models.includes(cost.model)) {
                    aggregatedByPhase[cost.phase].models.push(cost.model);
                }
                aggregatedByPhase[cost.phase].providers.add(cost.provider);

                // Somma token e costi
                aggregatedByPhase[cost.phase].inputTokens += cost.inputTokens;
                aggregatedByPhase[cost.phase].cachedInputTokens += (cost.cachedInputTokens || 0);
                aggregatedByPhase[cost.phase].outputTokens += cost.outputTokens;
                aggregatedByPhase[cost.phase].costUSD += cost.costUSD;
            }
        });
    }

    // Ordina per fase (opzionale, per avere un ordine consistente)
    const phaseOrder = ['transcription', 'metadata', 'embeddings', 'map', 'analyst', 'narrative_filter', 'summary', 'chat'];
    
    const phaseDisplayNames: Record<string, string> = {
        'transcription': 'Transcription (Whisper/Correction)',
        'metadata': 'Metadata Validation',
        'embeddings': 'RAG Embeddings',
        'map': 'Map Phase (Condensation)',
        'analyst': 'Data Analyst (Extraction)',
        'narrative_filter': 'Narrative Filter',
        'summary': 'Storyteller (Summary)',
        'chat': 'Chat / RAG Query'
    };

    const sortedPhases = Object.values(aggregatedByPhase).sort((a, b) => {
        const indexA = phaseOrder.indexOf(a.phase);
        const indexB = phaseOrder.indexOf(b.phase);
        if (indexA === -1 && indexB === -1) return a.phase.localeCompare(b.phase);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
    });

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
            <td><strong>Process</strong> CPU/RAM</td>
            <td>${avgCpu.toFixed(1)}% / ${maxRam} MB</td>
        </tr>
        <tr style="background-color: ${(metrics.systemHealth?.minFreeRamMB || 9999) < 2000 ? '#fff3cd' : 'white'};">
            <td><strong>System</strong> Min Free RAM</td>
            <td style="font-weight: bold; color: ${(metrics.systemHealth?.minFreeRamMB || 9999) < 1000 ? 'red' : 'black'};">
                ${metrics.systemHealth?.minFreeRamMB.toLocaleString() || 'N/A'} MB
            </td>
        </tr>
        <tr>
            <td><strong>System</strong> Max Load</td>
            <td>${metrics.systemHealth?.maxCpuLoad.toFixed(2) || 'N/A'}</td>
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

        <!-- 💰 COST ANALYSIS -->
        <tr style="background-color: #fff3cd;">
            <td colspan="2"><strong>💰 COST ANALYSIS</strong></td>
        </tr>
        <tr>
            <td><strong>Total Cost</strong></td>
            <td style="font-weight: bold; font-size: 16px; color: #d35400;">
                $${metrics.costMetrics?.totalCostUSD.toFixed(4) || '0.0000'} USD
            </td>
        </tr>
        ${metrics.costMetrics ? `
        <tr>
            <td style="padding-left: 20px;">OpenAI</td>
            <td><strong>$${metrics.costMetrics.byProvider.openai.toFixed(4)}</strong></td>
        </tr>
        <tr>
            <td style="padding-left: 20px;">Ollama (Self-hosted)</td>
            <td>$${metrics.costMetrics.byProvider.ollama.toFixed(4)} (Free)</td>
        </tr>
        ` : ''}

        <!-- Breakdown per fase (AGGREGATO) -->
        <tr style="background-color: #f9f9f9;">
            <td colspan="2"><strong>📊 Cost Breakdown by Phase</strong></td>
        </tr>
        ${sortedPhases.length > 0 ? sortedPhases.map(cost => {
            const displayName = phaseDisplayNames[cost.phase] || (cost.phase.charAt(0).toUpperCase() + cost.phase.slice(1));
            return `
        <tr>
            <td style="padding-left: 20px;">
                <strong>${displayName}</strong>
                <br/><small style="color: #666;">
                    ${Array.from(cost.providers).join(', ')} • ${cost.models.join(', ')}
                </small>
            </td>
            <td>
                <small>
                    In: ${cost.inputTokens.toLocaleString()} 
                    ${cost.cachedInputTokens > 0 ? `(Cached: ${cost.cachedInputTokens.toLocaleString()})` : ''}
                    <br/>
                    Out: ${cost.outputTokens.toLocaleString()}
                </small>
                <br/>
                <strong style="color: ${cost.costUSD > 0.01 ? '#d35400' : '#27ae60'};">
                    $${cost.costUSD.toFixed(4)}
                </strong>
            </td>
        </tr>
        `;
        }).join('') : '<tr><td colspan="2" style="padding: 8px; color: #999;">Nessun dato disponibile</td></tr>'}
        
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
    // 🆕 USA LA LISTA TECNICA
    const recipients = getRecipients('TECHNICAL_REPORT_RECIPIENT');
    const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
        to: recipients.join(', '),
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

export async  function testRemoteConnection() {
    const REMOTE_WHISPER_URL = process.env.REMOTE_WHISPER_URL;
    if (!REMOTE_WHISPER_URL) return;

    const healthUrl = `${REMOTE_WHISPER_URL}/health`;

    console.log(`[System] 📡 Test connessione PC remoto (${healthUrl})...`);
    try {
        // Timeout breve per il test (3s). Usiamo GET che è meno invasivo di POST.
        // Anche un 404 o 405 conferma che il server è raggiungibile.
        await axios.get(healthUrl, { timeout: 3000 });
        console.log(`[System] ✅ PC remoto ONLINE e raggiungibile.`);
    } catch (error: any) {
        if (error.response) {
            // Il server ha risposto (es. 404, 405, 500), quindi è online
            console.log(`[System] ✅ PC remoto ONLINE (risposta HTTP ${error.response.status}).`);
        } else {
            // Nessuna risposta (timeout, connection refused)
            console.warn(`[System] ⚠️ PC remoto NON RAGGIUNGIBILE: ${error.message}`);
        }
    }
}

/**
 * Genera e archivia le trascrizioni (Raw + Cleaned) su Oracle Cloud.
 * 🆕 SEMPLIFICATO: Rimossa generazione AI narrativa, solo regex cleaning.
 * - raw: Output Whisper grezzo
 * - cleaned: Pulito con regex anti-allucinazioni (ex "corrected")
 * - summary: Il riassunto narrativo da generateSummary (opzionale)
 */
export async function archiveSessionTranscripts(
    sessionId: string,
    campaignId: number,
    summaryNarrative?: string
): Promise<{ raw: string; cleaned: string; summary?: string }> {
    console.log(`[Reporter] 📦 Archiviazione trascrizioni per sessione ${sessionId}...`);

    // 1. Recupero Dati
    const transcripts = getSessionTranscript(sessionId);
    const notes = getSessionNotes(sessionId);
    const startTime = getSessionStartTime(sessionId);

    if (!transcripts || transcripts.length === 0) {
        throw new Error(`Nessuna trascrizione trovata per ${sessionId}`);
    }

    // 2. Generazione Testi
    // --- ELABORAZIONE CLEANED (regex-filtered, no AI) ---
    const processedCleaned = processChronologicalSession(transcripts, notes, startTime, campaignId);
    const cleanedText = processedCleaned.formattedText;

    // --- ELABORAZIONE RAW ---
    const rawTranscripts = transcripts.map(t => {
        const recording = db.prepare(`
            SELECT raw_transcription_text
            FROM recordings
            WHERE session_id = ? AND user_id = ? AND timestamp = ?
        `).get(sessionId, t.user_id, t.timestamp) as { raw_transcription_text: string | null } | undefined;

        return {
            ...t,
            transcription_text: recording?.raw_transcription_text || "[Trascrizione grezza non disponibile]"
        };
    });

    const processedRaw = processChronologicalSession(rawTranscripts, notes, startTime, campaignId, true);
    const rawText = processedRaw.formattedText;

    // 3. Salvataggio Temporaneo
    const tempDir = path.join(__dirname, '..', 'temp_emails');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const cleanedPath = path.join(tempDir, `${sessionId}_cleaned.txt`);
    const rawPath = path.join(tempDir, `${sessionId}_raw_whisper.txt`);
    const summaryPath = summaryNarrative ? path.join(tempDir, `${sessionId}_summary.txt`) : undefined;

    fs.writeFileSync(cleanedPath, cleanedText, 'utf-8');
    fs.writeFileSync(rawPath, rawText, 'utf-8');
    if (summaryPath && summaryNarrative) {
        fs.writeFileSync(summaryPath, summaryNarrative, 'utf-8');
    }

    // 4. Upload su Cloud
    try {
        await uploadToOracle(cleanedPath, 'transcript_cleaned.txt', sessionId, `transcripts/${sessionId}/transcript_cleaned.txt`);
        await uploadToOracle(rawPath, 'transcript_raw.txt', sessionId, `transcripts/${sessionId}/transcript_raw.txt`);
        if (summaryPath) {
            await uploadToOracle(summaryPath, 'summary_narrative.txt', sessionId, `transcripts/${sessionId}/summary_narrative.txt`);
        }
        console.log(`[Reporter] ☁️ Trascrizioni archiviate su Oracle Cloud.`);
    } catch (e) {
        console.error(`[Reporter] ❌ Errore upload trascrizioni:`, e);
    }

    return {
        raw: rawPath,
        cleaned: cleanedPath,
        summary: summaryPath
    };
}

export async function sendSessionRecap(
    sessionId: string,
    campaignId: number,
    log: string[],
    loot?: string[],
    lootRemoved?: string[],
    narrativeBrief?: string,
    fullNarrative?: string,
    monsters?: Array<{ name: string; status: string; count?: string }>
): Promise<boolean> {

    // 1. Generazione e Archiviazione (Sempre, anche se email disabilitata)
    let filePaths: { raw: string; cleaned: string; summary?: string } | null = null;
    try {
        filePaths = await archiveSessionTranscripts(sessionId, campaignId, fullNarrative);
    } catch (e) {
        console.error(`[Reporter] ❌ Errore archiviazione trascrizioni:`, e);
    }

    if (!process.env.EMAIL_ENABLED || process.env.EMAIL_ENABLED !== 'true') {
        console.log(`[Reporter] ✉️ Email disabilitata`);
        if (filePaths) {
            try {
                if (fs.existsSync(filePaths.cleaned)) fs.unlinkSync(filePaths.cleaned);
                if (fs.existsSync(filePaths.raw)) fs.unlinkSync(filePaths.raw);
                if (filePaths.summary && fs.existsSync(filePaths.summary)) fs.unlinkSync(filePaths.summary);
            } catch (e) {}
        }
        return false;
    }

    try {
        // 🔄 DATI SESSIONE
        const campaign = getCampaignById(campaignId);
        const sessionNum = getExplicitSessionNumber(sessionId) || "?";
        const startTime = getSessionStartTime(sessionId);
        const travels = getSessionTravelLog(sessionId);
        const npcs = getSessionEncounteredNPCs(sessionId);

        // 📅 Data formattata
        const sessionDate = startTime
            ? new Date(startTime).toLocaleDateString('it-IT', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            })
            : new Date().toLocaleDateString('it-IT', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            });

        // Usa il racconto breve per l'email body (il lungo va in allegato)
        let narrativeText = narrativeBrief;

        // Genera Link Raw Full Session
        let fullMixUrl = "";
        try {
            const mixKey = `mixed_sessions/${sessionId}/session_${sessionId}_full.mp3`;
            fullMixUrl = await getPresignedUrl(mixKey, undefined, 604800) || "";
        } catch (e) {
            console.warn(`[Reporter] ⚠️ Traccia raw non disponibile per ${sessionId}`);
        }

        // HTML Download Button (SOLO Raw)
        let downloadLinksHtml = "";
        if (fullMixUrl) {
            downloadLinksHtml = `
            <div style="margin: 20px 0; padding: 15px; background-color: #e8f6f3; border: 1px solid #1abc9c; border-radius: 5px; text-align: center;">
                <p style="margin: 0 0 10px 0; font-weight: bold; color: #16a085;">📥 Download Registrazione</p>
                <a href="${fullMixUrl}" style="background-color: #e74c3c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                    🎙️ Traccia Raw Full (MP3)
                </a>
                <p style="margin: 10px 0 0 0; font-size: 12px; color: #7f8c8d;">
                    Registrazione completa non editata • Link valido per 7 giorni
                </p>
            </div>
            `;
        }

        // ✉️ HTML EMAIL (VERSIONE COMPLETA)
        const htmlContent = `
<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
    <h1 style="color: #d35400;">📜 Report Sessione: ${campaign?.name || 'Campagna'}</h1>
    <p style="font-style: italic; margin-bottom: 5px;">ID Sessione: ${sessionId}</p>
    <p style="font-weight: bold; margin-top: 0;">📅 Data: ${sessionDate}</p>
    <p><strong>Sessione #${sessionNum}</strong></p>
    <hr style="border: 1px solid #d35400;">
    
    ${downloadLinksHtml}

    ${narrativeText && narrativeText.length > 10 ? `
    <h2>📖 Racconto</h2>
    <div style="background-color: #fff8e1; padding: 15px; border-radius: 5px; white-space: pre-line; border-left: 4px solid #d35400;">
        ${narrativeText}
    </div>
    ` : ''}

    <h2>📝 Riassunto Eventi (Log)</h2>
    <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px;">
        <ul style="margin: 0; padding-left: 20px;">
            ${log && log.length > 0 ? log.map(entry => `<li>${entry}</li>`).join('\n            ') : '<li>Nessun evento registrato</li>'}
        </ul>
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

    <h3 style="margin-top: 20px;">👹 Bestiario / Minacce</h3>
    <table style="width: 100%; border-collapse: collapse;">
        <tr style="background-color: #eee;">
            <th style="padding: 8px; text-align: left; border-bottom: 1px solid #ddd;">Creatura</th>
            <th style="padding: 8px; text-align: left; border-bottom: 1px solid #ddd;">Stato</th>
            <th style="padding: 8px; text-align: left; border-bottom: 1px solid #ddd;">Quantità</th>
        </tr>
        ${monsters && monsters.length > 0 ? monsters.map(m => `
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;"><b>${m.name}</b></td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">
                    ${m.status === 'DEFEATED' ? '⚔️ SCONFITTO' : m.status === 'FLED' ? '💨 FUGGITO' : '👀 VIVO'}
                </td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">${m.count || '1'}</td>
            </tr>
        `).join('') : '<tr><td colspan="3" style="padding: 8px;">Nessuna minaccia rilevata.</td></tr>'}
    </table>

    <hr>
    <h3>📎 Allegati</h3>
    <ul>
      <li><strong>Trascrizioni Corrette:</strong> Testo rivisto dall'AI con ortografia e punteggiatura corrette</li>
      <li><strong>Trascrizioni Grezze:</strong> Output originale di Whisper senza modifiche</li>
      <li><strong>Trascrizioni Narrative:</strong> Versione ottimizzata per analisi RAG (senza metagaming, eventi normalizzati in terza persona)</li>
    </ul>
    
    <p style="font-size: 12px; color: #999; margin-top: 30px;">Generato automaticamente dal Bardo AI Lestapenna.</p>
</div>
`;

        // 🆕 USA LA LISTA SESSIONE
        const recipients = getRecipients('SESSION_REPORT_RECIPIENT');
        
        const attachments = [];
        if (filePaths) {
            if (fs.existsSync(filePaths.cleaned)) attachments.push({ filename: `Sessione_${sessionNum}_Trascrizione.txt`, path: filePaths.cleaned });
            if (fs.existsSync(filePaths.raw)) attachments.push({ filename: `Sessione_${sessionNum}_Raw_Whisper.txt`, path: filePaths.raw });
            if (filePaths.summary && fs.existsSync(filePaths.summary)) attachments.push({ filename: `Sessione_${sessionNum}_Racconto_Completo.txt`, path: filePaths.summary });
        }

        const mailOptions = {
            from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
            to: recipients.join(', '),
            subject: `[D&D Report] ${campaign?.name || 'Campagna'} - Sessione #${sessionNum} - ${sessionDate}`,
            html: htmlContent,
            attachments: attachments
        };

        await transporter.sendMail(mailOptions);
        console.log(`[Reporter] ✅ Email inviata con HTML completo + ${attachments.length} allegati`);

        // 🧹 PULIZIA
        if (filePaths) {
            try {
                if (fs.existsSync(filePaths.cleaned)) fs.unlinkSync(filePaths.cleaned);
                if (fs.existsSync(filePaths.raw)) fs.unlinkSync(filePaths.raw);
                if (filePaths.summary && fs.existsSync(filePaths.summary)) fs.unlinkSync(filePaths.summary);
            } catch (e) {
                console.warn(`[Reporter] ⚠️ Errore pulizia temp:`, e);
            }
        }

        return true;

    } catch (err: any) {
        console.error(`[Reporter] ❌ Errore:`, err.message);
        return false;
    }
}
