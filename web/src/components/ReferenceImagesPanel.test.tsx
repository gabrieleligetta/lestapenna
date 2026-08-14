import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceImagesPanel } from './ReferenceImagesPanel';
import { renderWithProviders } from '../test/renderWithProviders';
import { HttpResponse, http, server } from '../test/server';

beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
    // jsdom has no object URLs, and the draft card previews the chosen file.
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REFERENCE = {
    id: 'reference:1',
    scope: 'faction',
    scope_key: 'wtwmk',
    imageUrl: '/reference.webp',
    width: 800,
    height: 800,
    label: 'Iron dames livery',
    roles: ['clothing', 'armor_equipment'],
    instruction: null,
    auto_select: true,
    created_at: 1,
};

beforeEach(() => {
    server.use(
        http.get('/api/v1/campaigns/7/references', () => HttpResponse.json([REFERENCE])),
    );
});

function render() {
    return renderWithProviders(
        <ReferenceImagesPanel campaignId="7" scope="faction" scopeKey="wtwmk" canEdit />,
    );
}

/**
 * The pictures a faction or a campaign is drawn from.
 *
 * What these tests hold down is that every field on this panel belongs to one
 * picture and ends in a button: the note typed for a new reference used to be
 * sent as a side effect of picking a file, which is how it read as the settings
 * of the pictures already saved.
 */
describe('ReferenceImagesPanel', () => {
    it('uploads nothing until the button under the chosen picture is pressed', async () => {
        const user = userEvent.setup();
        // Read as raw multipart: undici's FormData rejects a jsdom File part,
        // so parsing the body here would fail the request rather than the test.
        let posted: string | null = null;
        server.use(
            http.post('/api/v1/campaigns/7/references', async ({ request }) => {
                posted = await request.text();
                return HttpResponse.json({ ...REFERENCE, id: 'reference:2' });
            }),
        );

        render();
        await screen.findByText('Iron dames livery');

        const file = new File(['bytes'], 'livery.png', { type: 'image/png' });
        await user.upload(screen.getByLabelText('Choose an image'), file);

        await user.type(screen.getByLabelText('Note'), 'The armour the iron dames wear');
        expect(posted).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Add a reference' }));

        await waitFor(() => expect(posted).not.toBeNull());
        expect(posted).toContain('The armour the iron dames wear');
        expect(posted).toContain(JSON.stringify(['clothing', 'armor_equipment']));
    });

    it('drops the draft, and its words, when the upload is cancelled', async () => {
        const user = userEvent.setup();
        render();
        await screen.findByText('Iron dames livery');

        const file = new File(['bytes'], 'livery.png', { type: 'image/png' });
        await user.upload(screen.getByLabelText('Choose an image'), file);
        await user.type(screen.getByLabelText('Note'), 'Something I changed my mind about');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByText('New reference')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Note')).not.toBeInTheDocument();
    });

    it('corrects the note of a saved picture, which upload was the only way to set', async () => {
        const user = userEvent.setup();
        let patched: any = null;
        server.use(
            http.patch('/api/v1/campaigns/7/references/reference:1', async ({ request }) => {
                patched = await request.json();
                return HttpResponse.json({ ...REFERENCE, label: 'Iron dames, winter livery' });
            }),
        );

        render();
        await user.click(await screen.findByRole('button', { name: 'Edit default use' }));

        const note = screen.getByLabelText('Note');
        await user.clear(note);
        await user.type(note, 'Iron dames, winter livery');
        await user.click(screen.getByRole('button', { name: 'Save default use' }));

        await waitFor(() => expect(patched).not.toBeNull());
        expect(patched.label).toBe('Iron dames, winter livery');
        expect(patched.roles).toEqual(['clothing', 'armor_equipment']);
    });
});
