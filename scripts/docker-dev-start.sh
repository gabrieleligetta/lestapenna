#!/usr/bin/env bash
set -euo pipefail

cd /app

mkdir -p recordings batch_processing data mixed_sessions

if [ ! -x /app/node_modules/.bin/nodemon ]; then
    echo "[docker-dev-start] node_modules volume vuoto. Installo dipendenze..."
    yarn install --frozen-lockfile
fi

exec yarn dev
