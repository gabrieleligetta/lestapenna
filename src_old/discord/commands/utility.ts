import { Message, EmbedBuilder, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';
import { getGuildConfig, setGuildConfig, wipeDatabase, getActiveCampaign, setCampaignYear, addWorldEvent } from '../../db';
import { audioQueue, correctionQueue, clearQueue } from '../../queue';
import { wipeBucket } from '../../backupService';
import { wipeLocalFiles } from '../../voicerecorder';
import { sendTestEmail } from '../../reporter';
import { ensureTestEnvironment } from '../../services/recoveryService';
import { TONES } from '../../bard';

export async function handleUtilityCommands(message: Message, command: string, args: string[]) {
    // --- AIUTO ---
    if (command === 'aiuto') {
        const helpEmbed = new EmbedBuilder()
            .setTitle("🖋️ Lestapenna - Comandi Disponibili")
            .setColor("#D4AF37")
            .setDescription("Benvenuti, avventurieri! Io sono il vostro bardo e cronista personale.")
            .addFields(
                {
                    name: "🗺️ Campagne",
                    value:
                        "`$creacampagna <Nome>`: Crea nuova campagna.\n" +
                        "`$selezionacampagna <Nome>`: Attiva una campagna.\n" +
                        "`$listacampagne`: Mostra le campagne.\n" +
                        "`$eliminacampagna <Nome>`: Elimina una campagna."
                },
                {
                    name: "🎙️ Gestione Sessione",
                    value:
                        "`$ascolta [Luogo]`: Inizia la registrazione (Campagna Attiva).\n" +
                        "`$termina`: Termina la sessione.\n" +
                        "`$pausa`: Sospende la registrazione.\n" +
                        "`$riprendi`: Riprende la registrazione.\n" +
                        "`$luogo [Macro | Micro]`: Visualizza o aggiorna il luogo attuale.\n" +
                        "`$viaggi`: Mostra la cronologia degli spostamenti.\n" +
                        "`$atlante [Descrizione]`: Visualizza o aggiorna la memoria del luogo.\n" +
                        "`$nota <Testo>`: Aggiunge una nota manuale al riassunto.\n" +
                        "`$impostasessione <N>`: Imposta numero sessione.\n" +
                        "`$impostasessioneid <ID> <N>`: Corregge il numero.\n" +
                        "`$reset <ID>`: Forza la rielaborazione di una sessione."
                },
                {
                    name: "👥 NPC & Dossier",
                    value:
                        "`$npc [Nome]`: Visualizza o aggiorna il dossier NPC.\n" +
                        "`$presenze`: Mostra gli NPC incontrati nella sessione corrente."
                },
                {
                    name: "📜 Narrazione & Archivi",
                    value:
                        "`$listasessioni`: Ultime 5 sessioni (Campagna Attiva).\n" +
                        "`$racconta <ID> [tono]`: Rigenera riassunto.\n" +
                        "`$modificatitolo <ID> <Titolo>`: Modifica il titolo di una sessione.\n" +
                        "`$chiedialbardo <Domanda>`: Chiedi al Bardo qualcosa sulla storia.\n" +
                        "`$wiki <Termine>`: Cerca frammenti di lore esatti.\n" +
                        "`$timeline`: Mostra la cronologia degli eventi mondiali.\n" +
                        "`$memorizza <ID>`: Indicizza manualmente una sessione nella memoria.\n" +
                        "`$scarica <ID>`: Scarica audio.\n" +
                        "`$scaricatrascrizioni <ID>`: Scarica testo trascrizioni (txt)."
                },
                {
                    name: "🎒 Inventario & Quest",
                    value:
                        "`$quest`: Visualizza quest attive.\n" +
                        "`$quest add <Titolo>`: Aggiunge una quest.\n" +
                        "`$quest done <Titolo>`: Completa una quest.\n" +
                        "`$inventario`: Visualizza inventario.\n" +
                        "`$loot add <Oggetto>`: Aggiunge un oggetto.\n" +
                        "`$loot use <Oggetto>`: Rimuove/Usa un oggetto."
                },
                {
                    name: "👤 Scheda Personaggio (Campagna Attiva)",
                    value:
                        "`$sono <Nome>`: Imposta il tuo nome.\n" +
                        "`$miaclasse <Classe>`: Imposta la tua classe.\n" +
                        "`$miarazza <Razza>`: Imposta la tua razza.\n" +
                        "`$miadesc <Testo>`: Aggiunge dettagli.\n" +
                        "`$chisono`: Visualizza la tua scheda.\n" +
                        "`$party`: Visualizza tutti i personaggi.\n" +
                        "`$storia <Nome>`: Genera la biografia evolutiva (PG o NPC).\n" +
                        "`$resetpg`: Resetta la tua scheda."
                },
                {
                    name: "⏳ Tempo & Storia",
                    value:
                        "`$anno0 <Descrizione>`: Imposta l'evento fondante (Anno 0).\n" +
                        "`$data <Anno>`: Imposta l'anno corrente della campagna.\n" +
                        "`$timeline`: Mostra la cronologia degli eventi.\n" +
                        "`$timeline add <Anno> | <Tipo> | <Desc>`: Aggiunge un evento storico."
                },
                {
                    name: "⚙️ Configurazione & Status",
                    value:
                        "`$setcmd`: Imposta questo canale per i comandi.\n" +
                        "`$setsummary`: Set this channel for summaries.\n" +
                        "`$stato`: Mostra lo stato delle code di elaborazione."
                },
                {
                    name: "🧪 Test & Debug",
                    value:
                        "`$teststream <URL>`: Simula una sessione via link audio.\n" +
                        "`$cleantest`: Rimuove tutte le sessioni di test dal DB."
                }
            )
            .setFooter({ text: "Per la versione inglese usa $help" });
        return await message.reply({ embeds: [helpEmbed] });
    }

    // --- HELP (INGLESE) ---
    if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle("🖋️ Lestapenna - Available Commands")
            .setColor("#D4AF37")
            .setDescription("Welcome, adventurers! I am your personal bard and chronicler.")
            .addFields(
                {
                    name: "🗺️ Campaigns",
                    value:
                        "`$createcampaign <Name>`: Create a new campaign.\n" +
                        "`$selectcampaign <Name>`: Activate a campaign.\n" +
                        "`$listcampaigns`: Show available campaigns.\n" +
                        "`$deletecampaign <Name>`: Delete a campaign."
                },
                {
                    name: "🎙️ Session Management",
                    value:
                        "`$listen [Location]`: Start recording (Active Campaign).\n" +
                        "`$stoplistening`: End the session.\n" +
                        "`$pause`: Pause recording.\n" +
                        "`$resume`: Resume recording.\n" +
                        "`$location [Macro | Micro]`: View or update current location.\n" +
                        "`$travels`: Show travel history.\n" +
                        "`$atlas [Description]`: View or update location memory.\n" +
                        "`$note <Text>`: Add a manual note to the summary.\n" +
                        "`$setsession <N>`: Manually set session number.\n" +
                        "`$setsessionid <ID> <N>`: Fix session number by ID.\n" +
                        "`$reset <ID>`: Force re-processing of a session."
                },
                {
                    name: "👥 NPC & Dossier",
                    value:
                        "`$npc [Name]`: View or update NPC dossier.\n" +
                        "`$presenze`: Show NPCs encountered in current session."
                },
                {
                    name: "📜 Storytelling & Archives",
                    value:
                        "`$listsessions`: Last 5 sessions (Active Campaign).\n" +
                        "`$narrate <ID> [tone]`: Regenerate summary.\n" +
                        "`$edittitle <ID> <Title>`: Edit session title.\n" +
                        "`$ask <Question>`: Ask the Bard about the lore.\n" +
                        "`$lore <Term>`: Search exact lore fragments.\n" +
                        "`$timeline`: Show world history timeline.\n" +
                        "`$ingest <ID>`: Manually index a session into memory.\n" +
                        "`$download <ID>`: Download audio.\n" +
                        "`$downloadtxt <ID>`: Download transcriptions (txt)."
                },
                {
                    name: "🎒 Inventory & Quests",
                    value:
                        "`$quest`: View active quests.\n" +
                        "`$quest add <Title>`: Add a quest.\n" +
                        "`$quest done <Title>`: Complete a quest.\n" +
                        "`$inventory`: View inventory.\n" +
                        "`$loot add <Item>`: Add an item.\n" +
                        "`$loot use <Item>`: Remove/Use an item."
                },
                {
                    name: "👤 Character Sheet (Active Campaign)",
                    value:
                        "`$iam <Name>`: Set your character name.\n" +
                        "`$myclass <Class>`: Set your class.\n" +
                        "`$myrace <Race>`: Set your race.\n" +
                        "`$mydesc <Text>`: Add details.\n" +
                        "`$whoami`: View your current sheet.\n" +
                        "`$party`: View all characters.\n" +
                        "`$story <CharName>`: Generate character biography.\n" +
                        "`$clearchara`: Reset your sheet."
                },
                {
                    name: "⚙️ Configuration & Status",
                    value:
                        "`$setcmd`: Set this channel for commands.\n" +
                        "`$setsummary`: Set this channel for summaries.\n" +
                        "`$status`: Show processing queue status."
                },
                {
                    name: "🧪 Test & Debug",
                    value:
                        "`$teststream <URL>`: Simulate a session via direct audio link.\n" +
                        "`$cleantest`: Remove all test sessions from DB."
                }
            )
            .setFooter({ text: "Per la versione italiana usa $aiuto" });
        return await message.reply({ embeds: [helpEmbed] });
    }

    // --- CONFIGURAZIONE ---
    if (command === 'setcmd') {
        if (!message.member?.permissions.has('ManageChannels')) {
            return await message.reply("⛔ Non hai il permesso di configurare il bot.");
        }
        setGuildConfig(message.guild!.id, 'cmd_channel_id', message.channelId);
        return await message.reply(`✅ Canale Comandi impostato su <#${message.channelId}>.`);
    }

    if (command === 'setsummary') {
        if (!message.member?.permissions.has('ManageChannels')) {
            return await message.reply("⛔ Non hai il permesso di configurare il bot.");
        }
        setGuildConfig(message.guild!.id, 'summary_channel_id', message.channelId);
        return await message.reply(`✅ Canale Riassunti impostato su <#${message.channelId}>.`);
    }

    // --- STATO ---
    if (command === 'stato' || command === 'status') {
        const audioCounts = await audioQueue.getJobCounts();
        const correctionCounts = await correctionQueue.getJobCounts();

        const embed = new EmbedBuilder()
            .setTitle("⚙️ Stato del Sistema")
            .setColor("#2ECC71")
            .addFields(
                { name: "🎙️ Coda Audio", value: `In attesa: ${audioCounts.waiting}\nAttivi: ${audioCounts.active}\nCompletati: ${audioCounts.completed}\nFalliti: ${audioCounts.failed}`, inline: true },
                { name: "🧠 Coda Correzione", value: `In attesa: ${correctionCounts.waiting}\nAttivi: ${correctionCounts.active}\nCompletati: ${correctionCounts.completed}\nFalliti: ${correctionCounts.failed}`, inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
        return;
    }

    // --- TONI ---
    if (command === 'toni' || command === 'tones') {
        const embed = new EmbedBuilder()
            .setTitle("🎭 Toni Narrativi")
            .setColor("#9B59B6")
            .setDescription("Scegli come deve essere raccontata la tua storia:")
            .addFields(Object.entries(TONES).map(([key, desc]) => ({ name: key, value: desc })));

        await message.reply({ embeds: [embed] });
        return;
    }

    // --- TEST STREAM ---
    if (command === 'teststream') {
        // La logica è gestita in index.ts
        return; 
    }

    // --- CLEAN TEST ---
    if (command === 'cleantest') {
        // La logica è gestita in index.ts
        return;
    }

    // --- WIPE ---
    if (command === 'wipe') {
        if (message.author.id !== '310865403066712074') return;

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

    // --- TEST MAIL ---
    if (command === 'testmail') {
        if (message.author.id !== '310865403066712074') return;

        await message.reply("📧 Invio email di test in corso...");
        const success = await sendTestEmail('gabligetta@gmail.com');

        if (success) {
            await message.reply("✅ Email inviata con successo! Controlla la casella di posta.");
        } else {
            await message.reply("❌ Errore durante l'invio. Controlla i log della console.");
        }
        return;
    }

    // --- NUOVO: $anno0 <Descrizione> ---
    if (command === 'anno0' || command === 'year0') {
        const activeCampaign = getActiveCampaign(message.guild!.id);
        if (!activeCampaign) return await message.reply("⚠️ **Nessuna campagna attiva!**");

        const desc = args.join(' ');
        if (!desc) return await message.reply("Uso: `$anno0 <Descrizione Evento Cardine>` (es. 'La Caduta dell'Impero')");

        setCampaignYear(activeCampaign.id, 0);
        addWorldEvent(activeCampaign.id, null, desc, 'GENERIC', 0);

        return await message.reply(`📅 **Anno 0 Stabilito!**\nEvento: *${desc}*\nOra puoi usare \`$data <Anno>\` per impostare la data corrente.`);
    }

    // --- NUOVO: $data <Anno> ---
    if (command === 'data' || command === 'date' || command === 'anno' || command === 'year') {
        const activeCampaign = getActiveCampaign(message.guild!.id);
        if (!activeCampaign) return await message.reply("⚠️ **Nessuna campagna attiva!**");

        const yearStr = args[0];
        if (!yearStr) {
            const current = activeCampaign.current_year;
            const label = current === undefined ? "Non impostata" : (current === 0 ? "Anno 0" : (current > 0 ? `${current} D.E.` : `${Math.abs(current)} P.E.`));
            return await message.reply(`📅 **Data Attuale:** ${label}`);
        }

        const year = parseInt(yearStr);
        if (isNaN(year)) return await message.reply("Uso: `$data <Numero Anno>` (es. 100 o -50)");

        setCampaignYear(activeCampaign.id, year);
        const label = year === 0 ? "Anno 0" : (year > 0 ? `${year} D.E.` : `${Math.abs(year)} P.E.`);
        
        // Aggiorna anche l'anno corrente in memoria per le registrazioni attive
        activeCampaign.current_year = year;
        
        return await message.reply(`📅 Data campagna aggiornata a: **${label}**`);
    }
}
