import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface KnowledgeFragment {
  id: number;
  campaign_id: string;
  session_id: string;
  content: string;
  embedding: Buffer;
  tags?: string;
  created_at: number;
}

@Injectable()
export class KnowledgeRepository {
  constructor(private readonly dbService: DatabaseService) {}

  addFragment(campaignId: string, sessionId: string, content: string, embedding: number[]): void {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    this.dbService.getDb().prepare(
      'INSERT INTO knowledge_fragments (campaign_id, session_id, content, embedding, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(campaignId, sessionId, content, buffer, Date.now());
  }

  deleteBySession(sessionId: string): void {
    this.dbService.getDb().prepare(
      'DELETE FROM knowledge_fragments WHERE session_id = ?'
    ).run(sessionId);
  }
}
