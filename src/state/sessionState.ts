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
import { sessionFinalizationQueue, sessionProcessingQueue } from '../services/queue';

const log = logger('SessionState');

// --- REDIS CLIENT ---
const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null, // Required by BullMQ compatibility
    lazyConnect: true,
});

// Connect (non-blocking, reconnects automatically). A disabled local/test
// harness must not leave an unused Redis socket retrying in the background.
if (process.env.DISABLE_REDIS !== 'true') {
    redis.connect().catch((err) => {
        log.error('Redis connection error', err);
    });
}

// --- REDIS KEYS ---
const SESSION_KEY_PREFIX = 'lp:session:'; // lp:session:<guildId> → sessionId
const RECORDING_GUILDS_KEY = 'lp:recording_guilds';
const RECORDING_CAPACITY_KEY = 'lp:recording_capacity_v2'; // hash guildId -> active marker
const MAX_CONCURRENT_RECORDING_GUILDS = Math.max(
    1,
    Number.parseInt(process.env.MAX_CONCURRENT_RECORDING_GUILDS || '2', 10) || 2,
);
const MAX_PENDING_SESSIONS_PER_GUILD = Math.max(
    1,
    Number.parseInt(process.env.MAX_PENDING_SESSIONS_PER_GUILD || '2', 10) || 2,
);
const disabledRecordingGuilds = new Set<string>();

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

export interface RecordingAdmission {
    acquired: boolean;
    reason?: 'recording_capacity' | 'guild_backlog';
    active: number;
    limit: number;
    pendingForGuild: number;
}

async function countPendingSessions(guildId: string): Promise<number> {
    const sessionIds = new Set<string>();
    for (const queue of [sessionProcessingQueue, sessionFinalizationQueue]) {
        const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'paused']);
        for (const job of jobs) {
            if (job.data?.guildId === guildId && job.data?.sessionId) sessionIds.add(job.data.sessionId);
        }
    }
    return sessionIds.size;
}

/** Atomically reserves scarce recording capacity across gateway processes. */
export async function acquireRecordingCapacity(guildId: string): Promise<RecordingAdmission> {
    const pendingForGuild = await countPendingSessions(guildId);
    if (pendingForGuild >= MAX_PENDING_SESSIONS_PER_GUILD) {
        return {
            acquired: false,
            reason: 'guild_backlog',
            active: await getActiveRecordingCount(),
            limit: MAX_CONCURRENT_RECORDING_GUILDS,
            pendingForGuild,
        };
    }

    if (process.env.DISABLE_REDIS === 'true') {
        if (!disabledRecordingGuilds.has(guildId) && disabledRecordingGuilds.size >= MAX_CONCURRENT_RECORDING_GUILDS) {
            return { acquired: false, reason: 'recording_capacity', active: disabledRecordingGuilds.size, limit: MAX_CONCURRENT_RECORDING_GUILDS, pendingForGuild };
        }
        disabledRecordingGuilds.add(guildId);
        return { acquired: true, active: disabledRecordingGuilds.size, limit: MAX_CONCURRENT_RECORDING_GUILDS, pendingForGuild };
    }

    const result = await redis.eval(
        `local key = KEYS[1]
         local guild = ARGV[1]
         local maxGuilds = tonumber(ARGV[2])
         local existing = redis.call('HGET', key, guild)
         local active = redis.call('HLEN', key)
         if existing then
           return {1, active}
         end
         if active >= maxGuilds then return {0, active} end
         redis.call('HSET', key, guild, 1)
         return {1, active + 1}`,
        1,
        RECORDING_CAPACITY_KEY,
        guildId,
        MAX_CONCURRENT_RECORDING_GUILDS,
    ) as [number, number];

    return {
        acquired: result[0] === 1,
        reason: result[0] === 1 ? undefined : 'recording_capacity',
        active: result[1],
        limit: MAX_CONCURRENT_RECORDING_GUILDS,
        pendingForGuild,
    };
}

export async function releaseRecordingCapacity(guildId: string): Promise<void> {
    if (process.env.DISABLE_REDIS === 'true') {
        disabledRecordingGuilds.delete(guildId);
        return;
    }
    await redis.hdel(RECORDING_CAPACITY_KEY, guildId);
}

export async function getActiveRecordingCount(): Promise<number> {
    if (process.env.DISABLE_REDIS === 'true') return disabledRecordingGuilds.size;
    return redis.hlen(RECORDING_CAPACITY_KEY);
}

export function getRecordingCapacityLimit(): number {
    return MAX_CONCURRENT_RECORDING_GUILDS;
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
export async function decrementRecordingCount(guildId?: string): Promise<void> {
    if (guildId) await releaseRecordingCapacity(guildId);
}

/**
 * Reset recording state and ensure queue is running.
 * Called at boot to clean up after a crash.
 */
export async function resetRecordingState(): Promise<void> {
    // Clean up old counter key if it exists
    if (process.env.DISABLE_REDIS === 'true') {
        disabledRecordingGuilds.clear();
    } else {
        await redis.del('lp:recording_count', RECORDING_GUILDS_KEY, RECORDING_CAPACITY_KEY);
    }
    log.info('Stato registrazione resettato.');
}

// ============================================
// AUTO-LEAVE TIMERS (in-memory, non serializable)
// ============================================

export const autoLeaveTimers = new Map<string, NodeJS.Timeout>();
