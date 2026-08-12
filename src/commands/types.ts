import { Message, Client, MessageComponentInteraction } from 'discord.js';
import { Campaign } from '../db';
import { Locale, MessageKey } from '../i18n';
import type { CommandDispatcher } from './index';

/**
 * Context passed to every command handler
 */
export interface CommandContext {
    message: Message;
    args: string[];
    /** Text after the command name with its original spacing (for free text). */
    rawArgs?: string;
    guildId: string;
    activeCampaign: Campaign | null;
    client: Client;
    /** The guild's language (explicit config → Discord preferredLocale → en). */
    locale: Locale;
    /**
     * The dispatcher that routed this command, i.e. the registry itself.
     *
     * `$help` builds its pages from here instead of from a hand-written list:
     * that list had drifted to the point of advertising `$resetpg`, which does
     * not exist, while omitting a third of the commands that do.
     */
    dispatcher?: CommandDispatcher;
    interaction?: MessageComponentInteraction; // Optional interaction for interactive flows
}

/** Usage example shown in $help and in errors with hints. */
export interface UsageExample {
    /** Canonical syntax, e.g. "$npc #ID". Not translated: it is syntax. */
    usage: string;
    /** i18n key describing what it does, in one line. */
    descriptionKey: MessageKey;
}

/** Categories used to group commands in $help/$aiuto, in page order. */
export type CommandCategory =
    | 'sessione' | 'personaggi' | 'entita' | 'mondo' | 'narrativa'
    | 'campagna' | 'admin' | 'dev' | 'meta';

/**
 * The order the help pages are shown in, and the only list of categories that
 * exists. `$aiuto` iterates over this, so a category that is not here has no
 * page — which is why the coverage test checks every command carries one.
 */
export const CATEGORY_ORDER: CommandCategory[] = [
    'sessione', 'personaggi', 'entita', 'mondo', 'narrativa',
    'campagna', 'admin', 'meta', 'dev',
];

/**
 * Base interface for all commands.
 * The metadata fields (description/category/usage/adminOnly) are optional:
 * commands adopt them incrementally; where present they feed the data-driven
 * help and the errors with usage hints.
 */
export interface Command {
    /** Primary command name (e.g., 'listen') */
    name: string;

    /** Alternative names (e.g., ['ascolta'] for Italian) */
    aliases: string[];

    /** If true, the command will fail if no campaign is active */
    requiresCampaign: boolean;

    /**
     * i18n key with the one-line description shown in the help.
     *
     * It used to be a `{ it, en }` pair, which could not express the six locales
     * the bot actually speaks: the help fell back to English for four of them.
     * As a key it goes through `t()` like every other user-facing string, and
     * the i18n guard test enforces that all six translations exist.
     */
    descriptionKey?: MessageKey;

    /** Category used to group commands in the help. */
    category?: CommandCategory;

    /** Canonical usage examples (shown in $help <cmd> and in errors). */
    usage?: UsageExample[];

    /** When true, the dispatcher requires the Discord ManageGuild permission. */
    adminOnly?: boolean;

    /**
     * Heavy operations (wipe, full regenerations, resyncs, deleting a
     * campaign): the dispatcher reserves them for the maintainer or for anyone
     * with administration permissions (`isGuildOperator`).
     *
     * Each command used to defend itself with an inline `isGuildAdmin` — seven
     * copies, some with a silent `return` that left the user without a reply —
     * and three destructive commands did not defend themselves at all.
     */
    operatorOnly?: boolean;

    /** Execute the command */
    execute(ctx: CommandContext): Promise<void>;
}
