# Istruzioni per agenti e maintainer

Prima di operazioni Git, GitHub, release, sicurezza o infrastruttura, leggere
integralmente [`MAINTAINING.md`](MAINTAINING.md).

- L'identità dei commit/tag del maintainer è
  `gabrieleligetta <58666051+gabrieleligetta@users.noreply.github.com>`; non
  introdurre email personali o di lavoro.
- Il repository GitHub storico contiene ref della PR #1 precedenti alla
  bonifica e deve restare privato. Il pubblico va creato come repository nuovo
  dal solo root commit verificato.
- Tutti i link pubblici al codice, inclusi bot e web app, devono mantenere l'URL
  canonico `https://github.com/gabrieleligetta/lestapenna`; non sostituirlo con
  il nome del repository operativo privato.
- Non reintrodurre wipe globali o primitive che svuotano database, bucket o code
  dal bot. Ogni ID sessione fornito dall'utente va validato nello scope corretto.
- Non rendere pubblico il workflow di deploy o configurazioni operative. La CI
  pubblica deve essere priva di secret e con permessi in sola lettura.
- `lestapenna` e il sibling `lesta-penna-ai-server` sono repository distinti:
  non modificare il sibling salvo richiesta esplicita.
