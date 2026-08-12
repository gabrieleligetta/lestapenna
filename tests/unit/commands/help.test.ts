/**
 * $help / $aiuto, now built from the registry.
 *
 * The old help was hand-written prose repeated in six locales, and it had
 * drifted: it advertised `$resetpg` and `$clearchara`, which are registered
 * nowhere, and omitted about half the real command table. These tests pin the
 * property that replaced that prose — the page shows what is registered — plus
 * the two things a reader relies on: destructive commands stay out of the way,
 * and asking about one command answers about that command.
 */

import { helpCommand } from '../../../src/commands/help/help';
import { aiutoCommand } from '../../../src/commands/help/aiuto';
import { CommandContext, Command } from '../../../src/commands/types';
import { EmbedBuilder } from 'discord.js';

/** A registry just big enough to exercise the renderer. */
const FAKE_COMMANDS: Command[] = [
    {
        name: 'listen', aliases: ['ascolta'], requiresCampaign: true,
        category: 'sessione', descriptionKey: 'help.cmd.listen',
        execute: async () => {},
    },
    {
        name: 'stop', aliases: ['termina'], requiresCampaign: false,
        category: 'sessione', descriptionKey: 'help.cmd.stop',
        execute: async () => {},
    },
    {
        name: 'npc', aliases: ['dossier'], requiresCampaign: true,
        category: 'entita', descriptionKey: 'help.cmd.npc',
        usage: [{ usage: '$npc #ID', descriptionKey: 'help.cmd.npc' }],
        execute: async () => {},
    },
    {
        name: 'metrics', aliases: ['metriche'], requiresCampaign: false,
        category: 'admin', descriptionKey: 'help.cmd.metrics', adminOnly: true,
        execute: async () => {},
    },
    {
        name: 'rebuild', aliases: ['reindex'], requiresCampaign: false,
        category: 'dev', descriptionKey: 'help.cmd.rebuild', operatorOnly: true,
        execute: async () => {},
    },
];

function makeContext(args: string[] = []): { ctx: CommandContext; reply: jest.Mock } {
    const reply = jest.fn().mockResolvedValue({
        createMessageComponentCollector: () => ({ on: jest.fn() }),
        edit: jest.fn(),
    });
    const ctx = {
        locale: 'it' as const,
        message: { reply, author: { id: 'author-1' } } as never,
        args,
        guildId: 'guild-1',
        activeCampaign: null,
        client: {} as never,
        dispatcher: { getCommands: () => FAKE_COMMANDS } as never,
    };
    return { ctx, reply };
}

/** All the text of a reply, embeds included, as one searchable string. */
function replyText(reply: jest.Mock): string {
    return reply.mock.calls.map(call => {
        const arg = call[0];
        if (typeof arg === 'string') return arg;
        const embeds = (arg.embeds || []) as EmbedBuilder[];
        return embeds.map(e => JSON.stringify(e.data)).join(' ');
    }).join(' ');
}

describe('$help', () => {
    it('lists the registered commands instead of a hand-written list', async () => {
        const { ctx, reply } = makeContext();
        await helpCommand.execute(ctx);

        const text = replyText(reply);
        expect(text).toContain('$listen');
        expect(text).toContain('$stop');
    });

    it('keeps destructive commands off the normal pages', async () => {
        const { ctx, reply } = makeContext();
        await helpCommand.execute(ctx);
        expect(replyText(reply)).not.toContain('$rebuild');
    });

    it('shows them under `dev`, because they still exist', async () => {
        const { ctx, reply } = makeContext(['dev']);
        await helpCommand.execute(ctx);
        expect(replyText(reply)).toContain('$rebuild');
    });

    it('marks the commands that need server permissions', async () => {
        const { ctx, reply } = makeContext(['admin']);
        await helpCommand.execute(ctx);
        const text = replyText(reply);
        expect(text).toContain('$metrics');
        expect(text).toContain('admin');
    });

    it('answers about a single command, by name', async () => {
        const { ctx, reply } = makeContext(['npc']);
        await helpCommand.execute(ctx);
        const text = replyText(reply);
        expect(text).toContain('$npc');
        expect(text).toContain('$npc #ID'); // its usage
    });

    it('answers about a single command by alias too', async () => {
        const { ctx, reply } = makeContext(['dossier']);
        await helpCommand.execute(ctx);
        expect(replyText(reply)).toContain('$npc');
    });

    it('says so when the command does not exist', async () => {
        const { ctx, reply } = makeContext(['resetpg']);
        await helpCommand.execute(ctx);
        expect(replyText(reply)).toContain('resetpg');
        expect(reply.mock.calls[0][0]).toEqual(expect.stringContaining('❌'));
    });

    it('opens directly on a category when named', async () => {
        const { ctx, reply } = makeContext(['entita']);
        await helpCommand.execute(ctx);
        expect(replyText(reply)).toContain('$npc');
    });
});

describe('$aiuto', () => {
    it('answers in Italian whatever the server language is', async () => {
        const { ctx, reply } = makeContext();
        // Guild set to German: $aiuto must ignore it, that is its whole purpose.
        (ctx as { locale: string }).locale = 'de';
        await aiutoCommand.execute(ctx);
        expect(replyText(reply)).toContain('Comandi');
    });
});
