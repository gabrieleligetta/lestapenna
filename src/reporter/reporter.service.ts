import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SessionMetrics } from '../monitor/monitor.service';
import { BackupService } from '../backup/backup.service';
import { LoggerService } from '../logger/logger.service';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { CampaignRepository } from '../campaign/campaign.repository';
import { SessionRepository } from '../session/session.repository';
import { LoreRepository } from '../lore/lore.repository';
import { RecordingRepository } from '../audio/recording.repository';

@Injectable()
export class ReporterService {
    private transporter: nodemailer.Transporter;
    private openai: OpenAI;

    constructor(
        private readonly configService: ConfigService,
        private readonly backupService: BackupService,
        private readonly logger: LoggerService,
        private readonly campaignRepo: CampaignRepository,
        private readonly sessionRepo: SessionRepository,
        private readonly loreRepo: LoreRepository,
        private readonly recordingRepo: RecordingRepository
    ) {
        this.transporter = nodemailer.createTransport({
            host: this.configService.get<string>('SMTP_HOST') || "smtp.porkbun.com",
            port: parseInt(this.configService.get<string>('SMTP_PORT') || "465"),
            secure: true,
            auth: {
                user: this.configService.get<string>('SMTP_USER'),
                pass: this.configService.get<string>('SMTP_PASS')
            }
        });

        const provider = this.configService.get<string>('AI_PROVIDER');
        this.openai = new OpenAI({
            baseURL: provider === 'ollama' ? (this.configService.get<string>('OLLAMA_BASE_URL') || 'http://host.docker.internal:11434/v1') : undefined,
            apiKey: provider === 'ollama' ? 'ollama' : this.configService.get<string>('OPENAI_API_KEY'),
            project: provider === 'ollama' ? undefined : this.configService.get<string>('OPENAI_PROJECT_ID'),
        });
    }

    async sendTestEmail(recipient: string): Promise<boolean> {
        try {
            await this.transporter.sendMail({
                from: `"${this.configService.get('SMTP_FROM_NAME') || 'Lestapenna'}" <${this.configService.get('SMTP_USER')}>`,
                to: recipient,
                subject: `[Lestapenna] Test Email`,
                html: `<h1>Test Email</h1><p>Se leggi questo messaggio, il sistema di notifica email funziona correttamente.</p>`
            });
            this.logger.log(`[Reporter] 📧 Email di test inviata a ${recipient}`);
            return true;
        } catch (e) {
            this.logger.error("[Reporter] ❌ Errore invio email di test:", e);
            return false;
        }
    }

    async sendTechnicalReport(metrics: SessionMetrics) {
        this.logger.log(`[Reporter] 📝 Generazione report tecnico per sessione ${metrics.sessionId}...`);

        const durationMin = metrics.startTime && metrics.endTime ? (metrics.endTime - metrics.startTime) / 60000 : 0;
        const avgCpu = metrics.resourceUsage.cpuSamples.length > 0 
            ? metrics.resourceUsage.cpuSamples.reduce((a, b) => a + b, 0) / metrics.resourceUsage.cpuSamples.length 
            : 0;
        const maxRam = metrics.resourceUsage.ramSamplesMB.length > 0 
            ? Math.max(...metrics.resourceUsage.ramSamplesMB) 
            : 0;

        const dbStartMB = (metrics.dbStartSizeBytes || 0) / (1024 * 1024);
        const dbEndMB = (metrics.dbEndSizeBytes || 0) / (1024 * 1024);
        const dbGrowthMB = dbEndMB - dbStartMB;

        const diskTotal = metrics.diskUsage?.totalGB || 0;
        const diskFree = metrics.diskUsage?.freeGB || 0;
        const diskUsedPct = metrics.diskUsage?.usedPercent || 0;

        const statsJson = JSON.stringify(metrics, null, 2);
        
        // Analisi AI
        let emailBody = "";
        try {
            const prompt = `
            Sei un ingegnere DevOps che analizza i log di un bot Discord ("Lestapenna").
            Ecco le metriche della sessione:
            - ID Sessione: ${metrics.sessionId}
            - Durata: ${durationMin.toFixed(2)} min
            - File Audio: ${metrics.totalFiles}
            - Durata Audio Totale: ${metrics.totalAudioDurationSec} sec
            - Tempo Trascrizione Totale: ${(metrics.transcriptionTimeMs / 1000).toFixed(2)} sec
            - Token AI Utilizzati: ${metrics.totalTokensUsed}
            - CPU Media: ${avgCpu.toFixed(1)}%
            - RAM Max: ${maxRam} MB
            - DB Growth: ${dbGrowthMB.toFixed(3)} MB
            - Disk Used: ${diskUsedPct}%
            - Errori: ${metrics.errors.length}

            Analizza brevemente la stabilità del sistema.
            `;

            const provider = this.configService.get<string>('AI_PROVIDER');
            const modelToUse = provider === 'ollama' 
                ? (this.configService.get<string>('OLLAMA_MODEL') || "llama3.2") 
                : (this.configService.get<string>('OPEN_AI_MODEL_MINI') || "gpt-4o-mini");

            const response = await this.openai.chat.completions.create({
                model: modelToUse,
                messages: [{ role: "user", content: prompt }]
            });
            emailBody = response.choices[0].message.content || "Report generico.";
        } catch (e: any) {
            emailBody = `Impossibile generare analisi AI: ${e.message}`;
        }

        const htmlTable = `
        <h2>📊 Session Metrics Report</h2>
        <p><strong>Session ID:</strong> ${metrics.sessionId}</p>
        <p><strong>Analysis:</strong><br/>${emailBody.replace(/\n/g, '<br/>')}</p>
        <pre>${statsJson}</pre>
        `;

        // Salvataggio e Upload Log
        const logFileName = `report-${metrics.sessionId}.json`;
        const logPath = path.join(process.cwd(), 'recordings', logFileName);
        fs.writeFileSync(logPath, statsJson);

        try {
            await this.backupService.uploadToOracle(logPath, logFileName, undefined, `logs/${logFileName}`);
        } catch (e) {
            this.logger.error("[Reporter] ❌ Errore upload metriche:", e);
        }

        const recipient = this.configService.get<string>('REPORT_RECIPIENT');
        if (!recipient) return;

        try {
            await this.transporter.sendMail({
                from: `"${this.configService.get('SMTP_FROM_NAME') || 'Lestapenna'}" <${this.configService.get('SMTP_USER')}>`,
                to: recipient,
                subject: `[Lestapenna] Tech Report ${metrics.sessionId} - ${metrics.errors.length > 0 ? '⚠️ ALERT' : '✅ OK'}`,
                html: htmlTable,
                attachments: [{ filename: logFileName, content: statsJson }]
            });
            this.logger.log(`[Reporter] 📧 Email tecnica inviata a ${recipient}`);
        } catch (e) {
            this.logger.error("[Reporter] ❌ Errore invio email tecnica:", e);
        }

        if (fs.existsSync(logPath)) try { fs.unlinkSync(logPath); } catch {}
    }

    async sendSessionRecap(sessionId: string, campaignId: number | null, summaryText: string, lootGained: string[] = [], lootLost: string[] = [], narrative?: string) {
        const campaign = this.campaignRepo.findById(campaignId);
        const campaignName = campaign ? campaign.name : "Sconosciuta";

        // Recupera dati DB tramite Repository
        const travels = this.sessionRepo.getLocationHistory(sessionId);
        const npcs = this.loreRepo.findEncounteredNpcs(sessionId);
        const session = this.sessionRepo.findById(sessionId);
        
        const sessionDate = session && session.start_time 
            ? new Date(session.start_time).toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
            : new Date().toLocaleDateString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Genera Link
        let audioUrl = "";
        try {
            audioUrl = await this.backupService.getPresignedUrl(`MASTER-${sessionId}.mp3`, sessionId, 604800) || "";
        } catch {}

        // Genera Transcript TXT per email
        const transcriptUrl = await this.generateAndUploadTranscript(sessionId);

        let downloadLinksHtml = "";
        if (audioUrl || transcriptUrl) {
            downloadLinksHtml = `
            <div style="margin: 20px 0; padding: 15px; background-color: #e8f6f3; border: 1px solid #1abc9c; border-radius: 5px; text-align: center;">
                <p style="margin: 0 0 10px 0; font-weight: bold; color: #16a085;">📥 Download Materiali Sessione</p>
                <div style="display: flex; justify-content: center; gap: 10px; flex-wrap: wrap;">
                    ${audioUrl ? `<a href="${audioUrl}" style="background-color: #1abc9c; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">🎧 Scarica Podcast (MP3)</a>` : ''}
                    ${transcriptUrl ? `<a href="${transcriptUrl}" style="background-color: #3498db; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">📜 Scarica Trascrizione (TXT)</a>` : ''}
                </div>
                <p style="margin: 10px 0 0 0; font-size: 12px; color: #7f8c8d;">Link validi per 7 giorni</p>
            </div>
            `;
        }

        let htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
            <h1 style="color: #d35400;">📜 Report Sessione: ${campaignName}</h1>
            <p style="font-style: italic; margin-bottom: 5px;">ID Sessione: ${sessionId}</p>
            <p style="font-weight: bold; margin-top: 0;">📅 Data: ${sessionDate}</p>
            <hr style="border: 1px solid #d35400;">
            ${downloadLinksHtml}
        `;

        if (narrative && narrative.length > 10) {
            htmlContent += `
            <h2>📖 Racconto</h2>
            <div style="background-color: #fff8e1; padding: 15px; border-radius: 5px; white-space: pre-line; border-left: 4px solid #d35400;">
                ${narrative}
            </div>`;
        }

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
                            const time = new Date(t.timestamp!).toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'});
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
        </div>`;

        const recipient = this.configService.get<string>('REPORT_RECIPIENT');
        if (!recipient) return;

        try {
            await this.transporter.sendMail({
                from: `"${this.configService.get('SMTP_FROM_NAME') || 'Lestapenna'}" <${this.configService.get('SMTP_USER')}>`,
                to: recipient,
                subject: `[D&D Report] ${campaignName} - ${sessionDate}`,
                html: htmlContent
            });
            this.logger.log(`[Reporter] 📧 Email recap inviata a ${recipient}`);
        } catch (e) {
            this.logger.error("[Reporter] ❌ Errore invio email recap:", e);
        }
    }

    private async generateAndUploadTranscript(sessionId: string): Promise<string | null> {
        try {
            const transcripts = this.recordingRepo.getTranscripts(sessionId);

            if (!transcripts || transcripts.length === 0) return null;

            const session = this.sessionRepo.findById(sessionId);
            const startTime = session?.start_time || 0;

            const formattedText = transcripts.map(t => {
                let text = "";
                try {
                    const segments = JSON.parse(t.transcription_text || "[]");
                    if (Array.isArray(segments)) {
                        text = segments.map(s => {
                            if (typeof s.start !== 'number' || !s.text) return "";
                            const absTime = t.timestamp! + (s.start * 1000);
                            const mins = Math.floor((absTime - startTime) / 60000);
                            const secs = Math.floor(((absTime - startTime) % 60000) / 1000);
                            return `[${mins}:${secs.toString().padStart(2, '0')}] ${s.text}`;
                        }).filter(line => line !== "").join('\n');
                    } else {
                        text = t.transcription_text || "";
                    }
                } catch (e) {
                    text = t.transcription_text || "";
                }
                // Recupera nome personaggio se possibile (qui semplificato, si potrebbe fare join con users/characters)
                const charName = t.user_id || 'Sconosciuto'; 
                return `--- ${charName} (File: ${new Date(t.timestamp!).toLocaleTimeString()}) ---\n${text}\n`;
            }).join('\n');

            const fileName = `transcript-${sessionId}.txt`;
            const recordingsDir = path.join(process.cwd(), 'recordings');
            if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
            
            const filePath = path.join(recordingsDir, fileName);
            fs.writeFileSync(filePath, formattedText);

            const customKey = `recordings/${sessionId}/transcript/${fileName}`;
            await this.backupService.uploadToOracle(filePath, fileName, sessionId, customKey);
            
            try { fs.unlinkSync(filePath); } catch (e) {}

            // URL valido per 7 giorni
            return await this.backupService.getPresignedUrl(fileName, sessionId, 604800);
        } catch (e) {
            this.logger.error(`[Reporter] ❌ Errore generazione transcript per email:`, e);
            return null;
        }
    }
}
