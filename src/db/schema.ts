/**
 * The D1 schema, as Drizzle tables.
 *
 * This file is a mirror, not a source of truth: `migrations/*.sql` still owns
 * the shape of the database, and wrangler still applies it. Drizzle is used
 * here as a query builder over an existing schema, which is why there is no
 * `drizzle-kit` and no generated migration — introducing a second migration
 * engine against a live D1 would be a much larger change than replacing the
 * query strings, and the two would race.
 *
 * The consequence is that this file can drift from the DDL, and drift would be
 * silent: a column named wrongly here compiles and then fails at runtime. So
 * `test/db-schema.test.mjs` asserts these definitions against the columns
 * SQLite actually reports after every migration has been applied. Change a
 * migration, and that test tells you to change this file too.
 *
 * Timestamps are ISO-8601 strings compared lexicographically, as everywhere
 * else in this codebase, so every one of them is a `text` column.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text
} from 'drizzle-orm/sqlite-core';

/**
 * One row per session. A session and its instance are 1:1 by design — the
 * session id is the instance id — so both record shapes project from this one
 * row (see [hub-rows.ts](../hub-rows.ts)).
 *
 * `lifecycle` and `phase` are stored as free-form text on purpose. The DDL kept
 * a CHECK on `phase` and dropped the one on `lifecycle` in migration 0004, and
 * that asymmetry is deliberate: a new lifecycle ships with the code that speaks
 * it, not with a table rebuild. Typing them here as unions is a compile-time
 * convenience over the same text column.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),

    // instance side
    name: text('name').notNull(),
    /** Empty for a session with no checkout; the projection drops it. */
    repoKey: text('repo_key').notNull(),
    /** The pinned RepoDefinition, whole, as JSON. Never queried by sub-field. */
    repoJson: text('repo_json'),
    lifecycle: text('lifecycle').notNull().default('ready'),
    /** Why deletion or cleanup failed; unrelated to the session's last_error. */
    lifecycleError: text('lifecycle_error'),
    deleteOperationId: text('delete_operation_id'),
    provider: text('provider').notNull().default('cloudflare'),

    // session side
    directory: text('directory'),
    model: text('model').notNull(),
    variant: text('variant'),
    title: text('title').notNull(),
    titleLocked: integer('title_locked').notNull().default(0),
    opencodeSessionId: text('opencode_session_id'),
    phase: text('phase').notNull(),
    pendingPromptCount: integer('pending_prompt_count').notNull().default(0),
    lastError: text('last_error'),
    lastPromptAt: text('last_prompt_at'),
    cleanedAt: text('cleaned_at'),
    unreadAt: text('unread_at'),
    pinnedAt: text('pinned_at'),
    bootStep: text('boot_step'),

    // runtime status cache for the session list
    runtimeLifecycle: text('runtime_lifecycle'),
    container: text('container'),
    statusQuery: integer('status_query').notNull().default(1),
    statusObservedAt: text('status_observed_at'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('idx_sessions_created_at').on(table.createdAt),
    index('idx_sessions_repo_key').on(table.repoKey),
    index('idx_sessions_delete_queue').on(table.lifecycle, table.updatedAt),
    index('idx_sessions_status_query').on(table.statusQuery)
  ]
);

/** Singleton configuration: one whole JSON document per key. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull()
});

/**
 * One row per signed-in browser. Only the token hash is stored, so the database
 * alone grants nothing and revoking a browser is deleting its row.
 */
export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at')
  },
  (table) => [index('idx_admin_sessions_expires').on(table.expiresAt)]
);

/**
 * `MAX(a, b)` over two columns — SQLite's scalar form, not the aggregate.
 *
 * "When was this repository last worked in": a session counts as used at its
 * most recent prompt, not its creation, and `last_prompt_at` is nullable, so
 * the repository ordering goes through this expression. ISO timestamps compare
 * lexicographically, so the string maximum is the later moment.
 *
 * The composer's default *model* deliberately does not — see
 * `lastModelSelection` in [hub-store.ts](../hub-store.ts). A repository is
 * remembered by where work happens; a model by where it was chosen.
 */
export const lastActivityAt = sql<string>`CASE WHEN ${sessions.lastPromptAt} > ${sessions.createdAt}
       THEN ${sessions.lastPromptAt} ELSE ${sessions.createdAt} END`;

/**
 * The sidebar's idea of "last touched", in SQL.
 *
 * Not {@link lastActivityAt}: that one answers "when was this repository last
 * *worked in*" and so ignores everything but a prompt. The history has to move
 * for an agent finishing a turn too — otherwise a session whose answer just
 * landed sits below sessions nobody has looked at, and paging would cut it off.
 * This is `deriveLastActivityAt` in [sessions.ts](../sessions.ts) expressed as a
 * scalar `MAX`, and the two must agree: the server pages on this, the sidebar
 * sorts on that. `last_prompt_at` is nullable and `MAX` is null-propagating, so
 * the coalesce is what keeps a never-prompted session from vanishing.
 */
export const sessionActivityAt = sql<string>`MAX(${sessions.updatedAt}, ${sessions.createdAt}, COALESCE(${sessions.lastPromptAt}, ''))`;

/** Pinned rows first, as an ascending sort key. */
export const pinnedFirst = sql`CASE WHEN ${sessions.pinnedAt} IS NULL THEN 1 ELSE 0 END`;
