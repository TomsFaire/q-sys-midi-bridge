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

function makeElement(tag = 'div'): Any {
  const el: Any = {
    tagName: tag.toUpperCase(),
    textContent: '', innerHTML: '', value: '', id: '', className: '',
    type: '', checked: false, disabled: false, title: '', placeholder: '',
    colSpan: 1, style: {}, dataset: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
    appendChild: (c: Any) => c, removeChild: (c: Any) => c,
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
    closest: () => null, querySelector: () => makeElement(), querySelectorAll: () => [],
  }
  return el
}

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

export function loadSharedEditor(): Any {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'assets', 'shared', 'mapping-editor.js'), 'utf-8')
  const sandbox: Any = { console, document: makeDocument() }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  return sandbox.MappingEditor
}
