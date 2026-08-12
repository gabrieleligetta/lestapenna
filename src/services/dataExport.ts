import { db } from '../db';
import { logger } from '../utils/logger';
import { sessionIdsForGuild } from './dataErasure';

const log = logger('DataExport');

/**
 * Giving a person back what we hold about them.
 *
 * Worth being precise about why this exists, because Discord's own documents do
 * not ask for it. The Developer Terms §5(b) require an accessible way to have
 * API Data «modified and deleted», and §5(a) requires the privacy policy to
 * explain how to request «deletion» — the words *download*, *export*, *copy*
 * and *portability* appear nowhere in either document.
 *
 * It comes in through the first sentence of §5(a) instead: «you will comply with
 * all applicable privacy laws and regulations, including the GDPR». GDPR
 * art. 15(3) requires providing a copy of the personal data being processed and
 * art. 20 requires it in a structured, machine-readable format. So the
 * obligation is real, just second-hand.
 *
 * The scoping is deliberately the same as {@link ./dataErasure}: whatever
 * `eraseUserData` would delete is what this returns. If the two ever disagreed,
 * one of them would be lying — either we delete something we never admitted to
 * holding, or we admit to holding something we cannot delete.
 *
 * What is **not** here: the recap, the chronicle and the campaign's world. They
 * are the table's collective work rather than one member's personal data, and
 * handing one player the full archive under the banner of a subject access
 * request would disclose everyone else's contribution along with it.
 */

export interface UserDataExport {
    exportedAt: string;
    guildId: string;
    userId: string;
    /** What this file deliberately leaves out, stated in the file itself. */
    notIncluded: string[];
    characters: unknown[];
    campaignMemberships: unknown[];
    recordings: unknown[];
    sessionNotes: unknown[];
    askConversations: unknown[];
    chatHistory: unknown[];
    uploadedMedia: unknown[];
    legalAcceptances: unknown[];
}

export function exportUserData(guildId: string, userId: string): UserDataExport {
    const sessionIds = sessionIdsForGuild(guildId);
    const placeholders = sessionIds.map(() => '?').join(',');

    // The transcript columns are the point of the whole export: they are this
    // person's own speech, and everything else in the archive is derived from
    // them. `filepath` is left out on purpose — a path on the operator's disk
    // says nothing to the person reading it and only advertises the layout.
    const recordings = sessionIds.length === 0 ? [] : db.prepare(
        `SELECT r.session_id, r.filename, r.timestamp, r.status,
                r.transcription_text, r.raw_transcription_text,
                r.character_name_snapshot, r.macro_location, r.micro_location,
                s.session_number, s.title
           FROM recordings r
           LEFT JOIN sessions s ON s.session_id = r.session_id
          WHERE r.user_id = ? AND r.session_id IN (${placeholders})
          ORDER BY r.timestamp`,
    ).all(userId, ...sessionIds);

    const sessionNotes = sessionIds.length === 0 ? [] : db.prepare(
        `SELECT session_id, content, timestamp, macro_location, micro_location
           FROM session_notes
          WHERE user_id = ? AND session_id IN (${placeholders})
          ORDER BY timestamp`,
    ).all(userId, ...sessionIds);

    const characters = db.prepare(
        `SELECT c.campaign_id, ca.name AS campaign_name, c.character_name, c.race, c.class,
                c.description, c.foundation_description, c.manual_description, c.email,
                c.alignment_moral, c.alignment_ethical
           FROM characters c
           LEFT JOIN campaigns ca ON ca.id = c.campaign_id
          WHERE c.user_id = ? AND c.campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)`,
    ).all(userId, guildId);

    const campaignMemberships = db.prepare(
        `SELECT m.campaign_id, ca.name AS campaign_name, m.role, m.added_at
           FROM campaign_members m
           LEFT JOIN campaigns ca ON ca.id = m.campaign_id
          WHERE m.user_id = ? AND m.campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)`,
    ).all(userId, guildId);

    const askConversations = db.prepare(
        `SELECT c.id, c.campaign_id, c.title, c.created_at,
                (SELECT json_group_array(json_object('role', m.role, 'content', m.content, 'created_at', m.created_at))
                   FROM ask_messages m WHERE m.conversation_id = c.id) AS messages
           FROM ask_conversations c
          WHERE c.user_id = ? AND c.campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)
          ORDER BY c.created_at`,
    ).all(userId, guildId);

    // Rows written before chat_history was given a scope carry NULL in both
    // columns: they cannot be attributed to anyone, so they are not returned.
    const chatHistory = db.prepare(
        `SELECT channel_id, role, content, timestamp
           FROM chat_history WHERE user_id = ? AND guild_id = ? ORDER BY timestamp`,
    ).all(userId, guildId);

    const uploadedMedia = db.prepare(
        `SELECT id, campaign_id, entity_type, entity_key, alt_text, created_at
           FROM entity_media
          WHERE uploaded_by = ? AND campaign_id IN (SELECT id FROM campaigns WHERE guild_id = ?)`,
    ).all(userId, guildId);

    const legalAcceptances = db.prepare(
        'SELECT document, version, accepted_at FROM legal_acceptances WHERE discord_user_id = ? ORDER BY accepted_at',
    ).all(userId);

    log.info(`Exported data for user ${userId} on guild ${guildId}: ${recordings.length} recording(s)`);

    return {
        exportedAt: new Date().toISOString(),
        guildId,
        userId,
        notIncluded: [
            'Session recaps, the campaign chronicle and the world state (NPCs, quests, locations): they are the whole table\'s work, not one member\'s personal data.',
            'Audio files: ask the server administrator for those — they are large, and this export is a document.',
            'Other members\' transcripts, notes and conversations.',
        ],
        characters,
        campaignMemberships,
        recordings,
        sessionNotes,
        askConversations,
        chatHistory,
        uploadedMedia,
        legalAcceptances,
    };
}
