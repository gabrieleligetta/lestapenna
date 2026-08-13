# Maintainer playbook

Questa pagina conserva le decisioni operative che non si possono ricostruire
guardando soltanto il codice. Va letta prima di una release, di un force-push o
di un cambio di visibilità GitHub.

## Identità Git del progetto

I commit e i tag del maintainer devono usare esclusivamente l'identità pubblica
GitHub:

```text
gabrieleligetta <58666051+gabrieleligetta@users.noreply.github.com>
```

Non usare email personali o di lavoro. Prima di un push controllare entrambi i
campi, perché autore e committer possono essere diversi:

```bash
git show -s --format='author=%an <%ae>%ncommitter=%cn <%ce>' HEAD
git for-each-ref refs/tags --format='%(refname:short) %(taggername) %(taggeremail)'
```

Per un commit del maintainer, senza cambiare la configurazione Git globale:

```bash
git -c user.name=gabrieleligetta \
    -c user.email=58666051+gabrieleligetta@users.noreply.github.com \
    commit
```

Per un tag annotato, `user.*` non basta in tutti i contesti; impostare anche
`GIT_COMMITTER_NAME` e `GIT_COMMITTER_EMAIL`:

```bash
GIT_COMMITTER_NAME=gabrieleligetta \
GIT_COMMITTER_EMAIL=58666051+gabrieleligetta@users.noreply.github.com \
git tag -a 1.0.0 -m 'Release 1.0.0'
```

Non riscrivere invece l'autore di un contributo esterno: la regola riguarda i
commit creati dal maintainer.

## Stato della pubblicazione 1.0.0

Il 12 agosto 2026 la history di `main` è stata riscritta come un singolo root
commit `Release 1.0.0`, e il tag annotato `1.0.0` è stato riallineato allo stesso
snapshot. Il repository era ed è rimasto privato durante tutta la bonifica.

Il force-push non ha cancellato i riferimenti della vecchia pull request #1:
GitHub conserva ancora dieci commit precedenti, e nei loro metadati compare una
vecchia email di lavoro. **Quel repository GitHub non deve quindi essere reso
pubblico.** La separazione è stata completata così:

1. il repository storico è stato rinominato
   `gabrieleligetta/lestapenna-private` ed è rimasto privato;
2. è stato creato da zero il nuovo `gabrieleligetta/lestapenna` pubblico;
3. vi sono stati pubblicati soltanto il root commit verificato e il tag
   `1.0.0`, senza pull request, ref nascoste, reflog, bundle o vecchi oggetti;
4. workflow di deploy, secret, vecchie Actions e PR sono rimasti nel repository
   privato. Nel pubblico è presente soltanto `.github/workflows/ci.yml`.

I due tag `1.0.0` sono intenzionalmente snapshot diversi: quello privato punta
al commit `ac33e72294839e9b543ca3697a59262475ceeb40` e include `deploy.yml`;
quello pubblico punta al commit `8c0d802db5a803772bae8c4a23cb1918ac45cf26`
e lo esclude. Il codice distribuito è altrimenti lo stesso.

Il checkout operativo `lestapenna/` usa come `origin` il repository privato.
Controllare sempre `git remote -v` prima di un push e non inviare mai il suo
`HEAD` direttamente al pubblico: contiene il workflow di deploy. Gli
aggiornamenti pubblici vanno preparati in un checkout separato o come export
sanitizzato, verificando ancora l'assenza di `deploy.yml` prima del push.

Non affidarsi a `git log main`: dopo un rewrite bisogna controllare anche pull
request, release, tag, ref remote e qualunque archivio collegato su GitHub.

### URL pubblico e link mostrati dal prodotto

L'URL canonico del codice è e deve restare:

```text
https://github.com/gabrieleligetta/lestapenna
```

È il nome che verrà liberato rinominando il repository storico e poi assegnato
al repository pubblico nuovo. Per questo README, self-hosting, pagine statiche,
pagina della licenza e metadati npm puntano già a quell'URL: non devono essere
aggiornati al nome dell'archivio privato.

Nel bot, `$dona` mostra collegamenti distinti: `DONATION_URL` conduce al canale
di donazione, mentre `REPO_URL` conduce al codice sorgente. Il default di
`REPO_URL`, esposto anche dalla API `app-info` e usato dalla barra della web app,
è l'URL pubblico canonico. In produzione lasciare il default oppure impostare
esplicitamente lo stesso URL; non usare mai il repository operativo privato.

La variabile shell chiamata `REPO_URL` dentro `deploy.yml` ha invece vita solo
nello step SSH: serve al server per clonare il repository privato da cui è
partito il deploy e usa `${{ github.repository }}`. Non è la configurazione
mostrata dal bot. Il repository privato può quindi essere rinominato senza
diventare una destinazione pubblica del prodotto.

Prima di ogni release cercare tutti gli URL GitHub: i link a Lestapenna devono
usare il canonico pubblico; sono ammessi separatamente il profilo GitHub
Sponsors e il repository pubblico di `lesta-penna-ai-server`.

## Checklist prima di rendere pubblico uno snapshot

1. Il working tree deve essere pulito e la release deve compilare.
2. Eseguire backend TypeScript, Jest, build, controlli OpenAPI e tutta la suite
   web (typecheck, lint, test, build).
3. Eseguire `npm audit` sia nella root sia in `web/`, includendo le dipendenze di
   sviluppo. Una scansione passata non vale per la release successiva.
4. Scansionare **l'albero Git esatto**, non la directory di lavoro con
   `node_modules`, `.git` e vecchi reflog. Un metodo riproducibile è creare un
   archivio dal risultato di `git write-tree` e lanciare Gitleaks sulla directory
   temporanea estratta.
5. Cercare inoltre email, path assoluti, nomi utente, OCID, URL di produzione e
   IPv4 hardcoded. Gli indirizzi RFC riservati negli esempi e nei test sono
   ammessi; host reali e identificativi di tenancy no.
6. Verificare autore e committer del commit, tagger del tag, numero di root
   commit e ref remote.
7. Eseguire la CI GitHub sul commit finale. Non spostare il tag dopo una CI
   eseguita su uno snapshot diverso senza rieseguirla.

Alla bonifica 1.0.0 lo snapshot finale risultava senza finding Gitleaks e senza
vulnerabilità npm note. I log dei run Actions esistenti sono stati scansionati e
non contenevano dati sensibili; possono quindi essere pubblici. Questa è una
fotografia, non un'esenzione dai controlli futuri.

## Confini delle operazioni distruttive

Il bot non deve offrire un comando Discord capace di cancellare l'intera
istanza, il bucket o le code condivise. Per questo sono stati rimossi
`$wipe`/`$softwipe` e anche i primitive di produzione `wipeBucket`,
`wipeLocalFiles` e `clearQueue`.

`wipeDatabase` esiste soltanto per i test, non è riesportato dal modulo DB e
rifiuta l'esecuzione fuori da `NODE_ENV=test`. Non aggirare quel controllo per
comodità amministrativa: una manutenzione globale deve avvenire fuori dal bot,
con backup e accesso host esplicito.

Ogni operazione rimanente deve rispettare il confine più stretto possibile:

- utente per `$forgetme`;
- campagna per cancellazione e rebuild;
- gilda per `$eraseserver` e manutenzione di sessioni da parte di operatori;
- campagna attiva per letture e rigenerazioni avviate dai giocatori.

Un `operatorOnly` controlla **chi** chiama, non **cosa** può indicare. Qualunque
comando che accetta un session ID fornito dall'utente deve usare
`assertSessionInGuild` o `assertSessionInActiveCampaign` prima di leggere,
cancellare, accodare file o costruire chiavi object-storage. Il test
`tests/unit/commands/destructiveSafety.test.ts` difende queste invarianti.

Le cancellazioni privacy legittime restano disponibili e confermate:
`$forgetme`, `$deletecampaign`, `$eraseserver` e la cancellazione automatica
della sola gilda quando il bot viene realmente rimosso. Un evento Discord di
semplice indisponibilità non deve mai essere trattato come una rimozione.

## Infrastruttura e workflow

La decisione operativa corrente è **una sola VM, due processi applicativi**:
gateway Discord/API e worker di processing hanno immagini uguali ma ruoli
separati. La coda Redis è il confine durevole; il gateway non deve fare mix,
trascrizioni o attese lunghe. Il worker ammette due trascrizioni in parallelo ma
una sola per sessione, così gilde diverse avanzano senza sovraccaricare il PC
remoto di un singolo tavolo. Il limite pubblico iniziale è due gilde in
registrazione e due sessioni pendenti per gilda. Aumentarlo richiede prima una
prova di carico sulla shape reale e il controllo di `/health`.

La spesa infrastrutturale desiderata resta `0` finché la VM gratuita regge. Non
aggiungere Lambda/Functions, un database gestito o autoscaling come reazione a
una coda lunga: il processing è differibile, mentre un servizio serverless ha
limiti di durata, trasferimenti e costi variabili. Le donazioni possono finanziare
capacità cloud condivisa, ma non danno priorità e non vanno promesse come entrata.

SQLite in WAL è intenzionalmente mantenuto finché entrambi i processi restano
sullo stesso host. Ha `busy_timeout=10s`, backup Litestream e un probe ripetibile
con `npm run infra:probe-sqlite`. Pianificare PostgreSQL soltanto se almeno una
di queste condizioni è vera:

- gateway e worker devono essere distribuiti su host distinti;
- serve alta disponibilità o più di un gateway;
- sotto il carico target compaiono errori `SQLITE_BUSY` non recuperati;
- il probe fallisce ripetutamente sulla stessa classe di hardware;
- tempi di scrittura/backup incidono sulla registrazione nonostante il worker
  isolato e i limiti di ammissione.

La motivazione estesa e la procedura di scaling sono in
[`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md). Questa sezione è la memoria
vincolante: non migrare il database solo per prepararsi a un traffico ipotetico.

La baseline del 13 agosto 2026 (report + backup DB + OCI a 1 minuto) misura
2,86–4,60% CPU media VM durante registrazioni reali da 4–5 parlanti, p95 massimo
5,69% e nessuna concorrenza tra gilde. La lunga saturazione del 21–22 luglio era
Whisper locale e non va usata per stimare l'acquisizione attuale. Tenere il
limite a 2 finché due prove concorrenti da almeno 30 minuti non soddisfano il
protocollo in `docs/INFRASTRUCTURE.md`. L'ammissione è per gilda: non troncare o
limitare i partecipanti di una sessione già accettata.

- SSH in Terraform usa `ssh_allowed_cidr`, senza default permissivo, e vieta
  `0.0.0.0/0`. Usare normalmente l'IP amministrativo con `/32`.
- Il cloud-init non deve svuotare `iptables`.
- `terraform.tfvars`, state, OCID reali, chiavi e file di import restano fuori
  Git.
- I workflow usano `permissions: contents: read`; aggiungere permessi solo al
  job che ne ha realmente bisogno.
- I secret non vanno interpolati direttamente in script shell. Passarli come
  ambiente o canale dati, e non stamparli. Le maschere GitHub sono una seconda
  difesa, non il controllo principale.
- La CI pubblica non deve avere secret di produzione. Il deploy resta nel
  repository operativo privato.

## Protezioni GitHub dopo la creazione del repository pubblico

Con `gh`, verificare e attivare almeno secret scanning, push protection,
Dependabot alerts e gli aggiornamenti di sicurezza disponibili per repository
pubblici. Impostare `GITHUB_TOKEN` in sola lettura come default e proteggere
`main` dopo il primo push. Infine controllare da una sessione non autenticata
che branch, tag, release, PR e Actions mostrino soltanto ciò che si è deciso di
pubblicare.
