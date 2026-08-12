#!/bin/bash
# ============================================================================
# Lestapenna DB Restore Script
# ============================================================================
# Two restore strategies:
#   1. Snapshot restore: latest atomic backup from OCI (daily snapshots)
#   2. Litestream restore: point-in-time recovery from WAL stream
#
# Usage:
#   ./scripts/restore-db.sh snapshot    # Restore latest daily snapshot
#   ./scripts/restore-db.sh litestream  # Point-in-time WAL recovery
#
# Auto-detects target:
#   - Named volume lestapenna_db_data (production, since 2026-07-19): restores
#     directly into it via throwaway containers, so neither `aws` nor
#     `litestream` need to be installed on the host — only Docker. Requires
#     the container using the volume ($CONTAINER_NAME) to be STOPPED first:
#     overwriting a SQLite file that a live process holds open (WAL) while
#     Litestream streams from it is unsafe. Set FORCE=yes to skip the
#     interactive confirmation (e.g. in scripted use).
#   - Otherwise: legacy ./data bind mount, for local/dev use — requires
#     `aws`/`litestream` installed locally (original behavior, unchanged).
# ============================================================================

set -euo pipefail

PROD_DB_VOLUME="${PROD_DB_VOLUME:-lestapenna_db_data}"
CONTAINER_NAME="${CONTAINER_NAME:-dnd-bot-prod}"
# No default: a name written here is the maintainer's bucket, and this script
# restores a database over the existing one. Better to stop immediately than to
# read somebody else's backups by mistake.
BACKUP_BUCKET="${OCI_DB_BACKUP_BUCKET:-}"
DB_FILENAME="dnd_bot.db"
LEGACY_DIR="./data"
UTIL_IMAGE="alpine:3.20"
AWS_CLI_IMAGE="amazon/aws-cli:2.17.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[Restore]${NC} $1"; }
warn() { echo -e "${YELLOW}[Restore]${NC} $1"; }
err() { echo -e "${RED}[Restore]${NC} $1" >&2; }

has_prod_volume() {
    command -v docker &> /dev/null && docker volume inspect "$PROD_DB_VOLUME" &> /dev/null
}

# Check required env vars for OCI
check_oci_env() {
    local missing=0
    for var in OCI_ENDPOINT OCI_REGION OCI_ACCESS_KEY_ID OCI_SECRET_ACCESS_KEY OCI_NAMESPACE OCI_DB_BACKUP_BUCKET; do
        if [ -z "${!var:-}" ]; then
            err "Missing environment variable: $var"
            missing=1
        fi
    done
    if [ $missing -eq 1 ]; then
        err "Set OCI env vars or source .env first: export \$(grep -v '^#' .env | xargs)"
        exit 1
    fi
}

# The container must be stopped before writing into a live named volume — the
# running process holds the DB open (WAL) and Litestream streams from it;
# overwriting the file underneath is unsafe.
ensure_container_stopped() {
    if docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
        err "$CONTAINER_NAME is running — stop it first:"
        err "  docker compose -f docker-compose.prod.yml stop dnd-bot"
        exit 1
    fi
}

confirm_or_abort() {
    if [[ "${FORCE:-}" == "yes" ]]; then return 0; fi
    warn "This will OVERWRITE the database in volume $PROD_DB_VOLUME."
    read -r -p "Type 'yes' to continue: " reply
    [[ "$reply" == "yes" ]] || { err "Aborted."; exit 1; }
}

# Safety backup + stale WAL/SHM/Litestream-metadata cleanup, inside the volume,
# via a throwaway container (no host-level tooling required). Litestream's
# local generation metadata must be cleared on manual restore or it will try
# to resume an inconsistent WAL stream against the new file.
backup_and_clean_volume() {
    docker run --rm -v "$PROD_DB_VOLUME":/data "$UTIL_IMAGE" sh -c "
        set -e
        if [ -f /data/$DB_FILENAME ]; then
            cp /data/$DB_FILENAME /data/${DB_FILENAME}.pre-restore-\$(date +%s)
            echo '[Restore] Safety backup created inside the volume.'
        fi
        rm -f /data/${DB_FILENAME}-wal /data/${DB_FILENAME}-shm
        rm -rf /data/.${DB_FILENAME}-litestream
    "
}

# --- Production path: named volume, via throwaway containers ---

restore_snapshot_prod() {
    check_oci_env
    ensure_container_stopped

    log "Fetching latest snapshot from OCI bucket: $BACKUP_BUCKET..."
    LATEST=$(docker run --rm \
        -e AWS_ACCESS_KEY_ID="$OCI_ACCESS_KEY_ID" \
        -e AWS_SECRET_ACCESS_KEY="$OCI_SECRET_ACCESS_KEY" \
        "$AWS_CLI_IMAGE" s3 ls "s3://$BACKUP_BUCKET/snapshots/" \
        --endpoint-url "$OCI_ENDPOINT" --region "$OCI_REGION" \
        | sort | tail -1 | awk '{print $4}')

    if [ -z "$LATEST" ]; then
        err "No snapshots found in bucket $BACKUP_BUCKET"
        exit 1
    fi
    log "Latest snapshot: $LATEST"
    log "Target: volume $PROD_DB_VOLUME"

    confirm_or_abort
    backup_and_clean_volume

    log "Downloading snapshot into the volume..."
    docker run --rm \
        -e AWS_ACCESS_KEY_ID="$OCI_ACCESS_KEY_ID" \
        -e AWS_SECRET_ACCESS_KEY="$OCI_SECRET_ACCESS_KEY" \
        -v "$PROD_DB_VOLUME":/data \
        "$AWS_CLI_IMAGE" s3 cp "s3://$BACKUP_BUCKET/snapshots/$LATEST" "/data/$DB_FILENAME" \
        --endpoint-url "$OCI_ENDPOINT" --region "$OCI_REGION"

    log "Snapshot restored successfully: $LATEST"
    log "Restart the stack: docker compose -f docker-compose.prod.yml up -d"
}

restore_litestream_prod() {
    check_oci_env
    ensure_container_stopped

    local image
    image=$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}' 2>/dev/null || echo "")
    if [ -z "$image" ]; then
        err "Could not resolve the image for $CONTAINER_NAME (needed for the litestream binary)."
        exit 1
    fi

    log "Target: volume $PROD_DB_VOLUME (using image $image for the litestream binary)"
    confirm_or_abort
    backup_and_clean_volume

    log "Running Litestream point-in-time restore..."
    docker run --rm \
        -e OCI_ENDPOINT -e OCI_REGION -e OCI_ACCESS_KEY_ID -e OCI_SECRET_ACCESS_KEY \
        -v "$PROD_DB_VOLUME":/app/data \
        --entrypoint litestream \
        "$image" \
        restore -config /etc/litestream.yml -if-replica-exists "/app/data/$DB_FILENAME"

    log "Litestream restore completed."
    log "Restart the stack: docker compose -f docker-compose.prod.yml up -d"
}

# --- Legacy path: ./data bind mount, local/dev use (unchanged behavior) ---

restore_snapshot_legacy() {
    check_oci_env
    log "Fetching latest snapshot from OCI bucket: $BACKUP_BUCKET..."

    LATEST=$(aws s3 ls "s3://$BACKUP_BUCKET/snapshots/" \
        --endpoint-url "$OCI_ENDPOINT" \
        --region "$OCI_REGION" \
        2>/dev/null | sort | tail -1 | awk '{print $4}')

    if [ -z "$LATEST" ]; then
        err "No snapshots found in bucket $BACKUP_BUCKET"
        exit 1
    fi

    log "Latest snapshot: $LATEST"

    local db_file="$LEGACY_DIR/$DB_FILENAME"
    if [ -f "$db_file" ]; then
        BACKUP_NAME="${db_file}.pre-restore-$(date +%s)"
        warn "Existing DB found. Backing up to: $BACKUP_NAME"
        cp "$db_file" "$BACKUP_NAME"
    fi

    mkdir -p "$LEGACY_DIR"
    aws s3 cp "s3://$BACKUP_BUCKET/snapshots/$LATEST" "$db_file" \
        --endpoint-url "$OCI_ENDPOINT" \
        --region "$OCI_REGION"

    rm -f "${db_file}-wal" "${db_file}-shm"

    log "Snapshot restored successfully: $LATEST"
    log "Restart the bot to use the restored database."
}

restore_litestream_legacy() {
    if ! command -v litestream &> /dev/null; then
        err "litestream not found. Install it first: https://litestream.io/install/"
        exit 1
    fi

    log "Starting Litestream point-in-time restore..."

    local db_file="$LEGACY_DIR/$DB_FILENAME"
    if [ -f "$db_file" ]; then
        BACKUP_NAME="${db_file}.pre-restore-$(date +%s)"
        warn "Existing DB found. Backing up to: $BACKUP_NAME"
        cp "$db_file" "$BACKUP_NAME"
    fi

    mkdir -p "$LEGACY_DIR"
    litestream restore -config litestream.yml "$db_file"

    log "Litestream restore completed."
    log "Restart the bot to use the restored database."
}

# --- Main ---

case "${1:-}" in
    snapshot)
        if has_prod_volume; then restore_snapshot_prod; else restore_snapshot_legacy; fi
        ;;
    litestream)
        if has_prod_volume; then restore_litestream_prod; else restore_litestream_legacy; fi
        ;;
    *)
        echo "Usage: $0 {snapshot|litestream}"
        echo ""
        echo "  snapshot   - Restore latest daily atomic backup from OCI"
        echo "  litestream - Point-in-time recovery via Litestream WAL replay"
        echo ""
        echo "If volume $PROD_DB_VOLUME exists, restores into it directly"
        echo "(requires $CONTAINER_NAME stopped first). Otherwise falls back"
        echo "to the legacy ./data bind mount for local/dev use."
        exit 1
        ;;
esac
