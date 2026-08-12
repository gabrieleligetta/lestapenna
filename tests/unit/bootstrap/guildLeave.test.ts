/**
 * What happens when the bot leaves a server — and when it only looks like it did.
 *
 * Discord emits `guildDelete` for two entirely different events: the bot was
 * removed, and the guild became temporarily unavailable during an outage on
 * Discord's side. The payload is the same; only `guild.available` distinguishes
 * them.
 *
 * Since removal now erases everything immediately, confusing the two would wipe
 * the archives of every table connected during a Discord incident, at once and
 * irreversibly. That is what the first test here exists to prevent, and it is
 * the reason the guard is the first statement in the handler.
 */

import { Client } from 'discord.js';

const eraseGuildDataMock = jest.fn(
    async (_guildId: string) => ({ rows: {}, objects: 0, localFiles: 0, failedPrefixes: [] as string[] }),
);
jest.mock('../../../src/services/dataErasure', () => ({
    eraseGuildData: (guildId: string) => eraseGuildDataMock(guildId),
}));

const disconnectMock = jest.fn(async (_guildId: string, _options?: unknown) => true);
jest.mock('../../../src/services/recorder', () => ({
    disconnect: (guildId: string, options?: unknown) => disconnectMock(guildId, options),
}));

import { registerGuildLeaveHandler } from '../../../src/bootstrap/guildLeave';
import { config } from '../../../src/config';

const GUILD = 'guild-leaving';

/** Captures the handler the bootstrap registers, so the test can fire it. */
function captureHandler(): (guild: unknown) => Promise<void> {
    let handler: ((guild: unknown) => Promise<void>) | null = null;
    const client = {
        on: (event: string, fn: (guild: unknown) => Promise<void>) => {
            if (event === 'guildDelete') handler = fn;
        },
    } as unknown as Client;

    registerGuildLeaveHandler(client);
    if (!handler) throw new Error('the handler was never registered on guildDelete');
    return handler;
}

beforeEach(() => {
    jest.clearAllMocks();
    config.discord.devGuildId = '';
    config.discord.ignoreGuildIds = [];
});

describe('guildDelete', () => {
    it('erases NOTHING when the guild is merely unavailable', async () => {
        const handler = captureHandler();

        await handler({ id: GUILD, name: 'Tavolo', available: false });

        // The single most important assertion in this suite: a Discord outage
        // must never be read as «the bot was removed».
        expect(eraseGuildDataMock).not.toHaveBeenCalled();
        expect(disconnectMock).not.toHaveBeenCalled();
    });

    it('erases the guild when it was really removed', async () => {
        const handler = captureHandler();

        await handler({ id: GUILD, name: 'Tavolo', available: true });

        expect(eraseGuildDataMock).toHaveBeenCalledWith(GUILD);
    });

    it('closes an ongoing recording without processing the session', async () => {
        const handler = captureHandler();

        await handler({ id: GUILD, name: 'Tavolo', available: true });

        // Transcribing for a server that just removed us would spend the table's
        // AI budget on something nobody can read, and would race the erasure.
        expect(disconnectMock).toHaveBeenCalledWith(GUILD, { processSession: false });
    });

    it('respects the ignore list', async () => {
        config.discord.ignoreGuildIds = [GUILD];
        const handler = captureHandler();

        await handler({ id: GUILD, name: 'Tavolo', available: true });

        expect(eraseGuildDataMock).not.toHaveBeenCalled();
    });

    it('leaves other guilds alone when DEV_GUILD_ID is set', async () => {
        config.discord.devGuildId = 'some-other-guild';
        const handler = captureHandler();

        await handler({ id: GUILD, name: 'Tavolo', available: true });

        expect(eraseGuildDataMock).not.toHaveBeenCalled();
    });

    it('survives a failing erasure without throwing', async () => {
        eraseGuildDataMock.mockRejectedValueOnce(new Error('storage unreachable'));
        const handler = captureHandler();

        await expect(handler({ id: GUILD, name: 'Tavolo', available: true })).resolves.toBeUndefined();
    });
});
