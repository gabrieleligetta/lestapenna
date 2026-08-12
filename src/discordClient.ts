/**
 * Discord Client singleton — set once by src/index.ts after the bot logs in,
 * read by the NestJS API (same process) to check bot/guild membership
 * (e.g. GET /api/v1/me/guilds) without a second Discord connection.
 */

import { Client } from 'discord.js';

let client: Client | null = null;

export function setDiscordClient(c: Client): void {
    client = c;
}

/** Null until the bot has been constructed (always set before the API starts accepting traffic). */
export function getDiscordClient(): Client | null {
    return client;
}
