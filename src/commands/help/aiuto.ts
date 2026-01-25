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
                        "`$selezionacampagna <Nome>`: Attiva campagna.\n" +
                        "`$eliminacampagna <Nome>`: Cancella campagna."
                },
                {
                    name: "🧩 Interfaccia Unificata Entità",
                    value:
                        "**Entità:** `$npc`, `$quest`, `$atlante`, `$loot`, `$bestiario`\n" +
                        "**Sintassi:**\n" +
                        "• `$cmd list` / `$cmd #ID`\n" +
                        "• `$cmd update <ID> | <Nota>` (Narrativa)\n" +
                        "• `$cmd update <ID> field:<key> <val>` (Metadati)\n" +
                        "• `$cmd merge <Old> | <New>`\n" +
                        "• `$cmd delete <ID>`"
                },
                {
                    name: "👥 Comandi Specifici",
                    value:
                        "`$npc alias`: Gestione soprannomi.\n" +
                        "`$loot use`: Consuma oggetto.\n" +
                        "`$unisciitem`: Unisci oggetti doppi.\n" +
                        "`$quest done`: Completa missione.\n" +
                        "`$viaggi fix`: Correggi storico.\n" +
                        "`$timeline add <Anno> | <Tipo> | <Desc>`\n" +
                        "`$data <Anno>` / `$anno0 <Desc>`"
                },
                {
                    name: "🔧 Admin & Config",
                    value:
                        "`$setcmd`: Imposta canale comandi.\n" +
                        "`$impostasessione <N>`: Forza num sessione.\n" +
                        "`$autoaggiorna on/off`: Bio PG auto.\n" +
                        "`$scarica <ID>`: Download audio master.\n" +
                        "`$memorizza <ID>`: Import manuale.\n" +
                        "`$presenze <ID>`: Lista NPC sessione."
                },
                {
                    name: "⚠️ Area Pericolo",
                    value:
                        "`$recover <ID>`: Riprova sessione bloccata.\n" +
                        "`$riprocessa <ID>`: Rigenera dati (No trascrizione).\n" +
                        "`$reset <ID>`: Reset Totale (Audio orig.).\n" +
                        "`$recover regenerate-all`: **Time Travel** (Full Regen).\n" +
                        "`$wipe`: Reset dati."
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
                        "`$metriche`: Costi e token sessione."
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
                    name: "🌍 Luogo",
                    value:
                        "`$luogo`: Dove siamo?\n" +
                        "`$luogo <Regione> | <Posto>`: Set manuale."
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
                        "`$bio reset [Nome]`: Rigenera bio PG."
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
