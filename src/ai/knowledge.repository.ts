import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface KnowledgeFragment {
  id: number;
  campaign_id: number;
  session_id: string;
  content: string;
  embedding: Buffer;
  tags?: string;
  created_at: number;
  macro_location?: string;
  micro_location?: string;
  timestamp?: number;
  embedding_model?: string;
  associated_npcs?: string;
}

@Injectable()
export class KnowledgeRepository {
  constructor(private readonly dbService: DatabaseService) {}

  addFragment(
      campaignId: number, 
      sessionId: string, 
      content: string, 
      embedding: number[], 
      timestamp: number = 0,
      macro?: string,
      micro?: string,
      tags: string[] = [],
      model: string = 'openai',
      associatedNpcs: string[] = []
  ): void {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    const tagsStr = tags.length > 0 ? tags.join(',') : null;
    const npcsStr = associatedNpcs.length > 0 ? associatedNpcs.join(',') : null;
    
    this.dbService.getDb().prepare(
      `INSERT INTO knowledge_fragments 
      (campaign_id, session_id, content, embedding, tags, created_at, macro_location, micro_location, timestamp, embedding_model, associated_npcs) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(campaignId, sessionId, content, buffer, tagsStr, Date.now(), macro, micro, timestamp, model, npcsStr);
  }

  deleteBySession(sessionId: string, model?: string): void {
    if (model) {
        this.dbService.getDb().prepare(
            'DELETE FROM knowledge_fragments WHERE session_id = ? AND embedding_model = ?'
        ).run(sessionId, model);
    } else {
        this.dbService.getDb().prepare(
            'DELETE FROM knowledge_fragments WHERE session_id = ?'
        ).run(sessionId);
    }
  }

  search(campaignId: number, queryEmbedding: number[], model: string, limit: number = 5, currentMacro?: string, currentMicro?: string, mentionedNpcs: string[] = []): string[] {
    const fragments = this.dbService.getDb().prepare(
        'SELECT * FROM knowledge_fragments WHERE campaign_id = ? AND embedding_model = ?'
    ).all(campaignId, model) as KnowledgeFragment[];

    if (fragments.length === 0) return [];

    // Filtro Investigativo (NPC)
    let candidates = fragments;
    if (mentionedNpcs.length > 0) {
        const filtered = fragments.filter(f => {
            if (!f.associated_npcs) return false;
            const fragmentNpcs = f.associated_npcs.split(',').map(n => n.toLowerCase());
            return mentionedNpcs.some(mn => fragmentNpcs.includes(mn.toLowerCase()));
        });
        if (filtered.length > 0) candidates = filtered;
    }

    // Scoring & Boosting
    const scored = candidates.map((f, index) => {
        const vector = new Float32Array(f.embedding.buffer);
        let score = this.cosineSimilarity(queryEmbedding, vector);

        // Boost Contestuale
        if (currentMacro && f.macro_location === currentMacro) score += 0.05;
        if (currentMicro && f.micro_location === currentMicro) score += 0.10;

        return { ...f, score, originalIndex: index };
    });

    scored.sort((a, b) => b.score - a.score);

    // Selezione Top K + Espansione Temporale
    const topK = scored.slice(0, limit);
    const finalIndices = new Set<number>();

    topK.forEach(item => {
        finalIndices.add(item.originalIndex);
        // Espansione temporale semplificata (richiederebbe ordinamento globale per timestamp per essere accurata come legacy)
        // Qui ci limitiamo a restituire i top match per ora.
    });

    return topK.map(k => k.content);
  }

  private cosineSimilarity(vecA: number[], vecB: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
