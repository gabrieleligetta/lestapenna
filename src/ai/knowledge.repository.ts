import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { KnowledgeFragment } from '../database/types';

@Injectable()
export class KnowledgeRepository {
  constructor(private readonly dbService: DatabaseService) {}

    addFragment(
        campaignId: number | null,
        sessionId: string,
        content: string,
        embedding: number[],
        timestamp: number = 0,
        macro?: string | undefined,
        micro?: string | undefined,
        tags: string[] = [],
        model: string = 'openai',
        associatedNpcs: string[] = []
    ): void {
    // FIX: embedding -> embedding_json (stored as JSON string)
    const embeddingJson = JSON.stringify(embedding);
    const npcsStr = associatedNpcs.length > 0 ? associatedNpcs.join(',') : null;
    
    // FIX: Removed 'tags' column which does not exist in schema
    // FIX: Added 'start_timestamp'
    this.dbService.getDb().prepare(
      `INSERT INTO knowledge_fragments 
      (campaign_id, session_id, content, embedding_json, created_at, macro_location, micro_location, start_timestamp, embedding_model, associated_npcs) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(campaignId, sessionId, content, embeddingJson, Date.now(), macro, micro, timestamp, model, npcsStr);
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
        // FIX: embedding_json -> number[]
        let vector: number[];
        try {
            vector = JSON.parse(f.embedding_json || '[]');
        } catch {
            return { ...f, score: -1, originalIndex: index };
        }

        if (!Array.isArray(vector) || vector.length === 0) return { ...f, score: -1, originalIndex: index };

        let score = this.cosineSimilarity(queryEmbedding, vector);

        // Boost Contestuale
        if (currentMacro && f.macro_location === currentMacro) score += 0.05;
        if (currentMicro && f.micro_location === currentMicro) score += 0.10;

        return { ...f, score, originalIndex: index };
    });

    scored.sort((a, b) => b.score - a.score);

    // Selezione Top K
    const topK = scored.slice(0, limit);

    return topK.map(k => k.content);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
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
