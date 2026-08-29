# Multi-stage build: compile in a full Rust image, ship only the
# resulting binary in a slim runtime image.
#
# Note: this app uses sqlx's runtime-checked query_as (not the
# compile-time query!/query_as! macros), so no DATABASE_URL or live
# database connection is needed during `docker build`.

FROM rust:1-slim-bookworm AS builder
WORKDIR /app

# Cache dependency compilation separately from source changes: build a
# throwaway main.rs against just the manifest first, so `cargo build`
# only recompiles your actual code (not every dependency) when main.rs
# changes on subsequent builds.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src

COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/axum-item-crud /usr/local/bin/axum-item-crud

EXPOSE 3000
CMD ["axum-item-crud"]
