<div align="center">

# Lestapenna

**The Digital Bard** — records your tabletop RPG sessions on Discord,
transcribes them, and writes the chronicle.

Free. Open source. **No subscription** — the AI runs on your own keys.

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

</div>

---

## What it is

The bot joins your voice channel when you ask it to, records every voice
separately, and when the session ends it hands you back:

- **the transcript**, corrected and attributed to whoever spoke;
- **a narrative chronicle** of the evening, written the way a bard would tell it;
- **the campaign's memory** — NPCs, places, quests, factions, items, reputations —
  which grows session after session and which you can question by voice or from
  the web.

There is a web app too: a session archive, character sheets, and a chat with the
Bard about your own story.

## We make nothing from this

This is not a product looking for customers. It is one person's work, given to
the tabletop community, and the model is designed so that it stays that way:

- **no subscription, no credits, no payment to us.** There is no company behind
  this, and there is nothing to buy;
- **the AI runs on your keys** (OpenAI or Google Gemini), so whatever it costs
  you pay directly to them. A four-hour session usually lands around a couple of
  euros, and **you see the estimate before you press "listen"**;
- **or it costs nothing at all**: with Ollama and your own computer doing the
  transcription, you spend only your time and your electricity;
- **we don't sell data and there is no tracking.** No Google Analytics, no
  Plausible, no Sentry, no pixel. That claim is checkable, since the code is
  right here.

## How it works, briefly

```
Discord ──▶ per-user recording ──▶ transcription ──▶ AI correction
                                        │
                              your own PC, or a cloud model
                                        │
                                        ▼
                    analyst (extracts the world) ──▶ writer (tells it)
                                        │
                                        ▼
                      campaign memory (RAG) ──▶ questions to the Bard
```

Every phase picks its own model, but the choice *you* make is **a single one,
split in two**: a *Quality* group for the analyst and the writer, where it is
decided whether the summary is worth reading; a *Fast* group for everything
else, which runs hundreds of times on mechanical work. Per-phase granularity
exists, but it lives in the campaign's advanced settings, where it gets in
nobody's way.

## Trying it without installing anything

Invite the bot to your server, open the settings, paste an OpenAI or Gemini key.
The bot refuses to record until you have a transcription route configured — a
recording with no engine behind it is audio nobody will ever be able to read,
and it is better to say so beforehand than after four hours.

The shared public bot currently runs on donated/free hardware and accepts at
most **two simultaneous recordings across two Discord guilds** (one per guild).
Recording is protected from background processing, but at busy times a new
session may be refused until one of those recordings finishes. The message says
why instead of pretending the service has unlimited resources.

If you need dedicated capacity and control over availability, self-host the bot:
it is the most reliable route and is exactly what the AGPL source is here for.
If you prefer to improve the shared instance, `$dona` lists the ways to fund
maintenance and additional cloud capacity. A donation never buys queue priority
or private features.

## Self-hosting

```bash
git clone https://github.com/gabrieleligetta/lestapenna
cd lestapenna
cp .env.example .env          # DISCORD_BOT_TOKEN and little else
npm install
npm run secrets:generate-key  # generates SECRETS_MASTER_KEY, put it in .env
docker compose up -d
```

⚠️ **AI keys do not belong in `.env`.** They are configured per table from the
web app, or from the command line with `npm run secrets:set`: they live
encrypted in the database, not in the clear on disk.

⚠️ **`SECRETS_MASTER_KEY` must be kept outside the project**, and specifically
outside the Litestream replica bucket and outside `data/`: otherwise it ends up
in the very backup it protects.

### The two things that, ignored, cost you data

- **Losing `SECRETS_MASTER_KEY` means losing every table's credentials.** It is
  unrecoverable by design: the rows stay, marked `UNDECRYPTABLE`, and every table
  has to enter its own again. Keep an offline copy, and **not** in the Litestream
  replica bucket nor under `data/`: it would end up in the very backup it
  protects.
- **A campaign's embedding model is pinned at its first indexing.** Changing it
  makes everything that campaign remembers invisible until you reindex:
  `npm run rag:reindex -- --campaign <id> --model <model>`, which first shows you
  how many fragments it touches and what they cost.

To configure a table without going through the web app:

```bash
npm run secrets:set -- --guild <guildId> --key openai.apiKey
```

You type the value when prompted rather than passing it as an argument: an
argument would end up in your shell history and in the process list.

## Transcribing on your own computer

The free route. On a machine of yours, install
[`lesta-penna-ai-server`](https://github.com/gabrieleligetta/lesta-penna-ai-server)
and point your table's settings at it: the bot sends it a temporary link to the
audio and gets the text back. Your PC serves no other table, and nobody else's
PC serves yours.

If you switch it off between sessions, the bot can turn it on by itself:
Wake-on-LAN, your router's API, or any other method — it is an interface, and
adding one means writing one file.

## Supported providers

|  | transcription | text | memory (embeddings) |
|---|---|---|---|
| **OpenAI** | yes | yes | yes |
| **Google Gemini** | yes | yes | yes |
| **Ollama** (your hardware) | with your own PC | yes | yes |

Anthropic and Ollama Cloud are absent, and it is not a preference: Anthropic's
Messages API takes no audio and Anthropic has no embedding models — a table on
Anthropic would stall mid-session and have a mute RAG. Ollama Cloud does not
transcribe. Self-hosters can still force either from `ai.config.json`.

## Commands

Prefix `$`. The main ones: `$listen` to start, `$stop` to finish, `$ask` to
question the Bard. The full list is in [`COMMANDS.md`](COMMANDS.md), or `$help`.

## Documentation

- [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) — running it on your own server:
  the vault, key rotation, transcription, backups.
- [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md) — capacity limits, process
  isolation, zero-budget scaling, and the SQLite/PostgreSQL decision.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute, and what I look for
  in a change.
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability, and which areas
  do the worst damage.
- [`MAINTAINING.md`](MAINTAINING.md) — release identity, public-repository
  checklist, destructive-operation boundaries, and GitHub safety rules.

The rest lives in the code comments, next to what it describes: nearly every
non-obvious choice has the reason it was made, and the alternative that was
discarded, sitting beside it.

## License

**AGPL-3.0.** You may use it, study it, modify it and redistribute it. If you run
a modified version as a service for other people, you must offer those people the
source of your version — that is the clause that keeps this work where it was
put. The full text is in [`LICENSE`](LICENSE).

**Your campaign material is not covered by the license**: it is yours, and we
claim nothing over it.

## Supporting it

There is nothing to buy. The public instance currently runs on free hardware,
so it is deliberately limited to **two simultaneous recordings**. If the project
is useful to you, you can [sponsor it on GitHub](https://github.com/sponsors/gabrieleligetta)
or use the other channel shown by `$dona`: contributions pay for maintenance and
shared cloud capacity. They are optional and unlock nothing; self-hosting remains
free and gives your table dedicated resources.
