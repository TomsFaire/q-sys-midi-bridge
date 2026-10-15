/**
 * Removing the mappings password, so an install can go back to "no password"
 * (UCI and mappings editor both open). Kept apart from configurator.ts, which
 * imports electron, so it can be tested directly.
 */

import fs from 'node:fs'
import { stripComments } from './config.js'

/**
 * Deletes `uci.mappingsPasswordHash` from the config file. Returns whether a
 * password was actually removed. A config that cannot be parsed is left
 * untouched and the error propagates: never rewrite a file we couldn't read.
 */
export function clearMappingsPassword(configFilePath: string): boolean {
  const raw = fs.readFileSync(configFilePath, 'utf-8')
  const config = JSON.parse(stripComments(raw)) as Record<string, unknown>
  const uci = config.uci as Record<string, unknown> | undefined
  if (!uci || !uci.mappingsPasswordHash) return false
  delete uci.mappingsPasswordHash
  fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8')
  return true
}
