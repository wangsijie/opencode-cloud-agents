/**
 * A real D1 binding for the test runner, backed by `node:sqlite`.
 *
 * The database layer used to be untestable: every module reached for
 * `env.DB.prepare(...)`, and the only stub in the suite answered a single
 * settings read. That made a refactor of the query layer unverifiable, so this
 * harness exists first — it runs the actual `migrations/*.sql` against an
 * in-memory SQLite database and exposes the `D1Database` surface the Worker
 * code (and drizzle's D1 driver) call.
 *
 * The subset implemented is the one the site uses: `prepare().bind().first()`,
 * `.all()`, `.run()`, `.raw()`, plus `batch()` and `exec()` because drizzle's
 * transaction and migration paths reach for them. Semantics follow D1's
 * documented behaviour, notably: `first()` returns `null` (not `undefined`)
 * when nothing matched, and `all()` always carries a `results` array.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations/', import.meta.url)
);

/** Every migration file, in the order wrangler would apply them. */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(MIGRATIONS_DIR, name));
}

/**
 * D1 binds by `?1`-style position, and `node:sqlite` accepts the same
 * anonymous-parameter call shape, so binding is a straight spread. Booleans are
 * the one value D1 accepts that SQLite does not, and `undefined` reaches here
 * from optional record fields.
 */
function toSqliteParams(values) {
  return values.map((value) => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    return value;
  });
}

/** SQLite hands back null-prototype rows; D1 hands back plain objects. */
function plain(row) {
  return row === undefined ? null : { ...row };
}

class FakeD1PreparedStatement {
  #db;
  #sql;
  #params;

  constructor(db, sql, params = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...values) {
    return new FakeD1PreparedStatement(this.#db, this.#sql, values);
  }

  #statement() {
    return this.#db.prepare(this.#sql);
  }

  async first(column) {
    const rows = this.#statement().all(...toSqliteParams(this.#params));
    const row = plain(rows[0]);
    if (row === null) {
      return null;
    }
    return column === undefined ? row : (row[column] ?? null);
  }

  async all() {
    const rows = this.#statement().all(...toSqliteParams(this.#params));
    return {
      success: true,
      results: rows.map((row) => plain(row)),
      meta: {}
    };
  }

  async raw({ columnNames = false } = {}) {
    const statement = this.#statement();
    const columns = statement.columns().map((column) => column.name);
    statement.setReturnArrays(true);
    const rows = statement.all(...toSqliteParams(this.#params));
    const values = rows.map((row) => [...row]);
    return columnNames ? [columns, ...values] : values;
  }

  async run() {
    const statement = this.#statement();
    // A statement with a RETURNING clause still has to execute; `run()` on
    // `node:sqlite` performs it and simply discards the rows, which matches how
    // D1's `run()` behaves for callers that ignore the output.
    const meta = statement.run(...toSqliteParams(this.#params));
    return {
      success: true,
      results: [],
      meta: {
        changes: meta.changes,
        last_row_id: Number(meta.lastInsertRowid),
        rows_written: meta.changes,
        rows_read: 0
      }
    };
  }
}

class FakeD1Database {
  #db;

  constructor(db) {
    this.#db = db;
  }

  prepare(sql) {
    return new FakeD1PreparedStatement(this.#db, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.all());
    }
    return results;
  }

  async exec(sql) {
    this.#db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Escape hatch for assertions that want to look at raw rows. */
  get $sqlite() {
    return this.#db;
  }
}

/**
 * A fresh in-memory database with every migration applied.
 *
 * Applying the real migration files (rather than a hand-written schema) is the
 * point: a Drizzle table definition that drifts from the shipped DDL fails
 * here, which is exactly the regression this suite has to catch.
 */
export function createTestD1() {
  const db = new DatabaseSync(':memory:');
  for (const file of migrationFiles()) {
    db.exec(readFileSync(file, 'utf8'));
  }
  return new FakeD1Database(db);
}

/** The `Env` shape the store modules take, with only `DB` filled in. */
export function createTestEnv(extra = {}) {
  return { DB: createTestD1(), ...extra };
}

/**
 * An `Env` whose settings table already holds these key/value pairs.
 *
 * Synchronous, because the callers are `const env = envWith({...})` at the top
 * of a test. `writeSetting` is async only because D1 is, so the rows are
 * inserted straight through the binding instead.
 */
export function createSettingsEnv(settings, extra = {}) {
  const DB = createTestD1();
  const now = new Date().toISOString();
  const insert = DB.$sqlite.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
  );
  for (const [key, value] of Object.entries(settings)) {
    insert.run(key, JSON.stringify(value), now);
  }
  return { DB, ...extra };
}
