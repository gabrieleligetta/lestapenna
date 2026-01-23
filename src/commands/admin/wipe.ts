import { TextChannel, Message } from 'discord.js';
import { Command, CommandContext } from '../types';
import { clearQueue } from '../../services/queue';
import { wipeLocalFiles } from '../../services/recorder';
// @ts-ignore
import { wipeBucket } from '../../services/backup';
import { wipeDatabase, db } from '../../db';

export const wipeCommand: Command = {
    name: 'wipe',
    aliases: ['softwipe'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        const DEVELOPER_ID = process.env.DISCORD_DEVELOPER_ID || '310865403066712074';
        if (message.author.id !== DEVELOPER_ID) return;

        // --- $wipe (HARD WIPE) ---
        if (commandName === 'wipe') {
            await message.reply("⚠️ **ATTENZIONE**: Questa operazione cancellerà **TUTTO** (DB, Cloud, Code, File Locali). Sei sicuro? Scrivi `CONFERMO` entro 15 secondi.");

            try {
                const collected = await (message.channel as TextChannel).awaitMessages({
                    filter: (m: Message) => m.author.id === message.author.id && m.content === 'CONFERMO',
                    max: 1,
                    time: 15000,
                    errors: ['time']
                });

                if (collected.size > 0) {
                    const statusMsg = await message.reply("🧹 **Ragnarok avviato...**");
                    try {
                        await clearQueue();
                        await statusMsg.edit("🧹 **Ragnarok in corso...**\n- Code svuotate ✅");
                        const cloudCount = await wipeBucket();
                        await statusMsg.edit(`🧹 **Ragnarok in corso...**\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅`);
                        wipeDatabase();
                        await statusMsg.edit(`🧹 **Ragnarok in corso...**\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅\n- Database resettato ✅`);
                        wipeLocalFiles();
                        await statusMsg.edit(`🔥 **Ragnarok completato.** Tutto è stato riportato al nulla.\n- Code svuotate ✅\n- Cloud svuotato (${cloudCount} oggetti rimossi) ✅\n- Database resettato ✅\n- File locali eliminati ✅`);
                    } catch (err: any) {
                        console.error("❌ Errore durante il wipe:", err);
                        await statusMsg.edit(`❌ Errore durante il Ragnarok: ${err.message}`);
                    }
                }
            } catch (e) {
                await message.reply("⌛ Tempo scaduto. Il mondo è salvo.");
            }
            return;
        }

        // --- $softwipe (SOFT WIPE) ---
        if (commandName === 'softwipe') {
            await message.reply(`⚠️ **SOFT WIPE**: Stai per cancellare **TUTTA** la memoria derivata (RAG, Inventario, Quest, Storia) e svuotare la Coda.\n` +
                `Campagne, Sessioni, PG e Registrazioni rimarranno intatti.\n` +
                `Scrivi \`CONFERMO\` entro 15 secondi per procedere.`);

            try {
                const collected = await (message.channel as TextChannel).awaitMessages({
                    filter: (m: Message) => m.author.id === message.author.id && m.content === 'CONFERMO',
                    max: 1,
                    time: 15000,
                    errors: ['time']
                });

                if (collected.size > 0) {
                    const statusMsg = await message.reply("🧹 **Soft Wipe avviato...**");

                    // 1. Svuota Coda Redis
                    await clearQueue();
                    await statusMsg.edit("🧹 **Soft Wipe...**\n- Coda Redis svuotata ✅");

                    // 2. Cancella Tabelle Derivate (SQL)
                    db.prepare('DELETE FROM knowledge_fragments').run();
                    db.prepare('DELETE FROM inventory').run();
                    db.prepare('DELETE FROM quests').run();
                    db.prepare('DELETE FROM character_history').run();
                    db.prepare('DELETE FROM npc_history').run();
                    db.prepare('DELETE FROM world_history').run();
                    db.prepare('DELETE FROM chat_history').run(); // Reset anche della chat col bardo

                    // 3. Reset stato registrazioni bloccate
                    db.prepare("UPDATE recordings SET status = 'PENDING', error_log = NULL").run();

                    await statusMsg.edit(`✅ **Soft Wipe Completato.**\n` +
                        `- Coda svuotata.\n` +
                        `- Memoria RAG e Dati Derivati cancellati.\n` +
                        `- TUTTI i file resettati a PENDING (Pronti per rielaborazione).\n` +
                        `- Struttura (Campagne/Sessioni) preservata.\n\n` +
                        `Ora puoi lanciare \`$reset <ID_SESSIONE>\` per rigenerare i dati.`);
                }
            } catch (e) {
                await message.reply("⌛ Tempo scaduto. Operazione annullata.");
            }
        }
    }
};
