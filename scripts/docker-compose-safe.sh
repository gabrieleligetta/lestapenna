#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-up}"
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-lestapenna}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
COMPOSE_CMD=("${DOCKER_BIN}" "compose" "-f" "${PROJECT_DIR}/docker-compose.yml" "-p" "${PROJECT_NAME}")

die() {
    echo "[docker-compose-safe] $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Comando richiesto non trovato: $1"
}

ensure_docker_ready() {
    require_command "${DOCKER_BIN}"
    "${DOCKER_BIN}" info >/dev/null 2>&1 || die "Docker daemon non raggiungibile. Avvia Docker Desktop e riprova."
}

ensure_project_dirs() {
    mkdir -p "${PROJECT_DIR}/src" "${PROJECT_DIR}/scripts"

    if [ ! -f "${PROJECT_DIR}/ai.config.local.json" ]; then
        if [ -f "${PROJECT_DIR}/ai.config.local.example.json" ]; then
            cp "${PROJECT_DIR}/ai.config.local.example.json" "${PROJECT_DIR}/ai.config.local.json"
        else
            printf '{}\n' > "${PROJECT_DIR}/ai.config.local.json"
        fi
    fi

    [ -f "${PROJECT_DIR}/.env" ] || die "File .env mancante in ${PROJECT_DIR}"
}

run_compose() {
    local output
    if output="$("${COMPOSE_CMD[@]}" "$@" 2>&1)"; then
        [ -n "${output}" ] && printf '%s\n' "${output}"
        return 0
    fi

    printf '%s\n' "${output}" >&2
    if grep -Eq 'creating mount source path|docker-desktop-bind-mounts|file exists' <<<"${output}"; then
        cat >&2 <<'EOF'
[docker-compose-safe] Docker Desktop/WSL ha lasciato uno stato corrotto dei bind mount.
[docker-compose-safe] Ho gia' ridotto i mount al minimo, ma per sbloccare questo caso serve il reset del runtime:
  1. Chiudi Docker Desktop
  2. Da PowerShell esegui: wsl --shutdown
  3. Riapri Docker Desktop
  4. Rilancia questo stesso comando
EOF
    fi
    return 1
}

cmd_up() {
    ensure_docker_ready
    ensure_project_dirs
    if run_compose up -d --build --remove-orphans "$@"; then
        return 0
    fi

    echo "[docker-compose-safe] Primo avvio fallito. Eseguo cleanup leggero e ritento..."
    "${COMPOSE_CMD[@]}" down --remove-orphans --timeout 30 >/dev/null 2>&1 || true
    run_compose up -d --build --remove-orphans "$@"
}

cmd_down() {
    ensure_docker_ready
    run_compose down --remove-orphans --timeout 30 "$@"
}

cmd_restart() {
    cmd_down
    cmd_up "$@"
}

cmd_logs() {
    ensure_docker_ready
    "${COMPOSE_CMD[@]}" logs -f --tail "${DOCKER_TAIL_LINES:-200}" "$@"
}

case "${ACTION}" in
    up)
        cmd_up "$@"
        ;;
    down)
        cmd_down "$@"
        ;;
    restart)
        cmd_restart "$@"
        ;;
    logs)
        cmd_logs "$@"
        ;;
    *)
        die "Azione non supportata: ${ACTION}. Usa: up | down | restart | logs"
        ;;
esac
