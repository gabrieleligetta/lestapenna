# Infrastruttura della community

Questa è la decisione operativa per mantenere stabile il bot pubblico spendendo
il meno possibile. Non è una promessa di capacità illimitata: l'istanza condivisa
usa oggi una VM gratuita e protegge le sessioni già in corso rifiutando nuovo
carico quando non può sostenerlo in sicurezza. Il limite pubblico corrente è di
**due registrazioni contemporanee in due gilde Discord**, una per gilda.

## Architettura corrente

Il deploy di produzione usa la stessa immagine in due processi sulla stessa VM:

```text
Discord ──▶ gateway/API ──▶ Redis/BullMQ ──▶ worker di processing
                │                    │
                └─ acquisizione audio   └─ mix, upload, trascrizione, IA
                         │
                    SQLite in WAL
                    (volume locale condiviso)
```

Il gateway ha priorità CPU e non aspetta il completamento del processing. La
fine registrazione mette una sessione in una coda durevole; il worker la miscela
una alla volta, limita gli upload e completa i job audio. La finalizzazione torna
al gateway, l'unico processo che invia messaggi Discord. Dopo un riavvio, le
sessioni incomplete vengono riaccodate in base alla fase salvata nel database.

I default conservativi sono:

| Controllo | Default | Motivo |
|---|---:|---|
| gilde in registrazione | 2 | profilo misurato di 4–5 parlanti per tavolo |
| sessioni pendenti per gilda | 2 | una gilda non può saturare tutta la coda |
| mix contemporanei | 1 | è il picco CPU/I/O più prevedibile |
| upload contemporanei | 2 | evita memoria e banda senza limite |
| trascrizioni contemporanee | 2 | una per sessione, due gilde possono avanzare insieme |
| orchestrazioni di sessione | 10 | attendono soprattutto job esterni; il mix resta seriale |
| attesa lock SQLite | 10 s | assorbe brevi contese tra gateway e worker |

`/health` espone code, sessioni attive, ritardo dell'event loop, memoria, disco e
stato del database. Gli allarmi operativi notificano cambiamenti critici senza
inviare lo stesso messaggio ogni minuto.

Il limite è per gilda, non per persona. Dopo l'ammissione il bot continua a
registrare anche se entrano altri partecipanti: non tronca la sessione e non
esclude nuove voci. Il numero reale di encoder FFmpeg resta nelle metriche e
serve a tarare il limite di gilde sulle abitudini effettive della community.

Il report tecnico di fine sessione viene caricato nel bucket recordings come
`logs/report-<session-id>.json` e allegato alla mail operativa. Oltre ai dati
storici, registra separatamente gateway e worker, durata della sola registrazione,
partecipanti iniziali, picco di encoder FFmpeg, gilde concorrenti e peggior
ritardo dell'event loop. I report di capacità non salvano ID degli utenti. I
rebuild amministrativi non sono prove di capacità e non vanno
mescolati alle sessioni reali nell'analisi.

Ogni campione viene prima aggiunto anche a un checkpoint JSONL in
`data/capacity-metrics/`, sul volume persistente. Un crash può perdere al massimo
il campione ancora in scrittura, non l'intera sessione: al recovery i checkpoint
di gateway e worker vengono riuniti. Vengono cancellati soltanto dopo che il JSON
completo è stato caricato nel bucket.

## Perché non Lambda/Functions adesso

Spostare il processing in una funzione non elimina il lavoro: aggiunge packaging
FFmpeg, storage intermedio, trasferimenti, cold start, limiti di durata e una
fattura proporzionale a memoria e tempo. Le sessioni possono durare ore e il
pipeline contiene attese e chiamate esterne; è un job durevole, non una funzione
breve. Sulla VM già disponibile, un worker isolato ottiene il vantaggio più
importante — non bloccare Discord — senza un nuovo costo fisso.

La funzione serverless potrà avere senso per singoli passi brevi e idempotenti,
misurati prima in produzione. Non deve orchestrare un'intera sessione e non deve
essere introdotta finché il worker gratuito ha coda accettabile.

## Strategia di scaling a costo minimo

### Baseline misurata

Il 13 agosto 2026 sono stati incrociati i report tecnici con OCI Monitoring a
risoluzione di un minuto e con il database di backup. Le tre registrazioni
reali disponibili avevano il profilo indicato dall'operatore, 4–5 parlanti:

| Registrazione | Parlanti | CPU VM media | CPU p95 | CPU max durante acquisizione |
|---|---:|---:|---:|---:|
| 17 giugno | 4 | 2,86% | 4,11% | 5,14% |
| 7 luglio | 5 | 3,08% | 4,34% | 5,21% |
| 21 luglio | 5 | 4,60% | 5,69% | 6,96% |

La sessione del 21 luglio ha poi eseguito Whisper locale per oltre dieci ore:
in quella fase OCI misurava 65,74% CPU media e 75,22% p95. Non rappresenta il
percorso attuale con trascrizione remota, ma dimostra perché il processing deve
restare isolato. Il valore CPU nelle vecchie mail (0,76% in quel caso) misurava
solo Node e non i processi figli; per il consumo host la fonte corretta è OCI o
il nuovo campo `systemCpuPercent`.

Questi dati dicono che due gilde sono un default prudenziale, non che il massimo
sia già noto. Non esistono ancora registrazioni concorrenti nel campione. Per il
dimensionamento assumiamo il profilo normale indicato dall'operatore, 4–5
parlanti; eventuali tavoli più grandi vengono osservati, non interrotti.

1. Mantenere i limiti iniziali e osservare `/health`, tempi di coda e rifiuti.
2. Provare tre gilde contemporanee sulla VM reale. Alzare il limite solo se non
   ci sono buchi audio, event-loop lag sostenuto, pressione disco o errori DB.
3. Se cresce soltanto la coda, lasciarla drenare: il processing non deve sottrarre
   risorse alla registrazione.
4. Se le donazioni coprono un costo ricorrente, spostare prima il worker su una
   piccola VM dedicata. Questo passaggio richiede anche PostgreSQL e storage
   condiviso; non basta cambiare `PROCESS_ROLE`.
5. Aggiungere repliche/autoscaling solo dopo metriche che dimostrino quale fase
   satura. Il numero di worker deve restare esplicito e limitato, perché le API
   BYOK e gli upload hanno comunque quote.

La capacità non viene venduta: self-hosting e donazioni sono due modi distinti
di risolvere il limite. Il primo dà risorse dedicate sotto il controllo del
tavolo; le seconde aumentano, quando bastano, l'infrastruttura condivisa senza
corsie preferenziali.

### Protocollo per alzare il limite

Il default `2` è un limite prudenziale, non un benchmark certificato. Dopo il
deploy della diagnostica, eseguire sessioni controllate di almeno 30 minuti con
un numero realistico di parlanti: prima una gilda, poi due. Provare tre solo se
il gradino precedente soddisfa tutti questi criteri:

- nessun parlante atteso senza audio e nessun segmento FFmpeg troncato;
- nessun errore di upload, trascrizione o `SQLITE_BUSY`;
- ritardo event-loop del gateway sotto 500 ms e senza crescita progressiva;
- load medio sotto il numero di OCPU, almeno 2 GB di RAM e 5 GB di disco liberi;
- la coda drena dopo la registrazione senza peggiorare l'acquisizione.

Confrontare i JSON nel bucket con le metriche OCI nello stesso intervallo. Una
sola sessione breve o un picco OCI senza il relativo report non permette di
estrapolare il massimo. Se tre gilde passano due prove consecutive sulla shape
reale, portare `MAX_CONCURRENT_RECORDING_GUILDS` a `3`; in caso contrario resta
a `2` e il bot spiega il limite agli utenti.

## SQLite o PostgreSQL

Per una sola VM, **SQLite resta la scelta giusta**. Il carico applicativo è
piccolo, le transazioni sono brevi, WAL consente lettori durante una scrittura,
`busy_timeout` gestisce i due processi e Litestream copre la copia fuori host.
PostgreSQL oggi aggiungerebbe memoria, manutenzione e costo senza risolvere il
collo di bottiglia principale, che è audio/FFmpeg.

Eseguire periodicamente:

```bash
npm run infra:probe-sqlite
```

Il probe usa un database temporaneo, avvia più writer concorrenti e fallisce se
un lock supera il timeout o produce `SQLITE_BUSY`. Non sostituisce una prova end
to end sulla shape di produzione, ma rende visibile una regressione del profilo
di contesa senza toccare dati reali.

Migrare a PostgreSQL quando serve almeno una di queste proprietà:

- gateway e worker su host distinti;
- più gateway o alta disponibilità;
- errori `SQLITE_BUSY` persistenti sotto il carico ammesso;
- probe ripetutamente fallito sulla macchina target;
- backup o scritture SQLite che interferiscono con l'acquisizione audio.

La migrazione non è un cambio di URL: il codice usa `better-sqlite3` e SQL
SQLite in molti repository. Va trattata come progetto esplicito con adapter DB,
migrazione dati provata su una copia, doppia verifica dei conteggi e piano di
rollback. Fin quando i trigger sopra non scattano, rimandarla riduce sia rischio
sia costo.
