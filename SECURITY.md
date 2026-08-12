# Sicurezza

Le invarianti operative e la checklist usata prima di una release pubblica sono
nel [`Maintainer playbook`](MAINTAINING.md).

## Segnalare una vulnerabilità

Scrivi a **info@lestapenna.quest**, con oggetto che inizi per `[SECURITY]`.
Non aprire una issue pubblica: questo progetto custodisce chiavi API di altre
persone, e una segnalazione pubblica le espone prima che ci sia una correzione.

Includi, se puoi: cosa hai osservato, come riprodurlo, e cosa un attaccante
otterrebbe. Un proof-of-concept aiuta molto.

**Tempi realistici, dichiarati onestamente:** questo è il progetto di una
persona sola, senza un team di sicurezza. Punto a rispondere entro 72 ore e a
correggere le vulnerabilità gravi il prima possibile, ma non posso promettere
uno SLA che non sarei in grado di rispettare. Se non ricevi risposta in una
settimana, insisti.

## Cosa mi interessa di più

Le aree in cui un difetto fa il danno peggiore:

- **Fuga di credenziali di un tavolo.** Le chiavi API vivono cifrate in
  `tenant_secrets`; qualunque percorso che le riporti in chiaro fuori dal layer
  AI è grave. Il plaintext non deve mai lasciare `Secret.reveal()`, e i file
  autorizzati a chiamarla sono verificati da un test.
- **Confusione di scope fra gilde.** Un tavolo che riesce a far pagare le
  proprie chiamate a un altro, o a leggerne i dati.
- **SSRF sulla sonda del PC di trascrizione**, che accetta un URL scelto
  dall'utente per costruzione.
- **Accesso ai dati di campagna** senza appartenere alla gilda proprietaria.

## Cosa non è una vulnerabilità

- Che il server possa decifrare le chiavi dei tavoli: è inevitabile, e
  dichiarato — un worker deve poterle usare ore dopo, in background, senza
  nessuno presente. La cassaforte protegge i backup replicati fuori host, non
  dall'operatore.
- Che l'IA generi contenuti sbagliati. È un modello linguistico, non un oracolo.
- Segnalazioni automatiche di scanner senza un impatto dimostrato.

## Operazioni distruttive

Il bot non espone comandi Discord capaci di svuotare l'intera istanza, il
bucket o le code condivise. La funzione che ricrea il database è riservata ai
test e rifiuta di partire fuori da `NODE_ENV=test`.

Le cancellazioni disponibili in produzione hanno sempre un confine esplicito:

- `$forgetme` cancella soltanto i dati dell'utente che lo invoca nella gilda
  corrente;
- `$deletecampaign` cancella una campagna scelta fra quelle della gilda;
- `$eraseserver` cancella soltanto la gilda corrente e richiede di riscriverne
  il nome;
- reset, reprocessing e riconciliazione accettano soltanto sessioni appartenenti
  alla gilda corrente;
- `$rebuild` richiede una singola campagna della gilda: non esiste un'opzione
  “tutte le campagne”.

La rimozione reale del bot da una gilda avvia inoltre la cancellazione dei dati
di quella gilda. Una semplice indisponibilità temporanea di Discord non la
avvia.

## Se self-hosti

Due cose che valgono più di qualunque patch:

1. **`SECRETS_MASTER_KEY` non va custodita nello stesso bucket della replica
   Litestream né sotto `data/`**: finirebbe nello stesso backup che protegge.
2. **`TRANSCRIBE_AUTH_TOKEN` sul server di trascrizione è obbligatorio** se lo
   esponi oltre la tua rete: quell'endpoint scarica URL arbitrarie.
