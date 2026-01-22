/**
 * Location commands index
 */

export { locationCommand } from './location';
export { travelsCommand } from './travels';
export { atlasCommand } from './atlas';

import { Command } from '../types';
import { locationCommand } from './location';
import { travelsCommand } from './travels';
import { atlasCommand } from './atlas';

export const locationCommands: Command[] = [
    locationCommand,
    travelsCommand,
    atlasCommand
];
