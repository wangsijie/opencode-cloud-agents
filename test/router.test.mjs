import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRoute, settingsPath } from '../web/src/router.ts'

test('a settings tab is a place with an address', () => {
  assert.deepEqual(parseRoute('/settings'), { name: 'settings' })
  assert.deepEqual(parseRoute('/settings/'), { name: 'settings' })
  assert.deepEqual(parseRoute('/settings/prebuilds'), {
    name: 'settings',
    section: 'prebuilds'
  })
  assert.deepEqual(parseRoute('/settings/git-identity/'), {
    name: 'settings',
    section: 'git-identity'
  })
  assert.equal(settingsPath(), '/settings')
  assert.equal(settingsPath('prebuilds'), '/settings/prebuilds')
})

test('the retired prebuilds page resolves to the tab that replaced it', () => {
  assert.deepEqual(parseRoute('/prebuilds'), {
    name: 'settings',
    section: 'prebuilds'
  })
  assert.deepEqual(parseRoute('/prebuilds/'), {
    name: 'settings',
    section: 'prebuilds'
  })
})

test('session routes are unchanged by the settings segment', () => {
  assert.deepEqual(parseRoute('/sessions/abc'), { name: 'session', id: 'abc' })
  assert.deepEqual(parseRoute('/sessions/abc/agent/def'), {
    name: 'session',
    id: 'abc',
    agent: 'def'
  })
  assert.deepEqual(parseRoute('/'), { name: 'list' })
  // Deeper than a tab: nothing claims it, so it is the Hub.
  assert.deepEqual(parseRoute('/settings/prebuilds/extra'), { name: 'list' })
})
