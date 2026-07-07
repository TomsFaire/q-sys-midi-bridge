import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, SessionStore } from './auth.js'

test('verifyPassword accepts the correct password against its own hash', () => {
  const hash = hashPassword('correct horse battery staple')
  assert.equal(verifyPassword('correct horse battery staple', hash), true)
})

test('verifyPassword rejects a wrong password', () => {
  const hash = hashPassword('correct horse battery staple')
  assert.equal(verifyPassword('wrong password', hash), false)
})

test('hashPassword salts each call differently but both verify', () => {
  const a = hashPassword('same password')
  const b = hashPassword('same password')
  assert.notEqual(a, b)
  assert.equal(verifyPassword('same password', a), true)
  assert.equal(verifyPassword('same password', b), true)
})

test('verifyPassword rejects a malformed stored hash', () => {
  assert.equal(verifyPassword('anything', 'not-a-valid-hash'), false)
})

test('SessionStore.isValid is true for a fresh token and false for an unknown one', () => {
  const store = new SessionStore()
  const token = store.create()
  assert.equal(store.isValid(token), true)
  assert.equal(store.isValid('nonexistent-token'), false)
  assert.equal(store.isValid(undefined), false)
})

test('SessionStore.isValid expires tokens after the TTL using an injected clock', () => {
  let now = 0
  const store = new SessionStore(1000, () => now)
  const token = store.create()
  now = 500
  assert.equal(store.isValid(token), true)
  now = 1500
  assert.equal(store.isValid(token), false)
})
