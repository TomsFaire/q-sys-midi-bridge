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

  function buildMappings(physicalControls, assignments) {
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
    return mappings
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
    const assignments = new Map()
    const view = { group: 'all', text: '' }

    for (const mObj of opts.mappings || []) {
      const pc = physicalControls.find(p =>
        p.midi.type === mObj.midi.type && p.midi.channel === mObj.midi.channel && p.midi.number === mObj.midi.number)
      if (!pc) continue
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
    const tbody = el('tbody')
    table.appendChild(tbody)
    const countLabel = el('span', { className: 'count-label' })
    root.appendChild(table)
    root.appendChild(countLabel)

    function fillDatalist(dl, componentName) {
      if (!componentName) return
      if (ctrlCache.has(componentName)) { populateDatalist(dl, ctrlCache.get(componentName)); return }
      if (!getControls) return
      getControls(componentName).then(ctrls => {
        ctrlCache.set(componentName, ctrls)
        populateDatalist(dl, ctrls)
      }, () => {})
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

      const tdType = cell(row)
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

    renderTable()

    return {
      root,
      __internals: { assignments, view, ctrlCache, renderTable, renderRow, renderLinkRow, populateDatalist },
    }
  }

  global.MappingEditor = {
    __internals: { buildMappings, guessRange, withLink, repointPrimary, createEditor, populateDatalist },
  }
})(typeof window !== 'undefined' ? window : globalThis)
