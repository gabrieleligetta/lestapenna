# Generazione immagini con l'IA

> Stato: implementata; contratto multi-riferimento e multi-tag aggiornato il
> 13-08-2026. Provider supportati: OpenAI e Gemini.

## Obiettivo

I tre flussi devono differire solo per la provenienza delle parole, non per il
modo in cui immagini, controlli di scatto, costi e audit vengono gestiti:

| Modalità | Materiale testuale | Scheda dell'aspetto |
|---|---|---|
| `auto` | campagna | obbligatoria |
| `prompt` | descrizione dell'utente | non letta |
| `mixed` | campagna + descrizione, con la descrizione vincolante | obbligatoria |

`auto` e `mixed` non usano più la vecchia parafrasi di scheda/RAG come ripiego.
Senza una scheda dell'aspetto non esiste un'identità sufficientemente definita:
la richiesta si ferma prima del provider e invita ad analizzare o compilare il
soggetto. `prompt` resta disponibile e usa soltanto le parole della persona.

La scheda viene composta localmente e deterministicamente da `imagePrompt.ts`:
non c'è una chiamata testo da stimare o addebitare tra dossier e modello
immagine.

## Contratto dei riferimenti

Ogni immagine selezionata porta un manifest provider-neutral:

```json
{
  "id": "media:…",
  "roles": ["subject_identity", "face", "clothing"],
  "instruction": "Mantieni il vestito, ma rendilo bianco.",
  "priority": 1
}
```

I tag ammessi sono:

- `whole_image` (esclusivo);
- `subject_identity`, `face`, `body`, `hair`;
- `clothing`, `armor_equipment`;
- `architecture`, `landscape`, `materials`;
- `form`, `ornament`, `wear`;
- `pose_composition`, `background`, `style`, `palette`.

La stessa immagine può avere più tag. `whole_image` non può essere combinato con
gli altri perché autorizza già l'intero contenuto visivo. L'indicazione libera è
facoltativa, lunga al massimo 300 caratteri, e serve anche per trasformazioni
come «usa questo vestiario, ma colorato di bianco».

**I tag offerti dipendono dal tipo di soggetto**, per la stessa ragione per cui
`APPEARANCE_FIELDS` è diviso per tipo: una rovina non ha capelli e una spada non
porta armatura. `REFERENCE_ROLES_BY_KIND` (`bard/imageReferences.ts`, rispecchiato
in `web/src/api/types.ts`) dice cosa proporre a persona, luogo e oggetto —
architettura, paesaggio e materiali per un luogo; forma, decori e usura per un
artefatto. È **un'offerta, non una validazione**: l'API continua ad accettare
qualunque tag noto, perché un'immagine catalogata prima può portarsi dietro un
tag che oggi il suo soggetto non proporrebbe più, e il suo contratto deve
continuare a valere. Un riferimento di campagna o di fazione, che può mostrare
qualsiasi cosa, li vede tutti.

`architecture` e `form` contano come tag d'identità (`IDENTITY_ROLES`): sono la
somiglianza di un edificio e di un oggetto come il volto lo è di una persona,
quindi chiedono la stessa fedeltà in ingresso e un modello che non sa
preservare l'identità li rifiuta prima di spendere.

L'ordine di risoluzione dei conflitti è fissato nel prompt inviato a entrambi i
provider:

1. indicazione specifica della singola immagine;
2. descrizione dell'utente e controlli di scatto;
3. scheda dell'aspetto;
4. comportamento predefinito del tag.

Tra due riferimenti che pretendono lo stesso ruolo vince quello con priorità più
alta (numero più basso), se le istruzioni non risolvono già il conflitto. Il
modello riceve anche il divieto esplicito di copiare proprietà non nominate dai
tag di quella foto.

## Default e override per generazione

I metadati sono catalogabili sia sulle immagini di riferimento permanenti sia
sulle immagini della galleria:

- campagna: default `style`;
- fazione: default `clothing` + `armor_equipment`;
- immagine dell'entità: default `subject_identity`;
- riferimento temporaneo: default `subject_identity`.

Ogni record conserva tag, indicazione libera e `auto_select`. Nel generatore i
riferimenti pertinenti vengono preselezionati, ma sono sempre visibili e
deselezionabili prima della conferma del costo. Tag, istruzione e priorità si
possono sovrascrivere per il singolo job senza cambiare i default catalogati.

Il limite di prodotto è sei immagini. Nessun adapter tronca la lista: un limite
incompatibile produce un errore prima della chiamata a pagamento.

## Compatibilità dei provider

La matrice vive in un solo punto, `src/bard/imageReferences.ts`, ed è usata da
stima, enqueue, runner e adapter.

| Provider/modello | Riferimenti | Vincoli applicativi |
|---|---:|---|
| OpenAI `gpt-image-2` | sì | fino a 6; fedeltà input alta automatica, quindi `input_fidelity` viene omesso |
| OpenAI `gpt-image-1`, `gpt-image-1.5` | sì | fino a 6; `input_fidelity: high` quando è richiesto volto/identità |
| OpenAI `gpt-image-1-mini` | sì | fino a 6; niente parametro di fedeltà |
| Gemini 3 Pro Image | sì | fino a 6 nell'app; massimo 5 riferimenti d'identità e 3 di stile |
| Gemini 3.1 Flash Image | sì | fino a 6; massimo 4 riferimenti d'identità |
| Gemini 2.5 Flash Image | sì | massimo 3 |
| Gemini 3.1 Flash Lite Image | parziale | niente conservazione dell'identità |
| Imagen e modelli sconosciuti | no | la richiesta con riferimenti viene rifiutata |

OpenAI riceve le immagini tramite `images.edit`; senza riferimenti resta su
`images.generate`. Gemini riceve coppie testo + `inlineData`, una per immagine,
seguite dal prompt completo. Vedi la documentazione ufficiale:
[OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)
e [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation).

La matrice è volutamente conservativa per i modelli sconosciuti: una richiesta
pagata non deve essere l'esperimento che scopre che un riferimento è stato
ignorato.

## Persistenza, privacy e audit

Il job congela il manifest completo (`id`, scope, etichetta, tag, istruzione,
priorità), non soltanto gli id. La galleria conserva anche l'intera richiesta in
`entity_media.generation_request_json`: modalità, parole dell'utente, scatto e
manifest. Riaprendo un'immagine generata, la UI ripristina questa richiesta; i
riferimenti temporanei scaduti non vengono riutilizzati.

Le immagini «solo per questa generazione» non vivono più in una `Map` di
processo. Vengono trasformate, salvate nel media storage e registrate in
`image_reference_scratch`, quindi associate una sola volta al job. Il worker le
cancella appena il provider ha finito; il janitor rimuove gli upload abbandonati
o lasciati da un processo interrotto. Se l'object store non risponde, la riga
rimane come puntatore per il tentativo successivo. Le procedure di cancellazione
utente/campagna/guild includono anche questi oggetti.

Un riferimento selezionato che manca, è scaduto o non è leggibile produce
`error_kind = reference` prima del provider. Non viene mai saltato in silenzio e
non viene addebitata un'immagine diversa da quella confermata.

## Stima e costo effettivo

La SPA usa `POST …/image/generate/estimate` con la bozza completa. In questo
modo la conferma include numero e costo stimato dei riferimenti e intercetta i
limiti del modello configurato. Il vecchio `GET ?mode=` resta come stima grezza
compatibile durante il rollout; `reference_ids` resta leggibile, ma il nuovo
campo `references` ha precedenza.

Il costo effettivo somma il prezzo dell'immagine e gli eventuali token input
riportati dal provider. Una tariffa sconosciuta resta `null`, mai zero.

## Dove vive

| Pezzo | File |
|---|---|
| Tag, normalizzazione, precedenza e capability matrix | `src/bard/imageReferences.ts` |
| Adapter OpenAI/Gemini | `src/bard/llm/image.ts` |
| Tre modalità e dossier obbligatorio | `src/bard/imagePrompt.ts` |
| Snapshot, caricamento e scratch lifecycle | `src/api/campaigns/referenceImages.service.ts` |
| Stima, job, manifest e commit | `src/api/campaigns/imageGeneration.service.ts` |
| Tabelle e migrazioni additive | `src/db/schema.ts` |
| Picker e audit del manifest | `web/src/components/EntityImageGenerator.tsx` |
| Default catalogati | `ReferenceImagesPanel.tsx`, `EntityMediaManager.tsx` |

## Verifiche essenziali

```bash
npm run build
npx jest tests/unit/bard/imageGeneration.test.ts \
  tests/unit/bard/imageReferences.test.ts \
  tests/unit/bard/imagePrompt.test.ts \
  tests/unit/saas/imageGeneration.test.ts --runInBand
npm run openapi:generate
cd web
npm run api:types
npm run build
npm test -- --run src/components/EntityImageGenerator.test.tsx
```

I test dedicati coprono multi-tag, esclusività di `whole_image`, priorità,
limiti per modello, contratto inviato a Gemini, `images.edit` e fedeltà OpenAI,
dossier obbligatorio, persistenza della richiesta e picker preselezionato.
