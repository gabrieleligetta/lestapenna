import { Command, CommandContext } from '../types';
import { setSessionNumber } from '../../db';
import { guildSessions } from '../../state/sessionState';

export const manageCommand: Command = {
    name: 'manage',
    aliases: ['impostasessione', 'setsession', 'setsessionid', 'impostasessioneid'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        // --- $impostasessione <numero> ---
        if (commandName === 'impostasessione' || commandName === 'setsession') {
            const sessionId = guildSessions.get(message.guild!.id);
            if (!sessionId) {
                await message.reply("⚠️ Nessuna sessione attiva. Usa `$impostasessioneid` per modificare una sessione passata.");
                return;
            }

            const sessionNum = parseInt(args[0]);
            if (isNaN(sessionNum) || sessionNum <= 0) {
                await message.reply("Uso: `$impostasessione <numero>` (es. `$impostasessione 5`)");
                return;
            }

            setSessionNumber(sessionId, sessionNum);
            await message.reply(`✅ Numero sessione impostato a **${sessionNum}**. Sarà usato per il prossimo riassunto.`);
            return;
        }

        // --- $setsessionid <id> <numero> ---
        if (commandName === 'setsessionid' || commandName === 'impostasessioneid') {
            const targetSessionId = args[0];
            const sessionNum = parseInt(args[1]);

            if (!targetSessionId || isNaN(sessionNum)) {
                await message.reply("Uso: `$impostasessioneid <ID_SESSIONE> <NUMERO>`");
                return;
            }

            const success = setSessionNumber(targetSessionId, sessionNum);

            if (success) {
                await message.reply(`✅ Numero sessione per \`${targetSessionId}\` impostato a **${sessionNum}**.`);
            } else {
                await message.reply(`⚠️ Errore: Sessione \`${targetSessionId}\` non trovata.`);
            }
            return;
        }
    }
};
