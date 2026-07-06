import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidPort } from './config.js'

test('isValidPort accepts valid ports', () => {
  assert.equal(isValidPort(1), true)
  assert.equal(isValidPort(3001), true)
  assert.equal(isValidPort(65535), true)
})

test('isValidPort rejects out-of-range and non-integer values', () => {
  assert.equal(isValidPort(0), false)
  assert.equal(isValidPort(65536), false)
  assert.equal(isValidPort(-1), false)
  assert.equal(isValidPort(3001.5), false)
})

test('isValidPort rejects non-number types', () => {
  assert.equal(isValidPort('3001'), false)
  assert.equal(isValidPort(null), false)
  assert.equal(isValidPort(undefined), false)
})
