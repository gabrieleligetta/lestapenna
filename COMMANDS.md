# 📜 Lista Completa Comandi Lestapenna

## ℹ️ Generale
| Comando | Alias | Parametri | Descrizione |
| :--- | :--- | :--- | :--- |
| `$aiuto` | `$help` | `[dev/advanced]` | Mostra la lista dei comandi. |
| `$stato` | `$status` | - | Verifica lo stato delle code di elaborazione e dei servizi. |
| `$metriche` | `$metrics` | - | Visualizza statistiche tecniche (token, costi, durata). |

## 🎙️ Sessione
| Comando | Alias | Parametri | Descrizione |
| :--- | :--- | :--- | :--- |
| `$ascolta` | `$listen` | `[Luogo]` | Il bot entra in vocale e inizia a registrare. |
| `$pausa` | `$pause` | - | Sospende la registrazione audio. |
| `$riprendi` | `$resume` | - | Riprende la registrazione audio. |
| `$nota` | `$note` | `<Testo>` | Inserisce una nota manuale nel log. |
| `$stop` | `$termina` | - | Chiude la sessione, avvia trascrizione e riassunto. |
| `$listasessioni` | `$listsessions` | - | Elenca le sessioni recenti salvate. |

## 🌍 Luogo e Atmosfera
| Comando | Alias | Parametri | Descrizione |
| :--- | :--- | :--- | :--- |
| `$luogo` | `$location` | `[Regione] \| [Dettaglio]` | Mostra o imposta manualmente la posizione attuale. |

## 📜 Narrazione e Storia
| Comando | Alias | Parametri | Descrizione |
| :--- | :--- | :--- | :--- |
| `$racconta` | `$narrate` | `<ID> [tono]` | Rigenera il riassunto di una sessione passata. |
| `$chiedialbardo` | `$ask` | `<Domanda>` | Chiedi qualsiasi cosa sulla storia della campagna. |
| `$wiki` | - | `<Termine>` | Cerca informazioni specifiche negli archivi. |
| `$timeline` | - | `[add/delete]` | Mostra o gestisce la cronologia eventi. |

## 👤 Personaggio (PG)
| Comando | Alias | Parametri | Descrizione |
| :--- | :--- | :--- | :--- |
| `$sono` | `$iam` | `<NomePG>` | Associa il tuo account Discord a un personaggio. |
| `$chisono` | `$whoami` | - | Visualizza la tua scheda personaggio. |
| `$compagni` | `$party` | - | Elenca i membri del party. |
| `$storia` | `$story` | `<NomePG>` | Leggi la storia del tuo PG narrata dal Bardo. |
| `$miaclasse` | `$myclass` | `<Classe>` | Imposta la classe del tuo PG. |
| `$miarazza` | `$myrace` | `<Razza>` | Imposta la razza del tuo PG. |
| `$miadesc` | `$mydesc` | `<Testo>` | Aggiunge una nota descrittiva alla bio. |
| `$bio reset` | - | `[NomePG]` | **[Avanzato]** Rigenerazione completa della biografia. |

## 🛠️ Gestione Mondo (Entità)
*Sintassi unificata per: `$npc`, `$quest`, `$atlante` (`$atlas`), `$loot`, `$bestiario` (`$bestiary`).*

| Azione | Sintassi | Descrizione |
| :--- | :--- | :--- |
| **Lista** | `$npc list` | Elenco entità attive. |
| **Vedi** | `$npc <ID/Nome>` | Dettagli scheda. |
| **Crea** | `$npc add <Nome>...` | Crea nuova entità (params specifici per tipo). |
| **Aggiorna** | `$npc update <ID> \| <Nota>` | Aggiunge evento narrativo. |
| **Edit** | `$npc update <ID> field:<k> <v>` | Modifica metadati (status, role, name). |
| **Unisci** | `$npc merge <Old> \| <New>` | Unisce due entità duplicati. |
| **Elimina** | `$npc delete <ID>` | Rimuove un'entità. |

### Comandi Specifici Entità
| Comando | Parametri | Descrizione |
| :--- | :--- | :--- |
| `$npc alias` | `<Nome> \| add \| <Alias>` | Aggiunge soprannome a un NPC. |
| `$quest done` | `<ID/Titolo>` | Segna una quest come completata. |
| `$loot use` | `<Oggetto>` | Consuma/Rimuove un oggetto dall'inventario. |
| `$unisciitem` | `<Old> \| <New>` | Unisce due oggetti nell'inventario. |
| `$viaggi fix` | `<ID> \| <Reg> \| <Luogo>` | Corregge una voce nel diario di viaggio. |
| `$data` | `<Anno>` | Imposta l'anno corrente. |
| `$anno0` | `<Descrizione>` | Definisce l'evento dell'anno zero. |

## 🔧 Amministrazione Campagna
| Comando | Alias | Parametri | Descrizione |
| :--- | :--- | :--- | :--- |
| `$creacampagna` | `$createcampaign` | `<Nome>` | Crea una nuova campagna. |
| `$selezionacampagna` | `$selectcampaign` | `<Nome>` | Seleziona la campagna attiva. |
| `$listacampagne` | `$listcampaigns` | - | Lista campagne disponibili. |
| `$eliminacampagna` | `$deletecampaign` | `<Nome>` | Cancella una campagna. |
| `$autoaggiorna` | `$autoupdate` | `on/off` | Toggle aggiornamento automatico bio PG. |
| `$impostasessione` | `$setsession` | `<N>` | Forza il numero della sessione attuale. |
| `$setcmd` | - | - | Imposta il canale corrente per i comandi. |
| `$setsummary` | - | - | Imposta il canale corrente per i riassunti. |
| `$memorizza` | `$ingest` | `<ID>` | Ingestione manuale sessione (senza audio). |
| `$scarica` | `$download` | `<ID>` | Download audio masterizzato. |
| `$presenze` | - | `<ID>` | Elenca NPC incontrati in una sessione. |

## ⚠️ Area Pericolo (Recovery)
| Comando | Parametri | Descrizione |
| :--- | :--- | :--- |
| `$recover` | `<ID>` | Riprova elaborazione sessione bloccata. |
| `$recover` | `regenerate-all` | **Time Travel**: Rigenera TUTTA la campagna. |
| `$riprocessa` | `<ID>` | Rigenera dati sessione (senza ritrascrivere). |
| `$reset` | `<ID>` | Reset totale sessione (ritrascrive audio). |
| `$wipe` | - | Cancella database (richiede conferma: `softwipe`/`wipe`). |

## 👨‍💻 Strumenti Sviluppatore (Dev)
*Visibili con `$help dev`*

| Comando | Parametri | Descrizione |
| :--- | :--- | :--- |
| `$debug teststream` | `<URL>` | Simula sessione da audio URL. |
| `$debug testmail` | - | Test invio email. |
| `$rebuild` | `CONFIRM` | Re-indicizzazione completa DB. |
| `$resetpg` | `$clearchara` | Cancella la scheda PG dell'utente. |
