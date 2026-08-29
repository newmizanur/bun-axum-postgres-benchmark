# Bun ships Postgres support built into the runtime (bun:sql) — there
# are no npm dependencies for this app at all, so there's no install
# step. A single stage is all we need.
#
# Pinned to 1.4+, not just "1.2-slim": Bun.SQL's Postgres client had a
# real connection-pool race and a segfault-under-load bug in v1.2.19,
# both confirmed fixed as of v1.4.0 (see the comment in index.ts). Don't
# float this back down to an unpinned "1"/"latest" tag without
# re-verifying against a load test first.
FROM oven/bun:1.4-slim

WORKDIR /app

COPY package.json ./
COPY index.ts ./

EXPOSE 3000

CMD ["bun", "run", "index.ts"]
