/**
 * Reporter - Report Generator
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionMetrics, monitor } from '../monitor';
import { openaiReporterClient, REPORT_MODEL } from './config';
import { uploadToOracle } from '../services/backup';
import { getRecipients, sendEmail } from './email';
import { AggregatedCostByPhase } from './types';
import { getSessionGuildId } from '../db';

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
    const whisperEfficiency = whisperRatio > 3.0
        ? '🔴 Critical'
        : whisperRatio > 1.8
            ? '🟡 Slow (check thermal)'
            : whisperRatio > 1.0
                ? '⚠️ Normal (ARM64)'
                : '✅ Fast';

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
Rispondi in italiano, in modo conciso (max 10 righe), segnalando SOLO problemi REALI.
`;

    let emailBody = "";
    const startAI = Date.now();
    try {
        const response = await openaiReporterClient.chat.completions.create({
            model: REPORT_MODEL,
            messages: [{ role: "user", content: prompt }]
        });

        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens || 0;
        const provider = process.env.AI_PROVIDER === 'ollama' ? 'ollama' : 'openai';

        monitor.logAIRequestWithCost('summary', provider, REPORT_MODEL, inputTokens, outputTokens, cachedTokens, Date.now() - startAI, false);

        emailBody = response.choices[0].message.content || "Report generico.";
    } catch (e: any) {
        monitor.logAIRequestWithCost('summary', 'openai', REPORT_MODEL, 0, 0, 0, Date.now() - startAI, true);
        emailBody = `Impossibile generare analisi AI: ${e.message}`;
    }

    // 🆕 AGGREGA COSTI PER FASE
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
                if (!aggregatedByPhase[cost.phase].models.includes(cost.model)) {
                    aggregatedByPhase[cost.phase].models.push(cost.model);
                }
                aggregatedByPhase[cost.phase].providers.add(cost.provider);
                aggregatedByPhase[cost.phase].inputTokens += cost.inputTokens;
                aggregatedByPhase[cost.phase].cachedInputTokens += (cost.cachedInputTokens || 0);
                aggregatedByPhase[cost.phase].outputTokens += cost.outputTokens;
                aggregatedByPhase[cost.phase].costUSD += cost.costUSD;
            }
        });
    }

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

    let htmlTable = `
    <h2>📊 Session Metrics Report</h2>
    ${thermalWarning ? `<p style="color: red; font-weight: bold;">${thermalWarning}</p>` : ''}
    <p><strong>Session ID:</strong> ${metrics.sessionId}</p>
    <p><strong>Analysis:</strong><br/>${emailBody.replace(/\n/g, '<br/>')}</p>
    
    <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif;">
        <!-- METRICS ROWS OMITTED FOR BREVITY, ASSUME STANDARD STRUCTURE -->
        <tr>
            <td>Duration</td>
            <td>${durationMin.toFixed(2)} min</td>
        </tr>
         <tr>
            <td><strong>Process</strong> CPU/RAM</td>
            <td>${avgCpu.toFixed(1)}% / ${maxRam} MB</td>
        </tr>
         <tr>
            <td>Errors</td>
            <td style="color: ${metrics.errors.length > 0 ? 'red' : 'green'};">${metrics.errors.length}</td>
        </tr>
         <tr style="background-color: #fff3cd;">
            <td colspan="2"><strong>💰 COST ANALYSIS</strong></td>
        </tr>
        <tr>
            <td><strong>Total Cost</strong></td>
            <td style="font-weight: bold; font-size: 16px; color: #d35400;">
                $${metrics.costMetrics?.totalCostUSD.toFixed(4) || '0.0000'} USD
            </td>
        </tr>
        
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
    </table>
    
    ${metrics.errors.length > 0 ? `<h3>⚠️ Errors</h3><pre>${metrics.errors.join('\n')}</pre>` : ''}
    `;

    // 🆕 Append Token Usage Details for Analyst/Writer
    const tokenDebugDir = path.join(__dirname, '..', '..', 'transcripts', metrics.sessionId, 'debug_prompts');
    let tokenHtml = "";

    try {
        if (fs.existsSync(tokenDebugDir)) {
            const analystPath = path.join(tokenDebugDir, 'analyst_tokens.json');
            const writerPath = path.join(tokenDebugDir, 'writer_tokens.json');
            let analystTokens = { input: 0, output: 0, total: 0, inputChars: 0, outputChars: 0 };
            let writerTokens = { input: 0, output: 0, total: 0, inputChars: 0, outputChars: 0 };

            if (fs.existsSync(analystPath)) analystTokens = JSON.parse(fs.readFileSync(analystPath, 'utf-8'));
            if (fs.existsSync(writerPath)) writerTokens = JSON.parse(fs.readFileSync(writerPath, 'utf-8'));

            if (analystTokens.total > 0 || writerTokens.total > 0) {
                tokenHtml = `
                <div style="margin-top: 20px; padding: 10px; background-color: #eef2f3; border-radius: 5px;">
                    <h3>🧠 Detailed Token Usage</h3>
                    <table border="1" cellpadding="5" cellspacing="0" style="width: 100%; border-collapse: collapse;">
                        <tr>
                            <th>Phase</th>
                            <th>Prompt (In)</th>
                            <th>Response (Out)</th>
                            <th>Total</th>
                        </tr>
                        <tr>
                            <td><strong>Analyst</strong></td>
                            <td>${analystTokens.input.toLocaleString()} <small>(${analystTokens.inputChars?.toLocaleString() || 0} chars)</small></td>
                            <td>${analystTokens.output.toLocaleString()} <small>(${analystTokens.outputChars?.toLocaleString() || 0} chars)</small></td>
                            <td>${analystTokens.total.toLocaleString()} <br/><small>(${((analystTokens.inputChars || 0) + (analystTokens.outputChars || 0)).toLocaleString()} chars)</small></td>
                        </tr>
                        <tr>
                            <td><strong>Writer (Summary)</strong></td>
                            <td>${writerTokens.input.toLocaleString()} <small>(${writerTokens.inputChars?.toLocaleString() || 0} chars)</small></td>
                            <td>${writerTokens.output.toLocaleString()} <small>(${writerTokens.outputChars?.toLocaleString() || 0} chars)</small></td>
                            <td>${writerTokens.total.toLocaleString()} <br/><small>(${((writerTokens.inputChars || 0) + (writerTokens.outputChars || 0)).toLocaleString()} chars)</small></td>
                        </tr>
                        <tr>
                            <td><strong>TOTAL SESSION</strong></td>
                            <td><strong>${(analystTokens.input + writerTokens.input).toLocaleString()}</strong> <small>(${((analystTokens.inputChars || 0) + (writerTokens.inputChars || 0)).toLocaleString()} chars)</small></td>
                            <td><strong>${(analystTokens.output + writerTokens.output).toLocaleString()}</strong> <small>(${((analystTokens.outputChars || 0) + (writerTokens.outputChars || 0)).toLocaleString()} chars)</small></td>
                            <td><strong>${(analystTokens.total + writerTokens.total).toLocaleString()}</strong> <br/><small>(${((analystTokens.inputChars || 0) + (writerTokens.inputChars || 0) + (analystTokens.outputChars || 0) + (writerTokens.outputChars || 0)).toLocaleString()} chars)</small></td>
                        </tr>
                    </table>
                </div>
                `;
            }
        }
    } catch (e) {
        console.error("[Reporter] Failed to read token stats:", e);
    }

    htmlTable += tokenHtml;

    // 4. Salvataggio locale temporaneo del log
    const logFileName = `report-${metrics.sessionId}.json`;
    const logPath = path.join(__dirname, '..', '..', 'recordings', logFileName); // Adjust path
    fs.writeFileSync(logPath, statsJson);

    // 5. Upload su Oracle
    try {
        await uploadToOracle(logPath, logFileName, undefined, `logs/${logFileName}`);
        console.log("[Reporter] ☁️ Metriche caricate su Oracle Cloud.");
    } catch (e) {
        console.error("[Reporter] ❌ Errore upload metriche:", e);
    }

    // 6. Invio Email
    const guildId = getSessionGuildId(metrics.sessionId);
    const recipients = getRecipients('TECHNICAL_REPORT_RECIPIENT', guildId);

    const attachments: any[] = [{ filename: logFileName, content: statsJson }];

    // 🆕 Attach Debug Prompts/Responses if available
    // 🆕 Attach ALL Debug Prompts/Responses found in folder
    const debugDir = path.join(__dirname, '..', '..', 'transcripts', metrics.sessionId, 'debug_prompts');

    if (fs.existsSync(debugDir)) {
        try {
            const allFiles = fs.readdirSync(debugDir);
            allFiles.forEach(file => {
                if (file.endsWith('.txt') || file.endsWith('.json')) {
                    const filePath = path.join(debugDir, file);
                    try {
                        const content = fs.readFileSync(filePath, 'utf-8');
                        attachments.push({ filename: file, content: content });
                    } catch (e) {
                        console.error(`[Reporter] Failed to read debug file ${file}:`, e);
                    }
                }
            });
        } catch (e) {
            console.error(`[Reporter] Failed to list debug dir:`, e);
        }
    }

    await sendEmail(
        recipients,
        `[Lestapenna] Report Sessione ${metrics.sessionId} - ${metrics.errors.length > 0 ? '⚠️ ALERT' : '✅ OK'}`,
        emailBody + `\n\nDATI RAW:\n${statsJson}`,
        htmlTable,
        attachments
    );

    if (fs.existsSync(logPath)) {
        try { fs.unlinkSync(logPath); } catch (e) { }
    }
}
