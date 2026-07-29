import assert from 'node:assert/strict'
import test from 'node:test'

import {
  catalogFromConfig,
  resolveDefaultModelSelection
} from '../src/model-catalog.ts'

/**
 * The catalog used to be derived from a hardcoded config at module load;
 * these are the same guarantees against a fixture, the way the runtime now
 * derives it from the stored config.
 */
const fixture = () => ({
  model: 'acme/ag/nested-model',
  provider: {
    acme: {
      name: 'Acme',
      models: {
        // A model id with a slash in it: only the first segment is provider.
        'ag/nested-model': { name: 'Nested Model' },
        plain: {
          name: 'Plain Model',
          variants: {
            low: { reasoningEffort: 'low' },
            medium: { reasoningEffort: 'medium' },
            xhigh: { reasoningEffort: 'xhigh' }
          }
        }
      }
    },
    other: {
      // No display name: the provider id stands in.
      models: {
        solo: {
          name: 'Solo',
          variants: {
            high: { reasoningEffort: 'high' },
            max: { reasoningEffort: 'max' }
          }
        }
      }
    }
  }
})

test('the catalog exposes every configured provider model', () => {
  const catalog = catalogFromConfig(fixture())
  assert.equal(catalog.options.length, 3)
  for (const option of catalog.options) {
    assert.equal(option.id, option.providerID + '/' + option.modelID)
    assert.equal(catalog.findModel(option.id), option)
    assert.ok(catalog.isModelRef(option.id))
  }
  assert.equal(catalog.defaultModelRef, 'acme/ag/nested-model')
  assert.ok(catalog.isModelRef(catalog.defaultModelRef))
})

test('model references keep slashes inside the model id', () => {
  const catalog = catalogFromConfig(fixture())
  assert.deepEqual(catalog.parseModelRef('acme/ag/nested-model'), {
    providerID: 'acme',
    modelID: 'ag/nested-model'
  })
})

test('unknown model references are rejected rather than forwarded', () => {
  const catalog = catalogFromConfig(fixture())
  assert.equal(catalog.isModelRef('nope/nope'), false)
  assert.equal(catalog.isModelRef(''), false)
  assert.equal(catalog.isModelRef(undefined), false)
  assert.equal(catalog.parseModelRef('nope/nope'), undefined)
})

test('display names read provider · model, falling back to ids', () => {
  const catalog = catalogFromConfig(fixture())
  assert.equal(
    catalog.findModel('acme/ag/nested-model').displayName,
    'Acme · Nested Model'
  )
  assert.equal(catalog.findModel('other/solo').displayName, 'other · Solo')
})

test('variants validate against the model they belong to', () => {
  const catalog = catalogFromConfig(fixture())
  assert.ok(catalog.isValidVariant('acme/plain', 'medium'))
  assert.equal(catalog.isValidVariant('acme/plain', 'nope'), false)
  // A model without variants accepts only "no variant".
  assert.ok(catalog.isValidVariant('acme/ag/nested-model', undefined))
  assert.ok(catalog.isValidVariant('acme/ag/nested-model', ''))
  assert.equal(catalog.isValidVariant('acme/ag/nested-model', 'medium'), false)
  assert.equal(catalog.isValidVariant('nope/nope', undefined), false)
})

test('the default variant prefers medium, then high, then the first key', () => {
  const catalog = catalogFromConfig(fixture())
  assert.equal(catalog.defaultVariantForModel('acme/plain'), 'medium')
  assert.equal(catalog.defaultVariantForModel('other/solo'), 'high')
  assert.equal(catalog.defaultVariantForModel('acme/ag/nested-model'), undefined)
})

test('resolveVariant keeps a valid preference and replaces an invalid one', () => {
  const catalog = catalogFromConfig(fixture())
  assert.equal(catalog.resolveVariant('acme/plain', 'xhigh'), 'xhigh')
  assert.equal(catalog.resolveVariant('acme/plain', 'gone'), 'medium')
  assert.equal(catalog.resolveVariant('acme/plain', undefined), 'medium')
  assert.equal(catalog.resolveVariant('acme/ag/nested-model', 'anything'), undefined)
})

test('the composer default keeps the most recent valid model and variant', () => {
  const catalog = catalogFromConfig(fixture())
  assert.deepEqual(
    resolveDefaultModelSelection(catalog, {
      model: 'acme/plain',
      variant: 'xhigh'
    }),
    { model: 'acme/plain', variant: 'xhigh' }
  )
})

test('the composer default replaces a removed variant', () => {
  const catalog = catalogFromConfig(fixture())
  assert.deepEqual(
    resolveDefaultModelSelection(catalog, {
      model: 'acme/plain',
      variant: 'gone'
    }),
    { model: 'acme/plain', variant: 'medium' }
  )
})

test('the composer default falls back from a removed model to config.model', () => {
  const catalog = catalogFromConfig(fixture())
  assert.deepEqual(
    resolveDefaultModelSelection(catalog, {
      model: 'gone/model',
      variant: 'high'
    }),
    { model: 'acme/ag/nested-model' }
  )
  assert.deepEqual(resolveDefaultModelSelection(catalog), {
    model: 'acme/ag/nested-model'
  })
})

test('the composer default omits effort for a model without variants', () => {
  const catalog = catalogFromConfig(fixture())
  assert.deepEqual(
    resolveDefaultModelSelection(catalog, {
      model: 'acme/ag/nested-model',
      variant: 'medium'
    }),
    { model: 'acme/ag/nested-model' }
  )
})

test('variant labels capitalize, with xhigh spelled XHigh', () => {
  const catalog = catalogFromConfig(fixture())
  const labels = Object.fromEntries(
    catalog.findModel('acme/plain').variants.map((variant) => [variant.id, variant.label])
  )
  assert.deepEqual(labels, { low: 'Low', medium: 'Medium', xhigh: 'XHigh' })
})

test('an empty provider map yields an empty catalog rather than a crash', () => {
  const catalog = catalogFromConfig({})
  assert.deepEqual([...catalog.options], [])
  assert.equal(catalog.defaultModelRef, '')
  assert.equal(catalog.isModelRef('a/b'), false)
})
