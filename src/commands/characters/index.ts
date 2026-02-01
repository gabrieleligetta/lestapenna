/**
 * Character commands index
 */

export { iamCommand } from './iam';
export { whoamiCommand } from './whoami';
export { bioCommand } from './bio';
export { partyCommand } from './party';
export { characterCommand } from './character';

import { Command } from '../types';
import { iamCommand } from './iam';
import { whoamiCommand } from './whoami';
import { bioCommand } from './bio';
import { partyCommand } from './party';
import { characterCommand } from './character';

export const characterCommands: Command[] = [
    iamCommand,
    whoamiCommand,
    bioCommand,
    partyCommand,
    characterCommand
];
