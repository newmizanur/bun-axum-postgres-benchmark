# Axum + Postgres — Item CRUD API

A minimal REST API for managing "items" (id, name, description, quantity),
built with the [Axum](https://github.com/tokio-rs/axum) web framework and
[Postgres](https://www.postgresql.org/) via [sqlx](https://github.com/launchbadge/sqlx).

This is the Axum counterpart to the Bun version of the same example —
identical endpoints, identical database schema, identical behavior, so
both can be load-tested and compared directly. Both now run against
Postgres (not SQLite) so the comparison measures the frameworks under a
database that handles real concurrency, with each app capped to exactly
1 CPU core via Docker so the benchmark is apples-to-apples.

The `items` table is created automatically on first startup — no
separate migration step needed.

## Requirements

- **Docker + Docker Compose** (recommended — see below), or:
- Rust **1.85+** (stable) and a Postgres instance reachable at
  `DATABASE_URL` if running outside Docker

## Project layout

```
axum-item-crud/
├── Cargo.toml
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── README.md
├── api.http
└── src/
    └── main.rs
```

## Run it with Docker Compose (recommended)

```bash
docker compose up --build
```

This starts two containers:

- `postgres` — Postgres 16, **no CPU/memory limit**, so the database is
  never the bottleneck.
- `app` — the Axum server, **hard-capped to 1 CPU core** (`cpus: "1.0"`
  in `docker-compose.yml`), so what you're measuring is the framework
  and driver, not how many cores it was allowed to spread across.

You should see:

```
listening on http://0.0.0.0:3000
```

Tear it down (and wipe the database volume) with:

```bash
docker compose down -v
```

Leave off `-v` if you want the data to persist across `up`/`down` cycles.

## Run it without Docker

Point `DATABASE_URL` at any reachable Postgres instance:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/items
cargo run
```

If `DATABASE_URL` isn't set, it falls back to
`postgres://postgres:postgres@localhost:5432/items`, matching the
credentials the compose file's `postgres` service uses.

## A note on fairness for benchmarking against the Bun version

The earlier SQLite version of this example had to cap its connection
pool to 1 to avoid SQLite's single-writer lock contention distorting the
benchmark — see the git history / previous README revision if you're
curious. Postgres doesn't have that problem: it handles concurrent
readers and writers natively via MVCC and row-level locking, so this
version uses a real pool (`max_connections(10)`) with no artificial
serialization.

The leveling mechanism for this comparison has moved from "cap the
connection pool" to **"cap the CPU"**: both this app and the Bun version
run in a container limited to exactly 1 CPU core, while Postgres itself
runs unconstrained in both compose files. That isolates what's actually
being compared — the web framework and its database driver — from how
many cores each language runtime happened to get.

## Endpoints

| Method | Path          | Body                                              | Description                     |
|--------|---------------|----------------------------------------------------|----------------------------------|
| GET    | `/items`      | —                                                  | List all items                  |
| GET    | `/items/{id}` | —                                                  | Get a single item                |
| POST   | `/items`      | `{ "name": "...", "description": "...", "quantity": 0 }` | Create a new item          |
| PUT    | `/items/{id}` | any subset of `name` / `description` / `quantity` | Update an existing item (partial) |
| DELETE | `/items/{id}` | —                                                  | Delete an item                  |

`description` is optional everywhere; `quantity` defaults to `0` if omitted
on create.

## Example requests

Create an item:

```bash
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{"name": "Widget", "description": "A small widget", "quantity": 10}'
```

```json
{"id":1,"name":"Widget","description":"A small widget","quantity":10}
```

List all items:

```bash
curl http://localhost:3000/items
```

Update an item (only the fields you send are changed):

```bash
curl -X PUT http://localhost:3000/items/1 \
  -H "Content-Type: application/json" \
  -d '{"quantity": 25}'
```

Delete an item:

```bash
curl -X DELETE http://localhost:3000/items/1
# -> 204 No Content
```

A ready-to-run request collection is included in `api.http` — open it in
VS Code (with the "REST Client" extension) or a JetBrains IDE and click
"Run" above each request.

## How this compares to the Bun version

- **Connection pooling.** Both versions now use a real pool against
  Postgres — sqlx's `PgPoolOptions` here, Bun's built-in `SQL` client's
  internal pool on the other side. Neither needs the single-connection
  workaround the SQLite versions required.
- **State sharing.** Axum's `State<T>` extractor pulls the connection
  pool straight into each handler's function signature — no manual
  plumbing needed.
- **Error handling.** This example defines a small `AppError` enum that
  implements `IntoResponse`, plus a `From<sqlx::Error>` impl, so every
  handler can just use `?` and axum automatically turns failures into
  the right HTTP response.
- **Compile-time vs. runtime query checking.** This uses sqlx's
  runtime-checked `query_as` rather than the `query_as!` macro, so
  there's no need for a live database connection at `cargo build` time
  (relevant for the Docker build, which builds before Postgres is
  necessarily reachable).
- **Everything else** — schema, endpoints, response shapes — is
  identical, so any performance or behavior difference you observe when
  load-testing comes from the framework/driver/runtime, not from the API
  design.

## Notes / next steps

- This example keeps everything in one `src/main.rs` file for clarity.
  For a larger project, split handlers, models, error types, and the db
  pool setup into separate modules.
- No input validation is performed beyond basic type checking from
  `serde` — add checks (e.g. non-empty `name`, non-negative `quantity`)
  as needed.
- For OpenAPI docs, pair axum with the `utoipa` crate (`utoipa` +
  `utoipa-swagger-ui`) — axum has no built-in OpenAPI generation.
- The Dockerfile uses a two-stage build (compile in `rust:1-slim-bookworm`,
  ship only the binary in `debian:bookworm-slim`) with a throwaway
  `main.rs` layer to cache dependency compilation separately from your
  actual source changes — rebuilds after editing `main.rs` only recompile
  your code, not every crate in the dependency tree.
