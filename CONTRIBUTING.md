# Contribuire a Lestapenna

Grazie per l'interesse. Questo è il progetto di una persona sola, quindi la cosa
più utile che puoi fare è **aprire una issue prima di scrivere codice**: mi
capita di avere già in mano un pezzo di quel lavoro, o di aver scartato
quell'approccio per un motivo che vale la pena raccontarti prima che tu ci
spenda una serata.

Chi prepara una release o modifica GitHub/infrastruttura deve leggere anche il
[`Maintainer playbook`](MAINTAINING.md): contiene identità Git, scansioni e
vincoli che non sono normali istruzioni per una pull request.

## Partire

```bash
cd lestapenna
cp .env.example .env      # servono almeno DISCORD_BOT_TOKEN e SECRETS_MASTER_KEY
npm install
npm run secrets:generate-key   # genera SECRETS_MASTER_KEY
npm run db:init
npm run dev               # richiede un Redis locale
```

Le chiavi AI **non vanno in `.env`**: si configurano per tavolo dalla web app,
oppure da riga di comando con `npm run secrets:set`. È il cuore del modello BYOK
e non è un dettaglio di configurazione.

## Verificare

```bash
npx tsc --noEmit        # deve essere pulito
npx jest --silent       # backend
cd web && npm test      # frontend
npm run build           # in entrambi
```

Una pull request che lascia rossa la suite non viene guardata finché non è
verde: non per severità, ma perché non saprei distinguere il tuo rosso dal mio.

## Cosa cerco in una modifica

**Codice che si spiega da solo su ciò che è, e commentato su ciò che non è
ovvio.** I commenti di questo progetto raccontano *perché* una cosa è fatta così
— quale alternativa è stata scartata, quale difetto reale è stato incontrato.
Un commento che ripete il nome della funzione non serve a nessuno; uno che dice
«questa scorciatoia farebbe pagare a un tavolo le chiamate di un altro» salva
qualcuno fra sei mesi.

**Test che difendono un comportamento, non che coprono una riga.** Guarda quelli
esistenti: quasi tutti hanno accanto la ragione per cui esistono, cioè il modo
concreto in cui quella cosa si romperebbe.

**Attenzione ai soldi degli altri.** Questa è la regola che governa tutto il
resto. Ogni chiamata AI appartiene a una gilda e viene pagata dalle sue chiavi;
qualunque percorso che risolva lo scope sbagliato, o che faccia ricadere una
spesa su chi non l'ha autorizzata, è un difetto grave anche se i test passano.

## Aggiungere un metodo di accensione remota

È il punto di estensione pensato apposta. Ogni casa accende un computer a modo
suo — un magic packet, l'API del proprio router, Home Assistant, una presa
smart. Scrivi un file in `src/services/wake/`, dichiara i campi che ti servono,
registralo in `index.ts`: la pagina impostazioni disegna il form da sola, e non
devi toccare né il frontend né le sei traduzioni.

## Traduzioni

Sei lingue: en, it, es, fr, de, pt-BR. `src/i18n/locales/en.ts` (bot) e
`web/src/i18n/messages.ts` (web app) sono le sorgenti di verità — aggiungi lì
per primo e TypeScript ti costringerà a completare le altre.

Alcune stringhe recenti sono **in inglese anche nelle altre lingue**: una
traduzione fatta a caso è peggio di un inglese corretto, soprattutto dove si
parla di soldi e di licenze. Se una di quelle è la tua lingua, è un contributo
prezioso e piccolo.

## Licenza

Contribuendo accetti che il tuo lavoro sia rilasciato sotto **AGPL-3.0**, come
il resto del progetto.
