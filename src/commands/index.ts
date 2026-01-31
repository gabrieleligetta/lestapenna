/**
 * Command Dispatcher - Central command routing system
 */

import { Message, Client } from 'discord.js';
import { Command, CommandContext } from './types';
import { getActiveCampaign, getGuildConfig, factionRepository } from '../db';

export class CommandDispatcher {
    private commands = new Map<string, Command>();
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Register a command with all its aliases
     */
    register(command: Command): void {
        this.commands.set(command.name.toLowerCase(), command);
        for (const alias of command.aliases) {
            this.commands.set(alias.toLowerCase(), command);
        }
    }

    /**
     * Register multiple commands at once
     */
    registerAll(commands: Command[]): void {
        for (const cmd of commands) {
            this.register(cmd);
        }
    }

    /**
     * Get the command channel ID for a guild (no fallback - each server must configure its own)
     */
    getCmdChannelId(guildId: string): string | null {
        return getGuildConfig(guildId, 'cmd_channel_id') || null;
    }

    /**
     * Dispatch a message to the appropriate command handler
     * Returns true if a command was handled, false otherwise
     */
    async dispatch(message: Message): Promise<boolean> {
        // Ignore bots and non-guild messages
        if (message.author.bot) return false;
        if (!message.guild) return false;

        // Check for command prefix
        if (!message.content.startsWith('$')) return false;

        // Parse command and args
        const args = message.content.slice(1).split(' ');
        const commandName = args.shift()?.toLowerCase();
        if (!commandName) return false;

        // Check channel restriction
        // Config commands (setcmd, setsummary) always allowed - needed for initial setup
        const allowedChannelId = this.getCmdChannelId(message.guild.id);
        const isConfigCommand = commandName === 'setcmd' || commandName === 'setsummary';

        // If no channel configured and not a config command, ignore (server not set up yet)
        if (!allowedChannelId && !isConfigCommand) {
            return false;
        }

        // If channel configured but message is from wrong channel (and not config command), ignore
        if (allowedChannelId && message.channelId !== allowedChannelId && !isConfigCommand) {
            return false;
        }

        // Find the command
        const command = this.commands.get(commandName);
        if (!command) return false;

        // Check campaign requirement
        const activeCampaign = getActiveCampaign(message.guild.id);
        if (command.requiresCampaign && !activeCampaign) {
            await message.reply("⚠️ **Nessuna campagna attiva!**\nUsa `$creacampagna <Nome>` o `$selezionacampagna <Nome>` prima di iniziare.");
            return true;
        }

        // Ensure party faction exists for backward compatibility
        if (activeCampaign) {
            let party = factionRepository.getPartyFaction(activeCampaign.id);
            if (!party) {
                party = factionRepository.createPartyFaction(activeCampaign.id);
            }

            // Sync all existing PCs to party (excluding DM)
            if (party) {
                factionRepository.ensurePartyMembership(activeCampaign.id, party.id);
            }
        }

        // Build context and execute
        const ctx: CommandContext = {
            message,
            args,
            guildId: message.guild.id,
            activeCampaign: activeCampaign || null,
            client: this.client
        };

        try {
            await command.execute(ctx);
        } catch (error) {
            console.error(`[CommandDispatcher] Error executing ${commandName}:`, error);
            await message.reply(`❌ Si è verificato un errore durante l'esecuzione del comando.`);
        }

        return true;
    }

    /**
     * Get all registered command names (for debugging)
     */
    getRegisteredCommands(): string[] {
        return Array.from(new Set(
            Array.from(this.commands.values()).map(cmd => cmd.name)
        ));
    }
}

// Export types
export { Command, CommandContext } from './types';
