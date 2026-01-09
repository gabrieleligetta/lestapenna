import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Session {
  session_id: string;
  guild_id: string;
  campaign_id: number;
  start_time: number;
  end_time?: number;
  title?: string;
  summary?: string;
  session_number?: number;
}

export interface SessionNote {
  id: number;
  session_id: string;
  user_id: string;
  note: string;
  timestamp: number;
}

@Injectable()
export class SessionRepository {
  constructor(private readonly dbService: DatabaseService) {}

  create(sessionId: string, guildId: string, campaignId: number, startTime: number): void {
    this.dbService.getDb().prepare(
      'INSERT INTO sessions (session_id, guild_id, campaign_id, start_time) VALUES (?, ?, ?, ?)'
    ).run(sessionId, guildId, campaignId, startTime);
  }

  findById(sessionId: string): Session | undefined {
    return this.dbService.getDb().prepare(
      'SELECT * FROM sessions WHERE session_id = ?'
    ).get(sessionId) as Session | undefined;
  }

  findByCampaign(campaignId: number, limit: number = 10): Session[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM sessions WHERE campaign_id = ? ORDER BY start_time DESC LIMIT ?'
    ).all(campaignId, limit) as Session[];
  }

  findByTimestamp(timestamp: number): Session | undefined {
      // Cerca una sessione che era attiva durante quel timestamp
      // start_time <= timestamp AND (end_time IS NULL OR end_time >= timestamp)
      return this.dbService.getDb().prepare(
          'SELECT * FROM sessions WHERE start_time <= ? AND (end_time IS NULL OR end_time >= ?) ORDER BY start_time DESC LIMIT 1'
      ).get(timestamp, timestamp) as Session | undefined;
  }

  updateEndTime(sessionId: string, endTime: number): void {
    this.dbService.getDb().prepare(
      'UPDATE sessions SET end_time = ? WHERE session_id = ?'
    ).run(endTime, sessionId);
  }

  updateStartTime(sessionId: string, startTime: number): void {
    this.dbService.getDb().prepare(
      'UPDATE sessions SET start_time = ? WHERE session_id = ? AND start_time IS NULL'
    ).run(startTime, sessionId);
  }

  updateSessionNumber(sessionId: string, number: number): void {
    this.dbService.getDb().prepare(
      'UPDATE sessions SET session_number = ? WHERE session_id = ?'
    ).run(number, sessionId);
  }

  updateTitleAndSummary(sessionId: string, title: string, summary: string): void {
    this.dbService.getDb().prepare(
      'UPDATE sessions SET title = ?, summary = ? WHERE session_id = ?'
    ).run(title, summary, sessionId);
  }

  updateSessionTitle(sessionId: string, title: string): void {
    this.dbService.getDb().prepare(
      'UPDATE sessions SET title = ? WHERE session_id = ?'
    ).run(title, sessionId);
  }

  addNote(sessionId: string, userId: string, note: string): void {
    this.dbService.getDb().prepare(
      'INSERT INTO session_notes (session_id, user_id, note, timestamp) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, note, Date.now());
  }

  getNotes(sessionId: string): SessionNote[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM session_notes WHERE session_id = ? ORDER BY timestamp ASC'
    ).all(sessionId) as SessionNote[];
  }

  // --- Location History ---
  addLocationHistory(campaignId: number, sessionId: string | null, macro: string | null, micro: string | null): void {
    const now = Date.now();
    const dateStr = new Date().toLocaleDateString('it-IT');
    this.dbService.getDb().prepare(
      'INSERT INTO location_history (campaign_id, session_id, macro_location, micro_location, timestamp, session_date) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(campaignId, sessionId, macro, micro, now, dateStr);
  }

  getLastLocation(guildId: string): { macro: string, micro: string } | undefined {
    // Nota: location_history ora usa campaign_id, non guild_id direttamente.
    // Dobbiamo fare una JOIN con campaigns
    return this.dbService.getDb().prepare(`
      SELECT lh.macro_location as macro, lh.micro_location as micro 
      FROM location_history lh
      JOIN campaigns c ON lh.campaign_id = c.id
      WHERE c.guild_id = ? AND c.is_active = 1
      ORDER BY lh.timestamp DESC LIMIT 1
    `).get(guildId) as { macro: string, micro: string } | undefined;
  }

  getLocationHistory(sessionId: string): any[] {
    return this.dbService.getDb().prepare(
      'SELECT * FROM location_history WHERE session_id = ?'
    ).all(sessionId) as any[];
  }

  delete(sessionId: string): void {
    this.dbService.getDb().prepare(
      'DELETE FROM sessions WHERE session_id = ?'
    ).run(sessionId);
  }
}
