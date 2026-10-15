/**
 * The UCI "Mappings" tab.
 *
 * The tab frames the bridge's own /mappings editor. It must appear only when the
 * page is served by the bridge (the one host that answers
 * /api/mappings/session) and create the iframe lazily and once so UCI startup is
 * unchanged and unsaved edits survive tab switches. With no password set the
 * editor is open, so the tab loads it either way; the editor page itself shows
 * the "how to set a password" notice.
 *
 * Like the other UCI tests, these lift the real functions out of the page by
 * source, so they cannot drift from what the browser runs. The framing test
 * drives the real handler over loopback: a future X-Frame-Options or CSP
 * frame-ancestors would break the tab silently, so it must fail loudly here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { MappingsHttpHandler } from './mappings-http.js'

const UCI_PATH = path.join(__dirname, '..', '..', 'assets', 'uci', 'foh-uci.html')
const html = fs.readFileSync(UCI_PATH, 'utf-8')

type Probe = { status: number; body: unknown } | null
type State = 'hidden' | 'ready'

interface FakeEl {
  tag: string
  src?: string
  children: FakeEl[]
}
interface Host extends FakeEl {
  querySelector(sel: string): FakeEl | null
  appendChild(el: FakeEl): void
}

interface TabLogic {
  mappingsTabState(probe: Probe): State
  ensureMappingsFrame(host: Host, doc: { createElement(tag: string): FakeEl }): boolean
  mappingsPageView(state: State | 'checking'): { message: string; showFrame: boolean }
}

/** The two pure functions sit between these markers in the page script. */
function loadLogic(): TabLogic {
  const start = html.indexOf('// probe: { status, body }')
  const end = html.indexOf('async function probeMappingsSession')
  assert.ok(start > 0 && end > start, 'mappings tab logic not found in the page')
  const sandbox: Record<string, unknown> = {}
  vm.runInNewContext(`${html.slice(start, end)}\nthis.out = { mappingsTabState, ensureMappingsFrame, mappingsPageView }`, sandbox)
  return sandbox.out as TabLogic
}

const logic = loadLogic()

function fakeHost(): Host {
  const host: Host = {
    tag: 'div',
    children: [],
    querySelector: (sel: string) => (sel === 'iframe' ? host.children.find(c => c.tag === 'iframe') ?? null : null),
    appendChild: (el: FakeEl) => { host.children.push(el) },
  }
  return host
}
const fakeDoc = { createElement: (tag: string): FakeEl => ({ tag, children: [] }) }

test('a bridge with a password set shows the tab as ready', () => {
  assert.equal(logic.mappingsTabState({ status: 200, body: { authenticated: false, passwordSet: true } }), 'ready')
})

test('a bridge with no password set also shows the tab as ready (the editor is open)', () => {
  assert.equal(logic.mappingsTabState({ status: 200, body: { authenticated: true, passwordSet: false } }), 'ready')
})

test('anything that is not the bridge hides the tab', () => {
  const cases: Array<[string, Probe]> = [
    ['network failure / timeout', null],
    ['404', { status: 404, body: null }],
    ['500', { status: 500, body: { passwordSet: true } }],
    ['redirect', { status: 302, body: { passwordSet: true } }],
    ['non-JSON body', { status: 200, body: null }],
    ['HTML body', { status: 200, body: '<html></html>' }],
    ['JSON without passwordSet', { status: 200, body: { authenticated: true } }],
    ['passwordSet not a boolean', { status: 200, body: { passwordSet: 'yes' } }],
  ]
  for (const [name, probe] of cases) assert.equal(logic.mappingsTabState(probe), 'hidden', name)
})

test('the iframe is created once, pointing at /mappings, and never recreated', () => {
  const host = fakeHost()
  assert.equal(logic.ensureMappingsFrame(host, fakeDoc), true)
  assert.equal(logic.ensureMappingsFrame(host, fakeDoc), false)
  assert.equal(host.children.length, 1)
  assert.equal(host.children[0].src, '/mappings')
})

test('markup contract: hidden tab button, matching page, and no eager iframe', () => {
  const button = html.match(/<button[^>]*id="tab-mappings"[^>]*>/)
  assert.ok(button, '#tab-mappings button missing')
  assert.match(button[0], /\shidden[\s>]/, 'tab must be hidden until the probe succeeds')
  assert.match(button[0], /data-tab="mappings"/, 'generic tab handler targets #page-<data-tab>')
  assert.match(html, /<div id="page-mappings" class="page">/)
  assert.doesNotMatch(button[0], /\bstub\b/, 'a .stub tab is skipped by the tab handler')
  assert.doesNotMatch(html, /<iframe/i, 'the iframe must be created lazily, never in static markup')
})

test('/mappings is served without frame-blocking headers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-frame-'))
  const page = path.join(dir, 'mappings.html')
  fs.writeFileSync(page, '<html></html>')
  const handler = new MappingsHttpHandler(path.join(dir, 'config.json'), page)
  const server = http.createServer((req, res) => {
    if (!handler.handle(req, res)) { res.writeHead(404); res.end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address() as { port: number }
    const res = await fetch(`http://127.0.0.1:${port}/mappings`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-frame-options'), null)
    const csp = res.headers.get('content-security-policy') ?? ''
    assert.doesNotMatch(csp, /frame-ancestors/i)
  } finally {
    server.close()
  }
})

test('the page never sits blank: every state has a message or the editor', () => {
  assert.equal(logic.mappingsPageView('ready').showFrame, true)
  for (const state of ['checking', 'hidden'] as const) {
    const view = logic.mappingsPageView(state)
    assert.equal(view.showFrame, false, state)
    assert.ok(view.message.length > 0, `${state} must explain itself`)
  }
})

test('the editor page explains how to set a password without blocking use', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'mappings', 'mappings.html'), 'utf-8')
  const note = page.match(/<div[^>]*id="no-password-note"[^>]*>[\s\S]*?<\/div>/)
  assert.ok(note, '#no-password-note missing')
  assert.match(note[0], /class="[^"]*\bhidden\b/, 'hidden until the session says no password is set')
  assert.match(note[0], /Configure Mappings/)
  assert.match(note[0], /Network/)
  // The old behavior disabled sign-in and dead-ended the user.
  assert.doesNotMatch(page, /login-btn'\)\.disabled = true/)
})
