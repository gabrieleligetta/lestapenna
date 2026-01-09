import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LoggerService } from '../logger/logger.service';
import { KnowledgeRepository } from './knowledge.repository';
import { RecordingRepository } from '../audio/recording.repository';
import { SessionRepository } from '../session/session.repository';
import { CharacterRepository } from '../character/character.repository';

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly knowledgeRepo: KnowledgeRepository,
    private readonly recordingRepo: RecordingRepository,
    private readonly sessionRepo: SessionRepository,
    private readonly characterRepo: CharacterRepository
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
  }

  async generateSummary(sessionId: string, tone: string = 'DM'): Promise<any> {
    // Recupera trascrizioni
    const transcripts = this.recordingRepo.getTranscripts(sessionId);

    if (transcripts.length === 0) {
      throw new Error("Nessuna trascrizione disponibile per questa sessione.");
    }

    // Costruisci il testo completo
    let fullText = "";
    for (const t of transcripts) {
      const char = this.getCharacterName(t.user_id, sessionId);
      try {
        const segments = JSON.parse(t.transcription_text || '[]');
        const text = segments.map((s: any) => s.text).join(' ');
        if (text.trim()) fullText += `${char}: ${text}\n`;
      } catch {
        if (t.transcription_text?.trim()) fullText += `${char}: ${t.transcription_text}\n`;
      }
    }

    // Prompt Engineering (Semplificato per brevità, ma espandibile)
    const prompt = `
      Sei un Bardo esperto che narra le gesta di un gruppo di avventurieri D&D.
      Analizza la seguente trascrizione di una sessione di gioco e genera un riassunto strutturato.
      
      TONO RICHIESTO: ${tone} (Epico, Misterioso, Divertente, o Tecnico/DM).
      
      Output richiesto in JSON:
      {
        "title": "Titolo evocativo della sessione",
        "summary": "Riassunto narrativo dettagliato (max 4000 caratteri)",
        "narrative": "Un breve racconto in prosa (stile romanzo) degli eventi salienti",
        "loot": ["Lista oggetti trovati"],
        "loot_removed": ["Lista oggetti persi/usati"],
        "quests": ["Nuove missioni o aggiornamenti"],
        "character_growth": [{"name": "NomePG", "event": "Descrizione evento psicologico/fisico", "type": "TRAUMA/EPIPHANY/POWERUP"}],
        "npc_events": [{"name": "NomeNPC", "event": "Cosa è successo all'NPC", "type": "DEATH/BETRAYAL/ALLIANCE"}],
        "world_events": [{"event": "Evento che cambia il mondo", "type": "WAR/POLITICS/MAGIC"}]
      }

      TRASCRIZIONE:
      ${fullText.substring(0, 50000)} 
    `;

    const response = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: "Sei un assistente utile e creativo." }, { role: "user", content: prompt }],
      response_format: { type: "json_object" }
    });

    const content = response.choices[0].message.content;
    if (!content) throw new Error("Risposta vuota da OpenAI");

    return JSON.parse(content);
  }

  private getCharacterName(userId: string, sessionId: string): string {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return "Sconosciuto";
    
    const char = this.characterRepo.findByUser(userId, session.campaign_id);
    return char ? char.character_name : "Giocatore";
  }

  // --- RAG & MEMORY ---
  
  async ingestSessionRaw(sessionId: string) {
    const transcripts = this.recordingRepo.getTranscripts(sessionId);

    const fullText = transcripts.map(t => {
        try { return JSON.parse(t.transcription_text || '[]').map((s: any) => s.text).join(' '); }
        catch { return t.transcription_text || ''; }
    }).join('\n');

    if (!fullText.trim()) return;

    const embedding = await this.createEmbedding(fullText.substring(0, 8000)); // Limitiamo per ora
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return;

    this.knowledgeRepo.addFragment(session.campaign_id, sessionId, fullText, embedding);
    
    this.logger.log(`[AI] Ingestione completata per sessione ${sessionId}`);
  }

  async createEmbedding(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
    });
    return response.data[0].embedding;
  }
}
