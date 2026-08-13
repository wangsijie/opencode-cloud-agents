import assert from 'node:assert/strict'
import test from 'node:test'

function installStorage(entries = {}) {
  const map = new Map(Object.entries(entries))
  globalThis.localStorage = {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  }
  return map
}

const draft = (text, at) => JSON.stringify({ text, at })

test('pruning drops abandoned drafts and keeps recent ones', async () => {
  const now = Date.now()
  const old = now - 40 * 24 * 60 * 60 * 1_000
  const map = installStorage({
    'hub.draft.session.a': draft('kept', now - 1_000),
    'hub.draft.session.b': draft('abandoned', old),
    'hub.draft.new': draft('also abandoned', old),
    // Not a draft: a preference that must survive the sweep untouched.
    'hub.sidebarCollapsed': '1'
  })
  const { pruneDrafts } = await import('../web/src/useDraft.ts')
  pruneDrafts(now)
  assert.deepEqual([...map.keys()].sort(), ['hub.draft.session.a', 'hub.sidebarCollapsed'])
})

test('a malformed draft is swept rather than kept forever', async () => {
  const map = installStorage({ 'hub.draft.session.a': 'not json' })
  const { pruneDrafts } = await import('../web/src/useDraft.ts')
  pruneDrafts(Date.now())
  assert.equal(map.size, 0)
})

test('pruning survives a browser with no storage', async () => {
  globalThis.localStorage = undefined
  const { pruneDrafts } = await import('../web/src/useDraft.ts')
  assert.doesNotThrow(() => pruneDrafts(Date.now()))
})
