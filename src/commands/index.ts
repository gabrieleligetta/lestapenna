/**
 * Command Dispatcher - Central command routing system
 */

import { Message, Client, PermissionFlagsBits } from 'discord.js';
import { Command, CommandContext } from './types';
import { getActiveCampaign, getGuildConfig, factionRepository } from '../db';
import { config } from '../config';
import { errorReply } from './utils/embeds';
import { getGuildLocale, t } from '../i18n';
import { isGuildOperator } from '../utils/permissions';
import { runWithAiScope } from '../bard/ai/ambientScope';

/**
 * Tokenizes the content of a command message (without the '$' prefix).
 * Splits on generic whitespace (multiple spaces, tabs, newlines) so short-ids
 * and arguments are not lost to double spaces or line breaks.
 * `rawArgs` keeps the text after the command name with its original spacing,
 * for the commands that capture free text.
 */
export function parseCommandLine(content: string): { commandName: string | null; args: string[]; rawArgs: string } {
    const line = content.trim();
    if (!line) return { commandName: null, args: [], rawArgs: '' };
    const tokens = line.split(/\s+/);
    const first = tokens.shift() || '';
    const commandName = first.toLowerCase() || null;
    const rawArgs = line.slice(first.length).trim();
    return { commandName, args: tokens, rawArgs };
}

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

        // DEV_GUILD_ID: If set, only respond to that specific guild (for local development)
        if (config.discord.devGuildId && message.guild.id !== config.discord.devGuildId) {
            return false;
        }

        // IGNORE_GUILD_IDS: Skip these guilds (for prod to ignore dev servers)
        if (config.discord.ignoreGuildIds.includes(message.guild.id)) {
            return false;
        }

        // Check for command prefix
        if (!message.content.startsWith('$')) return false;

        // Parse command and args
        const { commandName, args, rawArgs } = parseCommandLine(message.content.slice(1));
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

        const locale = getGuildLocale(message.guild.id, message.guild.preferredLocale);

        // Centralized admin gating: adminOnly commands require ManageGuild
        if (command.adminOnly && !message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
            await message.reply(t(locale, 'dispatcher.adminOnly', { cmd: `$${command.name}` }));
            return true;
        }

        // Heavy operations: maintainer or administrator. A single check and a
        // single reply, in place of the inline checks each command used to
        // write for itself.
        if (command.operatorOnly && !isGuildOperator(message.author.id, message.guild.id, message.member)) {
            await message.reply(t(locale, 'dispatcher.operatorOnly', { cmd: `$${command.name}` }));
            return true;
        }

        // Check campaign requirement
        const activeCampaign = getActiveCampaign(message.guild.id);
        if (command.requiresCampaign && !activeCampaign) {
            await message.reply(t(locale, 'dispatcher.noCampaign'));
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
            rawArgs,
            guildId: message.guild.id,
            activeCampaign: activeCampaign || null,
            client: this.client,
            locale,
            dispatcher: this,
        };

        try {
            // Everything the command triggers — including the pipelines that keep
            // running after the reply — spends THIS guild's keys.
            await runWithAiScope(
                { guildId: message.guild.id, campaignId: activeCampaign?.id },
                () => command.execute(ctx),
            );
        } catch (error) {
            console.error(`[CommandDispatcher] Error executing ${commandName}:`, error);
            // Error with a usage hint: shows the usage metadata when the command has it
            try {
                await errorReply(ctx, t(locale, 'common.executionError', { cmd: `$${command.name}` }), command);
            } catch {
                await message.reply(t(locale, 'common.genericError'));
            }
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

    /** Every registered command (deduped over the aliases), for the data-driven help. */
    getCommands(): Command[] {
        return Array.from(new Set(this.commands.values()));
    }
}

// Export types
export { Command, CommandContext } from './types';
