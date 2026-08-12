/**
 * `$dona` and the nudge line.
 *
 * Two things matter here and neither is the wording. First, an instance that
 * configures no donation link must not show one: a fork should not quietly
 * collect for upstream. Second, the nudge must actually be rare — a reminder
 * that fires every session is not a reminder, and the rate limit is the only
 * thing standing between «mentioned occasionally» and «asks for money every
 * time you play».
 */

const mockConfig = {
    links: {
        donationUrl: 'https://example.test/sponsor',
        repoUrl: 'https://example.test/repo',
        webAppUrl: 'https://example.test',
        nudgesEnabled: true,
    },
};
jest.mock('../../../src/config', () => ({ config: mockConfig }));

const store = new Map<string, string>();
jest.mock('../../../src/db', () => ({
    getGuildConfig: (guildId: string, key: string) => store.get(`${guildId}_${key}`) ?? null,
    setGuildConfig: (guildId: string, key: string, value: string) => { store.set(`${guildId}_${key}`, value); },
}));

import { donateCommand } from '../../../src/commands/meta/donate';
import { communityLine, NUDGE_INTERVAL_MS } from '../../../src/commands/utils/communityLine';
import { CommandContext } from '../../../src/commands/types';

function makeContext(): { ctx: CommandContext; reply: jest.Mock } {
    const reply = jest.fn().mockResolvedValue({});
    const ctx = {
        locale: 'it' as const,
        message: { reply, author: { id: 'author-1' } } as never,
        args: [],
        guildId: 'guild-1',
        activeCampaign: null,
        client: {} as never,
    };
    return { ctx, reply };
}

const DEFAULTS = { ...mockConfig.links };
beforeEach(() => {
    store.clear();
    mockConfig.links = { ...DEFAULTS };
});

describe('$dona', () => {
    it('shows the donation, web app and source buttons', async () => {
        const { ctx, reply } = makeContext();
        await donateCommand.execute(ctx);

        const payload = reply.mock.calls[0][0];
        const urls = payload.components[0].components.map((b: { data: { url: string } }) => b.data.url);
        expect(urls).toEqual([
            'https://example.test/sponsor',
            'https://example.test',
            'https://example.test/repo',
        ]);
    });

    it('shows no donation button when the instance configured none', async () => {
        mockConfig.links.donationUrl = '';
        const { ctx, reply } = makeContext();
        await donateCommand.execute(ctx);

        const payload = reply.mock.calls[0][0];
        const urls = payload.components[0].components.map((b: { data: { url: string } }) => b.data.url);
        expect(urls).not.toContain('https://example.test/sponsor');
    });

    it('says so plainly when nothing at all is configured', async () => {
        mockConfig.links = { donationUrl: '', repoUrl: '', webAppUrl: '', nudgesEnabled: true };
        const { ctx, reply } = makeContext();
        await donateCommand.execute(ctx);
        expect(typeof reply.mock.calls[0][0]).toBe('string');
    });
});

describe('communityLine', () => {
    it('shows the nudge the first time', () => {
        expect(communityLine('guild-1', 'it')).toContain('$dona');
    });

    it('does not show it again straight after', () => {
        communityLine('guild-1', 'it');
        expect(communityLine('guild-1', 'it')).toBe('');
    });

    it('shows it again once the interval has passed', () => {
        communityLine('guild-1', 'it');
        store.set('guild-1_community_nudge_at', String(Date.now() - NUDGE_INTERVAL_MS - 1000));
        expect(communityLine('guild-1', 'it')).toContain('$dona');
    });

    it('rate-limits each server independently', () => {
        communityLine('guild-1', 'it');
        expect(communityLine('guild-2', 'it')).toContain('$dona');
    });

    it('stays silent when nudges are disabled', () => {
        mockConfig.links.nudgesEnabled = false;
        expect(communityLine('guild-1', 'it')).toBe('');
    });

    it('never throws, whatever the storage does', () => {
        // Same contract as sessionCostLine: a reminder is not worth failing
        // $listen over.
        mockConfig.links = null as never;
        expect(() => communityLine('guild-1', 'it')).not.toThrow();
        expect(communityLine('guild-1', 'it')).toBe('');
    });
});
