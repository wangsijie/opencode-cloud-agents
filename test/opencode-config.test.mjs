import assert from 'node:assert/strict'
import test from 'node:test'

import { OPENCODE_CONFIG } from '../src/opencode-config.ts'

/**
 * Every permission OpenCode knows about has to be decided in the config.
 *
 * There is no operator to answer a prompt: an unset permission evaluates to
 * `ask`, and an ask parks the tool call forever with the session stuck
 * `working`. This list is the set of keys OpenCode's config accepts.
 */
const PERMISSIONS = [
  'edit',
  'bash',
  'webfetch',
  'doom_loop',
  'external_directory'
]

test('every permission is decided, because nothing can answer an ask', () => {
  const permission = OPENCODE_CONFIG.permission
  assert.ok(permission, 'OPENCODE_CONFIG.permission must be set')
  for (const key of PERMISSIONS) {
    assert.equal(permission[key], 'allow', `permission.${key} must be decided`)
  }
})
