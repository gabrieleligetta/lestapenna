# Lestapenna — command reference

> Generated from the command metadata by `npm run docs:commands`.
> Do not edit by hand: the previous version of this file was written by
> hand and ended up documenting commands that no longer existed.

All commands use the `$` prefix. 54 commands, in 9 groups.

## 🎙️ Sessions

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$download` | `$scarica` | Manage Server | Rebuild and download a session’s full audio. |
| `$list` | `$listasessioni`, `$listsessions` | Anyone | Browse past sessions and download their transcripts. |
| `$listen` | `$ascolta`, `$testascolta` | Anyone | Join the voice channel and start recording the session. |
| `$pause` | `$pausa`, `$riprendi`, `$resume` | Anyone | Pause or resume the recording in progress. |
| `$reset` | `$resetsession` | Administrator | Full reset of a session: it is transcribed again from the audio. |
| `$session` | `$sessione`, `$cronaca`, `$manage_session` | Anyone | Session dashboard: notes, number, and stop. |
| `$stop` | `$termina`, `$stoplistening` | Anyone | End the session and generate the recap. |

## 👤 Characters

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$bio` | `$biografia` | Anyone | Read a character’s biography, or have it rewritten. |
| `$character` | `$pg`, `$personaggio` | Anyone | Character sheet and event history of a PC. |
| `$iam` | `$sono`, `$profilo`, `$profile` | Anyone | Link your Discord account to a character. |
| `$party` | `$compagni` | Anyone | List the party members and their alignment. |
| `$story` | `$storia` | Anyone | The story of a character, as told by the Bard. |
| `$whoami` | `$chisono` | Anyone | Show your character sheet. |

## 🧩 World records

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$affiliate` | `$affilia`, `$affiliazione` | Anyone | Link NPCs and places to a faction. |
| `$artifact` | `$artefatto`, `$artefatti`, `$artifacts` | Anyone | Artifacts: effects, curses, ownership. |
| `$atlas` | `$atlante`, `$memoria` | Anyone | Atlas of the known places, with their history. |
| `$bestiary` | `$bestiario`, `$mostri`, `$monsters` | Anyone | Bestiary of the creatures the party has met. |
| `$faction` | `$fazione`, `$fazioni` | Anyone | Factions: sheet, reputation, members. |
| `$inventory` | `$inventario`, `$loot`, `$bag` | Anyone | Party inventory: loot, use, merge. |
| `$npc` | `$dossier` | Anyone | NPCs: dossier, creation, updates, merge. |
| `$presenze` | — | Anyone | The NPCs met during a session. |
| `$quest` | `$obiettivi` | Anyone | Quests: open, progress, complete. |

## 🌍 Place and time

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$date` | `$data`, `$anno`, `$year` | Anyone | Show or set the current in-world year. |
| `$location` | `$luogo` | Anyone | Show or set where the party is now. |
| `$setworld` | `$configuramondo`, `$mondo`, `$setup-world` | Anyone | Interactive setup: year, place, party name. |
| `$timeline` | `$cronologia` | Anyone | The chronology of the world’s events. |
| `$travels` | `$viaggi` | Anyone | The party’s travel log. |
| `$year0` | `$anno0` | Anyone | Define the event that year zero counts from. |

## 📖 Story

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$ask` | `$chiedialbardo` | Anyone | Ask the Bard anything about the campaign. |
| `$narrate` | `$racconta`, `$summarize` | Anyone | Rewrite the recap of a past session, in a chosen tone. |
| `$riepilogotecnico` | `$tecnico`, `$riepilogo` | Anyone | Technical recap of a session: costs, timings, quality. |
| `$wiki` | `$lore` | Anyone | Search a term in the campaign archives. |

## 🗺️ Campaigns

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$createcampaign` | `$creacampagna` | Manage Server | Create a new campaign. |
| `$deletecampaign` | `$eliminacampagna` | Administrator | Permanently delete a campaign. |
| `$listcampaigns` | `$listacampagne` | Anyone | List the campaigns on this server. |
| `$members` | `$membri` | Anyone | Who sits at this table: list and manage the members. |
| `$selectcampaign` | `$selezionacampagna`, `$setcampagna`, `$setcampaign` | Manage Server | Switch the active campaign. |

## ⚙️ Settings

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$autoupdate` | `$autoaggiorna` | Anyone | Turn automatic biography updates on or off. |
| `$language` | `$lingua`, `$idioma`, `$langue`, `$sprache` | Manage Server | Change the bot’s language, or the table’s spoken language. |
| `$metrics` | `$metriche` | Manage Server | AI usage and cost of the current session. |
| `$set` | `$setcmd`, `$setsummary`, `$setemail`, `$setadmin` | Anyone | Set the command channel, the recap channel, and the emails. |
| `$status` | `$stato` | Manage Server | State of the processing queues. |

## 💛 About Lestapenna

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$aiuto` | — | Anyone | The command guide, in Italian. |
| `$donate` | `$dona`, `$sostieni`, `$support` | Anyone | Support Lestapenna, and where to find the web app. |
| `$help` | — | Anyone | The command guide, in the server’s language. |

## ⚠️ Danger zone

> These are destructive or maintenance commands. They ask for
> confirmation, but they cannot be undone.

| Command | Also | Who | What it does |
| :--- | :--- | :--- | :--- |
| `$debug` | `$teststream`, `$testmail` | Administrator | Development tools: simulate a session, test the email. |
| `$ingest` | `$memorizza` | Administrator | Re-summarize a session and put it back into memory. |
| `$pubblica_tutto` | `$publish_all`, `$pubblica` | Administrator | Publish every completed session recap again. |
| `$rebuild` | `$rebuild_index`, `$reindex` | Administrator | Rebuild the whole campaign from the transcripts. |
| `$recover` | `$ripristina` | Administrator | Resume a session stuck mid-processing. |
| `$reprocess` | `$riprocessa`, `$regenerate` | Administrator | Regenerate a session’s data without transcribing it again. |
| `$rereconcile` | `$rericoncilia`, `$fixreconcile` | Administrator | Run entity deduplication again from the cached data. |
| `$sync` | `$sincronizza` | Administrator | Force the campaign memory to re-index. |
| `$wipe` | `$softwipe` | Administrator | Danger zone: empties the memory, or the whole database. |

---

Type `$help` in Discord for the same list, browsable and in your
server’s language, or `$help <command>` for one command in detail.
