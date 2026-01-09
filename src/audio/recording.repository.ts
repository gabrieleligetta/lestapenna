import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Recording {
  id: number;
  session_id: string;
  filename: string;
  filepath: string;
  user_id: string;
  timestamp: number;
  status: string;
  macro_location?: string;
  micro_location?: string;
  campaign_year?: number;
  transcription_text?: string;
}

@Injectable()
export class RecordingRepository {
  constructor(private readonly dbService: DatabaseService) {}

  create(sessionId: string, filename: string, filepath: string, userId: string, timestamp: number, macro?: string, micro?: string, year?: number): void {
    this.dbService.getDb().prepare(
      'INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, macro_location, micro_location, campaign_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sessionId, filename, filepath, userId, timestamp, macro, micro, year);
  }

  findBySession(sessionId: string): Recording[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM recordings WHERE session_id = ?'
    ).all(sessionId) as Recording[];
  }

  findByFilename(filename: string): Recording | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM recordings WHERE filename = ?'
    ).get(filename) as Recording | undefined;
  }

  updateStatus(filename: string, status: string): void {
    this.dbService.getDb().prepare(
      'UPDATE recordings SET status = ? WHERE filename = ?'
    ).run(status, filename);
  }

  updateTranscription(filename: string, text: string, status: string): void {
    this.dbService.getDb().prepare(
      'UPDATE recordings SET status = ?, transcription_text = ? WHERE filename = ?'
    ).run(status, text, filename);
  }

  getTranscripts(sessionId: string): Recording[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM recordings WHERE session_id = ? AND transcription_text IS NOT NULL ORDER BY timestamp ASC'
    ).all(sessionId) as Recording[];
  }

  getUnprocessed(): Recording[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM recordings WHERE status = \'PENDING\' OR status = \'SECURED\''
    ).all() as Recording[];
  }

  resetUnfinished(sessionId: string): Recording[] {
    this.dbService.getDb().prepare(
        'UPDATE recordings SET status = \'SECURED\' WHERE session_id = ? AND (status = \'PROCESSING\' OR status = \'ERROR\')'
    ).run(sessionId);
    
    return this.dbService.getDb().prepare(
        'SELECT * FROM recordings WHERE session_id = ? AND status = \'SECURED\''
    ).all(sessionId) as Recording[];
  }

  deleteBySession(sessionId: string): void {
    this.dbService.getDb().prepare(
      'DELETE FROM recordings WHERE session_id = ?'
    ).run(sessionId);
  }
}
