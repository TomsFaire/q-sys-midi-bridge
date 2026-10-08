// Shared mapping editor. A CLASSIC script (not an ES module): the desktop
// renderer loads over file://, where Chromium blocks module imports.
;(function (global) {
  'use strict'

  function guessRange(ctrlName) {
    const n = String(ctrlName).toLowerCase()
    if (n.includes('gain') || n.includes('level') || n.includes('volume')) return [-100, 10]
    if (n.includes('freq') || n.includes('hz')) return [20, 20000]
    if (n.includes('threshold')) return [-40, 0]
    if (n.includes('ratio')) return [1, 20]
    if (n.includes('attack') || n.includes('release')) return [0, 500]
    if (n.includes('pan')) return [-100, 100]
    if (n.includes('delay') || n.includes('ms')) return [0, 2000]
    return [0, 1]
  }

  // Emits qsys.link only when it names a second target. Fields matching the
  // primary are omitted and inherited back on load. A ticked but unfilled row
  // would otherwise fail server validation and lose the whole save.
  function withLink(a, qsys) {
    if (!a.link) return qsys
    const link = {}
    if (a.link.component && a.link.component !== a.component) link.component = a.link.component
    if (a.link.control && a.link.control !== a.controlName) link.control = a.link.control
    if (link.component || link.control) qsys.link = link
    return qsys
  }

  // `unrepresented` holds mappings no row can show — snapshots, named
  // controls, and entries whose MIDI address matches no physical control.
  // They are appended verbatim, after the rows, so a save preserves them
  // instead of deleting them.
  function buildMappings(physicalControls, assignments, unrepresented) {
    const mappings = []
    for (const pc of physicalControls) {
      const a = assignments.get(pc.id)
      if (!a || !a.component || !a.controlName) continue
      const isToggle = pc.controlType === 'toggle'
      const qsys = isToggle
        ? { type: 'toggle', component: a.component, control: a.controlName }
        : { type: 'component_control', component: a.component, control: a.controlName,
            min: a.min ?? -100, max: a.max ?? 10 }
      mappings.push({ label: a.label || pc.label, midi: { ...pc.midi }, qsys: withLink(a, qsys) })
    }
    return mappings.concat(unrepresented || [])
  }

  // Repointing the primary drops any gang: the old partner is unrelated to
  // the new primary, and silently ganging two unrelated controls is worse
  // than making the user tick Link again.
  function repointPrimary(assignments, id, componentName) {
    const a = assignments.get(id) || {}
    assignments.set(id, { ...a, component: componentName, controlName: '',
                          min: -100, max: 10, link: null })
  }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function populateDatalist(dl, controls) {
    dl.innerHTML = controls.map(c => '<option value="' + esc(c.name) + '">').join('')
  }

  function el(tag, props) {
    const e = document.createElement(tag)
    if (props) Object.assign(e, props)
    return e
  }

  // Internal factory. Takes its data directly (no adapter, no async) because
  // rendering is independent of transport. mount() wraps this and adds the
  // adapter, status reporting and the public handle.
  // opts.getControls(componentName) -> Promise<control[]> is optional; without
  // it the control datalists are filled from the cache only.
  function createEditor(opts) {
    const physicalControls = opts.physicalControls || []
    const components = opts.components || []
    const getControls = opts.getControls || null
    const ctrlCache = new Map()
    const pendingControls = new Map()
    // A caller rebuilding the editor (refreshComponents) hands its live map
    // back in so unsaved edits survive; otherwise seed from opts.mappings.
    const assignments = opts.assignments || new Map()
    // The caller may own the view so tab and filter state survive a rebuild.
    const view = opts.view || { group: 'all', text: '' }
    // id -> the control name as it stood before the current typing session
    // began. The input event stores every keystroke (so Save never misses an
    // unblurred edit), so the change event needs this to tell a first fill
    // from an edit of an existing name.
    const committedCtrl = new Map()

    // Mappings this editor cannot show as a row. Saving rewrites the whole
    // array, so anything missing from buildMappings' output is deleted from
    // the user's config — these are carried through untouched instead. A
    // rebuild (refreshComponents) skips the seeding loop below, so the caller
    // hands them back the same way it hands back `assignments`.
    // Copied, not shared: the only caller that passes this also passes
    // `assignments`, which disables the push below — but a future caller that
    // passed it without `assignments` would otherwise append duplicates on
    // every rebuild.
    const unrepresented = (opts.unrepresented || []).slice()

    for (const mObj of opts.assignments ? [] : (opts.mappings || [])) {
      const pc = physicalControls.find(p =>
        p.midi.type === mObj.midi.type && p.midi.channel === mObj.midi.channel && p.midi.number === mObj.midi.number)
      // No row can show it: no physical control carries that MIDI address,
      // the type has no component to put in the row's fields, or the fields a
      // row needs are missing. The `?.` matters — an entry with no qsys at all
      // would otherwise throw here and blank the whole editor.
      const q = mObj.qsys
      if (!pc || (q?.type !== 'component_control' && q?.type !== 'toggle') || !q.component || !q.control) {
        unrepresented.push(mObj)
        continue
      }
      assignments.set(pc.id, {
        component: mObj.qsys.component ?? '',
        controlName: mObj.qsys.control ?? '',
        min: mObj.qsys.min ?? -100,
        max: mObj.qsys.max ?? 10,
        label: mObj.label ?? pc.label,
        // A link field left out on disk is inherited from the primary, so
        // show the inherited value rather than a blank box.
        link: mObj.qsys.link
          ? {
              component: mObj.qsys.link.component ?? mObj.qsys.component ?? '',
              control: mObj.qsys.link.control ?? mObj.qsys.control ?? '',
            }
          : null,
      })
    }

    const root = el('div')
    root.className = 'mapping-editor'
    const table = el('table')
    // Column headers. Order matches buildRowElement's cells; the last th is
    // the clear-button column and is deliberately blank.
    const thead = el('thead')
    const headRow = el('tr')
    const HEADERS = [
      ['Control'], ['Type'], ['Q-Sys Component'], ['Control Name'], ['Min'], ['Max'],
      ['Link', 'Gang a second Q-Sys target to this control \u2014 the right leg of a stereo pair'],
      [''],
    ]
    for (const [text, title] of HEADERS) {
      const th = el('th', { textContent: text })
      if (title) th.title = title
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)
    const tbody = el('tbody')
    table.appendChild(tbody)
    const countLabel = el('span', { className: 'count-label' })
    root.appendChild(table)
    root.appendChild(countLabel)

    // Resolves to the component's controls and never rejects. A failed lookup
    // is cached as [] (free-text entry), so a failing Core is asked once, not
    // on every row render. Concurrent callers share one in-flight request.
    function loadControls(componentName) {
      if (ctrlCache.has(componentName)) return Promise.resolve(ctrlCache.get(componentName))
      if (!getControls) return Promise.resolve([])
      if (pendingControls.has(componentName)) return pendingControls.get(componentName)
      const p = Promise.resolve().then(() => getControls(componentName)).then(
        ctrls => ctrls || [], () => []
      ).then(ctrls => {
        ctrlCache.set(componentName, ctrls)
        pendingControls.delete(componentName)
        return ctrls
      })
      pendingControls.set(componentName, p)
      return p
    }

    function fillDatalist(dl, componentName) {
      if (!componentName) return
      if (ctrlCache.has(componentName)) { populateDatalist(dl, ctrlCache.get(componentName)); return }
      if (!getControls) return
      loadControls(componentName).then(ctrls => populateDatalist(dl, ctrls))
    }

    // A component the Core did not report (renamed, or the Core is offline)
    // is still prepended as the selected option, so the stored value is
    // shown rather than blanked. Without it the next save would drop the
    // mapping.
    function componentSelect(className, id, placeholder, current) {
      const sel = el('select', { className })
      sel.dataset.id = id
      sel.appendChild(el('option', { value: '', textContent: placeholder }))
      if (current && !components.some(c => c.name === current)) {
        sel.appendChild(el('option', { value: current, textContent: current + ' (not on Core)', selected: true }))
      }
      for (const c of components) {
        sel.appendChild(el('option', { value: c.name, textContent: c.name, selected: current === c.name }))
      }
      return sel
    }

    function cell(row, className) {
      const td = el('td')
      if (className) td.className = className
      row.appendChild(td)
      return td
    }

    function buildRowElement(pc, a) {
      const isToggle = pc.controlType === 'toggle'
      const row = el('tr', { className: 'ctrl-row' + (a && a.component ? ' assigned' : '') })
      row.dataset.id = pc.id

      const tdLabel = cell(row, 'td-label')
      // Only call it the "L" leg once there's an "R" leg to tell it apart from.
      if (a && a.link) tdLabel.appendChild(el('span', { className: 'leg', textContent: 'L' }))
      tdLabel.appendChild(el('span', { textContent: pc.label }))

      const tdType = cell(row, 'td-type')
      tdType.appendChild(el('span', { className: 'badge badge-' + pc.controlType, textContent: pc.controlType }))

      cell(row).appendChild(componentSelect('comp-sel', pc.id, '— unassigned —', a && a.component))

      const tdCtrl = cell(row)
      const dlId = 'dl-' + pc.id
      const ctrlInput = el('input', {
        type: 'text', className: 'ctrl-input',
        placeholder: a && a.component ? 'type or pick…' : '—',
        value: (a && a.controlName) ?? '',
        disabled: !(a && a.component),
      })
      ctrlInput.dataset.id = pc.id
      ctrlInput.setAttribute('list', dlId)
      const dl = el('datalist', { id: dlId })
      tdCtrl.appendChild(ctrlInput)
      tdCtrl.appendChild(dl)

      for (const [cls, v] of [['min-inp', (a && a.min) ?? -100], ['max-inp', (a && a.max) ?? 10]]) {
        const inp = el('input', { type: 'number', className: cls, value: String(v),
                                  disabled: isToggle || !(a && a.component) })
        inp.step = 'any'
        inp.dataset.id = pc.id
        if (isToggle) inp.style.visibility = 'hidden'
        cell(row).appendChild(inp)
      }

      const linkChk = el('input', {
        type: 'checkbox', className: 'lnk-chk', checked: !!(a && a.link),
        disabled: !(a && a.component), title: 'Gang a second Q-Sys target to this control',
      })
      linkChk.dataset.id = pc.id
      cell(row, 'td-link').appendChild(linkChk)

      const clearBtn = el('button', { className: 'clear-btn', textContent: '✕', disabled: !(a && a.component) })
      clearBtn.dataset.id = pc.id
      cell(row, 'td-clear').appendChild(clearBtn)

      if (a && a.component) fillDatalist(dl, a.component)
      return row
    }

    /**
     * The ganged second leg, rendered as its own row under the primary.
     * Min/Max stay on the primary: both legs take the same scaled value,
     * which is the whole point of ganging them.
     */
    function buildLinkRowElement(pc, a) {
      const row = el('tr', { className: 'link-row' })
      row.dataset.id = pc.id

      const tdLabel = cell(row, 'td-label')
      tdLabel.appendChild(el('span', { className: 'leg', textContent: 'R' }))
      tdLabel.appendChild(el('span', { textContent: 'linked leg' }))

      cell(row)
      cell(row).appendChild(componentSelect('lnk-comp-sel', pc.id, '— pick a component —', a.link.component))

      const tdCtrl = cell(row)
      const dlId = 'dl-lnk-' + pc.id
      const ctrlInput = el('input', { type: 'text', className: 'lnk-ctrl-input',
                                      placeholder: 'type or pick…', value: a.link.control ?? '' })
      ctrlInput.dataset.id = pc.id
      ctrlInput.setAttribute('list', dlId)
      const dl = el('datalist', { id: dlId })
      tdCtrl.appendChild(ctrlInput)
      tdCtrl.appendChild(dl)

      const tdShared = cell(row)
      tdShared.colSpan = 2
      tdShared.appendChild(el('span', { className: 'shared-hint', textContent: 'min/max shared' }))

      cell(row)
      cell(row)

      fillDatalist(dl, a.link.component || a.component)
      return row
    }

    function renderLinkRow(parent, pc, a) {
      const row = buildLinkRowElement(pc, a)
      parent.appendChild(row)
      return row
    }

    function renderTable() {
      tbody.textContent = ''
      const lf = view.text.toLowerCase()
      let shown = 0
      let lastGroup = null
      for (const pc of physicalControls) {
        if (view.group !== 'all' && pc.group !== view.group) continue
        if (lf && !pc.label.toLowerCase().includes(lf) && !pc.id.toLowerCase().includes(lf)) continue
        if (pc.group !== lastGroup) {
          const gr = el('tr', { className: 'group-row' })
          const td = cell(gr)
          td.colSpan = 8
          td.textContent = pc.group
          tbody.appendChild(gr)
          lastGroup = pc.group
        }
        const a = assignments.get(pc.id)
        tbody.appendChild(buildRowElement(pc, a))
        if (a && a.link) renderLinkRow(tbody, pc, a)
        shown++
      }
      countLabel.textContent = shown + ' of ' + physicalControls.length + ' controls'
    }

    // Re-renders one row from current state, leaving the rest of the table
    // and the user's focus alone. Replaces both the web's full-table rebuild
    // and the desktop's clear-only refreshRow.
    function renderRow(id) {
      const old = root.querySelector('tr.ctrl-row[data-id="' + id + '"]')
      if (!old) return renderTable()
      const stale = root.querySelector('tr.link-row[data-id="' + id + '"]')
      if (stale) stale.remove()
      const pc = physicalControls.find(p => p.id === id)
      const a = assignments.get(id)
      const fresh = buildRowElement(pc, a)
      old.replaceWith(fresh)
      if (a && a.link) fresh.after(buildLinkRowElement(pc, a))
    }

    // Delegated from tbody. Typing (input) never re-renders, so the user's
    // caret survives; structural changes re-render only the affected row.
    tbody.addEventListener('change', async e => {
      const t = e.target
      const id = t.dataset && t.dataset.id
      if (!id) return
      if (t.classList.contains('comp-sel')) {
        const componentName = t.value
        committedCtrl.delete(id)
        if (!componentName) { assignments.delete(id); renderRow(id); return }
        repointPrimary(assignments, id, componentName)
        await loadControls(componentName)
        renderRow(id)
      } else if (t.classList.contains('lnk-chk')) {
        const a = assignments.get(id)
        if (!a) return
        // Seed the new leg from the primary so the common case (same control
        // name on the neighbouring component) only needs the component picked.
        assignments.set(id, { ...a, link: t.checked ? { component: '', control: a.controlName } : null })
        renderRow(id)
      } else if (t.classList.contains('lnk-comp-sel')) {
        const a = assignments.get(id)
        if (!a || !a.link) return
        assignments.set(id, { ...a, link: { ...a.link, component: t.value } })
        if (t.value) await loadControls(t.value)
        renderRow(id)
      } else if (t.classList.contains('ctrl-input')) {
        // Suggest a Min/Max when a control name is FIRST committed (blur,
        // Enter or a datalist pick). Guarding on the committed value, not the
        // live one, stops a hand-typed name guessing from its first letter;
        // an already-named row keeps whatever range the user has.
        const a = assignments.get(id)
        const had = committedCtrl.has(id) ? committedCtrl.get(id) : (a && a.controlName) || ''
        committedCtrl.delete(id)
        const name = t.value.trim()
        const pc = physicalControls.find(p => p.id === id)
        if (!a || had || !name || !pc || pc.controlType === 'toggle') return
        const [min, max] = guessRange(name)
        assignments.set(id, { ...a, controlName: name, min, max })
        // Set the boxes directly: re-rendering here would rebuild the row
        // under the user's caret.
        const row = root.querySelector('tr.ctrl-row[data-id="' + id + '"]')
        if (row) {
          row.querySelector('.min-inp').value = String(min)
          row.querySelector('.max-inp').value = String(max)
        }
      }
    })

    tbody.addEventListener('input', e => {
      const t = e.target
      const id = t.dataset && t.dataset.id
      if (!id) return
      const a = assignments.get(id) || {}
      if (t.classList.contains('lnk-ctrl-input')) {
        if (!a.link) return
        assignments.set(id, { ...a, link: { ...a.link, control: t.value.trim() } })
      } else if (t.classList.contains('ctrl-input')) {
        if (!committedCtrl.has(id)) committedCtrl.set(id, a.controlName || '')
        assignments.set(id, { ...a, controlName: t.value.trim() })
      } else if (t.classList.contains('min-inp')) {
        assignments.set(id, { ...a, min: parseFloat(t.value) || 0 })
      } else if (t.classList.contains('max-inp')) {
        assignments.set(id, { ...a, max: parseFloat(t.value) || 1 })
      }
    })

    tbody.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('.clear-btn')
      if (!btn) return
      committedCtrl.delete(btn.dataset.id)
      assignments.delete(btn.dataset.id)
      renderRow(btn.dataset.id)
    })

    renderTable()

    return {
      root,
      __internals: { assignments, unrepresented, view, ctrlCache, renderTable, renderRow, renderLinkRow, populateDatalist },
    }
  }

  function messageOf(e) {
    return e && e.message ? e.message : String(e)
  }

  function naturalSort(controls) {
    return controls.slice().sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  }

  /**
   * Public entry point. Owns the adapter, performs the initial load and wires
   * the tab/filter toolbar. Adapter methods throw; every failure is caught here
   * and reported through onStatus({ kind: 'info' | 'ok' | 'err', text }).
   * Q-Sys being unreachable is not fatal: the table still renders and control
   * names fall back to free text, so mappings stay editable with the Core off.
   */
  async function mount(opts) {
    const host = opts.root
    const adapter = opts.adapter
    const say = (kind, text) => { if (opts.onStatus) opts.onStatus({ kind, text }) }
    const view = { group: 'all', text: '' }
    let editor = null
    let physicalControls = []
    // When the initial load fails the table is empty. Saving that would wipe
    // the stored mappings, so saves are refused until a load succeeds.
    let loadFailed = false

    const toolbar = el('div', { className: 'me-toolbar' })
    const tabs = el('div', { className: 'me-tabs' })
    const filter = el('input', { type: 'search', className: 'filter-input', placeholder: 'Filter e.g. Fader 1, Mute…' })
    toolbar.appendChild(tabs)
    toolbar.appendChild(filter)

    function rerender() { if (editor) editor.__internals.renderTable() }

    function buildTabs() {
      tabs.textContent = ''
      const groups = []
      for (const pc of physicalControls) if (!groups.includes(pc.group)) groups.push(pc.group)
      if (view.group !== 'all' && !groups.includes(view.group)) view.group = 'all'
      for (const g of ['all'].concat(groups)) {
        const b = el('button', { className: 'tab' + (g === view.group ? ' active' : ''),
                                 textContent: g === 'all' ? 'All' : g })
        b.dataset.group = g
        tabs.appendChild(b)
      }
    }

    tabs.addEventListener('click', e => {
      const tab = e.target.closest && e.target.closest('.tab')
      if (!tab) return
      for (const t of tabs.querySelectorAll('.tab')) t.classList.remove('active')
      tab.classList.add('active')
      view.group = tab.dataset.group
      rerender()
    })

    filter.addEventListener('input', e => {
      view.text = e.target.value
      rerender()
    })

    async function load() {
      let state = { physicalControls: [], mappings: [] }
      try {
        // A null/undefined answer is a failed load, not an empty one: treating
        // it as empty would let a save wipe the stored mappings.
        state = (await adapter.loadEditorState()) || null
        if (!state) throw new Error('the server returned no mapping data')
        loadFailed = false
      } catch (e) {
        loadFailed = true
        state = { physicalControls: [], mappings: [] }
        say('err', 'Could not load mappings: ' + messageOf(e))
      }

      const components = await discover()

      physicalControls = state.physicalControls || []
      buildTabs()
      filter.value = view.text
      install({ mappings: state.mappings || [] }, components)
    }

    // Builds an editor and swaps it in. extra carries either mappings (fresh
    // load) or assignments (keep the user's unsaved edits).
    function install(extra, components) {
      const fresh = createEditor({
        physicalControls,
        components,
        view,
        getControls: name => Promise.resolve(adapter.getComponentControls(name)).then(naturalSort),
        ...extra,
      })
      if (editor) editor.root.replaceWith(fresh.root)
      else host.appendChild(fresh.root)
      editor = fresh
      handle.root = host
      handle.__internals = fresh.__internals
    }

    // Asks the Core for its components. Failures are reported and yield [].
    // A failing status probe carries the Core's own message, shown as an error:
    // with Access Control on, a logon failure is the usual reason for no components.
    async function discover() {
      let connected = true
      try {
        const st = await adapter.getQsysStatus()
        connected = !!(st && st.connected)
        if (!connected) {
          if (st && st.message) say('err', 'Q-Sys: ' + st.message)
          else say('info', 'Q-Sys is not connected. Control names are free text until it is.')
        }
      } catch (e) {
        // An unprobeable Core is not a connected one: skip discovery rather
        // than let its failure message overwrite this one.
        connected = false
        say('err', 'Q-Sys status: ' + messageOf(e))
      }
      if (!connected) return []
      try {
        return (await adapter.discoverComponents()) || []
      } catch (e) {
        say('err', 'Q-Sys: ' + messageOf(e))
        return []
      }
    }

    // Re-asks the Core for components and re-renders, keeping every unsaved
    // edit. Falls back to a full load if nothing has loaded yet.
    async function refreshComponents() {
      if (!editor || loadFailed) return load()
      install({ assignments: editor.__internals.assignments, unrepresented: editor.__internals.unrepresented }, await discover())
    }

    function getMappings() {
      if (loadFailed) throw new Error('Mappings failed to load, so there is nothing safe to read. Reload first.')
      return buildMappings(physicalControls, editor.__internals.assignments, editor.__internals.unrepresented)
    }

    async function send(method, busy, done) {
      if (loadFailed) {
        say('err', 'Not saved: the mappings failed to load, so saving would overwrite them. Reload first.')
        return false
      }
      say('info', busy)
      try {
        const sent = getMappings()
        const result = await adapter[method](sent)
        const count = result && typeof result.count === 'number' ? result.count : sent.length
        say('ok', done + ' — ' + count + ' mappings')
        return true
      } catch (e) {
        say('err', messageOf(e))
        return false
      }
    }

    const handle = {
      root: host,
      __internals: null,
      getMappings,
      save: () => send('save', 'Saving…', 'Saved'),
      saveAndApply: () => send('saveAndApply', 'Applying…', 'Applied'),
      reload: load,
      refreshComponents,
    }

    host.textContent = ''
    host.appendChild(toolbar)
    await load()
    return handle
  }

  global.MappingEditor = {
    mount,
    __internals: { buildMappings, guessRange, withLink, repointPrimary, createEditor, populateDatalist },
  }
})(typeof window !== 'undefined' ? window : globalThis)
