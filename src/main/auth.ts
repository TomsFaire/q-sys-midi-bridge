/**
 * auth — password hashing and session tokens for the browser-based
 * mappings page. Sessions are held in memory (process lifetime only —
 * restarting the app signs everyone out, which is fine for this use case).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SCRYPT_KEYLEN = 64
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** Hashes a password as `salt:hash` (both hex). Never store the plaintext. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `${salt}:${hash}`
}

/** Constant-time comparison against a `salt:hash` value from hashPassword(). */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

export class SessionStore {
  private sessions = new Map<string, number>() // token → expiresAt (ms epoch)

  constructor(
    private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(): string {
    const token = randomBytes(24).toString('hex')
    this.sessions.set(token, this.now() + this.ttlMs)
    return token
  }

  isValid(token: string | null | undefined): boolean {
    if (!token) return false
    const expiresAt = this.sessions.get(token)
    if (expiresAt === undefined) return false
    if (this.now() > expiresAt) {
      this.sessions.delete(token)
      return false
    }
    return true
  }
}
