/**
 * NPC commands index
 */

export { npcCommand } from './npc';
export { presenzeCommand } from './presenze';

import { Command } from '../types';
import { npcCommand } from './npc';
import { presenzeCommand } from './presenze';

export const npcCommands: Command[] = [
    npcCommand,
    presenzeCommand
];
