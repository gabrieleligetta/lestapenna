import 'dotenv/config';
import sodium from 'libsodium-wrappers';
import {
    Client,
    GatewayIntentBits
} from 'discord.js';
import { CommandDispatcher } from './commands';
import { registerAllCommands } from './commands/registry';
import { registerReadyHandler } from './bootstrap/ready';
import { registerVoiceStateHandler } from './bootstrap/voiceState';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Command Dispatcher Setup
const dispatcher = new CommandDispatcher(client);
registerAllCommands(dispatcher);

// Event Handlers Setup
registerReadyHandler(client);
registerVoiceStateHandler(client);

// Message Handler
client.on('messageCreate', async (message) => {
    // Dispatcher handles checks, prefix, routing
    await dispatcher.dispatch(message);
});

import { config } from './config';

// Start Bot
(async () => {
    await sodium.ready;
    await client.login(config.discord.token);
})();
