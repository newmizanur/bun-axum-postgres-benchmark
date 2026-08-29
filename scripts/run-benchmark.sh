#!/usr/bin/env bash
#
# Runs the k6 load test against axum-item-crud and bun-item-crud, one at a
# time, and writes the raw k6 output to benchmark-artifacts/.
#
# The two services are never run concurrently: they use the same host
# ports (3000 for the app, 5432 for Postgres), and running them back to
# back is also what makes the comparison fair — each app gets the full
# machine to itself for the duration of its run, capped to 1 CPU core by
# its own docker-compose.yml.
#
# Usage:
#   scripts/run-benchmark.sh
#
# Requires: docker, the docker compose plugin, k6, curl — all on PATH.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT_DIR/benchmark-artifacts}"
READY_TIMEOUT_SECS="${READY_TIMEOUT_SECS:-120}"

mkdir -p "$ARTIFACT_DIR"

log() {
    printf '\n[run-benchmark] %s\n' "$1"
}

# Polls the app's own /items endpoint until it answers, instead of a fixed
# sleep — startup time differs between a JIT-less Rust binary and the Bun
# runtime, so a fixed wait would either be too short for one or wasteful
# for the other.
wait_for_app() {
    local url="$1"
    local waited=0

    log "waiting for $url to be ready (timeout: ${READY_TIMEOUT_SECS}s)"
    until curl -sf -o /dev/null "$url"; do
        if [ "$waited" -ge "$READY_TIMEOUT_SECS" ]; then
            log "ERROR: $url did not become ready within ${READY_TIMEOUT_SECS}s"
            return 1
        fi
        sleep 2
        waited=$((waited + 2))
    done
    log "$url is ready"
}

# Runs one full benchmark cycle for a single service directory.
#   $1 = directory name relative to repo root (e.g. axum-item-crud)
#   $2 = short label used for output filenames (e.g. axum)
run_one() {
    local dir="$1"
    local label="$2"

    log "=============================================="
    log "Benchmarking: $label ($dir)"
    log "=============================================="

    pushd "$ROOT_DIR/$dir" > /dev/null

    # Clean slate: remove any containers/volumes left over from a
    # previous run (locally or from a failed CI run) before starting.
    docker compose down -v --remove-orphans > /dev/null 2>&1 || true

    docker compose up --build -d

    # Ensure teardown happens even if the wait or the k6 run fails.
    trap 'docker compose down -v --remove-orphans > /dev/null 2>&1 || true' EXIT

    wait_for_app "http://localhost:3000/items"

    log "running k6 load test against $label"
    # load-test.js's handleSummary() writes ./summary.json (a stable,
    # documented shape) and echoes the normal human summary to stdout —
    # deliberately not using `k6 run --summary-export`, whose on-disk
    # JSON shape is flatter/undocumented and isn't what
    # generate_results_md.py expects.
    k6 run load-test.js | tee "$ARTIFACT_DIR/${label}-stdout.txt"
    mv summary.json "$ARTIFACT_DIR/${label}-summary.json"

    docker compose down -v --remove-orphans
    trap - EXIT

    popd > /dev/null
}

run_one "axum-item-crud" "axum"
run_one "bun-item-crud" "bun"

log "done — raw results in $ARTIFACT_DIR"
