# Self-hosting

Guida a far girare Lestapenna sul proprio server. Se cerchi invece *perché* il
progetto funziona in BYOK — ogni tavolo con le proprie chiavi, nessun ricavo per
chi lo ospita — parti da [«We make nothing from this»](../README.md#we-make-nothing-from-this)
nel README.

## Cosa serve

- Docker e Docker Compose
- Un bot Discord con il suo token ([portale sviluppatori](https://discord.com/developers/applications))
- Un bucket S3-compatibile per l'audio — il progetto usa Oracle Cloud Object
  Storage, ma qualunque endpoint S3 va bene
- **Almeno una chiave** OpenAI o Gemini, *oppure* un computer con Ollama e il
  server di trascrizione

Non serve un server potente: il lavoro pesante lo fanno i provider AI, o il PC
di ciascun tavolo. Il bot muove file e coordina.

## Avvio

```bash
git clone https://github.com/gabrieleligetta/lestapenna
cd lestapenna
cp .env.example .env
```

Compila `.env` — token Discord, Redis, storage. Poi la chiave della cassaforte,
che è l'unico segreto che deve stare lì:

```bash
npm install
npm run secrets:generate-key    # stampa una chiave: mettila in SECRETS_MASTER_KEY
npm run db:init                 # crea lo schema
docker compose up -d
```

## La cassaforte

Le chiavi AI dei tavoli **non stanno in `.env`**. Vivono cifrate in
`tenant_secrets`, in AES-256-GCM, con una sottochiave derivata per gilda e il
testo cifrato legato alla propria posizione. Il motivo è concreto: il database
SQLite viene replicato fuori host da Litestream, e un backup finito nelle mani
sbagliate non deve contenere una sola chiave leggibile.

### Custodire `SECRETS_MASTER_KEY`

⚠️ **Non nello stesso bucket della replica Litestream, e non sotto `data/`.**
Finirebbe nello stesso backup dei dati che protegge, il che la rende inutile.

⚠️ **Perderla significa perdere tutte le credenziali di tutti i tavoli.** Non è
recuperabile per costruzione: le righe restano, marcate `UNDECRYPTABLE`, e ogni
tavolo deve reinserire le proprie. Tienine una copia offline.

Se manca, l'applicazione parte lo stesso ma non accetta credenziali — e senza
credenziali nessun tavolo può usare l'IA. Non viene mai autogenerata su file:
un riavvio con volume effimero renderebbe ogni segreto indecifrabile per sempre,
senza spiegazione.

### Configurare un tavolo senza web app

Se fai girare solo il bot:

```bash
npm run secrets:set -- --guild <guildId> --key openai.apiKey
```

Il valore si digita quando richiesto, **non si passa come argomento**: finirebbe
nella cronologia della shell e nella lista processi.

Chiavi accettate: `openai.apiKey`, `gemini.apiKey`, `remoteWhisper.authToken`,
`remoteWhisper.shutdownToken`, e i segreti dei metodi di accensione.

### Ruotare la master key

```bash
# 1. genera la nuova
npm run secrets:generate-key

# 2. in ambiente, AFFIANCA senza sostituire:
#    SECRETS_MASTER_KEY=<vecchia>
#    SECRETS_MASTER_KEY_V2=<nuova>

# 3. ricifra tutto
npm run secrets:rotate

# 4. solo a rotazione completa, rimuovi la vecchia
```

Le righe che la chiave attiva non riesce ad aprire vengono **saltate e contate**,
mai riscritte alla cieca: una rotazione parziale si recupera rimettendo la
vecchia chiave, una distruttiva no.

### Venire dall'ambiente

Se hai una versione precedente con le chiavi in `.env`:

```bash
npm run secrets:import-env                  # elenca le gilde candidate
npm run secrets:import-env -- --guild 123   # importa in quella gilda
```

Le gilde vanno **nominate una per una, di proposito**: importare in tutte
ricostruirebbe la situazione che il BYOK esiste per chiudere, cioè un'unica
chiave che paga per chiunque. A importazione riuscita, **svuota le chiavi da
`.env`**: lì restano in chiaro, finiscono nei backup del volume e in
`docker inspect`.

## I link che il bot mostra

`$dona` e la riga che compare a inizio e fine sessione puntano, per impostazione
predefinita, al progetto originale: sono gli stessi link già pubblicati in
`.github/FUNDING.yml` e nel README, e quel comando parla di Lestapenna, non di
chi lo ospita.

Se fai un fork, `DONATION_URL` e `REPO_URL` sono tuoi da cambiare. Se non vuoi
chiedere niente a nessuno:

```bash
DONATION_URL=          # il link sparisce ovunque, `$dona` compreso
COMMUNITY_NUDGES=false # nessun messaggio propone più la donazione da solo
```

Con `COMMUNITY_NUDGES=false` restano solo i comandi digitati apposta: né la riga
dopo `$ascolta`/`$termina`, né il piè di pagina dei riassunti. Quando è attivo,
il promemoria compare **al massimo una volta ogni due settimane per server** —
un messaggio a ogni sessione non è un promemoria, è rumore.

La barra in fondo alla web app ha un terzo stato, che serve a chi il canale non
lo ha ancora aperto:

```bash
DONATION_ACTIVE=false  # il sostegno è nominato, ma il link non è cliccabile
```

Un profilo GitHub Sponsors non ancora pubblicato reindirizza al profilo utente:
il link si apre e non chiede niente, il che è peggio che non averlo. Con
`DONATION_ACTIVE=false` la voce resta visibile e inerte; la si accende quando la
pagina accetta davvero donazioni, senza toccare il codice. A `DONATION_URL`
vuoto la voce non compare affatto, indipendentemente da questo.

## Trascrizione

Ogni tavolo sceglie per sé, dalla propria pagina impostazioni:

- **il proprio computer**, con
  [`lesta-penna-ai-server`](https://github.com/gabrieleligetta/lesta-penna-ai-server)
  installato sopra — gratis;
- **un modello cloud** sulla propria chiave — circa $0,003 al minuto di audio.

Non c'è un motore dell'istanza, e non c'è ripiego automatico dall'uno all'altro:
passare da un PC spento a un modello a pagamento spenderebbe soldi che nessuno
ha autorizzato.

### Esporre il server di trascrizione

Se lo installi su una macchina tua, leggi prima la sezione sicurezza del
[suo README](https://github.com/gabrieleligetta/lesta-penna-ai-server).

`TRANSCRIBE_AUTH_TOKEN` resta facoltativo, e la ragione è che **la rete è già
un controllo di sicurezza**: su un tailnet WireGuard, con autenticazione per
dispositivo e nessuna porta esposta, la §5(c) dei Developer Terms di Discord
(«administrative, physical, and technical safeguards») è soddisfatta senza un
secondo lucchetto applicativo. Se invece l'host è raggiungibile in qualunque
altro modo, il token diventa necessario: lo stesso valore va messo sul bot come
`remoteWhisper.authToken` (impostazioni AI della gilda, o
`REMOTE_WHISPER_AUTH_TOKEN` in `.env` prima dell'import in cassaforte).
**Tailscale resta più sicuro di una porta aperta sul router.**

Quello che invece *non* era coperto da nessuna rete è che
`logs/transcription-history/` conservava le trascrizioni testuali **per sempre**,
in chiaro su disco: lì chi ha accesso alla macchina legge tutto, senza passare da
un endpoint. Ora scadono (vedi tabella).

Due altre variabili di conservazione, entrambe con default sensati:

| Variabile | Dove | Default | Cosa fa |
|---|---|---|---|
| `TRANSCRIPTION_HISTORY_RETENTION_DAYS` | server Whisper | `7` | Da quanti giorni lo storico di tuning conserva le trascrizioni verbatim su disco. `0` disattiva del tutto la scrittura del testo, tenendo solo le metriche. |
| `RAW_AUDIO_RETENTION_DAYS` | bot | `30` | Dopo quanti giorni l'audio grezzo per-parlante viene cancellato dal bucket, indipendentemente dallo spazio occupato. `0` disattiva il passaggio a tempo e lascia solo quello per pressione di spazio. |

## Memoria della campagna

Gli embedding girano sull'Ollama del tavolo se ne ha uno, altrimenti sulla sua
chiave — sotto il centesimo per una campagna intera. Il modello **si fissa alla
prima indicizzazione** e cambiarlo richiede una reindicizzazione esplicita:
cambiare in silenzio renderebbe invisibile tutto ciò che la campagna ricorda.

Non c'è un nodo Ollama dell'istanza. Gli embedding di tutti sull'hardware
dell'operatore sono la stessa cosa di whisper.cpp sul server, tolto per la stessa
ragione.

## Manutenzione

```bash
docker compose logs -f bot     # log
npm run db:init                # riapplica lo schema, idempotente
```

Il database sta in un volume Docker (`lestapenna_db_data`), non in un bind mount.
Litestream lo replica in continuo se lo configuri: è il modo consigliato di
tenerne una copia, ma ricorda dove **non** va la master key.

I backup del database vogliono `OCI_DB_BACKUP_BUCKET` — lo usano sia la replica
Litestream sia lo snapshot notturno. **Non ha un default**: lasciato vuoto, il
backup viene semplicemente saltato (con una riga di log), perché un nome scritto
nel codice sarebbe il bucket di chi ha scritto il progetto, non il tuo.

## Aggiornare

```bash
git pull
docker compose build && docker compose up -d
```

Lo schema si applica da sé all'avvio. Le migrazioni non esistono: c'è un
baseline unico più `SCHEMA_UPGRADES` idempotenti, quindi un aggiornamento non
può fallire a metà lasciando il database in uno stato intermedio.
