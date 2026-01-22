/**
 * Help commands index
 */

export { aiutoCommand } from './aiuto';
export { helpCommand } from './help';

import { Command } from '../types';
import { aiutoCommand } from './aiuto';
import { helpCommand } from './help';

export const helpCommands: Command[] = [
    aiutoCommand,
    helpCommand
];
