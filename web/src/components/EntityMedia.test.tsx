import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityMedia, EntityThumbnail } from './EntityMedia';
import { EntityMediaManager } from './EntityMediaManager';
import { renderWithProviders } from '../test/renderWithProviders';
import { HttpResponse, http, server } from '../test/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('EntityMedia', () => {
    it('falls back without layout loss when an entity has no image or the image fails', () => {
        const { container, rerender } = renderWithProviders(
            <EntityMedia image={null} icon="npcs" />,
        );
        expect(container.querySelector('.entity-media__fallback')).toBeInTheDocument();

        rerender(
            <EntityMedia
                icon="npcs"
                image={{
                    id: 'm1',
                    thumbnailUrl: '/thumb',
                    displayUrl: '/display',
                    width: 800,
                    height: 1000,
                    altText: 'Portrait',
                    updatedAt: 1,
                }}
            />,
        );
        fireEvent.error(screen.getByRole('img', { name: 'Portrait' }));
        expect(container.querySelector('.entity-media__fallback')).toBeInTheDocument();
    });

    it('opens the picture full screen and closes it with Escape', async () => {
        const user = userEvent.setup();
        renderWithProviders(
            <EntityMedia
                icon="npcs"
                image={{
                    id: 'm1',
                    thumbnailUrl: '/thumb',
                    displayUrl: '/display',
                    width: 800,
                    height: 1000,
                    altText: 'Portrait',
                    updatedAt: 1,
                }}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Enlarge image' }));
        const dialog = screen.getByRole('dialog');
        expect(dialog.querySelector('img')).toHaveAttribute('src', '/display');

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('enlarges a zoomable thumbnail at display resolution, not at 48px', async () => {
        const user = userEvent.setup();
        renderWithProviders(
            <EntityThumbnail
                icon="characters"
                zoomable
                image={{
                    id: 'm2',
                    thumbnailUrl: '/thumb',
                    displayUrl: '/display',
                    width: 800,
                    height: 1000,
                    altText: 'Sephirot',
                    updatedAt: 1,
                }}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Enlarge image' }));
        expect(screen.getByRole('dialog').querySelector('img')).toHaveAttribute('src', '/display');
    });

    it('leaves a plain thumbnail decorative, so it cannot steal the row link', () => {
        const { container } = renderWithProviders(
            <EntityThumbnail
                icon="characters"
                image={{
                    id: 'm3',
                    thumbnailUrl: '/thumb',
                    displayUrl: '/display',
                    width: 800,
                    height: 1000,
                    altText: 'Sephirot',
                    updatedAt: 1,
                }}
            />,
        );

        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(container.querySelector('.entity-thumbnail')).toHaveAttribute('aria-hidden', 'true');
    });

    it('keeps mutation controls hidden from readers', () => {
        renderWithProviders(
            <EntityMediaManager
                campaignId="7"
                entityType="npc"
                entityId="npc1"
                image={null}
                canEdit={false}
            />,
        );
        expect(screen.queryByText('Image')).not.toBeInTheDocument();
    });

    it('uploads a validated image through the authenticated campaign endpoint', async () => {
        const user = userEvent.setup();
        let uploaded = false;
        server.use(
            http.put('/api/v1/campaigns/7/npc/npc1/image', () => {
                uploaded = true;
                return HttpResponse.json({
                    id: 'm1',
                    thumbnailUrl: '/thumb',
                    displayUrl: '/display',
                    width: 800,
                    height: 1000,
                    altText: null,
                    updatedAt: 1,
                });
            }),
        );
        renderWithProviders(
            <EntityMediaManager
                campaignId="7"
                entityType="npc"
                entityId="npc1"
                image={null}
                canEdit
            />,
        );

        await user.click(screen.getByText('Image'));
        await user.upload(
            screen.getByLabelText('Upload'),
            new File(['image-bytes'], 'portrait.png', { type: 'image/png' }),
        );
        await user.click(screen.getByRole('button', { name: 'Upload' }));

        expect(await screen.findByText('Image updated')).toBeInTheDocument();
        expect(uploaded).toBe(true);
    });
});

/**
 * Enlarging a picture when the entity has several.
 *
 * The gallery existed and there was nowhere to look at it: you could open the
 * one on the sheet and that was all. Arrow keys, buttons and dots all move
 * through the set, and the set is only fetched once somebody has actually
 * asked to see it — a list of thirty cards should not load thirty galleries.
 */
describe('the lightbox carousel', () => {
    const picture = (id: string) => ({
        id,
        thumbnailUrl: `/thumb/${id}`,
        displayUrl: `/display/${id}`,
        width: 800,
        height: 1000,
        altText: `Picture ${id}`,
        updatedAt: 1,
    });

    it('loads the rest of the gallery only when one is enlarged, and steps through it', async () => {
        let galleryRequests = 0;
        server.use(http.get('/api/v1/campaigns/1/npc/astr1/images', () => {
            galleryRequests += 1;
            return HttpResponse.json([picture('a'), picture('b')]);
        }));
        const user = userEvent.setup();

        renderWithProviders(
            <EntityMedia
                image={picture('a')}
                icon="npcs"
                campaignId="1"
                entityType="npc"
                entityId="astr1"
            />,
        );

        expect(galleryRequests).toBe(0);

        await user.click(screen.getByRole('button', { name: /enlarge/i }));
        expect(await screen.findByRole('button', { name: /next picture/i })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /next picture/i }));
        expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Picture b');
    });

    it('stays a plain lightbox for a picture with no entity behind it', async () => {
        const user = userEvent.setup();
        renderWithProviders(<EntityMedia image={picture('a')} icon="npcs" />);

        await user.click(screen.getByRole('button', { name: /enlarge/i }));

        expect(screen.queryByRole('button', { name: /next picture/i })).not.toBeInTheDocument();
    });
});
