# Bun (`Bun.serve`) + Postgres — Item CRUD API

A minimal REST API for managing "items" (id, name, description, quantity),
built with **Bun's built-in HTTP server and native Postgres client** —
[`Bun.serve`](https://bun.sh/docs/api/http) for routing and
[`Bun.SQL`](https://bun.com/docs/runtime/sql) for the database. No
third-party web framework and no third-party Postgres driver — `Bun.SQL`
speaks the Postgres wire protocol natively, so there isn't a single npm
dependency in this project.

This is the Bun counterpart to the Axum version of the same example —
identical endpoints, identical database schema, identical behavior (with
one small, called-out exception below), so both can be load-tested and
compared directly. Both now run against Postgres (not SQLite) so the
comparison measures the frameworks under a database that handles real
concurrency, with each app capped to exactly 1 CPU core via Docker so
the benchmark is apples-to-apples.

The `items` table is created automatically on first startup — no
separate migration step needed.

## Requirements

- **Docker + Docker Compose** (recommended — see below), or:
- **Bun 1.4+** and a Postgres instance reachable at `DATABASE_URL` if
  running outside Docker. Check your version with `bun --version`.
  Earlier versions are not recommended for this app — see the warning
  below.

## Project layout

```
bun-item-crud/
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── README.md
├── api.http
├── load-test.js
└── index.ts
```

## Run it with Docker Compose (recommended)

```bash
docker compose up --build
```

This starts two containers:

- `postgres` — Postgres 16, **no CPU/memory limit**, so the database is
  never the bottleneck.
- `app` — the Bun server, **hard-capped to 1 CPU core** (`cpus: "1.0"`
  in `docker-compose.yml`), so what you're measuring is the runtime and
  driver, not how many cores it was allowed to use.

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
bun run index.ts
```

If `DATABASE_URL` isn't set, it falls back to
`postgres://postgres:postgres@localhost:5432/items`, matching the
credentials the compose file's `postgres` service uses.

Or build a standalone binary first (useful for load testing outside
Docker, so you're not paying startup/JIT-warmup cost inside the
benchmark run):

```bash
bun build ./index.ts --compile --outfile item-crud
DATABASE_URL=postgres://postgres:postgres@localhost:5432/items ./item-crud
```

## A note on fairness for benchmarking against the Axum version

The earlier SQLite version of this example relied on `bun:sqlite`
opening a single native connection (no pool) to match Go's
`db.SetMaxOpenConns(1)` and avoid SQLite's single-writer lock
contention. Postgres doesn't have that problem — it handles concurrent
readers and writers natively via MVCC and row-level locking — so this
version uses `Bun.SQL`'s built-in connection pool (`max: 10`) with no
artificial serialization.

The leveling mechanism for this comparison has moved from "cap the
connection pool" to **"cap the CPU"**: both this app and the Axum
version run in a container limited to exactly 1 CPU core, while Postgres
itself runs unconstrained in both compose files. That isolates what's
actually being compared — the runtime and its database driver — from how
many cores each language happened to get.

One JS-specific wrinkle worth knowing about: Postgres's 64-bit
`BIGINT`/`BIGSERIAL` types get returned by `Bun.SQL` as **strings**, not
numbers, to avoid silently losing precision above JavaScript's
safe-integer range. Returning `"quantity":"10"` instead of
`"quantity":10` would break the plain-number JSON contract this API
returns everywhere else, so this version uses 32-bit `INTEGER`/`SERIAL`
instead, which comes back as an ordinary JS number. The Axum version
doesn't need this workaround — Rust's `i64` serializes to a plain JSON
number regardless of size — so its schema still uses `BIGINT`/`BIGSERIAL`.
Each service has its own Postgres instance in the compose setup, so the
schemas don't need to match byte-for-byte between the two.

## ⚠️ Bun version matters here — a real bug, not a style note

This was originally written and load-tested against Bun **v1.2.19**,
which turned out to have two serious bugs in `Bun.SQL`'s Postgres client
under concurrent load:

- **A connection-pool race.** With a real pool (`max` > 1), concurrent
  requests would intermittently `404` on a GET for an item that had
  *just* been created moments earlier in the same test — as if a read
  raced ahead of the write that created it. Reproduced directly: 2
  concurrent virtual users against `max: 10` produced roughly 15% failed
  reads.
- **A segfault under higher concurrency.** At 20 concurrent VUs, the Bun
  process itself crashed outright (`Segmentation fault at address 0x0`),
  not an application error — the runtime went down.

Both were confirmed **fixed as of Bun v1.4.0** — clean 100%-pass runs at
up to 50 concurrent VUs, no crashes. `docker-compose.yml` and the
Dockerfile here are pinned to `oven/bun:1.4-slim` specifically because
of this; don't float that back down to an unpinned `1.2`/`latest` tag
without re-running a concurrent load test first. If you're running this
outside Docker, check `bun --version` before trusting a load test that
shows flaky failures or crashes — it may be the runtime, not your code.

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

## How this compares to the Axum version

- **Connection pooling.** Both versions now use a real pool against
  Postgres — `Bun.SQL`'s built-in pool here, sqlx's `PgPoolOptions` on
  the other side. Neither needs the single-connection workaround the
  SQLite versions required.
- **No framework at all.** `Bun.serve`'s built-in route object (with
  `:id`-style path params) does the job on its own — no Express, Hono,
  or Elysia here, same "bare metal" spirit as Axum being a thin layer
  over Tokio/Hyper.
- **No compile-time extractor magic.** Path params come from
  `req.params.id`, and the JSON body is pulled out manually with `await
  req.json()` inside a `try`/`catch`. Axum's `Json<T>` extractor does
  this validation automatically before the handler runs — a real
  ergonomic difference, not just a style one (see the 400-vs-500
  behavior note below).
- **`undefined`/optional fields instead of `Option<T>`.** Rust models
  "field not provided" with `Option<T>`, `None` for absent. TypeScript
  doesn't have that distinction built into the type system the same way,
  so this version leans on `undefined` (field absent) vs `null` (field
  explicitly cleared) vs a real value — checked with `!== undefined`
  rather than pattern matching.
- **One real behavioral difference: missing required fields.** Axum's
  `Json<CreateItem>` extractor rejects a request missing `"name"` at
  deserialization time, before the handler even runs — a clean `400`.
  This version has no equivalent extractor-level validation: `body.name`
  comes back `undefined`, which the Postgres driver binds as SQL `NULL`,
  and the `NOT NULL` constraint on `items.name` rejects it at the
  database layer instead — a `500`, not a `400`. Worth knowing if you're
  diffing responses between the two servers request-for-request; see
  item 13 in `api.http`.
- **Bun's event loop instead of Tokio's multi-threaded runtime.** Every
  request in the Axum version can run on any of Tokio's worker threads.
  Bun runs a single-threaded event loop (like Node) — `await`ed
  `Bun.SQL` calls yield back to that one loop rather than running on
  separate OS threads. Capping both containers to 1 CPU core narrows
  this gap for the benchmark, since Axum's extra worker threads have
  nowhere to go anyway on a single core — but it's still a real
  architectural difference worth knowing about.

## Notes / next steps

- This example keeps everything in one `index.ts` file for clarity. For a
  larger project, split handlers, models, and the db setup into separate
  modules.
- Errors are returned as plain text with the underlying error message
  attached — fine for local development, but you'll likely want to hide
  internal error details behind a generic message before shipping to
  production.
- No input validation is performed beyond basic type checking from
  `req.json()` — add checks (e.g. non-empty `name`, non-negative
  `quantity`) as needed. As noted above, a missing `name` currently
  surfaces as a `500` from the database layer rather than a clean `400`
  — that's a good first validation to add.
- For OpenAPI/Swagger docs on a Bun/TypeScript API, you'd typically
  hand-write an OpenAPI spec or reach for a schema library (e.g. Zod +
  `zod-to-openapi`) — there's no automatic generation built in.
