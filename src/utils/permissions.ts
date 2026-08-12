/**
 * Permission utilities for multi-server support
 */

import { GuildMember, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../db';
import { config } from '../config';

/**
 * The instance developer: administrator of **every** guild served.
 *
 * It is real power, which is why it has no default value: `undefined` when
 * `DISCORD_DEVELOPER_ID` is unset. The comparison must always go through this
 * function and never through an empty string — `userId === ''` is false by
 * construction, but relying on that means the day something returns `''` as an
 * identity, global access opens by itself.
 */
function developerId(): string | undefined {
    return config.discord.developerId || undefined;
}

/** True only when the developer is configured and is this very user. */
function isInstanceDeveloper(userId: string): boolean {
    const developer = developerId();
    return developer !== undefined && userId === developer;
}

/**
 * Check if a user is admin for a specific guild
 * Falls back to global developer ID if no guild admin is set
 */
export function isGuildAdmin(userId: string, guildId: string): boolean {
    const guildAdmin = getGuildConfig(guildId, 'admin_user_id');

    // Guild-specific admin
    if (guildAdmin && userId === guildAdmin) {
        return true;
    }

    // Global developer (always admin everywhere)
    if (isInstanceDeveloper(userId)) {
        return true;
    }

    // No guild admin set - only global developer is admin
    return false;
}

/**
 * Get the admin user ID for a guild.
 *
 * Empty when the guild has no administrator and the instance has no developer:
 * that is true information, not a case to be filled in.
 */
export function getGuildAdminId(guildId: string): string {
    return getGuildConfig(guildId, 'admin_user_id') || developerId() || '';
}

/**
 * Who may run the heavy operations: wipe, full regenerations, resyncs,
 * deleting a campaign.
 *
 * Unifies the two mechanisms that coexisted in the codebase: the configured
 * admin (the guild's `admin_user_id`, plus the global developer — the
 * maintainer, who stays an administrator everywhere) and the Discord
 * permission. They used to be alternatives: some commands looked only at
 * `isGuildAdmin`, `$language` only at ManageGuild, and most looked at nothing.
 * A server owner without a configured `admin_user_id` was locked out of their
 * own maintenance commands.
 */
export function isGuildOperator(
    userId: string,
    guildId: string,
    member?: GuildMember | null,
): boolean {
    if (isGuildAdmin(userId, guildId)) return true;
    // `permissions` is always present on a real GuildMember, but the message
    // can arrive with an unresolved member (and tests mock it partially): when
    // in doubt deny, do not blow up.
    const permissions = member?.permissions;
    if (!permissions?.has) return false;
    return permissions.has(PermissionFlagsBits.ManageGuild)
        || permissions.has(PermissionFlagsBits.Administrator);
}
