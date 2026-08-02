import assert from 'node:assert/strict'
import test from 'node:test'

import { enteredNewSessionPage } from '../web/src/catalog-refresh.ts'

test('returning to the new-session page refreshes repository recency', () => {
  assert.equal(enteredNewSessionPage('session', 'list'), true)
  assert.equal(enteredNewSessionPage('settings', 'list'), true)
})

test('remaining on or leaving the new-session page does not reload the catalog', () => {
  assert.equal(enteredNewSessionPage('list', 'list'), false)
  assert.equal(enteredNewSessionPage('list', 'session'), false)
  assert.equal(enteredNewSessionPage('session', 'settings'), false)
})
