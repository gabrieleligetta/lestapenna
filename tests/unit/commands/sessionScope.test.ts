/**
 * Who a session belongs to.
 *
 * `$download`, `$ingest`, `$reset` and `$reprocess` all take a session id
 * straight from the user's arguments and act on it. The id then becomes a bucket
 * key and a signed link valid for 24 hours — and nothing ever checked that the
 * session was this server's. The ids are UUIDs, so they cannot be brute-forced,
 * but they appear in published recaps, in `$listsessions` and in the logs: «hard
 * to guess» is not an authorisation check.
 *
 * The second half is the character filter: the id is concatenated into
 * `recordings/<id>/…`, so a `../` would walk out of the prefix.
 */

const mockGetSessionGuildId = jest.fn<string | undefined, [string]>();
const mockBelongsToCampaign = jest.fn<boolean, [string, number]>();
jest.mock('../../../src/db', () => ({
    sessionRepository: {
        getSessionGuildId: (id: string) => mockGetSessionGuildId(id),
        belongsToCampaign: (id: string, campaignId: number) => mockBelongsToCampaign(id, campaignId),
    },
}));

import { assertSessionInActiveCampaign, assertSessionInGuild } from '../../../src/commands/utils/sessionScope';
import { CommandContext } from '../../../src/commands/types';

const OUR_GUILD = 'guild-of-this-table';
const SOMEONE_ELSES_GUILD = 'guild-of-another-table';
const VALID_ID = 'efaebb05-af05-4c02-a346-bebe0375eeaa';

describe('assertSessionInGuild', () => {
    let ctx: CommandContext;
    let replyMock: jest.Mock;

    beforeEach(() => {
        mockGetSessionGuildId.mockReset();
        mockBelongsToCampaign.mockReset();
        replyMock = jest.fn();
        ctx = {
            locale: 'en' as const,
            message: { reply: replyMock } as never,
            args: [],
            guildId: OUR_GUILD,
            activeCampaign: null,
            client: {} as never,
        };
    });

    it('accepts a session belonging to this guild', async () => {
        mockGetSessionGuildId.mockReturnValue(OUR_GUILD);
        await expect(assertSessionInGuild(ctx, VALID_ID)).resolves.toBe(true);
        expect(replyMock).not.toHaveBeenCalled();
    });

    it('refuses a session belonging to another guild', async () => {
        mockGetSessionGuildId.mockReturnValue(SOMEONE_ELSES_GUILD);
        await expect(assertSessionInGuild(ctx, VALID_ID)).resolves.toBe(false);
        expect(replyMock).toHaveBeenCalledTimes(1);
    });

    it('refuses a session that does not exist', async () => {
        mockGetSessionGuildId.mockReturnValue(undefined);
        await expect(assertSessionInGuild(ctx, VALID_ID)).resolves.toBe(false);
    });

    it('answers identically for a foreign session and a missing one', async () => {
        // Telling them apart would let whoever tries an id learn whether that
        // session exists on some other server.
        mockGetSessionGuildId.mockReturnValue(SOMEONE_ELSES_GUILD);
        await assertSessionInGuild(ctx, VALID_ID);
        const foreign = JSON.stringify(replyMock.mock.calls[0][0]);

        replyMock.mockClear();
        mockGetSessionGuildId.mockReturnValue(undefined);
        await assertSessionInGuild(ctx, VALID_ID);
        const missing = JSON.stringify(replyMock.mock.calls[0][0]);

        expect(foreign).toBe(missing);
    });

    it.each([
        ['../../etc/passwd', 'path traversal'],
        ['abc/def', 'a slash'],
        ['a b', 'a space'],
        ['', 'empty'],
        ['x'.repeat(129), 'over the length limit'],
    ])('refuses a malformed id: %s (%s)', async (id) => {
        await expect(assertSessionInGuild(ctx, id)).resolves.toBe(false);
        // It must not even reach the database: the shape is wrong already.
        expect(mockGetSessionGuildId).not.toHaveBeenCalled();
    });

    it.each([
        [VALID_ID, 'uuid'],
        ['test-direct-1a2b3c4d', 'debug session'],
        ['recovered-9f8e7d6c', 'recovered session'],
    ])('accepts the id formats actually in use: %s (%s)', async (id) => {
        mockGetSessionGuildId.mockReturnValue(OUR_GUILD);
        await expect(assertSessionInGuild(ctx, id)).resolves.toBe(true);
    });
});

describe('assertSessionInActiveCampaign', () => {
    const campaign = { id: 42, name: 'Current table' } as never;

    function context(): { ctx: CommandContext; reply: jest.Mock } {
        const reply = jest.fn();
        return {
            reply,
            ctx: {
                locale: 'en' as const,
                message: { reply } as never,
                args: [],
                guildId: OUR_GUILD,
                activeCampaign: campaign,
                client: {} as never,
            },
        };
    }

    beforeEach(() => {
        mockGetSessionGuildId.mockReset();
        mockBelongsToCampaign.mockReset();
    });

    it('accepts only a session in the active campaign', async () => {
        const { ctx, reply } = context();
        mockGetSessionGuildId.mockReturnValue(OUR_GUILD);
        mockBelongsToCampaign.mockReturnValue(true);

        await expect(assertSessionInActiveCampaign(ctx, VALID_ID)).resolves.toBe(true);
        expect(mockBelongsToCampaign).toHaveBeenCalledWith(VALID_ID, 42);
        expect(reply).not.toHaveBeenCalled();
    });

    it('refuses another campaign without disclosing it exists', async () => {
        const { ctx, reply } = context();
        mockGetSessionGuildId.mockReturnValue(OUR_GUILD);
        mockBelongsToCampaign.mockReturnValue(false);

        await expect(assertSessionInActiveCampaign(ctx, VALID_ID)).resolves.toBe(false);
        expect(reply).toHaveBeenCalledTimes(1);
    });
});
