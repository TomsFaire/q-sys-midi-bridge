/**
 * Loads assets/shared/mapping-editor.js (a classic script that sets
 * window.MappingEditor) into a vm with a stub window/document and returns the
 * MappingEditor global. No HTML and no <script> extraction needed.
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

/**
 * A deliberately small DOM: enough tree, selector and form-control behaviour
 * to exercise the editor's rendering without a browser or jsdom. It supports
 * compound selectors (tag, .class, [attr="v"]) joined by descendant
 * combinators, which is all the editor and its tests use.
 */
class StubElement {
  tagName: string
  children: StubElement[] = []
  parentNode: StubElement | null = null
  className = ''
  id = ''
  dataset: Any = {}
  style: Any = {}
  attrs: Record<string, string> = {}
  type = ''; checked = false; disabled = false; title = ''; placeholder = ''
  colSpan = 1; selected = false
  innerHTML = ''
  private _text = ''
  private _value = ''

  constructor(tag: string) { this.tagName = tag.toUpperCase() }

  get classList(): Any {
    const names = () => this.className.split(/\s+/).filter(Boolean)
    return {
      add: (n: string) => { if (!names().includes(n)) this.className = [...names(), n].join(' ') },
      remove: (n: string) => { this.className = names().filter(x => x !== n).join(' ') },
      contains: (n: string) => names().includes(n),
      toggle: (n: string) => { const h = names().includes(n); if (h) this.classList.remove(n); else this.classList.add(n); return !h },
    }
  }

  get textContent(): string { return this._text + this.children.map(c => c.textContent).join('') }
  set textContent(v: string) { this.children = []; this._text = String(v) }

  get value(): string {
    if (this.tagName === 'SELECT') {
      const opts = this.children.filter(c => c.tagName === 'OPTION')
      const hit = opts.find(o => o.selected) ?? opts[0]
      return hit ? hit.value : ''
    }
    return this._value
  }
  set value(v: string) {
    if (this.tagName === 'SELECT') {
      for (const o of this.children) o.selected = o.tagName === 'OPTION' && o.value === v
    } else this._value = String(v)
  }

  appendChild(c: StubElement) { c.remove(); c.parentNode = this; this.children.push(c); return c }
  remove() {
    if (!this.parentNode) return
    this.parentNode.children = this.parentNode.children.filter(c => c !== this)
    this.parentNode = null
  }
  replaceWith(n: StubElement) {
    const p = this.parentNode!
    n.remove(); n.parentNode = p
    p.children = p.children.map(c => (c === this ? n : c))
    this.parentNode = null
  }
  after(n: StubElement) {
    const p = this.parentNode!
    n.remove(); n.parentNode = p
    p.children.splice(p.children.indexOf(this) + 1, 0, n)
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v) }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  private listeners: Record<string, Array<(e: Any) => Any>> = {}
  addEventListener(type: string, fn: (e: Any) => Any) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener(type: string, fn: (e: Any) => Any) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn)
  }
  /**
   * Runs the REAL listeners on this element and each ancestor (events bubble).
   * Async listeners' promises are collected on event.pending so fireEvent can
   * await them; a listener that throws or rejects fails the calling test.
   */
  dispatchEvent(ev: Any): boolean {
    ev.target ??= this
    ev.pending ??= []
    for (let el: StubElement | null = this; el; el = el.parentNode) {
      ev.currentTarget = el
      for (const fn of [...(el.listeners[ev.type] ?? [])]) {
        const r = fn.call(el, ev)
        if (r && typeof r.then === 'function') ev.pending.push(r)
      }
    }
    return true
  }

  private attr(name: string): string | undefined {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      return this.dataset[key]
    }
    if (name === 'class') return this.className
    return name in this.attrs ? this.attrs[name] : (this as Any)[name]
  }

  private matchesCompound(sel: string): boolean {
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(sel)
    if (!m) throw new Error('stub selector unsupported: ' + sel)
    if (m[1] && m[1].toUpperCase() !== this.tagName) return false
    for (const c of m[2].split('.').filter(Boolean)) if (!this.classList.contains(c)) return false
    for (const a of m[3].match(/\[[^\]]+\]/g) ?? []) {
      const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a)
      if (!am) throw new Error('stub attribute selector unsupported: ' + a)
      const v = this.attr(am[1])
      if (am[2] === undefined ? v === undefined : v !== am[2]) return false
    }
    return true
  }

  matches(selector: string): boolean {
    const parts = selector.trim().split(/\s+/)
    if (!this.matchesCompound(parts[parts.length - 1])) return false
    let el: StubElement | null = this.parentNode
    for (let i = parts.length - 2; i >= 0; i--) {
      while (el && !el.matchesCompound(parts[i])) el = el.parentNode
      if (!el) return false
      el = el.parentNode
    }
    return true
  }

  querySelectorAll(selector: string): StubElement[] {
    const out: StubElement[] = []
    const walk = (n: StubElement) => {
      for (const c of n.children) { if (c.matches(selector)) out.push(c); walk(c) }
    }
    walk(this)
    return out
  }
  querySelector(selector: string): StubElement | null { return this.querySelectorAll(selector)[0] ?? null }
  closest(selector: string): StubElement | null {
    for (let el: StubElement | null = this; el; el = el.parentNode) if (el.matches(selector)) return el
    return null
  }
}

function makeElement(tag = 'div'): Any { return new StubElement(tag) }

function makeDocument(): Any {
  const byKey = new Map<string, Any>()
  const lookup = (key: string) => {
    let el = byKey.get(key)
    if (!el) { el = makeElement(); byKey.set(key, el) }
    return el
  }
  return {
    getElementById: (id: string) => lookup('#' + id),
    querySelector: (sel: string) => lookup(sel),
    querySelectorAll: () => [],
    createElement: (tag: string) => makeElement(tag),
    createTextNode: () => makeElement('#text'),
    addEventListener: () => {},
    body: makeElement('body'),
  }
}

/** A bare DOM element for tests that need to hand the editor a mount point. */
export function makeDomElement(tag = 'div'): Any { return makeElement(tag) }

/**
 * Dispatches a bubbling event at el through the stub's real listener chain and
 * resolves once every async listener has settled.
 */
export async function fireEvent(el: Any, type: string): Promise<void> {
  const ev: Any = { type, bubbles: true, pending: [] }
  el.dispatchEvent(ev)
  await Promise.all(ev.pending)
}

export function loadSharedEditor(): Any {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'assets', 'shared', 'mapping-editor.js'), 'utf-8')
  const sandbox: Any = { console, document: makeDocument() }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  return sandbox.MappingEditor
}
