// dsh-opencode-go-session local behaviour tests (no network).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import { headerValueFor, redactSessionId, withStore } from '../lib/index.js'
import { AsyncLocalStorage } from 'node:async_hooks'

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('  ✓', label)
}

async function checkAsync(label, fn) {
  await fn()
  passed++
  console.log('  ✓', label)
}

console.log('dsh-opencode-go-session tests')

// --- headerValueFor: default (uuid) must never expose the session id ---
check('uuid mode: value is opaque, not the session id', () => {
  const table = new Map()
  const value = headerValueFor('conv-123', 'uuid', table)
  assert.ok(typeof value === 'string' && value.length > 0)
  assert.notEqual(value, 'conv-123')
  // stable across calls for the same session
  assert.equal(headerValueFor('conv-123', 'uuid', table), value)
  // distinct sessions get distinct values
  assert.notEqual(headerValueFor('conv-456', 'uuid', table), value)
})

check('uuid mode matches UUID format', () => {
  const table = new Map()
  const value = headerValueFor('abc', 'uuid', table)
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

// --- headerValueFor: explicit session-id mode passes the value through ---
check('session-id mode: value equals the session id', () => {
  const table = new Map()
  assert.equal(headerValueFor('conv-123', 'session-id', table), 'conv-123')
})

// --- header header-injection guard ---
check('control characters are rejected (both modes)', () => {
  const table = new Map()
  assert.equal(headerValueFor('a\nInjected: x', 'uuid', table), undefined)
  assert.equal(headerValueFor('a\nInjected: x', 'session-id', table), undefined)
})

check('empty / non-string session ids are rejected', () => {
  const table = new Map()
  assert.equal(headerValueFor('', 'uuid', table), undefined)
  assert.equal(headerValueFor(null, 'uuid', table), undefined)
})

// --- redaction ---
check('redactSessionId is a stable hashed digest', () => {
  const a = redactSessionId('conv-secret-1')
  const b = redactSessionId('conv-secret-1')
  assert.ok(/^[0-9a-f]{16}$/.test(a))
  assert.equal(a, b)
  assert.notEqual(a, 'conv-secret-1')
})

// --- withStore drives the iterator inside the store ---
await checkAsync('withStore keeps store active across pulls', async () => {
  const als = new AsyncLocalStorage()
  const seen = []
  // The store is active inside the downstream generator body (where the real
  // HTTP request would happen), not in the consuming for-await loop.
  async function* gen() {
    seen.push(als.getStore()?.value)
    yield 'a'
    seen.push(als.getStore()?.value)
    yield 'b'
  }
  const wrapped = withStore(gen(), { value: 'V' }, als)
  const out = []
  for await (const chunk of wrapped) out.push(chunk)
  assert.deepEqual(out, ['a', 'b'])
  assert.deepEqual(seen, ['V', 'V'])
})

await Promise.resolve()
console.log(`\nall ${passed} checks passed`)
