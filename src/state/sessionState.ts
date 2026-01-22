export const guildSessions = new Map<string, string>(); // GuildId -> SessionId
export const autoLeaveTimers = new Map<string, NodeJS.Timeout>(); // GuildId -> Timer
