# bun-axum-postgres-benchmark

[![Benchmark](https://github.com/<owner>/bun-axum-postgres-benchmark/actions/workflows/benchmark.yml/badge.svg)](https://github.com/<owner>/bun-axum-postgres-benchmark/actions/workflows/benchmark.yml)

Two implementations of the same minimal "items" CRUD REST API, backed by
Postgres, benchmarked against each other under identical conditions:

- [`axum-item-crud/`](axum-item-crud) — [Axum](https://github.com/tokio-rs/axum) (Rust) + [sqlx](https://github.com/launchbadge/sqlx)
- [`bun-item-crud/`](bun-item-crud) — [Bun](https://bun.sh)'s built-in `Bun.serve` + `Bun.SQL` (TypeScript, zero npm dependencies)

Both apps expose the identical schema, endpoints, and behavior — see each
project's own README for details. That's what makes a direct comparison
meaningful: any difference in the numbers comes from the
framework/runtime/driver, not from the API design.

**Results live in [`results.md`](results.md)**, and are regenerated
automatically by CI — see [How the benchmark works](#how-the-benchmark-works)
below.

## Repo layout

```
bun-axum-postgres-benchmark/
├── axum-item-crud/         # Rust / Axum service (standalone — see its own README)
├── bun-item-crud/           # Bun service (standalone — see its own README)
├── scripts/
│   ├── run-benchmark.sh          # builds, runs, and load-tests both services in turn
│   └── generate_results_md.py    # turns the raw k6 output into results.md
├── benchmark-artifacts/     # raw k6 JSON/stdout from the last local run (gitignored)
├── results.md                # latest benchmark results (auto-committed by CI)
└── .github/workflows/benchmark.yml
```

Each service directory is a complete, independently runnable project —
`cd` into either one and follow its own README if you just want to run
that API on its own.

## How the benchmark works

1. Each service is started via its own `docker-compose.yml`, which runs
   Postgres unconstrained alongside the app container **hard-capped to 1
   CPU core**. That cap is the leveling mechanism: Postgres is never the
   bottleneck, so what's being measured is the framework and driver, not
   how many cores each runtime happened to get.
2. [k6](https://k6.io) runs the same [`load-test.js`](axum-item-crud/load-test.js)
   script (identical in both project directories) against whichever
   service is currently up: 50 virtual users for 30 seconds, each
   iteration doing a full list → create → get → update → delete cycle.
3. The two services are benchmarked **sequentially**, never at the same
   time — they share host ports (3000, 5432), and running one at a time
   also means each gets the runner to itself.
4. k6's JSON summary export is parsed into [`results.md`](results.md),
   including overall throughput/latency and a per-endpoint p95 latency
   breakdown, with the raw k6 output kept in collapsible sections for
   anyone who wants to dig further.

This all happens automatically in
[`.github/workflows/benchmark.yml`](.github/workflows/benchmark.yml), which
runs on a schedule (weekly), on any push to `main` that touches either
service or the benchmark scripts, and on demand via
`workflow_dispatch`. The workflow commits the regenerated `results.md`
straight back to `main`.

### Running it yourself

You don't need CI to reproduce the numbers — the same script CI calls
works locally:

```bash
# Requires: Docker + Docker Compose, k6 (https://k6.io/docs/get-started/installation/), curl
./scripts/run-benchmark.sh

# Then turn the raw k6 output into a results.md
python3 scripts/generate_results_md.py \
  --axum benchmark-artifacts/axum-summary.json \
  --bun benchmark-artifacts/bun-summary.json \
  --output results.md \
  --commit "$(git rev-parse HEAD)"
```

## A note on interpreting the numbers

GitHub-hosted runners are shared, general-purpose VMs — not dedicated
benchmarking hardware. Run-to-run variance is real. Treat `results.md` as
a **directional** comparison (which one tends to be faster, and by
roughly how much) rather than a lab-grade absolute measurement. If you
need reproducible numbers for a real decision, run
`scripts/run-benchmark.sh` yourself on hardware you control, ideally
several times.

## License

MIT (or update this to whatever license you'd like the repo to carry).
