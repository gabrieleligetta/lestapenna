/**
 * Session State — Redis-backed session tracking for multi-guild support
 *
 * Manages active sessions per guild via Redis (crash-safe).
 *
 * NOTE: The old "recording counter + global queue pause" has been REMOVED.
 * It paused the audio queue for ALL guilds when ANY guild was recording,
 * which blocked multi-tenancy. The queue now runs continuously.
 * incrementRecordingCount/decrementRecordingCount are kept as no-ops
 * for backward compatibility during migration.
 */

import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger('SessionState');

// --- REDIS CLIENT ---
const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null, // Required by BullMQ compatibility
    lazyConnect: true,
});

// Connect (non-blocking, reconnects automatically)
redis.connect().catch((err) => {
    log.error('Redis connection error', err);
});

// --- REDIS KEYS ---
const SESSION_KEY_PREFIX = 'lp:session:'; // lp:session:<guildId> → sessionId

// ============================================
// SESSION MANAGEMENT
// ============================================

/**
 * Get the active session ID for a guild.
 * Returns undefined if no active session.
 */
export async function getActiveSession(guildId: string): Promise<string | undefined> {
    const value = await redis.get(`${SESSION_KEY_PREFIX}${guildId}`);
    return value || undefined;
}

/**
 * Set the active session for a guild.
 */
export async function setActiveSession(guildId: string, sessionId: string): Promise<void> {
    await redis.set(`${SESSION_KEY_PREFIX}${guildId}`, sessionId);
}

/**
 * Delete the active session for a guild.
 */
export async function deleteActiveSession(guildId: string): Promise<void> {
    await redis.del(`${SESSION_KEY_PREFIX}${guildId}`);
}

/**
 * Check if a guild has an active session.
 */
export async function hasActiveSession(guildId: string): Promise<boolean> {
    const exists = await redis.exists(`${SESSION_KEY_PREFIX}${guildId}`);
    return exists === 1;
}

// ============================================
// RECORDING COUNTER — NO-OPS (backward compat)
// ============================================
// These functions previously paused/resumed the global audio queue.
// Now they are no-ops: the queue runs continuously, processing jobs
// from all guilds without blocking.

/**
 * @deprecated No-op. Queue no longer pauses during recording.
 */
export async function incrementRecordingCount(): Promise<void> {
    // No-op: queue runs continuously
}

/**
 * @deprecated No-op. Queue no longer pauses during recording.
 */
export async function decrementRecordingCount(): Promise<void> {
    // No-op: queue runs continuously
}

/**
 * Reset recording state and ensure queue is running.
 * Called at boot to clean up after a crash.
 */
export async function resetRecordingState(): Promise<void> {
    // Clean up old counter key if it exists
    await redis.del('lp:recording_count');
    log.info('Stato registrazione resettato.');
}

// ============================================
// AUTO-LEAVE TIMERS (in-memory, non serializable)
// ============================================

export const autoLeaveTimers = new Map<string, NodeJS.Timeout>();
