import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { SupportBar } from './SupportBar';
import { renderWithProviders } from '../test/renderWithProviders';
import { server, jsonGet } from '../test/server';
import { en } from '../i18n/en';

function appInfo(donation: { url: string; active: boolean }) {
    return jsonGet('/app-info', {
        donation,
        repo_url: 'https://github.com/gabrieleligetta/lestapenna',
        license: 'AGPL-3.0',
    });
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('SupportBar', () => {
    it('links to the donation page once the channel is open', async () => {
        server.use(appInfo({ url: 'https://github.com/sponsors/someone', active: true }));
        renderWithProviders(<SupportBar />);

        const link = await screen.findByRole('link', { name: en.support.donate });
        expect(link).toHaveAttribute('href', 'https://github.com/sponsors/someone');
    });

    it('names the donation without making it clickable while it is not open', async () => {
        server.use(appInfo({ url: 'https://github.com/sponsors/someone', active: false }));
        renderWithProviders(<SupportBar />);

        const pending = await screen.findByText(en.support.donate);
        expect(pending).toHaveAttribute('aria-disabled', 'true');
        expect(pending.tagName).toBe('SPAN');
        // The whole point of the inert state: no reader can reach a page that
        // would ask them for nothing.
        expect(screen.queryByRole('link', { name: en.support.donate })).toBeNull();
    });

    it('omits the donation entirely when the instance asks for nothing', async () => {
        server.use(appInfo({ url: '', active: false }));
        renderWithProviders(<SupportBar />);

        // The source link resolves from the same payload, so its arrival proves
        // the query settled before we assert on the absence of the other one.
        await screen.findByRole('link', { name: en.support.source });
        expect(screen.queryByText(en.support.donate)).toBeNull();
    });

    it('shows what it already knows while the instance details are still loading', () => {
        renderWithProviders(<SupportBar />);

        expect(screen.getByText(en.support.tagline)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: en.support.license })).toBeInTheDocument();
    });

    it('opens the outward links in a new tab, safely', async () => {
        server.use(appInfo({ url: 'https://github.com/sponsors/someone', active: true }));
        renderWithProviders(<SupportBar />);

        const source = await screen.findByRole('link', { name: en.support.source });
        expect(source).toHaveAttribute('target', '_blank');
        expect(source).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('is reachable as a landmark', async () => {
        renderWithProviders(<SupportBar />);

        await waitFor(() =>
            expect(screen.getByRole('contentinfo', { name: en.support.label })).toBeInTheDocument());
    });
});
