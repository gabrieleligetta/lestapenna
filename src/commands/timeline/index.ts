/**
 * Timeline commands index
 */

export { year0Command } from './year0';
export { dateCommand } from './date';
export { timelineCommand } from './timeline';

import { Command } from '../types';
import { year0Command } from './year0';
import { dateCommand } from './date';
import { timelineCommand } from './timeline';

export const timelineCommands: Command[] = [
    year0Command,
    dateCommand,
    timelineCommand
];
