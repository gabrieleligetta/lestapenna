/**
 * Permission utilities for multi-server support
 */

import { getGuildConfig } from '../db';
import { config } from '../config';

const DEFAULT_DEVELOPER_ID = config.discord.developerId;

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
    if (userId === DEFAULT_DEVELOPER_ID) {
        return true;
    }

    // No guild admin set - only global developer is admin
    return false;
}

/**
 * Get the admin user ID for a guild
 */
export function getGuildAdminId(guildId: string): string {
    return getGuildConfig(guildId, 'admin_user_id') || DEFAULT_DEVELOPER_ID;
}
