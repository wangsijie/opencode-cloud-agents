/**
 * `migrations/0009_docker_hosts.sql`, run the way a deploy runs it: against a
 * database that already holds the four flat `docker.*` settings.
 *
 * The migration is the only thing standing between an existing deployment and
 * a Docker provider that resolves to nothing, so it is exercised on a real
 * SQLite database rather than read. Everything else in the suite starts from a
 * fully migrated database, where the old rows never existed at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { migrationFiles } from './helpers/d1.mjs';

const files = migrationFiles();
const MIGRATION = files.find((name) => name.endsWith('0009_docker_hosts.sql'));

/** A database with every migration before this one applied. */
function beforeMigration(settings) {
  const db = new DatabaseSync(':memory:');
  for (const file of files) {
    if (file === MIGRATION) {
      break;
    }
    db.exec(readFileSync(file, 'utf8'));
  }
  for (const [key, value] of Object.entries(settings)) {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).run(key, JSON.stringify(value), '2026-08-01T00:00:00.000Z');
  }
  return db;
}

function migrate(db) {
  db.exec(readFileSync(MIGRATION, 'utf8'));
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('docker.hosts');
  return row === undefined ? undefined : JSON.parse(row.value);
}

function keys(db) {
  return db
    .prepare("SELECT key FROM settings WHERE key LIKE 'docker.%' ORDER BY key")
    .all()
    .map((row) => row.key);
}

test('the configured agent becomes the host bare `docker` resolves to', () => {
  const db = beforeMigration({
    'docker.agent-url': 'https://mini.example.com',
    'docker.agent-token': 'tok-123'
  });
  // Id `default` is load-bearing: it is what every existing session's
  // `docker` provider lands on, being the first entry in the list.
  assert.deepEqual(migrate(db), [
    {
      id: 'default',
      label: 'Docker',
      baseUrl: 'https://mini.example.com',
      token: 'tok-123'
    }
  ]);
  assert.deepEqual(keys(db), ['docker.hosts']);
});

test('an image and an idle timeout ride along; absent ones stay absent', () => {
  const db = beforeMigration({
    'docker.agent-url': 'https://mini.example.com',
    'docker.agent-token': 'tok-123',
    'docker.image': 'ghcr.io/acme/opencode-session:v1',
    'docker.idle-timeout-minutes': 90
  });
  assert.deepEqual(migrate(db), [
    {
      id: 'default',
      label: 'Docker',
      baseUrl: 'https://mini.example.com',
      token: 'tok-123',
      image: 'ghcr.io/acme/opencode-session:v1',
      // A JSON number, not the string SQLite would give a naive extract.
      idleTimeoutMinutes: 90
    }
  ]);
});

test('a half-configured provider carries nothing forward', () => {
  // It was never usable — a URL with no token only ever gets a 401 — so the
  // migration stores no host rather than one that cannot work.
  const urlOnly = beforeMigration({
    'docker.agent-url': 'https://mini.example.com',
    'docker.image': 'ghcr.io/acme/opencode-session:v1'
  });
  assert.equal(migrate(urlOnly), undefined);
  assert.deepEqual(keys(urlOnly), []);

  const tokenOnly = beforeMigration({ 'docker.agent-token': 'tok-123' });
  assert.equal(migrate(tokenOnly), undefined);
  assert.deepEqual(keys(tokenOnly), []);
});

test('a deployment that never configured Docker is untouched', () => {
  const db = beforeMigration({ 'github.token': 'ghp_x' });
  assert.equal(migrate(db), undefined);
  assert.deepEqual(keys(db), []);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM settings').get().n,
    1
  );
});
