import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { Page } from '../api/types';

/**
 * The register of AI jobs, which the shell asks for on every page.
 *
 * A default handler rather than one per test: the bell and the corner card are
 * mounted by `AppShell`, so every rendered page requests this — and a test about
 * breadcrumbs should not have to know that.
 */
const emptyAiJobs = http.get('/api/v1/me/ai-jobs', () =>
    HttpResponse.json({ items: [], unseen_count: 0, active_count: 0 }));

/**
 * The instance's own links, asked for by the support bar at the foot of every
 * page. Same reasoning as the register above, and the same defaults as a fresh
 * `.env`: a declared donation URL that is not open for business yet.
 */
const defaultAppInfo = http.get('/api/v1/app-info', () =>
    HttpResponse.json({
        donation: { url: 'https://github.com/sponsors/gabrieleligetta', active: false },
        repo_url: 'https://github.com/gabrieleligetta/lestapenna',
        license: 'AGPL-3.0',
    }));

export const server = setupServer(emptyAiJobs, defaultAppInfo);

/** Every list endpoint answers with this envelope — see src/api/common/pagination.ts. */
export function pageOf<T>(items: T[], total = items.length, limit = 25, offset = 0): Page<T> {
    return { items, total, limit, offset };
}

export function jsonGet(path: string, body: unknown, status = 200) {
    return http.get(`/api/v1${path}`, () => HttpResponse.json(body as never, { status }));
}

/**
 * The campaign overview, from which the SPA reads the caller's permissions.
 *
 * Needed in every test that touches writing: `canWrite` is no longer inferred
 * from the guild's `canManage`, because being an administrator of the Discord
 * server and being part of the table are two different things.
 */
export function campaignOverview(campaignId: number | string = 1, overrides: Record<string, unknown> = {}) {
    return jsonGet(`/campaigns/${campaignId}`, {
        id: Number(campaignId),
        name: 'Campaign',
        myRole: 'MASTER',
        canWrite: true,
        canManageMembers: true,
        currentYear: null,
        currentLocation: null,
        partyAlignment: { moral: null, ethical: null },
        party: [],
        lastSession: null,
        counts: {
            sessions: 0, openQuests: 0, npcs: 0, locations: 0,
            factions: 0, inventory: 0, artifacts: 0, bestiary: 0,
        },
        ...overrides,
    });
}

export { http, HttpResponse };
