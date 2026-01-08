import { Message, EmbedBuilder, TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { getActiveCampaign, getUserProfile, updateUserCharacter, getCampaignCharacters, deleteUserCharacter, getNpcEntry } from '../../db';
import { db } from '../../db';
import {generateCharacterBiography, generateNpcBiography} from "../../ai/storyteller"; // Per query dirette se necessario

export async function handleCharacterCommands(message: Message, command: string, args: string[]) {
    const activeCampaign = getActiveCampaign(message.guild!.id);
    if (!activeCampaign) return; // Gestito altrove

    if (command === 'iam' || command === 'sono') {
        const val = args.join(' ');
        if (val) {
            if (val.toUpperCase() === 'DM' || val.toUpperCase() === 'DUNGEON MASTER') {
                updateUserCharacter(message.author.id, activeCampaign.id, 'character_name', 'DM');
                updateUserCharacter(message.author.id, activeCampaign.id, 'class', 'Dungeon Master');
                updateUserCharacter(message.author.id, activeCampaign.id, 'race', 'Narratore');
                await message.reply(`🎲 **Saluti, Dungeon Master.** Il Bardo è ai tuoi ordini per la campagna **${activeCampaign.name}**.`);
            } else {
                updateUserCharacter(message.author.id, activeCampaign.id, 'character_name', val);
                await message.reply(`⚔️ Nome aggiornato: **${val}** (Campagna: ${activeCampaign.name})`);
            }
        } else await message.reply("Uso: `$sono Nome`");
        return;
    }

    if (command === 'myclass' || command === 'miaclasse') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign.id, 'class', val);
            await message.reply(`🛡️ Classe aggiornata: **${val}**`);
        } else await message.reply("Uso: `$miaclasse Barbaro / Mago / Ladro...`");
        return;
    }

    if (command === 'myrace' || command === 'miarazza') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign.id, 'race', val);
            await message.reply(`🧬 Razza aggiornata: **${val}**`);
        } else await message.reply("Uso: `$miarazza Umano / Elfo / Nano...`");
        return;
    }

    if (command === 'mydesc' || command === 'miadesc') {
        const val = args.join(' ');
        if (val) {
            updateUserCharacter(message.author.id, activeCampaign.id, 'description', val);
            await message.reply(`📜 Descrizione aggiornata! Il Bardo prenderà nota.`);
        } else await message.reply("Uso: `$miadesc Breve descrizione del carattere o aspetto`");
        return;
    }

    if (command === 'whoami' || command === 'chisono') {
        const p = getUserProfile(message.author.id, activeCampaign.id);
        if (p.character_name) {
            const embed = new EmbedBuilder()
                .setTitle(`👤 Profilo di ${p.character_name}`)
                .setDescription(`Campagna: **${activeCampaign.name}**`)
                .setColor("#3498DB")
                .addFields(
                    { name: "⚔️ Nome", value: p.character_name || "Non impostato", inline: true },
                    { name: "🛡️ Classe", value: p.class || "Sconosciuta", inline: true },
                    { name: "🧬 Razza", value: p.race || "Sconosciuta", inline: true },
                    { name: "📜 Biografia", value: p.description || "Nessuna descrizione." }
                )
                .setThumbnail(message.author.displayAvatarURL());

            await message.reply({ embeds: [embed] });
        } else {
            await message.reply("Non ti conosco in questa campagna. Usa `$sono <Nome>` per iniziare la tua leggenda!");
        }
        return;
    }

    if (command === 'party' || command === 'compagni') {
        const characters = getCampaignCharacters(activeCampaign.id);

        if (characters.length === 0) {
            return await message.reply("Nessun avventuriero registrato in questa campagna.");
        }

        const list = characters.map(c => {
            const name = c.character_name || "Sconosciuto";
            const details = [c.race, c.class].filter(Boolean).join(' - ');
            return `**${name}**${details ? ` (${details})` : ''}`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`🛡️ Party: ${activeCampaign.name}`)
            .setColor("#9B59B6")
            .setDescription(list);

        await message.reply({ embeds: [embed] });
        return;
    }

    if (command === 'resetpg' || command === 'clearchara') {
        deleteUserCharacter(message.author.id, activeCampaign.id);
        await message.reply("🗑️ Scheda personaggio resettata. Ora sei un'anima errante.");
        return;
    }

    // --- STORIA (PG o NPC) ---
    if (command === 'storia' || command === 'story') {
        const targetName = args.join(' ');
        if (!targetName) return await message.reply("Uso: `$storia <Nome>` (Cerca sia tra i PG che tra gli NPC)");

        const campaignId = activeCampaign.id;

        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        // 1. Cerca tra i PG
        const targetPG = db.prepare('SELECT race, class FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;

        if (targetPG) {
            await message.reply(`📖 **Saga dell'Eroe: ${targetName}**\nIl Bardo sta scrivendo...`);
            const bio = await generateCharacterBiography(campaignId, targetName, targetPG.class || "Eroe", targetPG.race || "Ignoto");
            const chunks = bio.match(/[\s\S]{1,1900}/g) || [];
            for (const chunk of chunks) await (message.channel as TextChannel).send(chunk);
            return;
        }

        // 2. Cerca tra gli NPC
        const targetNPC = getNpcEntry(campaignId, targetName);

        if (targetNPC) {
            await message.reply(`📂 **Dossier NPC: ${targetNPC.name}**\nConsultazione archivi...`);
            const bio = await generateNpcBiography(campaignId, targetNPC.name, targetNPC.role || "Sconosciuto", targetNPC.description || "Nessuna nota precedente.");
            const chunks = bio.match(/[\s\S]{1,1900}/g) || [];
            for (const chunk of chunks) await (message.channel as TextChannel).send(chunk);
            return;
        }

        await message.reply(`❌ Non ho trovato nessun PG o NPC chiamato "**${targetName}**" negli archivi di questa campagna.`);
        return;
    }
}
