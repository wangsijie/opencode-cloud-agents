import assert from 'node:assert/strict'
import test from 'node:test'

import {
  catalogForRoute,
  enteredNewSessionPage
} from '../web/src/catalog-refresh.ts'

test('returning to the new-session page refreshes repository recency', () => {
  assert.equal(enteredNewSessionPage('session', 'list'), true)
  assert.equal(enteredNewSessionPage('settings', 'list'), true)
})

test('remaining on or leaving the new-session page does not reload the catalog', () => {
  assert.equal(enteredNewSessionPage('list', 'list'), false)
  assert.equal(enteredNewSessionPage('list', 'session'), false)
  assert.equal(enteredNewSessionPage('session', 'settings'), false)
})

test('entering the new-session page hides the catalog until the fresh read lands', () => {
  const catalog = { repos: [], models: [], providers: ['cloudflare'] }
  // Coming from a session or settings: the old order must not reach the
  // composer, or its default would stick past the reordered answer.
  assert.equal(catalogForRoute('list', 'session', catalog), undefined)
  assert.equal(catalogForRoute('list', 'settings', catalog), undefined)
  // Already on the page, or anywhere else: the current catalog is the
  // composer's to render.
  assert.equal(catalogForRoute('list', 'list', catalog), catalog)
  assert.equal(catalogForRoute('session', 'list', catalog), catalog)
  assert.equal(catalogForRoute('settings', 'list', catalog), catalog)
  // An undefined catalog is passed through as undefined everywhere.
  assert.equal(catalogForRoute('list', 'session', undefined), undefined)
  assert.equal(catalogForRoute('list', 'list', undefined), undefined)
})
