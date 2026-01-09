import { Provider } from '@nestjs/common';
import { Client } from 'discord.js';

// Questo provider estrae il Client nativo di discord.js da Necord
// per poterlo iniettare dove serve (es. nei Worker che non sono gestiti da Necord)
export const DiscordClientProvider: Provider = {
  provide: 'DISCORD_CLIENT',
  useFactory: (client: Client) => client,
  inject: [Client],
};
