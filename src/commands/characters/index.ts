/**
 * Character commands index
 */

export { iamCommand } from './iam';
export { myclassCommand } from './myclass';
export { myraceCommand } from './myrace';
export { mydescCommand } from './mydesc';
export { whoamiCommand } from './whoami';
export { bioCommand } from './bio';
export { partyCommand } from './party';
export { resetCharacterCommand } from './reset';

import { Command } from '../types';
import { iamCommand } from './iam';
import { myclassCommand } from './myclass';
import { myraceCommand } from './myrace';
import { mydescCommand } from './mydesc';
import { whoamiCommand } from './whoami';
import { bioCommand } from './bio';
import { partyCommand } from './party';
import { resetCharacterCommand } from './reset';

export const characterCommands: Command[] = [
    iamCommand,
    myclassCommand,
    myraceCommand,
    mydescCommand,
    whoamiCommand,
    bioCommand,
    partyCommand,
    resetCharacterCommand
];
