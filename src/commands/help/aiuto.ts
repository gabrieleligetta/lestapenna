/**
 * $aiuto command - Italian help (contenuto condiviso in renderer.ts)
 */

import { Command, CommandContext } from '../types';
import { renderHelp } from './renderer';

export const aiutoCommand: Command = {
    name: 'aiuto',
    category: 'meta',
    descriptionKey: 'help.cmd.aiuto',
    aliases: [],
    requiresCampaign: false,
    usage: [
        { usage: '$aiuto', descriptionKey: 'help.usage.help.base' },
        { usage: '$aiuto sessione', descriptionKey: 'help.usage.help.category' },
        { usage: '$aiuto npc', descriptionKey: 'help.usage.help.command' },
    ],

    async execute(ctx: CommandContext): Promise<void> {
        await renderHelp(ctx, 'it');
    }
};
