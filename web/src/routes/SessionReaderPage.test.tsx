import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { SessionReaderPage } from './SessionReaderPage';
import { SessionTranscriptPage } from './SessionTranscriptPage';
import { SessionsArchivePage } from './SessionsArchivePage';
import { renderWithProviders } from '../test/renderWithProviders';
import { http, HttpResponse, jsonGet, pageOf, server } from '../test/server';
import { setViewportWidth } from '../test/media';

const READER_PATH = '/guilds/:guildId/campaigns/:campaignId/sessions/:sessionId';
const READER_URL = '/guilds/g1/campaigns/7/sessions/s2';
const TRANSCRIPT_PATH = `${READER_PATH}/transcript`;
const TRANSCRIPT_URL = `${READER_URL}/transcript`;
const ARCHIVE_PATH = '/guilds/:guildId/campaigns/:campaignId/sessions';
const ARCHIVE_URL = '/guilds/g1/campaigns/7/sessions';

const SESSION = {
    session_id: 's2',
    start_time: 1_753_000_000,
    session_number: 2,
    title: 'The glass tower',
    campaign_name: 'Ashes of Vaelor',
    brief: 'The heroes entered the tower.',
    narrative: 'Blue fire moved behind the glass.\n\nNo shadow followed them inside.',
    metadata: null,
    notes: [],
    npcsEncountered: [{ short_id: 'npc1', name: 'Ilyra', role: 'Seer', status: 'ALIVE' }],
    quests: [],
    inventory: [{
        short_id: 'inv1',
        item_name: 'Moon dust',
        quantity: 2,
        category: 'MATERIAL',
    }],
    bestiary: [],
    travels: [],
    navigation: {
        previous: { session_id: 's1', start_time: 1_752_000_000, session_number: 1, title: 'The silent gate' },
        next: { session_id: 's3', start_time: 1_754_000_000, session_number: 3, title: 'The last mirror' },
    },
    participants: [{ userId: 'u1', characterName: 'Aria' }],
    media: { audioAvailable: true, transcriptAvailable: true },
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
    server.resetHandlers();
    setViewportWidth(0);
});
afterAll(() => server.close());

describe('SessionsArchivePage', () => {
    it('presents every session as a deep link into the journal', async () => {
        server.use(
            jsonGet(
                '/campaigns/7/sessions',
                pageOf([
                    { session_id: 's2', start_time: 1_753_000_000, session_number: 2, title: 'The glass tower' },
                ]),
            ),
        );
        renderWithProviders(<SessionsArchivePage />, { route: ARCHIVE_URL, path: ARCHIVE_PATH });

        expect(screen.getByRole('heading', { name: 'Campaign journal' })).toBeInTheDocument();
        expect(await screen.findByRole('link', { name: /the glass tower/i })).toHaveAttribute(
            'href',
            '/guilds/g1/campaigns/7/sessions/s2',
        );
    });
});

describe('SessionReaderPage', () => {
    it('renders the selected session as a semantic article with navigable references', async () => {
        server.use(jsonGet('/campaigns/7/sessions/s2', SESSION));
        renderWithProviders(<SessionReaderPage />, { route: READER_URL, path: READER_PATH });

        expect(await screen.findByRole('article', { name: 'The glass tower' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Aria' })).toHaveAttribute(
            'href',
            '/guilds/g1/campaigns/7/characters/u1',
        );
        expect(screen.getByRole('link', { name: 'Ilyra' })).toHaveAttribute(
            'href',
            '/guilds/g1/campaigns/7/npcs/npc1',
        );
        expect(screen.getByRole('link', { name: /Moon dust/ })).toHaveAttribute(
            'href',
            '/guilds/g1/campaigns/7/inventory/inv1',
        );
        expect(screen.getByText('Material')).toBeInTheDocument();
        expect(screen.getByLabelText('Listen to audio')).toHaveAttribute(
            'src',
            '/api/v1/campaigns/7/sessions/s2/audio',
        );
    });

    it('uses both desktop pages for the selected session and keeps navigation at the sides', async () => {
        setViewportWidth(1280);
        server.use(jsonGet('/campaigns/7/sessions/s2', SESSION));
        const { container } = renderWithProviders(
            <SessionReaderPage />,
            { route: READER_URL, path: READER_PATH },
        );

        expect(await screen.findByRole('article', { name: 'The glass tower' })).toBeInTheDocument();
        expect(screen.queryByRole('article', { name: 'The silent gate' })).not.toBeInTheDocument();
        expect(container.querySelectorAll('.session-book-page')).toHaveLength(2);
        expect(screen.getByRole('link', { name: 'Previous session' })).toHaveClass(
            'session-page-arrow--previous',
        );
        expect(screen.getByRole('link', { name: 'Next session' })).toHaveClass(
            'session-page-arrow--next',
        );
    });

    it('keeps a readable single page at the sidebar breakpoint', async () => {
        setViewportWidth(1024);
        server.use(jsonGet('/campaigns/7/sessions/s2', SESSION));
        const { container } = renderWithProviders(
            <SessionReaderPage />,
            { route: READER_URL, path: READER_PATH },
        );

        expect(await screen.findByRole('article', { name: 'The glass tower' })).toBeInTheDocument();
        expect(container.querySelectorAll('.session-book-page')).toHaveLength(1);
    });

    it('links to the dedicated transcript page without loading it inside the reader', async () => {
        let transcriptRequests = 0;
        server.use(
            jsonGet('/campaigns/7/sessions/s2', SESSION),
            http.get('/api/v1/campaigns/7/sessions/s2/transcript', () => {
                transcriptRequests += 1;
                return HttpResponse.json({
                    items: [
                        {
                            text: 'The seal is awake.',
                            userId: 'u1',
                            characterName: 'Aria',
                            timestamp: 1_753_000_100,
                            macroLocation: 'North',
                            microLocation: 'Glass tower',
                        },
                    ],
                });
            }),
        );

        renderWithProviders(<SessionReaderPage />, { route: READER_URL, path: READER_PATH });
        await screen.findByRole('article', { name: 'The glass tower' });
        expect(transcriptRequests).toBe(0);

        expect(screen.getByRole('link', { name: 'Read transcript' })).toHaveAttribute(
            'href',
            TRANSCRIPT_URL,
        );
        expect(screen.queryByText('The seal is awake.')).not.toBeInTheDocument();
        expect(transcriptRequests).toBe(0);
    });

    it('keeps the audio player visible when the session master is not ready', async () => {
        server.use(jsonGet('/campaigns/7/sessions/s2', {
            ...SESSION,
            media: { audioAvailable: false, transcriptAvailable: false },
        }));
        renderWithProviders(<SessionReaderPage />, { route: READER_URL, path: READER_PATH });

        expect(await screen.findByLabelText('Listen to audio')).not.toHaveAttribute('src');
        expect(screen.getByText('The session audio mix is not available yet.')).toBeInTheDocument();
    });

    it('keeps working against a detail response without the additive reader fields', async () => {
        const legacy = { ...SESSION };
        delete (legacy as Partial<typeof SESSION>).navigation;
        delete (legacy as Partial<typeof SESSION>).participants;
        delete (legacy as Partial<typeof SESSION>).media;
        server.use(jsonGet('/campaigns/7/sessions/s2', legacy));
        renderWithProviders(<SessionReaderPage />, { route: READER_URL, path: READER_PATH });

        expect(await screen.findByRole('heading', { name: 'The glass tower' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Index' })).toBeInTheDocument();
    });
});

describe('SessionTranscriptPage', () => {
    it('renders the protected transcript on its own page with a link back to the session', async () => {
        server.use(
            jsonGet('/campaigns/7/sessions/s2', SESSION),
            jsonGet('/campaigns/7/sessions/s2/transcript', {
                items: [
                    {
                        text: 'The seal is awake.',
                        userId: 'u1',
                        characterName: 'Aria',
                        timestamp: 1_753_000_100,
                        macroLocation: 'North',
                        microLocation: 'Glass tower',
                    },
                ],
            }),
        );

        renderWithProviders(<SessionTranscriptPage />, {
            route: TRANSCRIPT_URL,
            path: TRANSCRIPT_PATH,
        });

        expect(await screen.findByRole('heading', { name: 'Transcript' })).toBeInTheDocument();
        expect(screen.getByText('The glass tower')).toBeInTheDocument();
        expect(screen.getByText('The seal is awake.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Back to session' })).toHaveAttribute(
            'href',
            READER_URL,
        );
    });
});
