/**
 * Config commands index
 */

import { Command } from '../types';
import { setCommand } from './set';
import { statusCommand } from './status';
import { metricsCommand } from './metrics';
import { autoupdateCommand } from './autoupdate';

export { setCommand } from './set';
export { statusCommand } from './status';
export { metricsCommand } from './metrics';
export { autoupdateCommand } from './autoupdate';

export const configCommands: Command[] = [
    setCommand,
    statusCommand,
    metricsCommand,
    autoupdateCommand
];
