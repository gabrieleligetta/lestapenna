import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { SupportBar } from './SupportBar';
import { renderWithProviders } from '../test/renderWithProviders';
import { server, jsonGet } from '../test/server';
import { en } from '../i18n/en';
import type { DonationChannel } from '../api/types';

const KOFI = 'Ko-fi';
const SPONSORS = 'GitHub Sponsors';

function appInfo(donations: DonationChannel[]) {
    return jsonGet('/app-info', {
        donations,
        repo_url: 'https://github.com/gabrieleligetta/lestapenna',
        license: 'AGPL-3.0',
    });
}

const kofi = (active: boolean): DonationChannel =>
    ({ platform: 'kofi', url: 'https://ko-fi.com/someone', active });
const github = (active: boolean): DonationChannel =>
    ({ platform: 'github', url: 'https://github.com/sponsors/someone', active });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('SupportBar', () => {
    it('links to a donation platform once its channel is open', async () => {
        server.use(appInfo([kofi(true)]));
        renderWithProviders(<SupportBar />);

        const link = await screen.findByRole('link', { name: en.support.donateOn(KOFI) });
        expect(link).toHaveAttribute('href', 'https://ko-fi.com/someone');
    });

    it('names a platform without making it clickable while it is not open', async () => {
        server.use(appInfo([github(false)]));
        renderWithProviders(<SupportBar />);

        const pending = await screen.findByText(SPONSORS);
        expect(pending).toHaveAttribute('aria-disabled', 'true');
        expect(pending.tagName).toBe('SPAN');
        // The whole point of the inert state: no reader can reach a page that
        // would ask them for nothing.
        expect(screen.queryByRole('link', { name: en.support.donateOn(SPONSORS) })).toBeNull();
    });

    it('opens the channel that works while the other is still waiting', async () => {
        // The reason this is a list: on the day Ko-fi went live, Sponsors was
        // still weeks from a tax profile. One shared flag would have meant
        // hiding a channel that could already take money.
        server.use(appInfo([kofi(true), github(false)]));
        renderWithProviders(<SupportBar />);

        expect(await screen.findByRole('link', { name: en.support.donateOn(KOFI) })).toBeInTheDocument();
        expect(screen.getByText(SPONSORS)).toHaveAttribute('aria-disabled', 'true');
    });

    it('tells the reader which platform each button opens', async () => {
        server.use(appInfo([kofi(true), github(true)]));
        renderWithProviders(<SupportBar />);

        // A mark on its own is a guess for anyone who cannot see it, and a
        // guess for anyone who does not recognise it.
        const kofiLink = await screen.findByRole('link', { name: en.support.donateOn(KOFI) });
        const sponsorsLink = screen.getByRole('link', { name: en.support.donateOn(SPONSORS) });
        expect(kofiLink).toHaveTextContent(KOFI);
        expect(sponsorsLink).toHaveTextContent(SPONSORS);
    });

    it('omits donations entirely when the instance asks for nothing', async () => {
        server.use(appInfo([]));
        renderWithProviders(<SupportBar />);

        // The source link resolves from the same payload, so its arrival proves
        // the query settled before we assert on the absence of the others.
        await screen.findByRole('link', { name: en.support.source });
        expect(screen.queryByText(KOFI)).toBeNull();
        expect(screen.queryByText(SPONSORS)).toBeNull();
    });

    it('shows what it already knows while the instance details are still loading', () => {
        renderWithProviders(<SupportBar />);

        expect(screen.getByText(en.support.tagline)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: en.support.license })).toBeInTheDocument();
    });

    it('opens the outward links in a new tab, safely', async () => {
        server.use(appInfo([kofi(true)]));
        renderWithProviders(<SupportBar />);

        for (const name of [en.support.source, en.support.donateOn(KOFI)]) {
            const link = await screen.findByRole('link', { name });
            expect(link).toHaveAttribute('target', '_blank');
            expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        }
    });

    it('is reachable as a landmark', async () => {
        renderWithProviders(<SupportBar />);

        await waitFor(() =>
            expect(screen.getByRole('contentinfo', { name: en.support.label })).toBeInTheDocument());
    });
});
