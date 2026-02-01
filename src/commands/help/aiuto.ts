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
                    .setDescription(`Interfaccia comune per la gestione di entità come NPC, Missioni, Luoghi, Oggetti, Mostri e Fazioni.`)
                    .addFields(
                        { name: "📋 Lista", value: `\`$${arg}\`: Vede tutti gli elementi (dossier).\n\`$${arg} list\`: Listing esplicito.\n\`$${arg} #ID\`: Visualizza i dettagli di un'entità specifica.` },
                        { name: "📝 Aggiornamento Narrativo", value: `\`$${arg} update <ID> | <Nota>\`\nAggiunge un aggiornamento o un'osservazione. Innesca la rigenerazione bio via IA.` },
                        { name: "⚙️ Aggiornamento Metadati", value: `\`$${arg} update <ID> field:<chiave> <valore>\`\nModifica direttamente i campi (es. \`field:status SCONFITTO\`).` },
                        { name: "🔀 Unione (Merge)", value: `\`$${arg} merge <VecchioID/Nome> | <NuovoID/Nome>\`\nUnisce i duplicati in un unico record.` },
                        { name: "📜 Storico Eventi", value: `\`$${arg} events [pagina]\`: Visualizza lo storico eventi paginato.` },
                        { name: "🗑️ Eliminazione", value: `\`$${arg} delete <ID>\`\nRimuove permanentemente l'entità.` }
                    );
            } else if (arg === 'timeline' || arg === 'cronologia') {
                embed.setTitle(`⏳ Comando: $timeline`)
                    .setDescription(`Gestisci gli eventi storici del tuo mondo.`)
                    .addFields(
                        { name: "📜 Mostra Cronologia", value: `\`$timeline\`: Visualizza la storia cronologica.` },
                        { name: "➕ Aggiungi Evento", value: `\`$timeline add <Anno> | <Tipo> | <Descrizione>\`\nAggiungi una pietra miliare storica.` },
                        { name: "🏷️ Tipi di Evento", value: `Tipi validi: \`WAR\` (Guerra), \`POLITICS\` (Politica), \`DISCOVERY\` (Scoperta), \`CALAMITY\` (Calamità), \`SUPERNATURAL\` (Sovrannaturale), \`GENERIC\` (Generico).` },
                        { name: "🗑️ Elimina", value: `\`$timeline delete #ID\`: Rimuove un evento usando il suo Short ID.` }
                    );
            } else if (arg === 'data' || arg === 'date' || arg === 'anno0' || arg === 'year0' || arg === 'setworld' || arg === 'mondo') {
                embed.setTitle(`📅 Comandi Calendario e Mondo`)
                    .addFields(
                        { name: "$setworld", value: "Configura interattivamente anno, luogo e nome del party." },
                        { name: "$data <Anno>", value: `Imposta l'anno corrente della campagna. Influenza la timeline e le registrazioni.` },
                        { name: "$anno0 <Descrizione>", value: `Definisce il punto di svolta della storia (Anno 0) e resetta l'anno corrente a 0.` }
                    );
            } else if (arg === 'npc') {
                // Special case for npc alias
                embed.setTitle(`👥 Speciale NPC: $npc alias`)
                    .addFields(
                        { name: "Gestione Soprannomi", value: `\`$npc alias <ID> add <Alias>\`: Aggiunge un nome riconosciuto.\n\`$npc alias <ID> remove <Alias>\`: Rimuove un alias.` }
                    );
            } else if (arg === 'loot' || arg === 'unisciitem' || arg === 'mergeitem') {
                embed.setTitle(`📦 Speciale Inventario`)
                    .addFields(
                        { name: "$loot use <ID>", value: `Consuma un oggetto (decrementa il numero o lo rimuove).` },
                        { name: "$unisciitem <ID1> | <ID2>", value: `Comando legacy per unire oggetti (usa \`$loot merge\` invece).` }
                    );
            } else if (arg === 'viaggi' || arg === 'travels') {
                embed.setTitle(`🗺️ Registro Viaggi: $viaggi fix`)
                    .addFields(
                        { name: "Correggi Storico", value: `\`$viaggi fix #ID | <NuovaRegione> | <NuovoLuogo>\`\nCorregge un errore nel registro degli spostamenti.` }
                    );
            } else if (arg === 'affiliate' || arg === 'affilia') {
                embed.setTitle(`🛡️ Affiliazioni: $affiliate`)
                    .addFields(
                        { name: "Uso", value: `\`$affiliate <Tipo> <Nome> | <Fazione> | <Ruolo>\`` },
                        { name: "Listing", value: `\`$affiliate list <Fazione>\`: Vedi membri.\n\`$affiliate of <Entità>\`: Vedi fazioni dell'entità.` },
                        { name: "Esempi", value: `\`$affiliate npc Frodo | Compagnia | MEMBER\`\n\`$affiliate location Imladris | Elfi | CONTROLLED\`` },
                        { name: "Ruoli", value: `NPC: MEMBER, LEADER, ALLY, ENEMY, PRISONER\nLocation: CONTROLLED, PRESENCE, BASE` }
                    );
            } else if (arg === 'presenze') {
                embed.setTitle(`👥 NPC in Sessione: $presenze`)
                    .setDescription(`Visualizza quali NPC erano presenti o hanno interagito durante una sessione.`)
                    .addFields(
                        { name: "Sessione Corrente", value: `\`$presenze\`: Mostra gli NPC della sessione attiva.` },
                        { name: "Sessione Specifica", value: `\`$presenze session_xxxx\`: Mostra gli NPC di una sessione passata.` }
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
            .setTitle(isAdvanced ? "🔧 Lestapenna - Comandi Avanzati" : "🖋️ Lestapenna - Comandi Base")
            .setDescription(isAdvanced
                ? "Strumenti di potere per Dungeon Master e Admin.\nPer l'uso quotidiano, scrivi `$aiuto`."
                : "Comandi essenziali per giocatori e consultazione rapida.\nPer strumenti di modifica e admin, scrivi `$aiuto avanzato`.");

        if (isAdvanced) {
            // --- VISTA AVANZATA ---
            embed.addFields(
                {
                    name: "🗺️ Campagne",
                    value:
                        "`$listacampagne`: Lista campagne.\n" +
                        "`$creacampagna <Nome>`: Nuova campagna.\n" +
                        "`$selezionacampagna <Nome>`: Attiva campagna."
                },
                {
                    name: "🧩 Interfaccia Unificata Entità",
                    value:
                        "**Entità:** `$npc`, `$quest`, `$atlante`, `$loot`, `$bestiario`, `$faction`\n" +
                        "• `$cmd list` / `$cmd #ID`: Gestione record.\n" +
                        "• `$cmd events`: Vedi eventi.\n" +
                        "• `$cmd update`: Aggiornamenti narrativi o tecnici.\n" +
                        "• `$cmd merge` / `$cmd delete`: Manutenzione.\n" +
                        "💡 *Scrivi `$aiuto <entità>` (es. `$aiuto npc`) per i dettagli.*"
                },
                {
                    name: "👥 Comandi Specifici",
                    value:
                        "`$npc alias`: Gestione soprannomi.\n" +
                        "`$loot use`: Consuma oggetto.\n" +
                        "`$quest done`: Completa missione.\n" +
                        "`$viaggi fix`: Correggi storico.\n" +
                        "`$timeline add`: Crea la storia.\n" +
                        "`$data` / `$anno0`: Gestione calendario.\n" +
                        "💡 *Scrivi `$aiuto <comando>` per i dettagli.*"
                },
                {
                    name: "🔧 Admin & Config",
                    value:
                        "`$setcmd`: Imposta canale comandi.\n" +
                        "`$impostasessione <N>`: Forza num sessione.\n" +
                        "`$autoaggiorna on/off`: Bio PG auto.\n" +
                        "`$presenze <ID>`: Lista NPC sessione."
                }
            );
        } else if (arg === 'dev') {
            // --- VISTA DEVELOPER ---
            embed.setTitle("👨‍💻 Strumenti Sviluppatore")
                .setDescription("Strumenti di debug e manutenzione. Usa con cautela.")
                .addFields(
                    {
                        name: "🧪 Debug & Test",
                        value:
                            "`$debug teststream <URL>`: Simula sessione da link.\n" +
                            "`$debug testmail`: Invia report test via email.\n" +
                            "`$rebuild CONFIRM`: Re-indicizza intero DB (SOLO DEV).\n" +
                            "`$stato`: Mostra salute code interna."
                    },
                    {
                        name: "🛠️ Basso Livello",
                        value:
                            "`$wipe softwipe`: Pulisce RAG/dati derivati.\n" +
                            "`$wipe wipe`: DISTRUZIONE TOTALE DATABASE.\n" +
                            "`$resetpg`: Cancella la tua scheda PG."
                    }
                );
        } else {
            // --- VISTA BASE ---
            embed.addFields(
                {
                    name: "ℹ️ Generale",
                    value:
                        "`$aiuto`: Mostra questa lista.\n" +
                        "`$stato`: Salute sistema e code.\n" +
                        "`$metriche`: Costi e token sessione.\n" +
                        "`$listasessioni`: Elenco di tutte le sessioni."
                },
                {
                    name: "🎙️ Sessione",
                    value:
                        "`$ascolta [Luogo]`: Avvia reg.\n" +
                        "`$termina`: Chiudi e trascrivi.\n" +
                        "`$listasessioni`: Elenco sessioni.\n" +
                        "`$pausa` / `$riprendi`: Controllo reg.\n" +
                        "`$nota <Testo>`: Nota manuale."
                },
                {
                    name: "🌍 Luogo & Mondo",
                    value:
                        "`$setworld`: Configurazione interattiva mondo.\n" +
                        "`$luogo`: Dove siamo?\n" +
                        "`$luogo <Regione> | <Posto>`: Set manuale.\n" +
                        "`$viaggi`: Diario degli spostamenti."
                },
                {
                    name: "📜 Narrazione",
                    value:
                        "`$chiedialbardo <Domanda>`: Chiedi al Bardo.\n" +
                        "`$wiki <Termine>`: Cerca archivio.\n" +
                        "`$racconta <ID> [tono]`: Rigenera riassunto.\n" +
                        "`$timeline`: Mostra storia."
                },
                {
                    name: "👤 Personaggio",
                    value:
                        "`$sono <Nome>`: Collega utente-PG.\n" +
                        "`$chisono`: Vedi tua scheda.\n" +
                        "`$compagni`: Vedi gruppo.\n" +
                        "`$miaclasse` / `$miarazza`: Imposta scheda.\n" +
                        "`$miadesc <Testo>`: Imposta bio manuale.\n" +
                        "`$storia <Nome>`: Leggi storia PG.\n" +
                        "`$bio reset [Name]`: Rigenera bio PG.\n" +
                        "`$presenze`: NPC incontrati in sessione."
                },
                {
                    name: "🧩 Dossier e Liste",
                    value:
                        "`$npc`: Elenco degli NPC.\n" +
                        "`$quest`: Lista delle missioni.\n" +
                        "`$loot`: Inventario di gruppo.\n" +
                        "`$atlante`: Luoghi del mondo.\n" +
                        "`$bestiario`: Mostri incontrati.\n" +
                        "`$fazione`: Fazioni e reputazioni."
                },
                {
                    name: "🔧 Strumenti Avanzati",
                    value: "Devi gestire entità, inventario o admin tools?\n👉 **Scrivi `$aiuto avanzato`**"
                }
            );
        }

        await ctx.message.reply({ embeds: [embed] });
    }
};
