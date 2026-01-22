import { TextChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { getPresignedUrl } from '../../backupService';
import { mixSessionAudio } from '../../sessionMixer';
import { audioQueue } from '../../queue';
import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore
import { guildSessions } from '../../index'; // Global state

export const downloadCommand: Command = {
    name: 'download',
    aliases: ['scarica'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;

        const isActiveSession = guildSessions.has(message.guild!.id);
        const queueCounts = await audioQueue.getJobCounts();
        const isProcessing = queueCounts.active > 0 || queueCounts.waiting > 0;

        if (isActiveSession || isProcessing) {
            await message.reply(
                `🛑 **Sistema sotto carico.**\n` +
                `Non posso generare il download mentre:\n` +
                `- Una sessione è attiva: ${isActiveSession ? 'SÌ' : 'NO'}\n` +
                `- Ci sono file in elaborazione: ${isProcessing ? 'SÌ' : 'NO'} (${queueCounts.waiting} in coda)\n\n` +
                `Attendi la fine della sessione e del riassunto.`
            );
            return;
        }

        let targetSessionId = args[0];
        let force = false;
        let keep = false;

        // Parse arguments
        for (const arg of args) {
            if (arg === 'force' || arg === '--force') force = true;
            else if (arg === 'keep' || arg === '--keep') keep = true;
            else if (!targetSessionId) targetSessionId = arg;
        }

        if (!targetSessionId) {
            // Try to find last session? The logic in index says: guildSessions.get(..) || ""
            // But guildSessions only has ACTIVE session?
            // Index logic: guildSessions.get(message.guild.id) || ""
            // But strict download check seems to want an ID if not active.
            // If isActiveSession is false (checked above), then guildSessions.get is undefined?
            // So targetSessionId would be empty.
            // But index.ts logic line 3014 checks this.
            // Effectively, if no active session, user MUST provide ID.
            // Unless we fetch the *last* session from DB? 
            // Index logic lines 3013-3015 seems to imply it tries to get active session if ID missing.
            // But we already errored if isActiveSession is false? No, we warned if it IS active.
            // Wait, lines 2992: if (isActiveSession || isProcessing) return error.
            // So we ONLY proceed if NO active session.
            // So guildSessions.get() will be undefined.
            // So targetSessionId will be undefined.
            // Line 3018 says: "Specifica un ID sessione".
            // So correct, user must provide ID.
            await message.reply("⚠️ Specifica un ID sessione: `$scarica <ID>`");
            return;
        }

        // Check if already exists in cloud
        const finalFileName = `session_${targetSessionId}_master.mp3`;
        const cloudKey = `recordings/${targetSessionId}/${finalFileName}`;

        // If not force, check if exists
        if (!force) {
            const existingUrl = await getPresignedUrl(cloudKey, undefined, 3600 * 24);
            if (existingUrl) {
                await (message.channel as TextChannel).send(`✅ **Audio Sessione Già Disponibile**\nPuoi scaricarlo qui (link valido 24h):\n${existingUrl}\n\n💡 Usa \`$scarica ${targetSessionId} force\` per rigenerarlo.`);
                return;
            }
        }

        await message.reply(`⏳ **Elaborazione Audio Completa** per sessione \`${targetSessionId}\`...\nPotrebbe volerci qualche minuto a seconda della durata. Ti avviserò qui.`);

        try {
            const filePath = await mixSessionAudio(targetSessionId, keep);
            // mixSessionAudio should return filePath
            // index.ts: const filePath = await mixSessionAudio(targetSessionId, keep);

            const stats = fs.statSync(filePath);
            const sizeMB = stats.size / (1024 * 1024);

            if (sizeMB < 25) {
                await (message.channel as TextChannel).send({
                    content: `✅ **Audio Sessione Pronto!** (${sizeMB.toFixed(2)} MB)`,
                    files: [filePath]
                });
            } else {
                const presignedUrl = await getPresignedUrl(cloudKey, undefined, 3600 * 24);

                if (presignedUrl) {
                    await (message.channel as TextChannel).send(`✅ **Audio Generato** (${sizeMB.toFixed(2)} MB).\nEssendo troppo grande per Discord, puoi scaricarlo qui (link valido 24h):\n${presignedUrl}`);
                } else {
                    await (message.channel as TextChannel).send(`✅ **Audio Generato** (${sizeMB.toFixed(2)} MB), ma non sono riuscito a generare il link di download.`);
                }

                // Cleanup local mixed file unless keep is true? 
                // index.ts line 3059: try { fs.unlinkSync(filePath); } catch(e) {}
                // Wait, if keep is true, mixSessionAudio might behave differently?
                // mixSessionAudio impl in voicerecorder handles keep?
                // If I pass keep to mixSessionAudio, maybe it keeps it?
                // But line 3059 unlinks it anyway?
                // I'll copy logic.
                try { fs.unlinkSync(filePath); } catch (e) { }
            }

        } catch (err: any) {
            console.error(err);
            await (message.channel as TextChannel).send(`❌ Errore durante la generazione dell'audio: ${err.message}`);
        }
    }
};
