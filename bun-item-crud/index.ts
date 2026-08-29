import { SQL } from "bun";

// ---------- Types ----------

interface Item {
  id: number;
  name: string;
  description: string | null;
  quantity: number;
}

interface CreateItemRequest {
  name: string;
  description?: string | null;
  quantity?: number;
}

interface UpdateItemRequest {
  name?: string | null;
  description?: string | null;
  quantity?: number | null;
}

// ---------- DB setup ----------
//
// Bun's built-in `Bun.SQL` client speaks Postgres natively (no external
// driver). It manages its own connection pool internally, sized via
// `max` below. Postgres itself has no problem with real concurrency
// (MVCC, row-level locking), so a real pool is used here.
//
// A note for anyone pinned to an older Bun: this was originally written
// and load-tested against Bun v1.2.19, which had two serious bugs in
// Bun.SQL under concurrent load — a connection-pool race (concurrent
// requests would intermittently 404 on a GET for an item that had just
// been created, as if a read raced ahead of the write that created it)
// and, at higher concurrency, an outright segfault crashing the whole
// process. Both were reproduced directly and both are gone as of Bun
// v1.4.0 (clean 100%-pass runs at up to 50 concurrent VUs). If you hit
// flaky reads or crashes under load, check `bun --version` first —
// this is bleeding-edge functionality (Postgres support landed in Bun
// 1.2, expanded in 1.3) and was still maturing as recently as v1.2.19.

const sql = new SQL({
  url:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/items",
  max: 20,
});

// Postgres `INTEGER`/`SERIAL` (32-bit) rather than `BIGINT`/`BIGSERIAL`
// (64-bit) — Bun's Postgres driver returns int8 values as strings to
// avoid silently losing precision above JS's safe-integer range, which
// would break the plain-number JSON contract this API returns
// everywhere else. INTEGER's range is comfortably enough for an "items"
// table and comes back as a normal JS number.
await sql`
  CREATE TABLE IF NOT EXISTS items (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    quantity    INTEGER NOT NULL DEFAULT 0
  )
`;

// ---------- JSON helpers ----------

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorText(status: number, msg: string): Response {
  return new Response(msg + "\n", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function parseId(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// ---------- Handlers ----------

// GET /items
async function listItems(): Promise<Response> {
  const items = await sql<Item[]>`
    SELECT id, name, description, quantity FROM items ORDER BY id
  `;
  return json(200, items);
}

// GET /items/:id
async function getItem(idRaw: string): Promise<Response> {
  const id = parseId(idRaw);
  if (id === null) return errorText(400, "invalid id");

  const rows = await sql<Item[]>`
    SELECT id, name, description, quantity FROM items WHERE id = ${id}
  `;
  if (rows.length === 0) return errorText(404, "item not found");
  return json(200, rows[0]);
}

// POST /items
async function createItem(req: Request): Promise<Response> {
  let body: CreateItemRequest;
  try {
    body = await req.json();
  } catch {
    return errorText(400, "invalid json body");
  }

  const description = body.description ?? null;
  const quantity = body.quantity ?? 0;

  try {
    const rows = await sql<Item[]>`
      INSERT INTO items (name, description, quantity)
      VALUES (${body.name}, ${description}, ${quantity})
      RETURNING id, name, description, quantity
    `;
    return json(201, rows[0]);
  } catch (err) {
    return errorText(500, (err as Error).message);
  }
}

// PUT /items/:id
async function updateItem(idRaw: string, req: Request): Promise<Response> {
  const id = parseId(idRaw);
  if (id === null) return errorText(400, "invalid id");

  let body: UpdateItemRequest;
  try {
    body = await req.json();
  } catch {
    return errorText(400, "invalid json body");
  }

  // Make sure the item exists first so we can return a clean 404.
  const existingRows = await sql<Item[]>`
    SELECT id, name, description, quantity FROM items WHERE id = ${id}
  `;
  if (existingRows.length === 0) return errorText(404, "item not found");
  const existing = existingRows[0]!;

  const name =
    body.name !== undefined && body.name !== null ? body.name : existing.name;
  const description =
    body.description !== undefined ? body.description : existing.description;
  const quantity =
    body.quantity !== undefined && body.quantity !== null
      ? body.quantity
      : existing.quantity;

  try {
    const rows = await sql<Item[]>`
      UPDATE items SET name = ${name}, description = ${description}, quantity = ${quantity}
      WHERE id = ${id}
      RETURNING id, name, description, quantity
    `;
    return json(200, rows[0]);
  } catch (err) {
    return errorText(500, (err as Error).message);
  }
}

// DELETE /items/:id
async function deleteItem(idRaw: string): Promise<Response> {
  const id = parseId(idRaw);
  if (id === null) return errorText(400, "invalid id");

  // RETURNING id, rather than relying on driver-reported affected-row
  // counts, since that metadata isn't consistently available across all
  // of Bun.SQL's database adapters.
  const rows = await sql<{ id: number }[]>`
    DELETE FROM items WHERE id = ${id} RETURNING id
  `;
  if (rows.length === 0) return errorText(404, "item not found");

  return new Response(null, { status: 204 });
}

// ---------- Router ----------

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  routes: {
    "/items": {
      GET: () => listItems(),
      POST: (req) => createItem(req),
    },
    "/items/:id": {
      GET: (req) => getItem(req.params.id),
      PUT: (req) => updateItem(req.params.id, req),
      DELETE: (req) => deleteItem(req.params.id),
    },
  },
  fetch() {
    return errorText(404, "not found");
  },
});

console.log(`listening on http://0.0.0.0:${server.port}`);
