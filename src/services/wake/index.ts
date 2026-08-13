import axios from 'axios';
import { udpWakeMethod } from './udp';
import { iliadboxWakeMethod } from './iliadbox';
import type { WakeConfig, WakeMethod } from './types';

/**
 * Registry of the wake methods.
 *
 * **Adding your own is writing a file and putting it in this list.** The
 * method describes its own fields, so the settings page draws them by
 * itself: there is no UI to touch, no six translations to update, and no extra
 * branch inside a chain of `if`s. It is the extension point an open source
 * project has to have, because every home switches a computer on in its own way —
 * a webhook to Home Assistant, a smart plug, one's own router's API.
 *
 * Waiting for the PC to answer, on the other hand, is **the same for everyone**:
 * polling `/health` does not depend on how it was switched on.
 */

const METHODS: WakeMethod[] = [udpWakeMethod, iliadboxWakeMethod];

export const WAKE_METHODS: Record<string, WakeMethod> = Object.fromEntries(
    METHODS.map(method => [method.id, method]),
);

/** The list for the UI: id, label and the fields to fill in. */
export function listWakeMethods(): WakeMethod[] {
    return METHODS;
}

export function wakeMethod(id: string | null | undefined): WakeMethod | null {
    return id ? WAKE_METHODS[id] ?? null : null;
}

export interface WakeAndWaitOptions extends WakeConfig {
    method: string;
    /** Endpoint to poll until it answers. */
    healthUrl: string;
    bootTimeoutMs?: number;
    pollIntervalMs?: number;
    /** Header to send with the health check, when the table's server is protected. */
    healthHeaders?: Record<string, string>;
}

export type WakeResult =
    | { success: true; elapsedMs: number }
    | { success: false; reason: string };

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(
    healthUrl: string,
    bootTimeoutMs: number,
    pollIntervalMs: number,
    headers: Record<string, string>,
): Promise<boolean> {
    const deadline = Date.now() + bootTimeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
        attempt++;
        try {
            await axios.get(healthUrl, { timeout: 5000, headers });
            console.log(`[WoL] ✅ Server online dopo ${attempt} tentativo/i.`);
            return true;
        } catch {
            const remaining = Math.max(0, deadline - Date.now());
            console.log(
                `[WoL] ⏳ Tentativo ${attempt}: non ancora online. Riprovo tra ` +
                `${pollIntervalMs / 1000}s (residuo: ${Math.round(remaining / 1000)}s)...`,
            );
        }
        await sleep(pollIntervalMs);
    }
    return false;
}

/**
 * Sends the wake request and returns, without waiting for the machine.
 *
 * The worker cannot use this — it has to know whether the PC came up before it
 * decides where to transcribe — but a browser can: a boot takes minutes, and an
 * HTTP request held open that long is a request that dies to a proxy timeout
 * and leaves the page unable to say whether anything happened. The caller polls
 * the status endpoint instead, which is also what shows the progress.
 */
export async function sendWakeRequest(
    options: Pick<WakeAndWaitOptions, 'method' | 'macAddress' | 'options' | 'secrets'>,
): Promise<{ sent: true } | { sent: false; reason: string }> {
    const implementation = wakeMethod(options.method);
    if (!implementation) return { sent: false, reason: `unknown_wake_method: ${options.method}` };

    try {
        await implementation.send({
            macAddress: options.macAddress,
            options: options.options,
            secrets: options.secrets,
        });
        return { sent: true };
    } catch (err: any) {
        console.error(`[WoL] ❌ Impossibile inviare la richiesta di accensione: ${err.message}`);
        return { sent: false, reason: `wake_request_failed: ${err.message}` };
    }
}

/** Switches the PC on with the method the table chose and waits for it to answer. */
export async function wakeAndWait(options: WakeAndWaitOptions): Promise<WakeResult> {
    const {
        method, macAddress, options: fields, secrets, healthUrl,
        bootTimeoutMs = 180_000, pollIntervalMs = 5_000, healthHeaders = {},
    } = options;

    const start = Date.now();

    const sent = await sendWakeRequest({ method, macAddress, options: fields, secrets });
    if (!sent.sent) return { success: false, reason: sent.reason };

    // The BIOS takes a few seconds before the network card answers
    // anything: polling straight away would only produce a guaranteed failure.
    await sleep(pollIntervalMs);

    if (await waitForHealth(healthUrl, bootTimeoutMs, pollIntervalMs, healthHeaders)) {
        const elapsedMs = Date.now() - start;
        console.log(`[WoL] 🚀 PC online in ${(elapsedMs / 1000).toFixed(1)}s.`);
        return { success: true, elapsedMs };
    }

    console.warn(`[WoL] ⏱️ Timeout: il PC non è tornato online entro ${bootTimeoutMs / 1000}s.`);
    return { success: false, reason: 'boot_timeout' };
}

export type { WakeConfig, WakeField, WakeMethod } from './types';
