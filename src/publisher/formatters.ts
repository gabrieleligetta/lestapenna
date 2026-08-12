/**
 * Publisher - Formatters & Helpers
 */

import { TextChannel } from 'discord.js';

// Helper to truncate text (Discord limit: 1024 chars per field)
export const truncate = (text: string, max: number = 1020) => {
    if (!text || text.length === 0) return "N/A";
    return text.length > max ? text.slice(0, max - 3) + '...' : text;
};

export async function fetchSessionInfoFromHistory(channel: TextChannel, targetSessionId?: string): Promise<{ lastRealNumber: number, sessionNumber?: number }> {
    let lastRealNumber = 0;
    let foundSessionNumber: number | undefined;

    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const sortedMessages = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        for (const msg of sortedMessages) {
            // Must recognize the header in every language of publish.sessionHeader
            // (discord.ts): SESSIONE/SESSION/SESIÓN/SITZUNG/SESSÃO — keep them in sync.
            const sessionMatch = msg.content.match(/-(?:SESSIONE|SESSION|SESI[ÓO]N|SITZUNG|SESS[ÃA]O)\s+(\d+)/i);
            const idMatch = msg.content.match(/\[ID: ([a-f0-9-]+)\]/i);
            const isReplay = msg.content.includes("(REPLAY)");

            if (sessionMatch) {
                const num = parseInt(sessionMatch[1]);
                if (!isNaN(num)) {
                    if (!isReplay && lastRealNumber === 0) {
                        lastRealNumber = num;
                    }
                    if (targetSessionId && idMatch && idMatch[1] === targetSessionId) {
                        foundSessionNumber = num;
                    }
                    if (!targetSessionId && lastRealNumber !== 0) break;
                    if (targetSessionId && lastRealNumber !== 0 && foundSessionNumber !== undefined) break;
                }
            }
        }
    } catch (e) {
        console.error("❌ Errore durante il recupero della cronologia del canale:", e);
    }

    return { lastRealNumber, sessionNumber: foundSessionNumber };
}
