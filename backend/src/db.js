import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

// Keep DATE columns as plain "YYYY-MM-DD" strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

// RDS requires TLS; verify the server against the regional RDS CA bundle.
function sslConfig() {
  if (process.env.DB_SSL === "false") return false;
  const caPath = path.join(here, "..", "rds-ca-bundle.pem");
  return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
}

export const pool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "pitchin",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  ssl: sslConfig(),
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id           BIGSERIAL PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      reward_cents INTEGER NOT NULL DEFAULT 0 CHECK (reward_cents >= 0),
      location     TEXT NOT NULL DEFAULT '',
      due_date     DATE,
      status       TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'accepted', 'completed', 'cancelled')),
      poster_id    BIGINT NOT NULL REFERENCES users(id),
      accepter_id  BIGINT REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      accepted_at  TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS tasks_status_idx   ON tasks (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS tasks_poster_idx   ON tasks (poster_id);
    CREATE INDEX IF NOT EXISTS tasks_accepter_idx ON tasks (accepter_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id           BIGSERIAL PRIMARY KEY,
      task_id      BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      s3_key       TEXT NOT NULL UNIQUE,
      filename     TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      uploaded     BOOLEAN NOT NULL DEFAULT false,
      uploaded_by  BIGINT NOT NULL REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments (task_id);
  `);
}
