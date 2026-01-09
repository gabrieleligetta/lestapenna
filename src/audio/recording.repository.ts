import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Recording } from '../database/types';

@Injectable()
export class RecordingRepository {
  constructor(private readonly dbService: DatabaseService) {}

  create(sessionId: string, filename: string, filepath: string, userId: string, timestamp: number, macro?: string, micro?: string, year?: number): void {
    this.dbService.getDb().prepare(
      'INSERT INTO recordings (session_id, filename, filepath, user_id, timestamp, macro_location, micro_location, year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
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

  updateStatus(filename: string, status: string, transcription?: string | null, errorMessage?: string | null): void {
    let query = 'UPDATE recordings SET status = ?';
    const params: any[] = [status];

    if (transcription !== undefined && transcription !== null) {
        query += ', transcription_text = ?';
        params.push(transcription);
    }

    if (errorMessage !== undefined && errorMessage !== null) {
        query += ', error_log = ?'; // FIX: error_message -> error_log
        params.push(errorMessage);
    }

    query += ' WHERE filename = ?';
    params.push(filename);

    this.dbService.getDb().prepare(query).run(...params);
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
