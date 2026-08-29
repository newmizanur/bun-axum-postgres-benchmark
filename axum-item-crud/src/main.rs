use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, FromRow, PgPool};

/// The shape of an Item as stored in and returned from the database.
#[derive(Debug, Serialize, FromRow)]
struct Item {
    id: i64,
    name: String,
    description: Option<String>,
    quantity: i64,
}

/// The shape of the JSON body accepted when creating an item.
#[derive(Debug, Deserialize)]
struct CreateItem {
    name: String,
    description: Option<String>,
    quantity: i64,
}

/// The shape of the JSON body accepted when updating an item.
/// All fields are optional so callers can send a partial update.
#[derive(Debug, Deserialize)]
struct UpdateItem {
    name: Option<String>,
    description: Option<String>,
    quantity: Option<i64>,
}

/// A small app-wide error type so handlers can just use `?` and let
/// axum turn failures into the right HTTP status automatically.
enum AppError {
    NotFound,
    Internal(sqlx::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "item not found".to_string()).into_response(),
            AppError::Internal(err) => {
                (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response()
            }
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::Internal(err)
    }
}

type AppResult<T> = Result<T, AppError>;

// ---------- Handlers ----------

/// GET /items
/// Returns every item in the table.
async fn list_items(State(pool): State<PgPool>) -> AppResult<Json<Vec<Item>>> {
    let items = sqlx::query_as::<_, Item>(
        "SELECT id, name, description, quantity FROM items ORDER BY id",
    )
    .fetch_all(&pool)
    .await?;

    Ok(Json(items))
}

/// GET /items/{id}
/// Returns a single item by id, or 404 if it doesn't exist.
async fn get_item(Path(id): Path<i64>, State(pool): State<PgPool>) -> AppResult<Json<Item>> {
    let item = sqlx::query_as::<_, Item>(
        "SELECT id, name, description, quantity FROM items WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(item))
}

/// POST /items
/// Creates a new item and returns it with its generated id.
async fn create_item(
    State(pool): State<PgPool>,
    Json(body): Json<CreateItem>,
) -> AppResult<(StatusCode, Json<Item>)> {
    let item = sqlx::query_as::<_, Item>(
        "INSERT INTO items (name, description, quantity) VALUES ($1, $2, $3)
         RETURNING id, name, description, quantity",
    )
    .bind(&body.name)
    .bind(&body.description)
    .bind(body.quantity)
    .fetch_one(&pool)
    .await?;

    Ok((StatusCode::CREATED, Json(item)))
}

/// PUT /items/{id}
/// Updates any provided fields on an existing item. Fields left out of
/// the JSON body (or sent as null) are left unchanged.
async fn update_item(
    Path(id): Path<i64>,
    State(pool): State<PgPool>,
    Json(body): Json<UpdateItem>,
) -> AppResult<Json<Item>> {
    // Make sure the item exists first so we can return a clean 404.
    let existing = sqlx::query_as::<_, Item>(
        "SELECT id, name, description, quantity FROM items WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let name = body.name.unwrap_or(existing.name);
    let description = body.description.or(existing.description);
    let quantity = body.quantity.unwrap_or(existing.quantity);

    let updated = sqlx::query_as::<_, Item>(
        "UPDATE items SET name = $1, description = $2, quantity = $3 WHERE id = $4
         RETURNING id, name, description, quantity",
    )
    .bind(&name)
    .bind(&description)
    .bind(quantity)
    .bind(id)
    .fetch_one(&pool)
    .await?;

    Ok(Json(updated))
}

/// DELETE /items/{id}
/// Deletes an item, returning 204 on success or 404 if it never existed.
async fn delete_item(Path(id): Path<i64>, State(pool): State<PgPool>) -> AppResult<StatusCode> {
    let result = sqlx::query("DELETE FROM items WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

#[tokio::main]
async fn main() {
    // Postgres handles concurrent readers and writers natively via MVCC
    // and row-level locking, so — unlike the SQLite version — there's no
    // single-writer-lock contention to work around here. A real
    // connection pool is safe and expected; size it however fits your
    // deployment. `DATABASE_URL` defaults to the docker-compose service
    // name/credentials but can be overridden for local runs.
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/items".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("failed to connect to postgres database");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS items (
            id          BIGSERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            quantity    BIGINT NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await
    .expect("failed to run migration");

    let app = Router::new()
        .route("/items", get(list_items).post(create_item))
        .route(
            "/items/{id}",
            get(get_item).put(update_item).delete(delete_item),
        )
        .with_state(pool);

    println!("listening on http://0.0.0.0:3000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("failed to bind to port 3000");
    axum::serve(listener, app).await.expect("server error");
}
