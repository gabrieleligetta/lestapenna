import { Provider } from '@nestjs/common';
import { Client } from 'discord.js';
import { NecordClient } from 'necord';

// Questo provider estrae il Client nativo di discord.js da NecordClient
// per poterlo iniettare dove serve (es. nei Worker che non sono gestiti da Necord)
export const DiscordClientProvider: Provider = {
  provide: 'DISCORD_CLIENT',
  useFactory: (necordClient: NecordClient) => necordClient, // NecordClient estende Client
  inject: [NecordClient],
};
