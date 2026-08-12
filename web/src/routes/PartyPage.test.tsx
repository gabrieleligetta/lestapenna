import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { PartyPage } from './PartyPage';
import { CampaignProvider } from '../context/CampaignContext';
import { renderWithProviders } from '../test/renderWithProviders';
import { server, jsonGet } from '../test/server';
import type { CampaignOverview } from '../api/types';

const OVERVIEW = {
    id: 1,
    name: 'Ashes of Vaelor',
    myRole: 'PLAYER',
    canWrite: true,
    canManageMembers: false,
    currentYear: null,
    currentLocation: null,
    partyAlignment: { moral: null, ethical: null },
    party: [],
    lastSession: null,
    counts: { sessions: 0, openQuests: 0, npcs: 0, locations: 0, factions: 0, inventory: 0, artifacts: 0, bestiary: 0 },
} as CampaignOverview;

const PARTY = {
    name: 'The Ashen Hand',
    factionShortId: 'gdb6h',
    alignmentSource: 'faction' as const,
    alignment: {
        moral: { score: 60, label: 'GOOD' as const },
        ethical: { score: -40, label: 'CHAOTIC' as const },
        cell: 'CHAOTIC_GOOD',
    },
    members: [
        {
            userId: 'pc-1',
            name: 'Aria',
            race: 'Human',
            class: 'Bard',
            role: 'LEADER',
            alignment: {
                moral: { score: 70, label: 'GOOD' as const },
                ethical: { score: 5, label: 'NEUTRAL' as const },
                cell: 'NEUTRAL_GOOD',
            },
            hasBio: true,
        },
        {
            userId: 'dm-1',
            name: 'Zora',
            race: null,
            class: null,
            role: null,
            alignment: {
                moral: { score: 0, label: 'NEUTRAL' as const },
                ethical: { score: 0, label: 'NEUTRAL' as const },
                cell: 'NEUTRAL_NEUTRAL',
            },
            hasBio: false,
        },
    ],
};

function renderParty() {
    return renderWithProviders(
        <CampaignProvider value={{ guildId: 'g1', campaignId: '1', overview: OVERVIEW }}>
            <PartyPage />
        </CampaignProvider>,
    );
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('PartyPage', () => {
    it('titles the page with the party faction, not the campaign', async () => {
        server.use(jsonGet('/campaigns/1/party', PARTY));
        renderParty();

        expect(await screen.findByRole('heading', { name: 'The Ashen Hand' })).toBeInTheDocument();
    });

    it('shows both alignment axes as meters', async () => {
        server.use(jsonGet('/campaigns/1/party', PARTY));
        renderParty();

        expect(await screen.findByRole('meter', { name: 'Moral' })).toHaveAttribute('aria-valuenow', '60');
        expect(screen.getByRole('meter', { name: 'Ethical' })).toHaveAttribute('aria-valuenow', '-40');
    });

    it('lists a member with no affiliation role — the DM is in the roster', async () => {
        server.use(jsonGet('/campaigns/1/party', PARTY));
        renderParty();

        expect(await screen.findByRole('link', { name: 'Zora' })).toBeInTheDocument();
        expect(screen.getByText('LEADER')).toBeInTheDocument();
    });

    it('renders each member’s own alignment, using the label the API sent', async () => {
        server.use(jsonGet('/campaigns/1/party', PARTY));
        renderParty();

        // Aria is moral 70 / ethical 5: inside the ±25 neutral band on the
        // ethical axis, so the cell is Neutral Good, not Lawful Good.
        await screen.findByRole('link', { name: 'Aria' });
        expect(screen.getByText('Neutral Good')).toBeInTheDocument();
        expect(screen.getByText('True Neutral')).toBeInTheDocument();
    });

    it('says when the alignment is only the campaign fallback', async () => {
        server.use(
            jsonGet('/campaigns/1/party', { ...PARTY, name: 'Ashes of Vaelor', alignmentSource: 'campaign' }),
        );
        renderParty();

        expect(await screen.findByText(/alignment from the campaign/i)).toBeInTheDocument();
    });

    it('links each member to their character sheet', async () => {
        server.use(jsonGet('/campaigns/1/party', PARTY));
        renderParty();

        const list = await screen.findByRole('list');
        expect(within(list).getByRole('link', { name: 'Aria' })).toHaveAttribute(
            'href',
            '/guilds/g1/campaigns/1/characters/pc-1',
        );
    });
});
