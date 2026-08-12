/**
 * The instance's public identity.
 *
 * One thing matters here: the three states of the donation item. A fork that
 * asks for nothing must not offer anything, and an instance whose channel is
 * declared but not yet open must offer it **inert** — a sponsorship page that
 * was never published redirects to a plain profile, so a live link would take
 * the reader somewhere that asks them for nothing at all.
 */

const mockConfig = {
    links: {
        donationUrl: 'https://example.test/sponsor',
        donationActive: false,
        repoUrl: 'https://example.test/repo',
        webAppUrl: 'https://example.test',
        nudgesEnabled: true,
        contactEmail: '',
    },
};
jest.mock('../../../src/config', () => ({ config: mockConfig }));

import { AppInfoController } from '../../../src/api/appInfo/appInfo.controller';

const DEFAULTS = { ...mockConfig.links };
const controller = new AppInfoController();

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
        const info = controller.getAppInfo();

        expect(info.donation.url).toBe('https://example.test/sponsor');
        expect(info.donation.active).toBe(false);
    });

    it('activates the channel once the instance says it accepts money', () => {
        mockConfig.links.donationActive = true;

        expect(controller.getAppInfo().donation.active).toBe(true);
    });

    it('never activates a donation an instance has switched off', () => {
        mockConfig.links.donationUrl = '';
        mockConfig.links.donationActive = true;

        // The two flags could disagree, and the honest reading of "no URL" is
        // "this fork collects nothing" — not a live link to an empty address.
        const info = controller.getAppInfo();
        expect(info.donation.url).toBe('');
        expect(info.donation.active).toBe(false);
    });
});
