/**
 * $aiuto command - Italian help
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';

export const aiutoCommand: Command = {
    name: 'aiuto',
    aliases: [],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args[0]?.toLowerCase();
        const isAdvanced = arg === 'advanced' || arg === 'avanzato' || arg === 'admin';

        if (arg && !['advanced', 'avanzato', 'admin', 'dev'].includes(arg)) {
            // --- AIUTO DETTAGLIATO COMANDO ---
            const embed = new EmbedBuilder().setColor("#D4AF37");

            if (['npc', 'quest', 'atlante', 'loot', 'bestiario', 'atlas', 'faction', 'fazione'].includes(arg)) {
                embed.setTitle(`🧩 Entità Unificata: $${arg}`)
                    .setDescription(`Interfaccia comune per la gestione di entità. La maggior parte dei sottocomandi è **interattiva**.`)
                    .addFields(
                        { name: "🔍 Esplorazione", value: `\`$${arg}\`: Lista e ricerca interattiva.\n\`$${arg} #ID\`: Visualizza il dossier dettagliato.` },
                        { name: "⚡ Azioni Interattive", value: `\`$${arg} add\`: Crea nuovo.\n\`$${arg} update\`: Modifica campi/narrativa.\n\`$${arg} merge\`: Unisci duplicati.\n\`$${arg} delete\`: Flusso eliminazione.` },
                        { name: "📜 Gestione Eventi", value: `\`$${arg} events\`: Sfoglia lo storico.\n\`$${arg} events add\`: Aggiungi manualmente un evento.\n\`$${arg} events update\`: Modifica eventi passati.\n\`$${arg} events delete\`: Rimuovi errori dallo storico.\n*Esempio: \`$${arg} events add Garlon\`*` },
                        { name: "📝 Aggiornamento Rapido Narrativo", value: `\`$${arg} update <ID> | <Nota>\`\nAggiungi un aggiornamento per innescare la rigenerazione bio via IA.` }
                    );
            } else if (arg === 'affiliate' || arg === 'affilia') {
                embed.setTitle(`🛡️ Affiliazioni: $affiliate`)
                    .setDescription("Gestisci le relazioni tra entità (NPC/Luoghi) e Fazioni.")
                    .addFields(
                        { name: "🔍 Consultazione", value: `\`$affiliate list <Fazione>\`: Elenca tutti i membri.\n\`$affiliate of <Entità>\`: Vedi a quali fazioni appartiene un personaggio/luogo.` },
                        { name: "🤝 Gestione (Interattiva)", value: `\`$affiliate\`: Avvia il flusso di associazione interattiva.` },
                        { name: "📝 Uso Manuale", value: `\`$affiliate <Tipo> <Nome> | <Fazione> | <Ruolo>\`\nes. \`$affiliate npc Frodo | Compagnia | MEMBER\`` }
                    );
            } else if (arg === 'timeline' || arg === 'cronologia') {
                embed.setTitle(`⏳ Comando: $timeline`)
                    .setDescription(`Gestisci gli eventi storici del tuo mondo.`)
                    .addFields(
                        { name: "📜 Mostra Cronologia", value: `\`$timeline\`: Visualizza la storia cronologica.` },
                        { name: "➕ Aggiungi Evento", value: `\`$timeline add <Anno> | <Tipo> | <Descrizione>\`\nAggiungi una pietra miliare storica.` },
                        { name: "🗑️ Elimina", value: `\`$timeline delete #ID\`: Rimuove un evento usando il suo Short ID.` }
                    );
            } else if (arg === 'setworld' || arg === 'mondo') {
                embed.setTitle(`🌍 Comando: $setworld`)
                    .setDescription("Il modo principale per configurare l'ambientazione della tua campagna.")
                    .addFields(
                        { name: "⚙️ Configurazione Interattiva", value: "Scrivi `$setworld` per aprire il menu di configurazione. Puoi impostare:\n• Anno Corrente\n• Luogo Corrente (Regione e Posto)\n• Nome Fazione del Party" }
                    );
            } else {
                await ctx.message.reply(`❌ Aiuto dettagliato per \`$${arg}\` non trovato. Usa \`$aiuto\` o \`$aiuto avanzato\`.`);
                return;
            }

            await ctx.message.reply({ embeds: [embed] });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor("#D4AF37")
            .setFooter({ text: "🇬🇧 For English version: $help" })
            .setTitle(isAdvanced ? "🔧 Lestapenna - Strumenti Avanzati" : "🖋️ Lestapenna - Guida Rapida")
            .setDescription(isAdvanced
                ? "Strumenti di gestione e amministrazione per i DM."
                : "Benvenuti su Lestapenna! Ecco i comandi essenziali per iniziare.");

        if (isAdvanced) {
            // --- VISTA AVANZATA ---
            embed.addFields(
                {
                    name: "🗺️ Gestione Campagna",
                    value:
                        "`$listacampagne`: Elenco di tutte le campagne.\n" +
                        "`$creacampagna <Nome>`: Crea una nuova campagna.\n" +
                        "`$selezionacampagna <Nome>`: Cambia campagna attiva."
                },
                {
                    name: "🧩 Manutenzione e Admin",
                    value:
                        "`$setcmd`: Imposta il canale dei comandi.\n" +
                        "`$autoaggiorna on/off`: Attiva/disattiva aggiornamenti bio auto.\n" +
                        "`$sync all`: Forza la sincronizzazione RAG per tutti gli NPC.\n" +
                        "`$metriche`: Visualizza utilizzo e costi IA."
                },
                {
                    name: "🛠️ Comandi Specializzati",
                    value:
                        "`$timeline add`: Crea eventi storici manuali.\n" +
                        "`$data <Anno>`: Imposta l'anno corrente.\n" +
                        "`$anno0 <Desc>`: Definisce il punto di svolta storico.\n" +
                        "💡 *Scrivi `$aiuto <comando>` (es. `$aiuto affiliate`) per i dettagli.*"
                }
            );
        } else if (arg === 'dev') {
            // --- VISTA DEVELOPER ---
            embed.setTitle("👨‍💻 Strumenti Sviluppatore")
                .addFields(
                    {
                        name: "🧪 Debug",
                        value: "`$stato`: Salute code.\n`$debug teststream <URL>`: Simulazione.\n`$rebuild CONFIRM`: Re-indicizza DB."
                    },
                    {
                        name: "⚠️ Danger Zone",
                        value: "`$wipe softwipe`: Pulisci RAG.\n`$wipe wipe`: DISTRUZIONE DB.\n`$resetpg`: Reset della tua scheda."
                    }
                );
        } else {
            // --- VISTA BASE ---
            embed.addFields(
                {
                    name: "🎙️ Sessioni",
                    value:
                        "• `$ascolta`: Avvia registrazione (setup interattivo).\n" +
                        "• `$termina`: Chiudi sessione e genera riassunto.\n" +
                        "• `$listasessioni`: Sfoglia archivi e scarica verbali."
                },
                {
                    name: "🌍 Tracking Mondo",
                    value:
                        "• `$setworld`: **Menu config** (Anno, Luogo, Party).\n" +
                        "• `$luogo`: Dove ci troviamo ora?\n" +
                        "• `$timeline`: Sfoglia la cronologia del mondo."
                },
                {
                    name: "👤 Personaggi e Party",
                    value:
                        "• `$sono <Nome>`: Collega te stesso a un personaggio.\n" +
                        "• `$chisono`: Visualizza la tua scheda.\n" +
                        "• `$compagni`: Vedi i tuoi alleati."
                },
                {
                    name: "🧩 Record Unificati (Interattivi)",
                    value:
                        "Gestisci le entità del mondo con questi comandi:\n" +
                        "**`$npc`, `$quest`, `$loot`, `$atlante`, `$fazione`, `$bestiario`**\n" +
                        "• Sottocomandi: `add`, `update`, `delete`, `merge`, `events`"
                },
                {
                    name: "🛡️ Legami Fazione",
                    value: "• `$affiliate`: Gestisci chi appartiene a cosa."
                },
                {
                    name: "📖 Narrazione",
                    value:
                        "• `$chiedialbardo <Argomento>`: Chiedi al Bardo informazioni sul lore.\n" +
                        "• `$wiki <Termine>`: Cerca negli archivi."
                },
                {
                    name: "🔧 Altro",
                    value: "Per strumenti DM e gestione campagna, scrivi **`$aiuto avanzato`**."
                }
            );
        }

        await ctx.message.reply({ embeds: [embed] });
    }
};
