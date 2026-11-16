/**
 * Test helper (issue #13): one PostgreSQL schema per test file.
 *
 * Every PostgreSQL test file used to share the `public` tables and TRUNCATE
 * them, so files running in parallel could wipe each other's rows. Here each
 * file gets its own schema; every connection of its pool is pinned to it with
 * `search_path`, and `src/storage/schema.sql` (which uses unqualified names)
 * is applied inside it. Nothing under `src/` changes.
 *
 * Known remaining sharing, by design and harmless: the advisory lock taken by
 * the stores is database-wide, so files may wait on each other (slower, never
 * wrong), and roles are cluster-wide (only the boundary test creates any).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface IsolatedSchema {
  /** Pool whose every connection has `search_path` set to the file's own schema. */
  readonly pool: Pool;
  readonly schema: string;
  readonly connectionString: string;
  /** Creates the schema and applies src/storage/schema.sql inside it. */
  create(): Promise<void>;
  /** Drops the schema (CASCADE) and closes both pools. Safe to call once. */
  drop(): Promise<void>;
}

export function isolatedSchema(connectionString: string, label: string): IsolatedSchema {
  const schema = `agt_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase().slice(0, 24)}_${randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  return {
    pool,
    schema,
    connectionString,
    async create() {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const sql = readFileSync(fileURLToPath(new URL("../../src/storage/schema.sql", import.meta.url)), "utf8");
      await pool.query(sql);
    },
    async drop() {
      try {
        await pool.end();
      } finally {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  };
}
