/**
 * Who is an administrator, and above all who is not.
 *
 * `DISCORD_DEVELOPER_ID` grants the maintenance commands on **every** guild served
 * by the instance. For years it had a default value written into the source: on
 * every installation in the world, one specific person was an administrator everywhere
 * without anyone having decided it. Here we defend the opposite — not
 * configured means nobody — and the lockout that default was hiding.
 */

import { PermissionFlagsBits } from 'discord.js';

const mockGuildConfig = jest.fn<string | null, [string, string]>();
jest.mock('../../../src/db', () => ({
    getGuildConfig: (guildId: string, key: string) => mockGuildConfig(guildId, key),
}));

const mockConfig = { discord: { developerId: '' } };
jest.mock('../../../src/config', () => ({ config: mockConfig }));

import { getGuildAdminId, isGuildAdmin, isGuildOperator } from '../../../src/utils/permissions';

const GUILD = 'gilda-1';
const CHIUNQUE = 'utente-qualsiasi';
const SVILUPPATORE = 'sviluppatore-istanza';

/** A Discord member with or without the server management permissions. */
function member(gestisce: boolean) {
    return { permissions: { has: (flag: bigint) => gestisce && flag === PermissionFlagsBits.ManageGuild } } as any;
}

beforeEach(() => {
    mockGuildConfig.mockReset();
    mockGuildConfig.mockReturnValue(null);
    mockConfig.discord.developerId = '';
});

describe('sviluppatore dell\'istanza non configurato', () => {
    it('makes nobody an administrator', () => {
        expect(isGuildAdmin(CHIUNQUE, GUILD)).toBe(false);
        expect(isGuildAdmin(SVILUPPATORE, GUILD)).toBe(false);
    });

    it('does not make an administrator of someone arriving with an empty identity', () => {
        // `userId === ''` would be false on its own, but the comparison must not
        // depend on that: the day a call passes an empty string
        // as an identity, global access would open by itself.
        expect(isGuildAdmin('', GUILD)).toBe(false);
    });

    it('still lets whoever manages the server on Discord govern it', () => {
        // This is the case of someone who has just installed their own instance: without
        // this they would be locked out of their own server's commands.
        expect(isGuildOperator(CHIUNQUE, GUILD, member(true))).toBe(true);
        expect(isGuildOperator(CHIUNQUE, GUILD, member(false))).toBe(false);
    });

    it('does not invent an administrator that does not exist', () => {
        expect(getGuildAdminId(GUILD)).toBe('');
    });
});

describe('sviluppatore dell\'istanza configurato', () => {
    beforeEach(() => { mockConfig.discord.developerId = SVILUPPATORE; });

    it('is an administrator everywhere, which is the point of that variable', () => {
        expect(isGuildAdmin(SVILUPPATORE, GUILD)).toBe(true);
        expect(isGuildAdmin(SVILUPPATORE, 'un\'altra-gilda')).toBe(true);
    });

    it('does not extend the power to anyone else', () => {
        expect(isGuildAdmin(CHIUNQUE, GUILD)).toBe(false);
    });

    it('gives way to the administrator the guild chose for itself', () => {
        mockGuildConfig.mockReturnValue('admin-di-gilda');
        expect(getGuildAdminId(GUILD)).toBe('admin-di-gilda');
        expect(isGuildAdmin('admin-di-gilda', GUILD)).toBe(true);
        // Without losing their own, though: it is there to be able to step in.
        expect(isGuildAdmin(SVILUPPATORE, GUILD)).toBe(true);
    });
});
