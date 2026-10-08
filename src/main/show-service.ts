/**
 * show-service — named mapping sets ("shows") that can be saved and recalled
 * between productions without restarting the app.
 *
 * A show holds the whole `mappings` array and nothing else. It deliberately
 * carries no Core host, credentials, UCI port or MIDI device, so a show file
 * is safe to copy between rigs: recalling one can never repoint the bridge at
 * a different Core or change how it listens.
 *
 * Every function takes its directory as a parameter and this module never
 * imports electron — that is what keeps it unit-testable. Resolving the real
 * userData location is the caller's job (see src/main/index.ts).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Mapping } from './config.js'

/** On-disk shape. `mappings` is named to match a config so loadMappings() reads it. */
export interface Show {
  schema: 1
  name: string
  savedAt: string
  mappings: Mapping[]
}

/** What a listing needs, without loading every mapping into the menu. */
export interface ShowSummary {
  id: string
  name: string
  savedAt: string
  count: number
}

const SCHEMA = 1 as const
const MAX_SLUG = 64

/**
 * A display name reduced to a safe filename stem.
 *
 * Anything that is not a letter or digit collapses to a hyphen, which is what
 * makes traversal impossible by construction: "../../etc/passwd" cannot keep
 * its separators. A name with nothing usable left throws rather than
 * returning '', which would write a dotfile or collide with the directory.
 */
export function slugify(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
  if (!slug) throw new Error(`"${name}" is not a usable show name`)
  return slug
}

/**
 * Guards an id arriving from HTTP or IPC. These are untrusted, so the id must
 * be exactly what slugify would have produced — any separator, traversal or
 * empty value is refused before it reaches the filesystem. Mirrors the check
 * in uci-server.ts resolveSharedFile.
 */
function showPath(showsDir: string, id: string): string {
  const clean = String(id ?? '')
  if (!clean || clean.includes('..') || /[\\/\0]/.test(clean) || !/^[a-z0-9-]+$/.test(clean)) {
    throw new Error(`"${id}" is not a valid show id`)
  }
  return path.join(showsDir, `${clean}.json`)
}

function parseShow(raw: string): Show {
  const data = JSON.parse(raw) as Partial<Show>
  if (!data || typeof data !== 'object' || !Array.isArray(data.mappings)) {
    throw new Error('not a show file')
  }
  return {
    schema: SCHEMA,
    name: typeof data.name === 'string' && data.name ? data.name : 'Untitled',
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : new Date(0).toISOString(),
    mappings: data.mappings as Mapping[],
  }
}

/**
 * Every readable show, newest first. A directory that does not exist yet is
 * simply empty — that is the state before anyone has saved a show. A single
 * corrupt file is skipped rather than being allowed to hide the rest.
 */
export function listShows(showsDir: string): ShowSummary[] {
  let names: string[]
  try {
    names = fs.readdirSync(showsDir)
  } catch {
    return []
  }

  const shows: ShowSummary[] = []
  for (const file of names) {
    if (!file.endsWith('.json')) continue // skips the .tmp of a half-written save
    try {
      const show = parseShow(fs.readFileSync(path.join(showsDir, file), 'utf-8'))
      shows.push({
        id: file.slice(0, -'.json'.length),
        name: show.name,
        savedAt: show.savedAt,
        count: show.mappings.length,
      })
    } catch {
      continue
    }
  }
  return shows.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** One show by id. Throws naming the show, so a failure is actionable. */
export function readShow(showsDir: string, id: string): Show {
  const file = showPath(showsDir, id)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    throw new Error(`Show "${id}" not found`)
  }
  try {
    return parseShow(raw)
  } catch (err) {
    throw new Error(`Show "${id}" could not be read: ${(err as Error).message}`)
  }
}

/**
 * Saves `mappings` under `name`, never overwriting an existing show — a second
 * "Gala" becomes "gala-2". Written to a .tmp and renamed so a crash mid-write
 * cannot leave a file that loads as valid but truncated.
 */
export function writeShow(showsDir: string, name: string, mappings: Mapping[]): ShowSummary {
  fs.mkdirSync(showsDir, { recursive: true })

  const base = slugify(name)
  let id = base
  for (let n = 2; fs.existsSync(path.join(showsDir, `${id}.json`)); n++) {
    id = `${base}-${n}`
  }

  const show: Show = { schema: SCHEMA, name, savedAt: new Date().toISOString(), mappings }
  const file = path.join(showsDir, `${id}.json`)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(show, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, file)

  return { id, name, savedAt: show.savedAt, count: mappings.length }
}

/** Removes a show. Refuses an id that is not there rather than succeeding quietly. */
export function deleteShow(showsDir: string, id: string): void {
  const file = showPath(showsDir, id)
  if (!fs.existsSync(file)) throw new Error(`Show "${id}" not found`)
  fs.unlinkSync(file)
}
