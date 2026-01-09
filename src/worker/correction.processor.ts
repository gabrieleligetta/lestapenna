import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LoggerService } from '../logger/logger.service';
import { AiService } from '../ai/ai.service';
import { RecordingRepository } from '../audio/recording.repository';
import { QueueService } from '../queue/queue.service';
import { SessionService } from '../session/session.service';
import { LoreRepository } from '../lore/lore.repository';

@Processor('correction-processing')
export class CorrectionProcessor extends WorkerHost {
  constructor(
    private readonly logger: LoggerService,
    private readonly aiService: AiService,
    private readonly recordingRepo: RecordingRepository,
    private readonly queueService: QueueService,
    private readonly sessionService: SessionService,
    private readonly loreRepo: LoreRepository
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    // --- 1. GESTIONE SENTINELLA ---
    if (job.data.isSentinel) {
        const { sessionId, channelId, guildId } = job.data;
        
        this.logger.log(`[Correttore] 🛑 Sentinel Job ricevuto. Correzioni terminate per ${sessionId}.`);
        this.logger.log(`[Correttore] 🔗 Avvio generazione Riassunto Finale (su dati corretti).`);

        // ORA i dati nel DB sono corretti. Lanciamo il riassunto.
        await this.queueService.addSummaryJob({
            sessionId,
            channelId,
            guildId
        });

        return { status: 'sentinel_triggered_summary' };
    }
    // ------------------------------

    // --- 2. ELABORAZIONE CORREZIONE NORMALE ---
    // Aggiungi channelId, guildId, triggerSummary al destructuring
    const { sessionId, fileName, segments, campaignId, triggerSummary, channelId, guildId } = job.data;
    this.logger.log(`[Correttore] 🧠 Analisi AI per ${fileName}...`);

    try {
        // 1. Correzione AI + Analisi Contesto
        const aiResult = await this.aiService.correctTranscription(segments, campaignId);
        
        // 2. --- FIX AGGIORNAMENTI LIVE ---
        // Se l'AI ha rilevato un cambio luogo, aggiorniamo SUBITO la sessione
        if (aiResult.detected_location && campaignId) {
            const { macro, micro } = aiResult.detected_location;
            
            // Recupera location attuale per vedere se è cambiata
            const currentLoc = this.sessionService.getLocation(job.data.guildId); // Assumi metodo esistente o usa Repo
            
            if (macro !== currentLoc?.macro || micro !== currentLoc?.micro) {
                this.logger.log(`[Live] 🌍 Spostamento rilevato: ${macro} - ${micro}`);
                // Aggiorna DB Sessioni (Live Update)
                this.sessionService.updateLocation(campaignId, sessionId, macro, micro);
            }
            
            // Aggiorna Atlante Live (Opzionale, come da Legacy)
            if (aiResult.atlas_update && macro && micro) {
                 this.loreRepo.upsertAtlasEntry(campaignId, macro, micro, aiResult.atlas_update);
            }
        }
        
        // Aggiorna NPC Live (Opzionale)
        if (aiResult.npc_updates && campaignId) {
            for (const npc of aiResult.npc_updates) {
                // FIX: Metodo corretto upsertNpc e ordine parametri (role prima di description)
                this.loreRepo.upsertNpc(campaignId, npc.name, npc.role, npc.description, npc.status);
            }
        }
        // ---------------------------------

        // 3. Salvataggio
        const jsonStr = JSON.stringify(aiResult.segments);
        // Salviamo anche macro/micro nel record audio per riferimento futuro
        const finalMacro = aiResult.detected_location?.macro || null;
        const finalMicro = aiResult.detected_location?.micro || null;
        
        this.recordingRepo.updateStatus(fileName, 'PROCESSED', jsonStr, null, finalMacro, finalMicro);
        
        this.logger.log(`[Correttore] ✅ Completato ${fileName}.`);

        // --- 4. CHAINING RIASSUNTO ---
        // Se richiesto dalla fase precedente, attiviamo il riassunto ORA che i dati sono corretti.
        if (triggerSummary && channelId && guildId) {
            this.logger.log(`[Correttore] 🔗 Dati corretti salvati. Attivo generazione riassunto per ${sessionId}...`);
            await this.queueService.addSummaryJob({
                sessionId,
                channelId,
                guildId
            });
        }
        // -----------------------------

        return { status: 'ok', segmentsCount: aiResult.segments.length };

    } catch (e: any) {
        this.logger.error(`[Correttore] ❌ Errore: ${e.message}`);
        throw e;
    }
  }
}
