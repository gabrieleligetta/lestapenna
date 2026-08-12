import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route } from 'react-router-dom';
import { RequireAuth } from './RequireAuth';
import { LoginPage } from './LoginPage';
import { renderRoutes } from '../test/renderWithProviders';
import { server, jsonGet } from '../test/server';

const ME = { id: 'u1', username: 'gm', globalName: null, avatar: null };
const DEEP_LINK = '/guilds/g1/campaigns/1/npcs';

function renderApp(route: string) {
    return renderRoutes(
        <>
            <Route path="/" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
                <Route path="/guilds" element={<p>guild list</p>} />
                <Route path={DEEP_LINK} element={<p>npc list</p>} />
            </Route>
        </>,
        { route },
    );
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
    server.resetHandlers();
    sessionStorage.clear();
});
afterAll(() => server.close());

describe('post-login return path', () => {
    it('remembers where the user was heading before the login bounce', async () => {
        server.use(jsonGet('/me', { message: 'Unauthorized' }, 401));
        renderApp(DEEP_LINK);

        expect(await screen.findByText('Log in with Discord')).toBeInTheDocument();
        // sessionStorage, not router state: logging in leaves the SPA entirely
        // (API → Discord → API), so anything held in memory is gone on return.
        expect(sessionStorage.getItem('lp_return_to')).toBe(DEEP_LINK);
    });

    it('lands on that destination instead of the generic home', async () => {
        sessionStorage.setItem('lp_return_to', DEEP_LINK);
        server.use(jsonGet('/me', ME));
        renderApp('/');

        expect(await screen.findByText('npc list')).toBeInTheDocument();
    });

    it('refuses a protocol-relative path, which would navigate off-site', async () => {
        sessionStorage.setItem('lp_return_to', '//evil.example/phish');
        server.use(jsonGet('/me', ME));
        renderApp('/');

        expect(await screen.findByText('guild list')).toBeInTheDocument();
    });
});
