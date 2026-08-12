import { CommandDispatcher } from '../../../src/commands/index';
import { Message } from 'discord.js';
import { deleteCampaignCommand } from '../../../src/commands/campaigns/delete';
import { syncCommand } from '../../../src/commands/admin/sync';
import * as db from '../../../src/db';

jest.mock('../../../src/db', () => ({
    getActiveCampaign: jest.fn(),
    getGuildConfig: jest.fn(),
    getCampaigns: jest.fn(),
    deleteCampaign: jest.fn(),
    db: { prepare: jest.fn() },
    factionRepository: {
        getPartyFaction: jest.fn().mockReturnValue(null),
        createPartyFaction: jest.fn().mockReturnValue(null),
        ensurePartyMembership: jest.fn(),
    },
}));

/**
 * The heavy operations — deleting a campaign, resyncing everything — could be
 * run by anyone able to write in the command channel. `$sync` on top of that
 * listed the campaigns of EVERY server, not just its own.
 */
describe('Operator-only commands', () => {
    let dispatcher: CommandDispatcher;
    let replyMock: jest.Mock;

    function messageFrom(userId: string, isAdmin: boolean): Message {
        return {
            author: { id: userId, bot: false },
            guild: { id: 'guild-1' },
            channelId: 'channel-1',
            channel: { id: 'channel-1', send: jest.fn() },
            content: '',
            reply: replyMock,
            member: { permissions: { has: () => isAdmin } },
        } as unknown as Message;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        dispatcher = new CommandDispatcher({ user: { id: 'bot' } } as never);
        dispatcher.register(deleteCampaignCommand);
        dispatcher.register(syncCommand);

        replyMock = jest.fn();
        (db.getGuildConfig as jest.Mock).mockImplementation((_guild: string, key: string) =>
            key === 'cmd_channel_id' ? 'channel-1' : null);
        (db.getActiveCampaign as jest.Mock).mockReturnValue({ id: 1, name: 'Campaign 1' });
        (db.getCampaigns as jest.Mock).mockReturnValue([{ id: 1, name: 'Campaign 1', guild_id: 'guild-1' }]);
    });

    it('refuses to delete a campaign for a plain member', async () => {
        const message = messageFrom('random-user', false);
        message.content = '$eliminacampagna Campaign 1';

        await dispatcher.dispatch(message);

        expect(db.deleteCampaign).not.toHaveBeenCalled();
        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('$deletecampaign'));
    });

    it('lets a server administrator through to the confirmation step', async () => {
        const message = messageFrom('random-user', true);
        message.content = '$eliminacampagna Campaign 1';

        await dispatcher.dispatch(message);

        // It does not delete straight away — the command asks for confirmation — but it is not
        // stopped by the dispatcher: the reply is not the refusal.
        expect(replyMock).toHaveBeenCalled();
        const replies = replyMock.mock.calls.map(([arg]) =>
            typeof arg === 'string' ? arg : arg?.content ?? '');
        expect(replies.join('\n')).not.toContain('$deletecampaign');
    });

    it('refuses $sync for a plain member', async () => {
        const message = messageFrom('random-user', false);
        message.content = '$sync';

        await dispatcher.dispatch(message);

        expect(db.getCampaigns).not.toHaveBeenCalled();
        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('$sync'));
    });

    it('scopes $sync to the caller’s own guild', async () => {
        const message = messageFrom('random-user', true);
        message.content = '$sync';

        await dispatcher.dispatch(message);

        // The query was `SELECT id, name FROM campaigns` with no WHERE: from any
        // server you could list everyone else's campaigns.
        expect(db.getCampaigns).toHaveBeenCalledWith('guild-1');
        expect((db.db as unknown as { prepare: jest.Mock }).prepare).not.toHaveBeenCalled();
    });
});
