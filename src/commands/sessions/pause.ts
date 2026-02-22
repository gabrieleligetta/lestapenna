import { Command, CommandContext } from '../types';
import { isRecordingPaused, pauseRecording, resumeRecording } from '../../services/recorder';
import { getActiveSession } from '../../state/sessionState';

export const pauseCommand: Command = {
    name: 'pause',
    aliases: ['pausa', 'riprendi', 'resume'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        const sessionId = await getActiveSession(message.guild!.id);
        if (!sessionId) {
            await message.reply("Nessuna sessione attiva.");
            return;
        }

        if (commandName === 'pausa' || commandName === 'pause') {
            if (isRecordingPaused(message.guild!.id)) {
                await message.reply("La registrazione è già in pausa.");
                return;
            }

            pauseRecording(message.guild!.id);
            await message.reply("⏸️ **Registrazione in Pausa**. Il Bardo si riposa.");
            return;
        }

        if (commandName === 'riprendi' || commandName === 'resume') {
            if (!isRecordingPaused(message.guild!.id)) {
                await message.reply("La registrazione è già attiva.");
                return;
            }

            resumeRecording(message.guild!.id);
            await message.reply("▶️ **Registrazione Ripresa**. Il Bardo torna ad ascoltare.");
            return;
        }
    }
};
