/**
 * The Redis boundary.
 *
 * `AsyncLocalStorage` does not cross a queue: a BullMQ job restarts in a fresh
 * async context, where the store of whoever enqueued it no longer exists.
 * If the processor does not re-enter the scope, one table's AI correction
 * ends up on another's keys — or on the operator's — with nothing
 * signalling the error. This test verifies the re-entry where it is easiest
 * to forget.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { db } from '../../../src/db';
import { currentAiScope } from '../../../src/bard/ai/ambientScope';
import { clearScopeCache } from '../../../src/bard/ai/scope';

const observedScopes: Array<string | undefined> = [];

jest.mock('../../../src/bard', () => ({
    correctTranscription: jest.fn(async (segments: any[]) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { currentAiScope } = require('../../../src/bard/ai/ambientScope');
        observedScopes.push(currentAiScope()?.guildId);
        return { segments };
    }),
}));

jest.mock('../../../src/db', () => {
    const actual = jest.requireActual('../../../src/db');
    return { ...actual, updateRecordingStatus: jest.fn() };
});

import { correctionProcessor } from '../../../src/workers/correction';

const GUILD = 'guild-del-tavolo';
let campaignId: number;

beforeEach(() => {
    wipeDatabase();
    clearScopeCache();
    observedScopes.length = 0;
    campaignId = campaignRepository.createCampaign(GUILD, 'Tavolo');
});

function fakeJob(sessionId: string) {
    return {
        data: { sessionId, fileName: 'a.flac', segments: [{ text: 'ciao' }], campaignId, userId: 'u1' },
        timestamp: Date.now(),
        attemptsMade: 0,
    } as any;
}

describe('correctionProcessor', () => {
    it('runs the correction in the scope of the session\'s table', async () => {
        db.prepare('INSERT INTO sessions (session_id, guild_id, campaign_id) VALUES (?, ?, ?)')
            .run('sess-1', GUILD, campaignId);

        // Outside the scope, as really happens: the worker runs in a
        // process that has never seen the Discord command that triggered it.
        expect(currentAiScope()).toBeUndefined();
        await correctionProcessor(fakeJob('sess-1'));

        expect(observedScopes).toEqual([GUILD]);
    });

    it('does not bill one table for another\'s work', async () => {
        const otherCampaign = campaignRepository.createCampaign('altra-gilda', 'Altro tavolo');
        db.prepare('INSERT INTO sessions (session_id, guild_id, campaign_id) VALUES (?, ?, ?)')
            .run('sess-a', GUILD, campaignId);
        db.prepare('INSERT INTO sessions (session_id, guild_id, campaign_id) VALUES (?, ?, ?)')
            .run('sess-b', 'altra-gilda', otherCampaign);

        await correctionProcessor(fakeJob('sess-a'));
        await correctionProcessor(fakeJob('sess-b'));

        expect(observedScopes).toEqual([GUILD, 'altra-gilda']);
    });
});
