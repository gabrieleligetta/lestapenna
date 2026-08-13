import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { LoginDonationButtons } from './LoginDonationButtons';
import { renderWithProviders } from '../test/renderWithProviders';
import { http, HttpResponse, server } from '../test/server';
import { en } from '../i18n/en';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('LoginDonationButtons', () => {
    it('shows active donation destinations to signed-out visitors', async () => {
        renderWithProviders(<LoginDonationButtons />);

        const link = await screen.findByRole('link', { name: en.support.donateOn('Ko-fi') });
        expect(link).toHaveAttribute('href', 'https://ko-fi.com/gabrieleligetta');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('does not turn an inactive channel into a donation button', async () => {
        renderWithProviders(<LoginDonationButtons />);

        await screen.findByRole('link', { name: en.support.donateOn('Ko-fi') });
        expect(screen.queryByRole('link', { name: en.support.donateOn('GitHub Sponsors') })).toBeNull();
    });

    it('stays absent when the instance has no active donation channel', async () => {
        server.use(http.get('/api/v1/app-info', () => HttpResponse.json({
            donations: [], repo_url: '', license: 'AGPL-3.0',
        })));
        const { container } = renderWithProviders(<LoginDonationButtons />);

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(container).toBeEmptyDOMElement();
    });
});
