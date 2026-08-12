/**
 * $help command - localized help (contenuto condiviso in renderer.ts)
 */

import { Command, CommandContext } from '../types';
import { renderHelp } from './renderer';

export const helpCommand: Command = {
    name: 'help',
    category: 'meta',
    descriptionKey: 'help.cmd.help',
    aliases: [],
    requiresCampaign: false,
    usage: [
        { usage: '$help', descriptionKey: 'help.usage.help.base' },
        { usage: '$help sessione', descriptionKey: 'help.usage.help.category' },
        { usage: '$help npc', descriptionKey: 'help.usage.help.command' },
    ],

    async execute(ctx: CommandContext): Promise<void> {
        await renderHelp(ctx, ctx.locale);
    }
};
