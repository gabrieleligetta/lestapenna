/**
 * Inventory commands index
 */

export { questCommand, mergeQuestCommand } from './quest';
export { inventoryCommand, mergeItemCommand } from './inventory';
export { bestiaryCommand } from './bestiary';

import { Command } from '../types';
import { questCommand, mergeQuestCommand } from './quest';
import { inventoryCommand, mergeItemCommand } from './inventory';
import { bestiaryCommand } from './bestiary';

export const inventoryCommands: Command[] = [
    questCommand,
    mergeQuestCommand,
    inventoryCommand,
    mergeItemCommand,
    bestiaryCommand
];
