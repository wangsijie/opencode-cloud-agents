/**
 * The Drizzle schema against the DDL that is actually shipped.
 *
 * `src/db/schema.ts` is a mirror of `migrations/*.sql`, not a source of truth,
 * and a mirror can drift silently: a column named wrongly there compiles fine
 * and fails at runtime, on a query nobody ran in review. So these tests apply
 * every migration to a real SQLite database and compare what it reports with
 * what Drizzle believes.
 *
 * If one of these fails after a migration was added, the fix is to update
 * `src/db/schema.ts` — not to relax the assertion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getTableColumns, getTableName } from 'drizzle-orm';

import {
  adminSessions,
  prebuildRuns,
  prebuilds,
  sessions,
  settings
} from '../src/db/schema.ts';
import { createTestD1 } from './helpers/d1.mjs';

const TABLES = [sessions, settings, adminSessions, prebuilds, prebuildRuns];

/** What SQLite reports about a table, keyed by column name. */
async function actualColumns(db, table) {
  const rows = await db
    .prepare(
      'SELECT name, type, "notnull" AS not_null, pk FROM pragma_table_info(?1)'
    )
    .bind(table)
    .all();
  return new Map(rows.results.map((row) => [row.name, row]));
}

test('every declared table exists in the migrated database', async () => {
  const db = createTestD1();
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const present = new Set(rows.results.map((row) => row.name));

  for (const table of TABLES) {
    assert.ok(present.has(getTableName(table)), `missing table ${getTableName(table)}`);
  }
});

test('every declared column exists, with the type the DDL gives it', async () => {
  const db = createTestD1();

  for (const table of TABLES) {
    const name = getTableName(table);
    const actual = await actualColumns(db, name);
    for (const [property, column] of Object.entries(getTableColumns(table))) {
      const found = actual.get(column.name);
      assert.ok(found, `${name}.${column.name} (${property}) is not in the database`);
      // Drizzle's `text`/`integer` map to SQLite's TEXT/INTEGER affinities.
      const expected = column.columnType === 'SQLiteText' ? 'TEXT' : 'INTEGER';
      assert.equal(
        found.type,
        expected,
        `${name}.${column.name} is ${found.type}, declared ${expected}`
      );
    }
  }
});

test('no column in the database is missing from the schema', async () => {
  const db = createTestD1();

  for (const table of TABLES) {
    const name = getTableName(table);
    const actual = await actualColumns(db, name);
    const declared = new Set(
      Object.values(getTableColumns(table)).map((column) => column.name)
    );
    for (const column of actual.keys()) {
      assert.ok(
        declared.has(column),
        `${name}.${column} exists in the database but not in src/db/schema.ts`
      );
    }
  }
});

test('nullability matches the DDL', async () => {
  const db = createTestD1();

  for (const table of TABLES) {
    const name = getTableName(table);
    const actual = await actualColumns(db, name);
    for (const column of Object.values(getTableColumns(table))) {
      const found = actual.get(column.name);
      // SQLite reports a single-column TEXT PRIMARY KEY as nullable — a legacy
      // quirk it keeps for backwards compatibility — so its `notnull` says
      // nothing. Primary keys are checked by the test below instead.
      if (found.pk > 0) {
        continue;
      }
      assert.equal(
        column.notNull,
        found.not_null === 1,
        `${name}.${column.name} nullability disagrees with the DDL`
      );
    }
  }
});

test('primary keys match the DDL, including the composite one', async () => {
  const db = createTestD1();

  const sessionKey = await actualColumns(db, 'sessions');
  assert.equal(sessionKey.get('id').pk, 1);

  const settingsKey = await actualColumns(db, 'settings');
  assert.equal(settingsKey.get('key').pk, 1);

  const adminKey = await actualColumns(db, 'admin_sessions');
  assert.equal(adminKey.get('token_hash').pk, 1);

  // `prebuilds` is keyed on the pair, which is what the registry upsert
  // conflicts on; getting this wrong would turn the upsert into an insert.
  const prebuildKey = await actualColumns(db, 'prebuilds');
  assert.equal(prebuildKey.get('repo_key').pk, 1);
  assert.equal(prebuildKey.get('provider').pk, 2);

  const runKey = await actualColumns(db, 'prebuild_runs');
  assert.equal(runKey.get('id').pk, 1);
});

test('every index the migrations create is declared in the schema', async () => {
  const db = createTestD1();
  const rows = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"
    )
    .all();
  const actual = new Set(rows.results.map((row) => row.name));

  // Declared on the Drizzle tables; the names are what the DDL created.
  for (const name of [
    'idx_sessions_created_at',
    'idx_sessions_repo_key',
    'idx_sessions_delete_queue',
    'idx_sessions_status_query',
    'idx_admin_sessions_expires',
    'idx_prebuild_runs_repo'
  ]) {
    assert.ok(actual.has(name), `missing index ${name}`);
  }
  assert.equal(actual.size, 6, 'a migration added an index the schema does not name');
});

test('the phase CHECK the DDL keeps is still enforced', async () => {
  const db = createTestD1();
  // 0004 rebuilt the table without a lifecycle CHECK but kept this one, so a
  // phase value the code does not know is refused by the database itself.
  await assert.rejects(
    db
      .prepare(
        `INSERT INTO sessions (id, name, repo_key, model, title, phase, created_at, updated_at)
         VALUES ('inst-1', 'n', '', 'm', 't', 'not-a-phase', 'now', 'now')`
      )
      .run()
  );
});
