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
                        "`$nota <Testo>`: Aggiunge una nota manuale al riassunto.\n" +
                        "`$impostasessione <N>`: Imposta numero sessione.\n" +
                        "`$reset <ID>`: Forza la rielaborazione di una sessione."
                },
                {
                    name: "🕰️ Comandi per Sessione Specifica",
                    value: "Molti comandi accettano un ID sessione (`session_xxxxx` o UUID) per vedere lo storico:\n" +
                           "`$viaggi <ID>`: Spostamenti della sessione.\n" +
                           "`$presenze <ID>`: NPC incontrati.\n" +
                           "`$npc <ID>`: Anteprima NPC.\n" +
                           "`$atlante <ID>`: Luoghi visitati.\n" +
                           "`$inventario <ID>`: Oggetti acquisiti.\n" +
                           "`$quest <ID>`: Quest aggiunte."
                },
                {
                    name: "📍 Luoghi & Atlante",
                    value:
                        "`$luogo [Macro | Micro]`: Visualizza o aggiorna il luogo.\n" +
                        "`$viaggi`: Cronologia spostamenti.\n" +
                        "`$viaggi fix #ID | <R> | <L>`: Correggi voce cronologia.\n" +
                        "`$atlante`: Memoria del luogo attuale.\n" +
                        "`$atlante list`: Elenca tutti i luoghi.\n" +
                        "`$atlante rename <VR>|<VL>|<NR>|<NL>`: Rinomina luogo.\n" +
                        "`$atlante <R> | <L> | <Desc> [| force]`: Aggiorna.\n" +
                        "`$atlante sync [all|Nome]`: Sincronizza RAG."
                },
                {
                    name: "👥 NPC & Dossier",
                    value:
                        "`$npc [Nome]`: Visualizza o aggiorna il dossier NPC.\n" +
                        "`$npc add <Nome> | <Ruolo> | <Desc>`: Crea un nuovo NPC.\n" +
                        "`$npc merge <Vecchio> | <Nuovo>`: Unisce due NPC.\n" +
                        "`$npc delete <Nome>`: Elimina un NPC.\n" +
                        "`$npc update <Nome> | <Campo> | <Val> [| force]`: Aggiorna campi.\n" +
                        "`$npc regen <Nome>`: Rigenera le note usando la cronologia.\n" +
                        "`$npc sync [Nome|all]`: Sincronizza manualmente il RAG.\n" +
                        "`$presenze`: Mostra NPC incontrati nella sessione."
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
                    name: "🐲 Bestiario",
                    value:
                        "`$bestiario`: Mostra i mostri incontrati.\n" +
                        "`$bestiario <Nome>`: Dettagli del mostro (abilità, debolezze, ecc.).\n" +
                        "`$bestiario merge <Vecchio> | <Nuovo>`: Unisce due mostri."
                },
                {
                    name: "🎒 Inventario & Quest",
                    value:
                        "`$quest`: Visualizza quest attive.\n" +
                        "`$quest add <Titolo>`: Aggiunge una quest.\n" +
                        "`$quest done <Titolo>`: Completa una quest.\n" +
                        "`$quest delete <ID>`: Elimina una quest.\n" +
                        "`$inventario`: Visualizza inventario.\n" +
                        "`$loot add <Oggetto>`: Aggiunge un oggetto.\n" +
                        "`$loot use <Oggetto>`: Rimuove/Usa un oggetto.\n" +
                        "`$unisciitem <Vecchio> | <Nuovo>`: Unisce due oggetti.\n" +
                        "`$unisciquest <Vecchia> | <Nuova>`: Unisce due quest."
                },
                {
                    name: "👤 Scheda Personaggio (Campagna Attiva)",
                    value:
                        "`$sono <Nome>`: Imposta il tuo nome.\n" +
                        "`$miaclasse <Classe>`: Imposta la tua classe.\n" +
                        "`$miarazza <Razza>`: Imposta la tua razza.\n" +
                        "`$miadesc <Testo>`: Aggiunge dettagli.\n" +
                        "`$chisono [Nome]`: Visualizza la scheda (tua o di un altro).\n" +
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
                        "`$stato`: Mostra lo stato delle code di elaborazione.\n" +
                        "`$metriche`: Mostra le metriche live della sessione."
                },
                {
                    name: "🔧 Comandi Avanzati",
                    value:
                        "**NPC Alias (per RAG)**\n" +
                        "`$npc alias <Nome> add <Soprannome>`: Aggiungi alias.\n" +
                        "`$npc alias <Nome> remove <Soprannome>`: Rimuovi alias.\n\n" +
                        "**Timeline**\n" +
                        "`$timeline delete <ID>`: Elimina evento storico.\n\n" +
                        "**Viaggi**\n" +
                        "`$viaggi fixcurrent <R> | <L>`: Correggi posizione corrente.\n" +
                        "`$viaggi delete <ID>`: Elimina voce cronologia.\n\n" +
                        "**Altro**\n" +
                        "`$toni`: Lista toni narrativi per `$racconta`.\n" +
                        "`$autoaggiorna on/off`: Toggle auto-update biografie PG.\n" +
                        "`$riprocessa <ID>`: Rigenera memoria/dati (no ritrascrizione)."
                },
                {
                    name: "🧪 Test & Debug",
                    value:
                        "`$teststream <URL>`: Simula una sessione via link audio.\n" +
                        "`$cleantest`: Rimuove tutte le sessioni di test dal DB."
                },
                {
                    name: "💡 Alias Comandi",
                    value: "Molti comandi hanno alias inglesi: `$luogo`/`$location`, `$atlante`/`$atlas`, `$dossier`/`$npc`, `$viaggi`/`$travels`, `$inventario`/`$inventario`, `$bestiario`/`$bestiario`, `$unisciitem`/`$mergeitem`, `$unisciquest`/`$mergequest`, etc."
                }
            )
            .setFooter({ text: "Per la versione italiana usa $aiuto" });

        await ctx.message.reply({ embeds: [helpEmbed] });
    }
};
