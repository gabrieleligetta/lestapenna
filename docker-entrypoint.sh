#!/bin/bash
set -e

# La trascrizione non gira più su questo container: avviene sul PC remoto del
# tavolo (lesta-penna-ai-server) oppure su un provider cloud con la chiave
# dell'utente. Non c'è quindi alcun binario o modello Whisper da preparare qui.

exec "$@"
