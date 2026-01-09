import { Client, GatewayIntentBits } from 'discord.js';

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Mappa GuildId -> SessionId
export const guildSessions = new Map<string, string>(); 

// Mappa GuildId -> Timer
export const autoLeaveTimers = new Map<string, NodeJS.Timeout>();
