/**
 * The instance's public identity.
 *
 * One thing matters here: the three states of a donation channel. A fork that
 * asks for nothing must not offer anything, and a channel that is declared but
 * not yet open must be offered **inert** — a sponsorship page that was never
 * published redirects to a plain profile, so a live link would take the reader
 * somewhere that asks them for nothing at all.
 *
 * And, since there are two channels, that those states are **independent**:
 * Ko-fi accepts money as soon as Stripe clears while GitHub Sponsors waits on a
 * tax profile, so one being shut must never hold the other back.
 */

const mockConfig = {
    links: {
        donationUrl: 'https://example.test/sponsor',
        donationActive: false,
        kofiUrl: 'https://example.test/kofi',
        kofiActive: true,
        repoUrl: 'https://example.test/repo',
        webAppUrl: 'https://example.test',
        nudgesEnabled: true,
        contactEmail: '',
    },
};
jest.mock('../../../src/config', () => ({ config: mockConfig }));

import { AppInfoController } from '../../../src/api/appInfo/appInfo.controller';
import type { DonationPlatform } from '../../../src/api/appInfo/appInfo.dto';

const DEFAULTS = { ...mockConfig.links };
const controller = new AppInfoController();

/** The channel for a platform, or undefined when the instance does not offer it. */
function channel(platform: DonationPlatform) {
    return controller.getAppInfo().donations.find(entry => entry.platform === platform);
}

beforeEach(() => {
    mockConfig.links = { ...DEFAULTS };
});

describe('GET /api/v1/app-info', () => {
    it('reports the licence and the repository this instance was built from', () => {
        const info = controller.getAppInfo();

        expect(info.license).toBe('AGPL-3.0');
        expect(info.repo_url).toBe('https://example.test/repo');
    });

    it('keeps a declared donation channel visible but inactive until it is open', () => {
        expect(channel('github')).toEqual({
            platform: 'github',
            url: 'https://example.test/sponsor',
            active: false,
        });
    });

    it('activates the channel once the instance says it accepts money', () => {
        mockConfig.links.donationActive = true;

        expect(channel('github')?.active).toBe(true);
    });

    it('lets one channel be open while the other is still waiting', () => {
        // The reason the payload is a list rather than a single object: this is
        // the real state of the project on the day Ko-fi went live, and a shared
        // flag would have forced hiding the channel that worked.
        expect(channel('kofi')?.active).toBe(true);
        expect(channel('github')?.active).toBe(false);
    });

    it('drops a channel an instance does not use, rather than showing it inert', () => {
        mockConfig.links.kofiUrl = '';
        mockConfig.links.kofiActive = true;

        // Inert means "declared, not open yet". A fork that simply has no Ko-fi
        // is not waiting for anything, so the button must not exist at all.
        expect(channel('kofi')).toBeUndefined();
        expect(controller.getAppInfo().donations).toHaveLength(1);
    });

    it('offers nothing at all when an instance collects nothing', () => {
        mockConfig.links.donationUrl = '';
        mockConfig.links.kofiUrl = '';

        expect(controller.getAppInfo().donations).toEqual([]);
    });
});
