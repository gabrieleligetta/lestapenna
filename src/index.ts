import 'dotenv/config';
import 'reflect-metadata'; // Required by NestJS decorators — must be imported early
import sodium from 'libsodium-wrappers';
import { Client, GatewayIntentBits } from 'discord.js';
import { CommandDispatcher } from './commands';
import { registerAllCommands } from './commands/registry';
import { registerReadyHandler } from './bootstrap/ready';
import { registerVoiceStateHandler } from './bootstrap/voiceState';
import { registerGuildJoinHandler } from './bootstrap/guildJoin';
import { registerGuildLeaveHandler } from './bootstrap/guildLeave';
import { config } from './config';
import { startApiServer } from './api/server';
import { secretVault } from './services/secretVault';
import { printAiBanner, checkOllamaModelsAvailable } from './bard/config';
import { db } from './db/client';
import { logger } from './utils/logger';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { setDiscordClient } from './discordClient';

const log = logger('Bootstrap');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Shared with the NestJS API (same process) so it can check bot/guild
// membership (GET /api/v1/me/guilds) without a second Discord connection.
setDiscordClient(client);

// Command Dispatcher Setup
const dispatcher = new CommandDispatcher(client);
registerAllCommands(dispatcher);

// Event Handlers Setup
registerReadyHandler(client);
registerVoiceStateHandler(client);
registerGuildJoinHandler(client);
registerGuildLeaveHandler(client);

// Message Handler
client.on('messageCreate', async (message) => {
    // Dispatcher handles checks, prefix, routing
    await dispatcher.dispatch(message);
});

// --- Graceful Shutdown ---
let nestApp: NestFastifyApplication | null = null;

async function shutdown(signal: string) {
    log.info(`Received ${signal}, shutting down gracefully...`);

    // 1. Stop accepting new HTTP requests
    if (nestApp) {
        try {
            await nestApp.close();
            log.info('NestJS HTTP server closed');
        } catch (err) {
            log.error('Error closing NestJS', err as Error);
        }
    }

    // 2. Disconnect Discord client
    if (client.isReady()) {
        try {
            client.destroy();
            log.info('Discord client disconnected');
        } catch (err) {
            log.error('Error disconnecting Discord', err as Error);
        }
    }

    // 3. Close database
    try {
        db.close();
        log.info('Database closed');
    } catch (err) {
        log.error('Error closing database', err as Error);
    }

    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start Bot + API Server
(async () => {
    await sodium.ready;

    // Loud on purpose: without the vault, tables cannot entrust their own
    // keys to the instance, and AI only works with the environment ones.
    // A silent failure here would surface much later, as an inexplicable
    // "I can't save the key".
    printAiBanner();
    if (process.env.NODE_ENV !== 'test') void checkOllamaModelsAvailable();

    if (!secretVault.isEnabled()) {
        log.warn(
            'SECRETS_MASTER_KEY non configurata: le credenziali AI per tavolo non sono ' +
            'salvabili. Genera una chiave con `npm run secrets:generate-key`.',
        );
    }

    // Start HTTP server for the web API + health checks + landing pages
    nestApp = await startApiServer();

    await client.login(config.discord.token);
    log.info('Bot and API server started');
})();
