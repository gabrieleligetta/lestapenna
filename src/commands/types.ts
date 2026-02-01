import { Message, Client, MessageComponentInteraction } from 'discord.js';
import { Campaign } from '../db';

/**
 * Context passed to every command handler
 */
export interface CommandContext {
    message: Message;
    args: string[];
    guildId: string;
    activeCampaign: Campaign | null;
    client: Client;
    interaction?: MessageComponentInteraction; // Optional interaction for interactive flows
}

/**
 * Base interface for all commands
 */
export interface Command {
    /** Primary command name (e.g., 'listen') */
    name: string;

    /** Alternative names (e.g., ['ascolta'] for Italian) */
    aliases: string[];

    /** If true, the command will fail if no campaign is active */
    requiresCampaign: boolean;

    /** Execute the command */
    execute(ctx: CommandContext): Promise<void>;
}
