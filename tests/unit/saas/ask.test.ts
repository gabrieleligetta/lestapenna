// No real Redis in the test environment — same in-memory fake as campaigns.test.ts.
jest.mock('ioredis', () => {
    const store = new Map<string, string>();
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => {
            store.set(key, value);
            return 'OK';
        }),
        del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
        ttl: jest.fn(async (key: string) => (store.has(key) ? 3600 : -2)),
    }));
});

// The real Bardo would call a paid provider: what matters here is the boundary
// around it, not the quality of the answer.
const askBardMock = jest.fn();
jest.mock('../../../src/bard', () => ({
    ...jest.requireActual('../../../src/bard'),
    askBard: (...args: unknown[]) => askBardMock(...args),
}));

import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { askConversationRepository } from '../../../src/db/repositories/AskConversationRepository';
import { ensureMembership } from '../../../src/services/campaignAccess';
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'ask-guild';
const OWNER = 'user-ask-owner';
const MATE = 'user-ask-mate';

function fakeSession(userId: string, canManage = false): WebSessionData {
    return {
        discordUserId: userId,
        username: 'tester',
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD, name: 'Ask Table', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

function goodAnswer(costUsd = 0.0028) {
    return { answer: 'Helena vive a Neverwinter.', costUsd, costEur: costUsd / 1.1, succeeded: true };
}

/**
 * The chat with the Bardo from the web app.
 *
 * The value of these tests is not the answer — that is mocked — but the
 * boundary around it: that the model is invoked exactly once, that a
 * provider failure does not pollute the conversation, and that sharing
 * publishes read-only.
 */
describe('Chat col Bardo (web)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let ownerCookie: string;
    let mateCookie: string;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD, 'Ask Campaign');

        ownerCookie = 'ask-owner-session';
        await signIn(ownerCookie, fakeSession(OWNER));
        ensureMembership(campaignId, OWNER, 'MASTER');

        mateCookie = 'ask-mate-session';
        await signIn(mateCookie, fakeSession(MATE));
        ensureMembership(campaignId, MATE);

    });

    afterAll(async () => {
        await app.close();
        db.prepare('DELETE FROM ask_conversations WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    });

    beforeEach(() => {
        askBardMock.mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function get(url: string, cookie = ownerCookie) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
    }

    function mutate(
        method: 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: Record<string, unknown>,
        cookie = ownerCookie,
    ) {
        return fastify.inject({
            method,
            url,
            headers: {
                cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
                ...(payload ? { 'content-type': 'application/json' } : {}),
            },
            ...(payload ? { payload: JSON.stringify(payload) } : {}),
        });
    }

    const base = () => `/api/v1/campaigns/${campaignId}/ask`;

    async function newConversation(cookie = ownerCookie): Promise<number> {
        const created = await mutate('POST', `${base()}/conversations`, undefined, cookie);
        expect(created.statusCode).toBe(201);
        return JSON.parse(created.payload).id;
    }

    describe('preventivo', () => {
        it('declares provider and model without invoking the Bard', async () => {
            const response = await get(`${base()}/estimate`);

            expect(response.statusCode).toBe(200);
            const estimate = JSON.parse(response.payload);
            // Under BYOK the estimate says which of the user's accounts will be spent on,
            // not a list price of ours.
            expect(typeof estimate.provider).toBe('string');
            expect(estimate.provider.length).toBeGreaterThan(0);
            expect(typeof estimate.model).toBe('string');
            expect(estimate.model.length).toBeGreaterThan(0);

            expect(askBardMock).not.toHaveBeenCalled();
        });
    });

    describe('domanda', () => {
        it('persists the exchange with its real cost and titles it from the first question', async () => {
            askBardMock.mockResolvedValue(goodAnswer());
            const conversationId = await newConversation();

            const response = await mutate(
                'POST', `${base()}/conversations/${conversationId}/messages`,
                { question: '  Dove si trova Helena adesso?  ' },
            );

            expect(response.statusCode).toBe(201);
            const body = JSON.parse(response.payload);
            expect(body.message).toMatchObject({
                role: 'assistant',
                content: 'Helena vive a Neverwinter.',
            });
            // The real cost incurred on the user's account stays tracked.
            expect(body.message.cost_usd).toBeCloseTo(0.0028);
            expect(body.conversation.title).toBe('Dove si trova Helena adesso?');
            expect(body.conversation.message_count).toBe(2);

            // La domanda arriva al Bardo già ripulita dagli spazi.
            expect(askBardMock).toHaveBeenCalledWith(campaignId, 'Dove si trova Helena adesso?', []);
        });

        it('carries the conversation history into the next question', async () => {
            askBardMock.mockResolvedValue(goodAnswer());
            const conversationId = await newConversation();

            await mutate('POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' });
            await mutate('POST', `${base()}/conversations/${conversationId}/messages`, { question: 'E ora dov’è?' });

            const [, , history] = askBardMock.mock.calls[1];
            expect(history).toEqual([
                { role: 'user', content: 'Chi è Helena?' },
                { role: 'assistant', content: 'Helena vive a Neverwinter.' },
            ]);
        });

        it('persists nothing when the provider fails', async () => {
            askBardMock.mockResolvedValue({ answer: 'nebbia…', costUsd: 0.0001, costEur: null, succeeded: false });
            const conversationId = await newConversation();

            const response = await mutate(
                'POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' },
            );

            expect(response.statusCode).toBe(502);
            expect(askConversationRepository.countMessages(conversationId)).toBe(0);
        });

        it('rejects an empty or over-long question without invoking the model', async () => {
            const conversationId = await newConversation();

            const empty = await mutate(
                'POST', `${base()}/conversations/${conversationId}/messages`, { question: '   ' },
            );
            const huge = await mutate(
                'POST', `${base()}/conversations/${conversationId}/messages`, { question: 'x'.repeat(2001) },
            );

            expect(empty.statusCode).toBe(400);
            expect(huge.statusCode).toBe(400);
            expect(askBardMock).not.toHaveBeenCalled();
        });

        it('does not spend twice when two submissions overlap', async () => {
            let release: (value: unknown) => void = () => {};
            const gate = new Promise((resolve) => { release = resolve; });
            askBardMock.mockImplementation(async () => {
                await gate;
                return goodAnswer();
            });
            const conversationId = await newConversation();

            const first = mutate('POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' });
            // The second send starts while the first is still in flight.
            await new Promise((resolve) => setTimeout(resolve, 10));
            const second = await mutate(
                'POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' },
            );
            release(undefined);
            const firstResponse = await first;

            expect(firstResponse.statusCode).toBe(201);
            expect(second.statusCode).toBe(409);
            // A single real invocation of the provider, therefore a single charge.
            expect(askBardMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('conversazioni: proprietà e condivisione', () => {
        it('keeps conversations private until they are shared', async () => {
            askBardMock.mockResolvedValue(goodAnswer());
            const conversationId = await newConversation();
            await mutate('POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' });

            const beforeShare = await get(`${base()}/conversations/${conversationId}`, mateCookie);
            expect(beforeShare.statusCode).toBe(403);
            const mateList = JSON.parse((await get(`${base()}/conversations`, mateCookie)).payload);
            expect(mateList.items).toHaveLength(0);

            const shared = await mutate('PATCH', `${base()}/conversations/${conversationId}`, { shared: true });
            expect(shared.statusCode).toBe(204);

            const afterShare = await get(`${base()}/conversations/${conversationId}`, mateCookie);
            expect(afterShare.statusCode).toBe(200);
            const seen = JSON.parse(afterShare.payload);
            expect(seen.owned).toBe(false);
            expect(seen.messages).toHaveLength(2);
        });

        it('public sharing is read-only: a companion can neither ask nor rename', async () => {
            askBardMock.mockResolvedValue(goodAnswer());
            const conversationId = await newConversation();
            await mutate('PATCH', `${base()}/conversations/${conversationId}`, { shared: true });

            const asked = await mutate(
                'POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' }, mateCookie,
            );
            const renamed = await mutate(
                'PATCH', `${base()}/conversations/${conversationId}`, { title: 'Mio ora' }, mateCookie,
            );

            expect(asked.statusCode).toBe(403);
            expect(renamed.statusCode).toBe(403);
            expect(askBardMock).not.toHaveBeenCalled();
        });

        it('renames without the next question overwriting the title', async () => {
            askBardMock.mockResolvedValue(goodAnswer());
            const conversationId = await newConversation();
            await mutate('POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' });

            await mutate('PATCH', `${base()}/conversations/${conversationId}`, { title: 'Il caso Helena' });
            await mutate('POST', `${base()}/conversations/${conversationId}/messages`, { question: 'E poi?' });

            const detail = JSON.parse((await get(`${base()}/conversations/${conversationId}`)).payload);
            expect(detail.title).toBe('Il caso Helena');
        });

        it('elimina la conversazione e i suoi messaggi', async () => {
            askBardMock.mockResolvedValue(goodAnswer());
            const conversationId = await newConversation();
            await mutate('POST', `${base()}/conversations/${conversationId}/messages`, { question: 'Chi è Helena?' });

            const removed = await mutate('DELETE', `${base()}/conversations/${conversationId}`);
            expect(removed.statusCode).toBe(204);
            expect(askConversationRepository.get(conversationId)).toBeNull();
            expect(askConversationRepository.countMessages(conversationId)).toBe(0);
        });

        it('does not expose another campaign\'s conversations', async () => {
            const otherCampaign = campaignRepository.createCampaign(GUILD, 'Altra Campagna');
            const foreign = askConversationRepository.create(otherCampaign, OWNER);

            const response = await get(`${base()}/conversations/${foreign.id}`);
            expect(response.statusCode).toBe(404);

            db.prepare('DELETE FROM campaigns WHERE id = ?').run(otherCampaign);
        });
    });
});
