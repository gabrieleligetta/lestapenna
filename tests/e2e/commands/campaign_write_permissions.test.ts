import { CommandDispatcher } from '../../../src/commands/index';
import { Message } from 'discord.js';
import { npcCommand } from '../../../src/commands/npcs/npc';
import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { ensureMembership } from '../../../src/services/campaignAccess';
import { setGuildConfig } from '../../../src/db';

const GUILD = 'write-perms-guild';

/**
 * Before this work, any member of the server who could write in the
 * command channel could run `$npc delete`, and with the cascade introduced shortly
 * before, that delete also takes away the history and the Bardo's memory.
 */
describe('Campaign write permissions on Discord', () => {
    let dispatcher: CommandDispatcher;
    let replyMock: jest.Mock;
    let campaignId: number;

    function messageFrom(userId: string, isAdmin = false): Message {
        return {
            author: { id: userId, bot: false },
            guild: { id: GUILD, preferredLocale: 'en-US' },
            channelId: 'cmd-channel',
            channel: { id: 'cmd-channel', send: jest.fn() },
            content: '',
            reply: replyMock,
            member: { permissions: { has: () => isAdmin } },
        } as unknown as Message;
    }

    function repliesText(): string {
        return replyMock.mock.calls
            .map(([arg]) => (typeof arg === 'string' ? arg : arg?.content ?? ''))
            .join('\n');
    }

    beforeEach(() => {
        wipeDatabase();
        campaignId = campaignRepository.createCampaign(GUILD, 'Perms Campaign');
        campaignRepository.setActiveCampaign(GUILD, campaignId);
        setGuildConfig(GUILD, 'cmd_channel_id', 'cmd-channel');

        npcRepository.updateNpcEntry(campaignId, 'Bersaglio', 'Un NPC qualsiasi');

        dispatcher = new CommandDispatcher({ user: { id: 'bot' } } as never);
        dispatcher.register(npcCommand);
        replyMock = jest.fn();
    });

    it('refuses a delete from someone who is not at the table', async () => {
        const message = messageFrom('outsider');
        message.content = '$npc delete Bersaglio';

        await dispatcher.dispatch(message);

        expect(npcRepository.getNpcEntry(campaignId, 'Bersaglio')).toBeDefined();
        expect(repliesText()).toContain('part of');
    });

    it('lets a table member reach the deletion picker', async () => {
        ensureMembership(campaignId, 'player-1');
        const message = messageFrom('player-1');
        message.content = '$npc delete Bersaglio';

        await dispatcher.dispatch(message);

        // `$npc delete` opens the selection wizard: what matters here is that the
        // member gets to it, not that the entity disappears without confirmation.
        expect(repliesText()).toContain('Deletion');
        expect(repliesText()).not.toContain('part of');
    });

    it('keeps the server administrator in, as a lockout valve', async () => {
        const message = messageFrom('owner', true);
        message.content = '$npc delete Bersaglio';

        await dispatcher.dispatch(message);

        expect(repliesText()).toContain('Deletion');
        expect(repliesText()).not.toContain('part of');
    });

    it('does not open the picker before refusing', async () => {
        const message = messageFrom('outsider');
        message.content = '$npc delete Bersaglio';

        await dispatcher.dispatch(message);

        // The check sits at the entrance to the wizard: offering the list of
        // entities and refusing afterwards would be worse than refusing at once.
        expect(repliesText()).not.toContain('Deletion');
    });
});
