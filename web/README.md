# Web app di Lestapenna

La parte autenticata: archivio delle sessioni, mondo di campagna, schede dei
personaggi, chat col Bardo, e le impostazioni IA del tavolo.

Vive su `/app/*` ed è `noindex`. **Il sito pubblico non è questo**: landing e
pagine legali sono HTML statico in `../public/`, servito da NestJS.

## Sviluppo

```bash
npm install
npm run dev     # Vite, con proxy verso l'API su :3000
```

Serve il backend acceso (`cd .. && npm run dev`): la web app non ha dati propri.

## Verificare

```bash
npx tsc --noEmit
npm run lint       # oxlint; gira anche in CI
npm test           # Vitest + Testing Library, con MSW per le risposte API
npm run build
```

## Prima di aggiungere un componente

Quasi tutti i mattoni esistono già in `src/components/` — dialoghi, conferme,
stati vuoti, esiti di form, badge, tabelle — e una pagina **non ne dichiara di
propri**. L'inventario, le regole che il compilatore non può imporre (un solo
`<h1>` per pagina, niente colori grezzi, nessun nome di classe inventato) e le
quattro cose che ogni azione IA a pagamento deve montare stanno nella sezione
**«Frontend: componenti condivisi e azioni a pagamento»** di
[`../CLAUDE.md`](../CLAUDE.md).

## Client tipizzato

`src/api/schema.d.ts` è **generato** dalla spec OpenAPI del backend: non si
modifica a mano.

```bash
cd .. && npm run openapi:generate   # rigenera web/openapi.json dai controller
cd web && npm run api:types         # rigenera schema.d.ts
```

Se cambi una rotta e non rigeneri, il client descrive un'API che non esiste più.
La CI lo verifica con `npm run openapi:check`.

## Come è organizzata

- `src/routes/` — una cartella piatta, una pagina per file.
- `src/api/hooks.ts` — tutte le query e le mutazioni, con TanStack Query.
- `src/api/types.ts` — i tipi che la UI usa davvero, scritti a mano sopra lo
  schema generato.
- `src/i18n/` — sei lingue. `messages.ts` è l'interfaccia sorgente di verità:
  aggiungi lì per primo e TypeScript ti costringerà a completare le altre.
- `src/components/` — quel poco che è condiviso davvero.

Niente libreria di componenti: CSS scritto a mano in `src/App.css`, con i token
in `:root`.

## Una regola che non si viola

**Nessuna chiave API deve raggiungere il browser.** I campi chiave sono
`type="password"`, non vengono mai precompilati, e di una credenziale salvata la
UI mostra solo le ultime quattro cifre. Nessuna rotta dell'API restituisce il
valore di un segreto — la scrittura è solo `PUT`, e le prove di connessione
partono dal server.
