/**
 * Session State — Redis-backed session tracking for multi-guild support
 * 
 * Replaces the old in-memory Map with Redis to survive crashes.
 * Also manages a "recording counter" for per-session queue pause/resume.
 */

import Redis from 'ioredis';
import { config } from '../config';
import { audioQueue } from '../services/queue';

// --- REDIS CLIENT ---
const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null, // Required by BullMQ compatibility
    lazyConnect: true,
});

// Connect (non-blocking, reconnects automatically)
redis.connect().catch((err) => {
    console.error('[SessionState] ❌ Redis connection error:', err.message);
});

// --- REDIS KEYS ---
const SESSION_KEY_PREFIX = 'lp:session:'; // lp:session:<guildId> → sessionId
const RECORDING_COUNTER_KEY = 'lp:recording_count'; // Counter of active recordings

// ============================================
// SESSION MANAGEMENT (Fix 3)
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
// RECORDING COUNTER + QUEUE PAUSE (Fix 1)
// ============================================

/**
 * Increment the recording counter and pause the audio queue.
 * Called when a guild starts recording ($ascolta).
 */
export async function incrementRecordingCount(): Promise<void> {
    const count = await redis.incr(RECORDING_COUNTER_KEY);
    if (count === 1) {
        // First guild to start recording → pause the queue
        await audioQueue.pause();
        console.log(`[SessionState] ⏸️ Coda audio in PAUSA (${count} guild in registrazione)`);
    } else {
        console.log(`[SessionState] 📝 Guild aggiunta alla registrazione (${count} attive)`);
    }
}

/**
 * Decrement the recording counter and resume the queue if no one is recording.
 * Called when a guild stops recording ($stop, auto-leave).
 */
export async function decrementRecordingCount(): Promise<void> {
    const count = await redis.decr(RECORDING_COUNTER_KEY);

    if (count <= 0) {
        // No more guilds recording → resume the queue
        await redis.set(RECORDING_COUNTER_KEY, 0); // Clamp to 0
        await audioQueue.resume();
        console.log(`[SessionState] ▶️ Coda audio RIPRESA (nessuna guild in registrazione)`);
    } else {
        console.log(`[SessionState] 📝 Guild rimossa dalla registrazione (${count} ancora attive)`);
    }
}

/**
 * Reset the recording counter to 0 and resume the queue.
 * Called at boot to clean up after a crash.
 */
export async function resetRecordingState(): Promise<void> {
    await redis.set(RECORDING_COUNTER_KEY, 0);
    await audioQueue.resume();
    console.log(`[SessionState] 🔄 Stato registrazione resettato, coda ripresa.`);
}

// ============================================
// AUTO-LEAVE TIMERS (in-memory, non serializable)
// ============================================

export const autoLeaveTimers = new Map<string, NodeJS.Timeout>();
